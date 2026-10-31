/* Retriever orchestrator (P2.2) — sync, query and recall cache for the
 * vector index of the CURRENT chat.
 *
 * Independence: depends only on ST core (via injected hooks) + the local
 * pure modules. No third-party extension is imported or referenced.
 *
 * Correctness contract (frozen P2 design):
 * - The chat-local store is the source of truth; the server index is derived
 *   and rebuildable. `/list` is the only proof of what the server holds.
 * - Every async flow snapshots the lifecycle epoch; if the chat changed
   mid-flight the result is dropped, not applied to the new chat.
 * - Recall results are content-version checked against the live store:
 *   a hit whose payload digest no longer matches is dropped and the index
 *   marked dirty for re-sync.
 * - The generation path never awaits: `getRecallSelection()` is synchronous
 *   and uses the latest VALID cache; `refreshRecall()` runs in the
 *   background and refreshes the cache + triggers re-injection.
 */

import { buildQueryText, computeDesiredDocuments, diffDocuments, payloadDigest, canonicalIndexText, shortHash } from './recall-core.js';
import { canonicalEntriesFingerprint } from './processing-core.js';
import { createVectorClient } from './vector-client.js';

const RETRIEVAL_SCHEMA = 1;
const SYNC_BATCH = 25;
const SYNC_TIMEOUT_MS = 15000;
const QUERY_TIMEOUT_MS = 4000;
const QUERY_DEPTH_MAX = 12;

const runtime = {
    ready: false,
    hooks: null,
    epoch: 0,
    syncInFlight: false,
    syncDirty: false,
    status: 'idle',
    lastSyncAt: 0,
    lastError: '',
    recall: { ids: [], stamp: '', hits: 0, at: 0, mode: 'off', queryText: '' },
    inflight: null,
    /* v0.9: stamp of the in-flight query + the last stamp ever queried
       (awaitFreshRecall single-flight). */
    inflightStamp: '',
    lastQueriedStamp: '',
    /* v0.6.0: per-flow abort controllers (S5), stamp cache (P1) and the
       optional createClient DI hook for tests (T3.6). */
    syncAbort: null,
    queryAbort: null,
    stampCache: { key: '', entriesPart: '' },
    createClient: null,
};

function hook(name, ...args) {
    const fn = runtime.hooks?.[name];
    return typeof fn === 'function' ? fn(...args) : undefined;
}

function retrievalConfig() {
    const settings = hook('getSettings') ?? {};
    const retrieval = settings.retrieval && typeof settings.retrieval === 'object' ? settings.retrieval : {};
    return {
        enabled: retrieval.enabled === true,
        source: String(retrieval.source ?? 'transformers'),
        model: String(retrieval.model ?? ''),
        topK: Math.max(1, Math.min(50, Math.round(Number(retrieval.topK)) || 16)),
        queryDepth: Math.max(1, Math.min(QUERY_DEPTH_MAX, Math.round(Number(retrieval.queryDepth)) || 4)),
        queryMaxChars: Math.max(200, Math.min(4000, Math.round(Number(retrieval.queryMaxChars)) || 1200)),
    };
}

function scopeKeyOf(context) {
    /* Physical chat identity: ST's chatId is `${characterToken}-${chatFile}` —
       stable per chat file, changes when the chat is copied or renamed. */
    return String(context?.chatId ?? '').trim();
}

function isChatOpen(context) {
    return Boolean(context?.chatMetadata) && scopeKeyOf(context) !== '';
}

function canRun() {
    if (!runtime.ready) return false;
    const settings = hook('getSettings') ?? {};
    if (!settings.enabled || !settings.retrieval?.enabled) return false;
    return isChatOpen(hook('getContext'));
}

function embeddingKeyFor(config) {
    /* The server already isolates per model on disk; this key is for manifest
       honesty and cache invalidation on the extension side. */
    return `${config.source}:${config.model || 'server-default'}`;
}

export function bumpEpoch() {
    runtime.epoch += 1;
    runtime.recall.stamp = '';
    runtime.lastQueriedStamp = '';
    /* v0.6.0 (S5): abort in-flight vector requests — the epoch checks between
       awaits alone left requests running up to 15s after a chat switch. */
    for (const controller of [runtime.syncAbort, runtime.queryAbort]) {
        try { controller?.abort(new DOMException('chat changed', 'AbortError')); } catch { /* already aborted */ }
    }
    runtime.syncAbort = null;
    runtime.queryAbort = null;
}

function clientFor(config, timeoutMs = SYNC_TIMEOUT_MS) {
    const create = typeof runtime.createClient === 'function' ? runtime.createClient : createVectorClient;
    return create({ source: config.source, model: config.model, timeoutMs });
}

function computeStamp(context, state) {
    const chat = Array.isArray(context.chat) ? context.chat : [];
    let lastKey = '';
    for (let i = chat.length - 1; i >= 0; i--) {
        const mes = chat[i];
        if (hook('isCountedChatMessage', mes)) {
            /* v0.6.0 (S4): digest the CONTENT, not the length — a same-length
               edit must invalidate the recall cache. One message, cheap. */
            lastKey = `${i}:${payloadDigest(String(mes?.mes ?? ''))}`;
            break;
        }
    }
    /* v0.6.0 (P1): the entries digest only changes through the mutation
       boundary (memoryRevision bumps on canonical entry changes only) or a
       vector rebind — cache it instead of hashing the whole store each call. */
    const cacheKey = `${state.memoryRevision}:${state.entries.length}:${state.vector?.indexId ?? ''}:${state.vector?.embeddingKey ?? ''}`;
    if (runtime.stampCache.key !== cacheKey) {
        runtime.stampCache = {
            key: cacheKey,
            entriesPart: state.entries.map(entry => `${entry.id}:${payloadDigest(canonicalIndexText(entry))}`).join(','),
        };
    }
    return [scopeKeyOf(context), lastKey, shortHash(runtime.stampCache.entriesPart), state.vector?.indexId ?? '', state.vector?.embeddingKey ?? ''].join('|');
}

export function getStatus() {
    const context = hook('getContext');
    const state = runtime.ready ? hook('loadState') : null;
    return {
        status: runtime.status,
        enabled: canRun(),
        lastSyncAt: runtime.lastSyncAt || null,
        lastError: runtime.lastError,
        documents: state ? Object.keys(state.vector?.documents ?? {}).length : 0,
        entries: state ? state.entries.length : 0,
        scope: context ? scopeKeyOf(context) : '',
        recallIds: runtime.recall.ids.length,
        recallAt: runtime.recall.at || null,
    };
}

/* Background index sync: /list is the server truth; diff drives batches.
   Commits only after every batch acknowledged; a lifecycle change aborts
   silently and the dirty flag re-runs against the new chat. */
export async function syncIndex({ force = false } = {}) {
    if (!canRun()) return false;
    /* v0.6.0 (S2): the mutation boundary is REQUIRED (invariant 10) — fail
       fast BEFORE touching the server, so a host without the boundary can
       never build server state it cannot then declare synced.
       NOTE: inspect runtime.hooks directly — hook() INVOKES the hook, so
       `typeof hook('commitMutation')` tested the RESULT, not the function
       (a latent bug in the v0.5.x commitHook detection). */
    const commitHook = typeof runtime.hooks?.commitMutation === 'function' ? runtime.hooks.commitMutation : null;
    if (!commitHook) {
        runtime.status = 'error';
        runtime.lastError = 'no mutation boundary';
        console.warn('[Memory Weaver] Vector index sync skipped: no commitMutation boundary wired.');
        return false;
    }
    if (runtime.syncInFlight) {
        runtime.syncDirty = true;
        return false;
    }
    runtime.syncInFlight = true;
    runtime.status = 'syncing';
    const epochAtStart = runtime.epoch;
    const lifecycleAtStart = typeof runtime.hooks?.getLifecycleEpoch === 'function' ? runtime.hooks.getLifecycleEpoch() : undefined;
    /* v0.6.0 (S5): every vector request in this flow shares one abort
       controller — bumpEpoch() cancels them all on a chat switch. */
    const abort = new AbortController();
    runtime.syncAbort = abort;
    try {
        const context = hook('getContext');
        const scopeKey = scopeKeyOf(context);
        const config = retrievalConfig();
        const embeddingKey = embeddingKeyFor(config);
        const state = hook('loadState');
        const manifest = state.vector ?? {};
        /* v0.6.0 (S3): snapshot the store identity — re-checked after every
           await so a mid-flight memory edit cannot commit a stale manifest. */
        const revisionAtStart = Number(state.memoryRevision ?? 0);
        const entriesDigestAtStart = canonicalEntriesFingerprint(state.entries);

        const needsRebind = force || manifest.schema !== RETRIEVAL_SCHEMA || manifest.boundScope !== scopeKey || manifest.embeddingKey !== embeddingKey || !manifest.indexId;
        const indexId = needsRebind ? shortHash(`${scopeKey}|${embeddingKey}|${Date.now()}|${Math.random()}`) : manifest.indexId;
        const collectionId = `memoryweaver_${shortHash(`${scopeKey}|${embeddingKey}`)}`;

        const desired = computeDesiredDocuments(state.entries);
        const client = clientFor(config);
        const serverHashes = await client.listHashes(collectionId, abort.signal);
        if (runtime.epoch !== epochAtStart) return false;

        const previousDocs = needsRebind ? {} : (manifest.documents ?? {});
        const diff = diffDocuments({ serverHashes, desired, previous: previousDocs });

        /* v0.6.0 (P4): id → entry Map once instead of a find() per insert. */
        const entriesById = new Map(state.entries.map(entry => [String(entry.id), entry]));
        for (const batch of chunk(diff.toDelete, SYNC_BATCH)) {
            /* toDelete carries NUMERIC hashes (server identifier), not ids. */
            await client.deleteHashes(collectionId, batch, abort.signal);
            if (runtime.epoch !== epochAtStart) return false;
        }
        for (const batch of chunk(diff.toInsert, SYNC_BATCH)) {
            const items = batch.map(id => ({ hash: desired[id].hash, text: canonicalIndexText(entriesById.get(String(id))), index: 0 }));
            await client.insertDocuments(collectionId, items, abort.signal);
            if (runtime.epoch !== epochAtStart) return false;
        }

        /* v0.6.5: nothing to do and the manifest already says exactly this —
           skip the vector-meta commit (no persist churn on every sync). */
        if (!needsRebind && !diff.toInsert.length && !diff.toDelete.length && sameDocuments(manifest.documents, desired)) {
            runtime.lastSyncAt = Date.now();
            runtime.lastError = '';
            runtime.status = 'ready';
            return true;
        }

        /* v0.6.0 (S3): the store must be exactly the state the manifest was
           computed from — otherwise the commit would mark stale documents as
           synced. Flag dirty; the finally-rerun syncs against the live state. */
        const freshState = hook('loadState');
        if (Number(freshState.memoryRevision ?? 0) !== revisionAtStart || canonicalEntriesFingerprint(freshState.entries) !== entriesDigestAtStart) {
            runtime.syncDirty = true;
            return false;
        }

        /* Metadata commit AFTER success: write through the mutation boundary
           (kind 'vector-meta') — merge semantics unchanged (only the vector
           field is replaced; schedule/entries/turnCount come from the live
           state). v0.6.0 (S2): the boundary is required and checked at the
           top of this flow — the old direct persistState fallback violated
           invariant 10 and is gone. */
        const committed = commitHook({
            kind: 'vector-meta',
            scopeKey,
            /* v0.6.5: test the HOOK, not its result (hook() invokes it — the
               old check was always undefined, so the lifecycle guard never
               ran). The value is the one captured at sync START, so a chat
               lifecycle change during the awaits rejects the commit. */
            lifecycleEpoch: lifecycleAtStart,
            reason: 'vector index metadata commit',
        }, (live) => {
            live.vector = {
                schema: RETRIEVAL_SCHEMA,
                boundScope: scopeKey,
                indexId,
                embeddingKey,
                syncedAt: new Date().toISOString(),
                documents: desired,
            };
            return { committed: true };
        });
        if (!committed?.ok) {
            /* Conflict or corrupt state: report failure — the dirty flag
               re-runs the sync against the live state later. */
            runtime.status = 'error';
            runtime.lastError = `vector metadata commit rejected (${committed?.reason ?? 'unknown'})`;
            console.warn('[Memory Weaver] Vector index sync rejected at metadata commit:', committed?.reason);
            return false;
        }
        runtime.lastSyncAt = Date.now();
        runtime.lastError = '';
        runtime.status = 'ready';
        runtime.recall.stamp = '';
        return true;
    } catch (error) {
        if (error?.name === 'AbortError') return false;
        runtime.status = 'error';
        runtime.lastError = String(error?.message ?? error);
        console.warn('[Memory Weaver] vector index sync failed:', error);
        return false;
    } finally {
        runtime.syncInFlight = false;
        if (runtime.syncAbort === abort) runtime.syncAbort = null;
        if (runtime.syncDirty && runtime.epoch === epochAtStart) {
            runtime.syncDirty = false;
            /* v0.6.5: the rerun is a plain diff sync — a forced rebind already
               happened (or will be re-requested); re-forcing on every
               revision drift re-embedded the whole store again. */
            void syncIndex({ force: false });
        }
    }
}

function sameDocuments(a, b) {
    const left = a && typeof a === 'object' ? a : {};
    const right = b && typeof b === 'object' ? b : {};
    const keys = Object.keys(right);
    if (Object.keys(left).length !== keys.length) return false;
    return keys.every(id => left[id] && Number(left[id].hash) === Number(right[id].hash) && left[id].digest === right[id].digest);
}

function chunk(array, size) {
    const out = [];
    for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
    return out;
}

/* Background recall refresh: query the index for the current scene and cache
   the validated entry ids. Generation never awaits this. */
export async function refreshRecall() {
    if (!canRun()) return [];
    if (runtime.inflight) return runtime.inflight;
    /* v0.6.0 (S5): the query flow gets its own abort controller + the short
       QUERY_TIMEOUT_MS (the 15s sync timeout made recalls hang long after
       the scene moved on). */
    const abort = new AbortController();
    runtime.queryAbort = abort;
    const promise = (async () => {
        const context = hook('getContext');
        const scopeKey = scopeKeyOf(context);
        const epochAtStart = runtime.epoch;
        const config = retrievalConfig();
        const state = hook('loadState');
        /* v0.8: the stamp is captured at query START — the results describe
           the scene AS QUERIED. A query started before MESSAGE_SENT must not
           be stamped fresh for the new message (computing the stamp after
           the await bound old hits to the newest message). */
        const stampAtStart = computeStamp(context, state);
        /* v0.9: single-flight bookkeeping for awaitFreshRecall (set before
           the first await — synchronous with the refreshRecall() call). */
        runtime.inflightStamp = stampAtStart;
        runtime.lastQueriedStamp = stampAtStart;
        const documents = state.vector?.documents ?? {};
        if (!state.vector?.indexId || !Object.keys(documents).length) {
            runtime.recall = { ids: [], stamp: '', hits: 0, at: Date.now(), mode: 'lexical', queryText: '' };
            return [];
        }

        const chat = Array.isArray(context.chat) ? context.chat : [];
        const items = [];
        for (let i = chat.length - 1; i >= 0 && items.length < config.queryDepth; i--) {
            const mes = chat[i];
            if (!hook('isCountedChatMessage', mes)) continue;
            items.unshift({ role: mes.is_user ? 'user' : 'assistant', text: String(mes.mes ?? '') });
        }
        const queryText = buildQueryText(items, { maxChars: config.queryMaxChars });
        if (!queryText) return [];

        const client = clientFor(config, QUERY_TIMEOUT_MS);
        const raw = await client.query(`memoryweaver_${shortHash(`${scopeKey}|${embeddingKeyFor(config)}`)}`, queryText, config.topK, abort.signal);
        if (runtime.epoch !== epochAtStart) return [];

        const hashToId = {};
        for (const [id, doc] of Object.entries(documents)) hashToId[doc.hash] = id;
        const byId = new Map(state.entries.map(entry => [String(entry.id), entry]));

        const ids = [];
        let stale = false;
        for (const meta of raw.metadata) {
            const id = hashToId[Number(meta?.hash)];
            const entry = byId.get(id);
            if (!entry) continue;
            /* Content-version check: the indexed text may be an older version
               of this entry (edited after the last sync). Drop stale hits and
               mark the document for re-sync. */
            const digest = payloadDigest(canonicalIndexText(entry));
            if (documents[id]?.digest !== digest) {
                stale = true;
                continue;
            }
            ids.push(id);
        }
        if (stale) void syncIndex();

        runtime.recall = {
            ids,
            stamp: stampAtStart,
            hits: ids.length,
            at: Date.now(),
            mode: 'vector',
            queryText,
        };
        hook('onRecallUpdated');
        return ids;
    })().catch(error => {
        if (error?.name === 'AbortError') return [];
        runtime.lastError = String(error?.message ?? error);
        runtime.recall = { ids: [], stamp: '', hits: 0, at: Date.now(), mode: 'error', queryText: '' };
        return [];
    }).finally(() => {
        if (runtime.inflight === promise) {
            runtime.inflight = null;
            runtime.inflightStamp = '';
        }
        if (runtime.queryAbort === abort) runtime.queryAbort = null;
    });
    runtime.inflight = promise;
    return promise;
}

/* Selection for the CURRENT stamp without scheduling anything (shared by
   peekRecallSelection and awaitFreshRecall). */
function currentSelection(staleReason) {
    if (!canRun()) return { ids: [], mode: 'off', fallbackReason: 'retrieval disabled' };
    const context = hook('getContext');
    const state = hook('loadState');
    const stamp = computeStamp(context, state);
    if (runtime.recall.stamp && runtime.recall.stamp === stamp) {
        return { ids: [...runtime.recall.ids], mode: runtime.recall.mode === 'vector' ? 'hybrid' : 'lexical', fallbackReason: '' };
    }
    return { ids: [], mode: 'lexical', fallbackReason: staleReason };
}

const AWAIT_RECALL_MAX_MS = 10000;

/* v0.9: bounded wait for a FRESH recall cache (generate-interceptor path —
 * the one sanctioned await before prompt assembly; getRecallSelection stays
 * the sync, never-awaiting path). Resolves with a getRecallSelection()-
 * shaped value `{ ids, mode, fallbackReason }` when:
 *  - the cache is already fresh for the current stamp (immediately), or
 *  - the query for the current stamp finished, or
 *  - `deadlineMs` passed (lexical fallback, reason 'recall wait deadline').
 * Single-flight: an in-flight query for the current stamp is joined; one
 * for an OLDER stamp is awaited and then ONE query for the current stamp
 * starts; a stamp that was already queried is never queried again by this
 * function (no two queries for the same stamp). Never rejects. */
export function awaitFreshRecall(deadlineMs = getWaitBudgetMs()) {
    if (!canRun()) return Promise.resolve(currentSelection('retrieval disabled'));
    const budget = Math.max(0, Math.min(AWAIT_RECALL_MAX_MS, Math.round(Number(deadlineMs)) || 0));
    const currentStamp = () => computeStamp(hook('getContext'), hook('loadState'));
    const fresh = () => Boolean(runtime.recall.stamp) && runtime.recall.stamp === currentStamp();
    if (fresh()) return Promise.resolve(currentSelection(''));

    const ensureQuery = () => {
        const stamp = currentStamp();
        if (runtime.inflight && runtime.inflightStamp === stamp) return runtime.inflight;
        if (runtime.inflight) {
            /* Older-stamp query in flight: wait for it, then (re)check. */
            return runtime.inflight.then(() => (fresh() ? undefined : ensureQuery()));
        }
        if (runtime.lastQueriedStamp === stamp) return Promise.resolve();
        return refreshRecall();
    };

    return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const finish = (reason) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(currentSelection(reason));
        };
        timer = setTimeout(() => finish('recall wait deadline passed — lexical fallback'), budget);
        Promise.resolve()
            .then(ensureQuery)
            .catch(() => undefined)
            .then(() => finish('recall cache stale after refresh'));
    });
}

/* Synchronous selection for the generation path. Vector hits are returned
   only when the cache stamp still matches the live context — otherwise the
   caller falls back to lexical/mention selection and a background refresh
   is scheduled. */
export function getRecallSelection() {
    if (!canRun()) return { ids: [], mode: 'off', fallbackReason: 'retrieval disabled' };
    const context = hook('getContext');
    const state = hook('loadState');
    const stamp = computeStamp(context, state);
    if (runtime.recall.stamp && runtime.recall.stamp === stamp) {
        return { ids: [...runtime.recall.ids], mode: runtime.recall.mode === 'vector' ? 'hybrid' : 'lexical', fallbackReason: '' };
    }
    void refreshRecall();
    return { ids: [], mode: 'lexical', fallbackReason: 'recall cache stale — refresh scheduled' };
}

/* v0.8: READ-ONLY twin of getRecallSelection for the dashboard preview —
   same return shape, but it NEVER schedules a refresh (opening the "Trong
   prompt" tab must not fire vector queries). */
export function peekRecallSelection() {
    if (!canRun()) return { ids: [], mode: 'off', fallbackReason: 'retrieval disabled' };
    const context = hook('getContext');
    const state = hook('loadState');
    const stamp = computeStamp(context, state);
    if (runtime.recall.stamp && runtime.recall.stamp === stamp) {
        return { ids: [...runtime.recall.ids], mode: runtime.recall.mode === 'vector' ? 'hybrid' : 'lexical', fallbackReason: '' };
    }
    return { ids: [], mode: 'lexical', fallbackReason: 'recall cache stale (preview — no refresh)' };
}

export function initRetriever(hooks) {
    /* v0.6.0 (S6): idempotent — a re-init must not inherit the previous
       lifecycle's in-flight bookkeeping, and status starts at 'idle' so
       retrievalStatus() never reports undefined. */
    runtime.hooks = hooks;
    runtime.ready = true;
    runtime.createClient = typeof hooks?.createClient === 'function' ? hooks.createClient : null;
    runtime.recall = { ids: [], stamp: '', hits: 0, at: 0, mode: 'off', queryText: '' };
    runtime.inflight = null;
    runtime.inflightStamp = '';
    runtime.lastQueriedStamp = '';
    runtime.syncInFlight = false;
    runtime.syncDirty = false;
    runtime.status = 'idle';
    runtime.epoch += 1;
}

/* v0.6.0 (P4): trailing debounce for the chatty bus events — memory edits
 * used to fire a full sync per mutation. A pending timer merges everything;
 * `vindex rebuild` still calls syncIndex({force:true}) directly. */
const SYNC_DEBOUNCE_MS = 300;
let syncDebounceTimer = null;

export function scheduleSync() {
    if (syncDebounceTimer) return;
    syncDebounceTimer = setTimeout(() => {
        syncDebounceTimer = null;
        void syncIndex();
    }, SYNC_DEBOUNCE_MS);
}

export function isRetrievalEnabled() {
    const settings = hook('getSettings') ?? {};
    return Boolean(settings.enabled && settings.retrieval?.enabled);
}

/* Current recall validity stamp — consumers (API envelope) surface it so a
   stale cache is visible instead of silent. */
export function getRecallStamp() {
    if (!runtime.ready) return '';
    const context = hook('getContext');
    const state = hook('loadState');
    return computeStamp(context, state);
}

export function getWaitBudgetMs() {
    const settings = hook('getSettings') ?? {};
    return Math.max(0, Math.min(2000, Math.round(Number(settings.retrieval?.waitBudgetMs)) || 400));
}

export { embeddingKeyFor };
