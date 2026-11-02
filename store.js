/* Memory Weaver — Copyright (C) 2026 kdturtle — GPL-3.0, see LICENSE. */
/* PURE module — the only intra-extension import is recall-core (also pure). */
import { findNearDuplicate, foundationIdsFor, prepareNearDuplicateSide, preparedSidesNearDuplicate } from './recall-core.js';

export const STORE_VERSION = 2;
export const STATE_VARIABLE = 'memoryWeaverState';
export const DEFAULT_MAX_ENTRIES = 150;
const CHARS_PER_TOKEN = 4;
export const PREFIX_BLOCK_SIZE = 50;
/* v0.6.0 (F4): near-dedupe similarity floor (constant, not a setting). */
export const NEAR_DUPE_THRESHOLD = 0.82;

/* v0.6.0 (P7): deep-default IN PLACE and return the SAME reference — the
 * settings object identity stays stable across calls (the old Object.assign
 * built a fresh object on every read). Missing keys are added; nested
 * default groups (retrieval, …) are deep-defaulted the same way; existing
 * user values are never overwritten. */
export function applyDefaultSettings(target, defaults) {
    const base = target && typeof target === 'object' && !Array.isArray(target) ? target : {};
    for (const [key, value] of Object.entries(defaults ?? {})) {
        if (base[key] === undefined) {
            base[key] = (value && typeof value === 'object' && !Array.isArray(value)) ? structuredClone(value) : value;
        } else if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
            applyDefaultSettings(base[key], value);
        }
    }
    return base;
}

/* v0.6.0 (P9): cumulative counted-message prefix — prefix[i] = number of
 * counted messages in chat[0..i). The counted ordinal "từ tin #N" of a raw
 * index i is prefix[i]; covered/pending progress reads are O(1) lookups
 * instead of an O(n) rescan per row. */
export function countedPrefixArray(chat, isCounted = null) {
    const list = Array.isArray(chat) ? chat : [];
    const predicate = typeof isCounted === 'function' ? isCounted : (message => isCountedChatMessage(message));
    const prefix = new Array(list.length + 1);
    prefix[0] = 0;
    for (let i = 0; i < list.length; i++) {
        prefix[i + 1] = prefix[i] + (predicate(list[i]) ? 1 : 0);
    }
    return prefix;
}
/* Coverage statuses (R1): 'ok' = digests match the last commit;
   'needs_review' = a source change below the cursor was detected (or the
   cursor overshoots the chat); 'legacy_unverified' = coverage predates
   fingerprinting and is NOT declared verified. */
export const PROCESSING_STATUS = { OK: 'ok', NEEDS_REVIEW: 'needs_review', LEGACY_UNVERIFIED: 'legacy_unverified' };

function makeId() {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function clampImportance(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 2;
    return Math.min(3, Math.max(1, Math.round(num)));
}

function sanitizeEntities(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const cleaned = [];
    for (const item of list) {
        /* v0.6.5: NFC — Vietnamese Unikey "tổ hợp" input produces NFD; the same
           visible name must be ONE tag. */
        const name = String(item ?? '').normalize('NFC').trim().slice(0, 60);
        if (name && !cleaned.includes(name)) cleaned.push(name);
        if (cleaned.length >= 8) break;
    }
    return cleaned;
}

/* v0.6.5: NFC-normalized (NFD "tổ hợp" input must dedupe against the NFC
 * form of the same fact). Exported so validatePatch compares exactly what
 * applyPatch stores. */
export function cleanText(value, maxLength = 500) {
    return String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/* v0.9 retention v2 — transient-line heuristic: scene/mood snapshots and
 * stat deltas ("Mood 70→78") are the first things a full store can lose.
 * A prefix match only counts for importance < 3 (a core line that merely
 * starts with "Tâm trạng" is not trivia).
 * v0.9.1 (audit3 #5): the numeric delta rule ALSO requires importance < 3
 * AND a stat/mood-ish keyword or a short line (≤ TRANSIENT_SHORT_LINE
 * chars) — "Rika lên lớp 11 -> 12 và chuyển trường sang Tokyo" (imp 3, a
 * life event) is NOT trivia. */
const TRANSIENT_PREFIX = /^(Cảnh hiện tại|Current scene|Mood|Tâm trạng)\b/i;
const TRANSIENT_DELTA = /\d+(?:[.,]\d+)?\s*(?:→|->)\s*\d+/;
const TRANSIENT_STAT_KEYWORD = /(?<![\p{L}\p{N}])(mood|tâm trạng|điểm|hp|mp|affection|thiện cảm|trust|tin tưởng)(?![\p{L}\p{N}])/iu;
export const TRANSIENT_SHORT_LINE = 40;
export const RETENTION_IMPORTANCE3_SHARE = 0.25;
export const RETENTION_FOUNDATION_LIMIT = 10;

export function isTransientEntry(entry) {
    const text = String(entry?.text ?? '').normalize('NFC').trim();
    if (!text) return false;
    if (clampImportance(entry?.importance) >= 3) return false;
    if (TRANSIENT_DELTA.test(text) && (TRANSIENT_STAT_KEYWORD.test(text) || text.length <= TRANSIENT_SHORT_LINE)) return true;
    return TRANSIENT_PREFIX.test(text);
}

/* v0.9.1 (audit3 #9): the greedy near-duplicate scan of planRetention step
 * (a) — same result as the naive `keepers.some(near)` loop (the FIRST
 * matching keeper in keeper order is reported), without paying the full
 * predicate for every pair. An inverted token index counts the exact
 * overlap |X∩K| against every keeper that shares a token (integer
 * increments only); the predicate (Jaccard ≥ T or containment ≥ 0.9,
 * T = NEAR_DUPE_THRESHOLD) implies |X∩K| ≥ ceil(T·min(|X|,|K|)), so only
 * keepers meeting that bound are tested. The filter only skips pairs the
 * predicate would reject → results are byte-identical to the all-pairs
 * scan, so no early stop (which would change WHICH duplicates go) is
 * needed: 500 entries / 1 eviction runs in a few ms.
 * Returns `[{ entry, keeper }]` in keeper order (keeper = the entry it
 * duplicates). Protected entries are always keepers. */
function scanNearDuplicates(keeperOrder, isProtected) {
    const tokenIds = new Map();
    const sides = keeperOrder.map(entry => {
        const side = prepareNearDuplicateSide(entry.text, entry.entities);
        const ids = [];
        for (const token of side.tokens) {
            let id = tokenIds.get(token);
            if (id === undefined) {
                id = tokenIds.size;
                tokenIds.set(token, id);
            }
            ids.push(id);
        }
        return { side, ids };
    });
    const postings = Array.from({ length: tokenIds.size }, () => []);
    const counts = new Int32Array(keeperOrder.length);
    const keepers = []; // slot → { side, size, entry }
    const duplicates = [];
    keeperOrder.forEach((entry, i) => {
        const { side, ids } = sides[i];
        const size = ids.length;
        let match = null;
        if (size && !isProtected(entry)) {
            const touched = [];
            for (let t = 0; t < size; t++) {
                const list = postings[ids[t]];
                for (let p = 0; p < list.length; p++) {
                    const slot = list[p];
                    if (counts[slot] === 0) touched.push(slot);
                    counts[slot] += 1;
                }
            }
            const viable = [];
            for (const slot of touched) {
                const need = Math.max(1, Math.ceil(NEAR_DUPE_THRESHOLD * Math.min(size, keepers[slot].size) - 1e-9));
                if (counts[slot] >= need) viable.push(slot);
                counts[slot] = 0;
            }
            viable.sort((a, b) => a - b);
            for (const slot of viable) {
                if (preparedSidesNearDuplicate(side, keepers[slot].side, NEAR_DUPE_THRESHOLD)) {
                    match = keepers[slot].entry;
                    break;
                }
            }
        }
        if (match) {
            duplicates.push({ entry, keeper: match });
            return;
        }
        const slot = keepers.length;
        keepers.push({ side, size, entry });
        for (const id of ids) postings[id].push(slot);
    });
    return duplicates;
}

/* Write-time retention plan. Returns `{ kept, evicted, reasons }` —
 * `reasons[id]` ∈ 'near_duplicate' | 'transient' | 'rank' (additive).
 * Protections (unchanged): locked/pinned entries are never evicted (the
 * store may sit over cap — `overCap` flags it). v0.9 eviction order when
 * over cap:
 *  (a) near-duplicates of a KEPT entry (recall-core predicate, threshold
 *      NEAR_DUPE_THRESHOLD; keeper preference = protected → importance desc →
 *      LONGER text → newer createdAt (v0.9.1 — the fuller phrasing wins);
 *      prefix-filtered scan, identical to the all-pairs loop);
 *  (b) transient lines (isTransientEntry), importance asc → createdAt asc;
 *  (c) the legacy ranking (importance asc → createdAt asc) where foundation
 *      ids (recall-core.foundationIdsFor, oldest USER/char-tagged, limit 10)
 *      go LAST, and importance inflation is dampened: when importance-3
 *      entries exceed 25% of the store, the OLDEST importance-3 entries
 *      beyond that share rank as importance 2; the surviving keeper of a
 *      duplicate evicted in (a) ranks after its importance peers (v0.9.1).
 * With no duplicates, no transient lines, no foundation tags and ≤25% core
 * the order is byte-identical to the pre-v0.9 algorithm. Kept order
 * preserves the original array (the fingerprint is order-sensitive). */
export function planRetention(entries, maxEntries = DEFAULT_MAX_ENTRIES, { charName = '' } = {}) {
    const list = Array.isArray(entries) ? entries.filter(entry => entry && entry.text) : [];
    const cap = Math.max(1, Number(maxEntries) || DEFAULT_MAX_ENTRIES);
    if (list.length <= cap) return { kept: list, evicted: [], reasons: {} };
    /* v0.6.0 (F5a) / v0.8: LOCKED and PINNED entries are never evicted. */
    const isProtected = entry => entry.locked === true || entry.pinned === true;
    const pool = list.filter(entry => !isProtected(entry));
    if (!pool.length) return { kept: list, evicted: [], reasons: {} };
    const evictCount = Math.min(list.length - cap, pool.length);
    const chosen = [];
    const chosenSet = new Set();
    const reasons = {};
    const take = (entry, reason) => {
        if (chosen.length >= evictCount || chosenSet.has(entry)) return;
        chosen.push(entry);
        chosenSet.add(entry);
        reasons[String(entry.id)] = reason;
    };
    const byOldRank = (a, b) => (clampImportance(a.importance) - clampImportance(b.importance)) || String(a.createdAt).localeCompare(String(b.createdAt));

    /* (a) near-duplicates of a kept entry. Greedy over the keeper order: an
       entry joins the keeper set unless it duplicates one already there.
       v0.9.1 (audit3 #4): keeper preference = protected → importance desc →
       LONGER text (the fuller phrasing — usually a token superset of the
       short one) → newer createdAt → original index. */
    const keeperOrder = list
        .map((entry, index) => ({ entry, index }))
        .sort((x, y) => {
            const a = x.entry;
            const b = y.entry;
            const pa = isProtected(a) ? 1 : 0;
            const pb = isProtected(b) ? 1 : 0;
            return (pb - pa)
                || (clampImportance(b.importance) - clampImportance(a.importance))
                || (String(b.text).length - String(a.text).length)
                || String(b.createdAt).localeCompare(String(a.createdAt))
                || (x.index - y.index);
        })
        .map(item => item.entry);
    const duplicates = scanNearDuplicates(keeperOrder, isProtected);
    /* Worst duplicate first (reverse keeper preference). */
    const evictedDuplicateKeepers = new Set();
    for (const { entry, keeper } of duplicates.reverse()) {
        take(entry, 'near_duplicate');
        if (chosenSet.has(entry)) evictedDuplicateKeepers.add(keeper);
    }

    /* (b) transient lines. */
    if (chosen.length < evictCount) {
        const transient = pool.filter(entry => !chosenSet.has(entry) && isTransientEntry(entry)).sort(byOldRank);
        for (const entry of transient) take(entry, 'transient');
    }

    /* (c) legacy ranking with foundation protection + importance dampening. */
    if (chosen.length < evictCount) {
        const foundation = new Set(foundationIdsFor(list, { charName, limit: RETENTION_FOUNDATION_LIMIT }));
        const core = list.filter(entry => clampImportance(entry.importance) >= 3)
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        const allowed = Math.floor(list.length * RETENTION_IMPORTANCE3_SHARE);
        const dampened = new Set(core.length > allowed ? core.slice(allowed) : []);
        const rankOf = entry => (dampened.has(entry) ? 2 : clampImportance(entry.importance));
        /* v0.9.1 (audit3 r3): the surviving keeper of an evicted duplicate
           ranks AFTER its importance peers — evicting both copies of a fact
           while keeping same-rank trivia lost the fact entirely. */
        const keeperFlag = entry => (evictedDuplicateKeepers.has(entry) ? 1 : 0);
        const rest = pool
            .filter(entry => !chosenSet.has(entry))
            .map((entry, index) => ({ entry, index }))
            .sort((x, y) => {
                const fa = foundation.has(String(x.entry.id)) ? 1 : 0;
                const fb = foundation.has(String(y.entry.id)) ? 1 : 0;
                return (fa - fb)
                    || (rankOf(x.entry) - rankOf(y.entry))
                    || (keeperFlag(x.entry) - keeperFlag(y.entry))
                    || String(x.entry.createdAt).localeCompare(String(y.entry.createdAt))
                    || (x.index - y.index);
            });
        for (const item of rest) take(item.entry, 'rank');
    }

    /* Evict by object identity — duplicate ids can never remove more than
       intended. */
    return {
        kept: list.filter(entry => !chosenSet.has(entry)),
        evicted: chosen,
        reasons,
    };
}

export function evictEntries(entries, maxEntries = DEFAULT_MAX_ENTRIES) {
    return planRetention(entries, maxEntries).kept;
}

/* Vector index MANIFEST (P2.2) — bookkeeping only, never float arrays: the
   vectors themselves live server-side under a chat-scoped collection and are
   rebuildable from the entries. documents = entryId → { hash (numeric, what
   the server knows), digest (payload version last verified) }. */
function normalizeVectorMeta(raw) {
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const documents = {};
    if (data.documents && typeof data.documents === 'object' && !Array.isArray(data.documents)) {
        for (const [id, doc] of Object.entries(data.documents)) {
            const hash = Math.floor(Number(doc?.hash));
            const digest = String(doc?.digest ?? '');
            if (!id || id.length > 32 || !Number.isFinite(hash) || hash <= 0 || !/^[0-9a-f]{8,16}$/.test(digest)) continue;
            documents[id] = { hash, digest };
        }
    }
    return {
        schema: Number(data.schema) === 1 ? 1 : 1,
        boundScope: typeof data.boundScope === 'string' ? data.boundScope.slice(0, 200) : '',
        indexId: typeof data.indexId === 'string' ? data.indexId.slice(0, 32) : '',
        embeddingKey: typeof data.embeddingKey === 'string' ? data.embeddingKey.slice(0, 120) : '',
        syncedAt: typeof data.syncedAt === 'string' ? data.syncedAt : null,
        documents,
    };
}

/* v0.6.0 (F1): oversized messages the user chose to skip — idempotent,
   capped, deduped by rawIndex (same sanitize spirit as blocked). */
function sanitizeSkippedList(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    for (const item of list) {
        const rawIndex = Math.max(0, Math.floor(Number(item?.rawIndex)) || 0);
        if (out.some(existing => existing.rawIndex === rawIndex)) continue;
        out.push({ rawIndex, reason: String(item?.reason ?? 'oversized_message').slice(0, 60) });
        if (out.length >= 20) break;
    }
    return out;
}

function normalizeProcessing(raw, entryCount, cursor) {
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!data) {
        /* v1 → v2 migration (additive, idempotent): coverage claimed by the
           old cursor was written by code that could not detect source
           changes — it is flagged legacy_unverified instead of silently
           declared verified. An empty fresh store is just 'ok'. */
        const status = (entryCount > 0 || cursor > 0) ? PROCESSING_STATUS.LEGACY_UNVERIFIED : PROCESSING_STATUS.OK;
        return { schema: 1, policyVersion: 1, status, prefixBlocks: { size: PREFIX_BLOCK_SIZE, digests: [] }, dirtyFrom: null, blocked: null, skipped: [], shrunkTo: null };
    }
    const status = [PROCESSING_STATUS.OK, PROCESSING_STATUS.NEEDS_REVIEW, PROCESSING_STATUS.LEGACY_UNVERIFIED].includes(data.status)
        ? data.status
        : PROCESSING_STATUS.LEGACY_UNVERIFIED;
    const rawBlocks = data.prefixBlocks && typeof data.prefixBlocks === 'object' && !Array.isArray(data.prefixBlocks) ? data.prefixBlocks : {};
    return {
        schema: Number(data.schema) === 1 ? 1 : 1,
        policyVersion: Math.max(1, Math.floor(Number(data.policyVersion)) || 1),
        status,
        prefixBlocks: {
            size: Math.max(1, Math.floor(Number(rawBlocks.size)) || PREFIX_BLOCK_SIZE),
            digests: Array.isArray(rawBlocks.digests) ? rawBlocks.digests.map(digest => String(digest ?? '').slice(0, 32)).filter(Boolean) : [],
        },
        dirtyFrom: (data.dirtyFrom === null || data.dirtyFrom === undefined) ? null : Math.max(0, Math.floor(Number(data.dirtyFrom)) || 0),
        blocked: data.blocked && typeof data.blocked === 'object' && !Array.isArray(data.blocked)
            ? {
                rawIndex: Math.max(0, Math.floor(Number(data.blocked.rawIndex)) || 0),
                reason: String(data.blocked.reason ?? '').slice(0, 200),
            }
            : null,
        skipped: sanitizeSkippedList(data.skipped),
        /* v0.8: shortest chat length seen while the cursor sat past the end
           (history deleted after processing) — index.js reassess sets it,
           the acknowledge path pulls the cursor back to it, a completed
           review clears it. Additive: absent/invalid → null. */
        shrunkTo: nonNegativeIntOrNull(data.shrunkTo),
    };
}

function nonNegativeIntOrNull(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? Math.floor(num) : null;
}

function normalizeLastResult(raw) {
    const added = Math.max(0, Math.floor(Number(raw.added)) || 0);
    const updated = Math.max(0, Math.floor(Number(raw.updated)) || 0);
    const deleted = Math.max(0, Math.floor(Number(raw.deleted)) || 0);
    const outcome = ['changed', 'no_change', 'deduped', 'conflict', 'failed', 'blocked'].includes(raw.outcome)
        ? raw.outcome
        /* Legacy (v0.4.1) states never stored an explicit outcome: a
           non-empty result meant success (coverage committed), an all-zero
           result was the "empty patch" failure path (cursor kept). */
        : ((added || updated || deleted) ? 'changed' : 'failed');
    const rawRange = raw.sourceRange && typeof raw.sourceRange === 'object' && !Array.isArray(raw.sourceRange) ? raw.sourceRange : null;
    const sourceRange = rawRange
        ? { start: Math.max(0, Math.floor(Number(rawRange.start)) || 0), end: Math.max(0, Math.floor(Number(rawRange.end)) || 0) }
        : null;
    return {
        at: typeof raw.at === 'string' ? raw.at : null,
        added,
        updated,
        deleted,
        outcome,
        sourceRange,
        /* Legacy fallback keeps the honest reading of what v0.4.1 did. */
        coverageCommitted: raw.coverageCommitted === undefined ? outcome === 'changed' : raw.coverageCommitted === true,
        jobId: typeof raw.jobId === 'string' ? raw.jobId.slice(0, 64) : null,
        /* v0.5.1: why a failed/conflict run failed — the runner persists the
           first error string so the dashboard can show the reason instead of
           a bare "THẤT BẠI". Null for successful/neutral outcomes. */
        error: typeof raw.error === 'string' && raw.error.trim() ? raw.error.trim().slice(0, 300) : null,
        /* v0.5.1: 'manual' | 'auto' | null — which kind of run produced it.
           v0.9: + 'consolidate' (AI merge/cleanup pass). */
        source: RUN_SOURCES.includes(raw.source) ? raw.source : null,
        /* v0.6.0 (F5a): how many patch ops were dropped because they touched
           a locked entry (0 = none). Additive; legacy results read 0. */
        protectedSkipped: Math.max(0, Math.floor(Number(raw.protectedSkipped)) || 0),
        /* v0.6.0 (U6a): execution record — additive, null on legacy results. */
        model: typeof raw.model === 'string' && raw.model ? raw.model.slice(0, 120) : null,
        api: typeof raw.api === 'string' && raw.api ? raw.api.slice(0, 60) : null,
        /* v0.9.1 (audit3 #8): null stays null (Number(null) === 0 made
           normalize non-idempotent) — same helper as the runLog records. */
        durationMs: tokensOrNull(raw.durationMs),
        estInputTokens: tokensOrNull(raw.estInputTokens),
        estOutputChars: tokensOrNull(raw.estOutputChars),
        estOutputTokens: tokensOrNull(raw.estOutputTokens),
        stopReason: typeof raw.stopReason === 'string' && raw.stopReason ? raw.stopReason.slice(0, 40) : null,
        /* v0.6.0 (S8): schedule auto op tallies — additive, 0 on legacy. */
        scheduleAdded: Math.max(0, Math.floor(Number(raw.scheduleAdded)) || 0),
        scheduleResolved: Math.max(0, Math.floor(Number(raw.scheduleResolved)) || 0),
        scheduleIgnored: Math.max(0, Math.floor(Number(raw.scheduleIgnored)) || 0),
        scheduleDropped: Math.max(0, Math.floor(Number(raw.scheduleDropped)) || 0),
        /* v0.8: planner honesty flags (additive; legacy → false/0). */
        floorApplied: raw.floorApplied === true,
        existingOverBudget: raw.existingOverBudget === true,
        existingTrimmed: Math.max(0, Math.floor(Number(raw.existingTrimmed)) || 0),
    };
}

function tokensOrNull(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : null;
}

/* v0.6.5: run history — newest first, capped. Compact records derived from
 * lastResult; NOT part of the canonical entries fingerprint (a run record
 * never bumps memoryRevision). */
export const RUN_LOG_MAX = 10;
const RUN_LOG_OUTCOMES = ['changed', 'no_change', 'deduped', 'conflict', 'failed', 'blocked'];
/* v0.9: run sources ('consolidate' = AI merge/cleanup pass). */
export const RUN_SOURCES = Object.freeze(['manual', 'auto', 'consolidate']);
/* v0.9 run diff — v0.9.1 (audit3 #1/#2) retention is per BURST: the runner
   stamps one `runId` (8 hex) on every record of a runBurst /
   runConsolidation / runReviewFrom invocation; a legacy record without
   runId is its own group. `changes` survives on ALL records of the newest
   RUN_CHANGES_KEEP groups that carry a diff, while the serialized total of
   the kept diffs stays ≤ RUN_CHANGES_TOTAL_MAX_CHARS (the OLDEST kept group
   is dropped first; the newest group is never dropped by the total cap —
   each of its records is bounded by the per-record share). A record whose
   diff does not fit its share RUN_CHANGES_MAX_CHARS keeps NO partial diff:
   `changes = { truncated: true, undoable: false }` (a partial diff that
   kept updates but dropped deletes made undo lose data). */
export const RUN_CHANGES_KEEP = 3;
export const RUN_CHANGES_MAX_CHARS = 8000;
export const RUN_CHANGES_TOTAL_MAX_CHARS = 24000;
const RUN_ID_PATTERN = /^[0-9a-f]{8}$/;
const TRUNCATED_CHANGES = Object.freeze({ truncated: true, undoable: false });

function changeSnapshot(raw) {
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        text: cleanText(data.text),
        entities: sanitizeEntities(data.entities),
        importance: clampImportance(data.importance),
    };
}

function changeEntryClone(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 16) : '';
    const text = cleanText(raw.text);
    if (!id || !text) return null;
    return {
        id,
        entities: sanitizeEntities(raw.entities),
        text,
        importance: clampImportance(raw.importance),
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
        fromMessage: normalizeFromMessage(raw.fromMessage),
        source: raw.source === 'manual' ? 'manual' : raw.source === 'schedule' ? 'schedule' : 'auto',
        ...(raw.locked === true ? { locked: true } : {}),
        ...(raw.pinned === true ? { pinned: true } : {}),
        ...(nonNegativeIntOrNull(raw.sourceStart) !== null ? { sourceStart: nonNegativeIntOrNull(raw.sourceStart) } : {}),
        ...(raw.fromScheduleId ? { fromScheduleId: String(raw.fromScheduleId).slice(0, 16) } : {}),
    };
}

/* Normalizes a run `changes` record: `{ added: [id], addedTexts: [text]
 * (parallel to added — the revert's "unchanged since" check), updated:
 * [{ id, before, after }], deleted: [fullEntryClone] }` — or the marker
 * `{ truncated: true, undoable: false }` (v0.9.1: ANY truncated input —
 * including a v0.9.0 partial diff — becomes the marker; a partial diff is
 * never undoable). Returns null for absent/invalid input. */
export function normalizeRunChanges(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.truncated === true || raw.undoable === false) return { ...TRUNCATED_CHANGES };
    const added = [];
    const addedTexts = [];
    const rawAdded = Array.isArray(raw.added) ? raw.added : [];
    const rawAddedTexts = Array.isArray(raw.addedTexts) ? raw.addedTexts : [];
    rawAdded.forEach((id, i) => {
        const key = typeof id === 'string' ? id.slice(0, 16) : '';
        if (!key) return;
        added.push(key);
        addedTexts.push(cleanText(rawAddedTexts[i]));
    });
    const updated = (Array.isArray(raw.updated) ? raw.updated : [])
        .filter(item => item && typeof item === 'object' && typeof item.id === 'string' && item.id)
        .map(item => ({ id: item.id.slice(0, 16), before: changeSnapshot(item.before), after: changeSnapshot(item.after) }));
    const deleted = (Array.isArray(raw.deleted) ? raw.deleted : []).map(changeEntryClone).filter(Boolean);
    return { added, addedTexts, updated, deleted };
}

/* false for the "too large to undo" marker (and for unusable input). */
export function isUndoableChanges(changes) {
    const normalized = normalizeRunChanges(changes);
    return Boolean(normalized) && normalized.undoable !== false;
}

/* v0.9.1: ALL-OR-NOTHING — the complete diff when it serializes within
 * `maxChars`, else the `{ truncated: true, undoable: false }` marker. Never
 * a partial list (dropping `deleted` while keeping updates made undo lose
 * every merged-away memory). */
export function compactRunChanges(changes, maxChars = RUN_CHANGES_MAX_CHARS) {
    const normalized = normalizeRunChanges(changes);
    if (!normalized) return null;
    if (normalized.undoable === false) return normalized;
    return JSON.stringify(normalized).length <= maxChars ? normalized : { ...TRUNCATED_CHANGES };
}

/* Diff of the entries before/after one commit (call inside the mutator):
 * `before` = a snapshot (array clone) taken BEFORE the mutation, `after` =
 * the live entries after it. Added = new ids, updated = same id with a
 * different text/entities/importance, deleted = ids gone (patch deletes AND
 * write-time evictions — undoing the run must restore both). */
export function captureRunChanges(before, after) {
    const prev = new Map((Array.isArray(before) ? before : []).filter(entry => entry && entry.id).map(entry => [String(entry.id), entry]));
    const next = new Map((Array.isArray(after) ? after : []).filter(entry => entry && entry.id).map(entry => [String(entry.id), entry]));
    const changes = { added: [], addedTexts: [], updated: [], deleted: [] };
    for (const [id, entry] of next) {
        const old = prev.get(id);
        if (!old) {
            changes.added.push(id);
            changes.addedTexts.push(cleanText(entry.text));
            continue;
        }
        const a = changeSnapshot(old);
        const b = changeSnapshot(entry);
        if (a.text !== b.text || a.importance !== b.importance || a.entities.join('\u0001') !== b.entities.join('\u0001')) {
            changes.updated.push({ id, before: a, after: b });
        }
    }
    for (const [id, entry] of prev) {
        if (!next.has(id)) {
            const clone = changeEntryClone(entry);
            if (clone) changes.deleted.push(clone);
        }
    }
    return changes;
}

export function makeRunLogRecord(raw) {
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const rawRange = data.sourceRange && typeof data.sourceRange === 'object' && !Array.isArray(data.sourceRange) ? data.sourceRange : null;
    const changes = normalizeRunChanges(data.changes);
    const memoryEpoch = nonNegativeIntOrNull(data.memoryEpoch);
    return {
        at: typeof data.at === 'string' ? data.at : null,
        outcome: RUN_LOG_OUTCOMES.includes(data.outcome) ? data.outcome : 'failed',
        added: Math.max(0, Math.floor(Number(data.added)) || 0),
        updated: Math.max(0, Math.floor(Number(data.updated)) || 0),
        deleted: Math.max(0, Math.floor(Number(data.deleted)) || 0),
        source: RUN_SOURCES.includes(data.source) ? data.source : null,
        /* v0.9 (additive, present only when set): job id (revert lookup),
           run diff, reverted marker. v0.9.1: runId (burst group, 8 hex) and
           memoryEpoch (state.memoryEpoch at commit — undo after a wipe is
           refused). */
        ...(typeof data.jobId === 'string' && data.jobId ? { jobId: data.jobId.slice(0, 64) } : {}),
        ...(typeof data.runId === 'string' && RUN_ID_PATTERN.test(data.runId) ? { runId: data.runId } : {}),
        ...(memoryEpoch !== null ? { memoryEpoch } : {}),
        ...(changes ? { changes } : {}),
        ...(data.reverted === true ? { reverted: true } : {}),
        sourceRange: rawRange
            ? { start: Math.max(0, Math.floor(Number(rawRange.start)) || 0), end: Math.max(0, Math.floor(Number(rawRange.end)) || 0) }
            : null,
        error: typeof data.error === 'string' && data.error.trim() ? data.error.trim().slice(0, 300) : null,
        model: typeof data.model === 'string' && data.model ? data.model.slice(0, 120) : null,
        durationMs: tokensOrNull(data.durationMs),
        /* v0.8: estimate + planner flags per run (additive; legacy → null/false/0). */
        estInputTokens: tokensOrNull(data.estInputTokens),
        estOutputTokens: tokensOrNull(data.estOutputTokens),
        floorApplied: data.floorApplied === true,
        existingOverBudget: data.existingOverBudget === true,
        existingTrimmed: Math.max(0, Math.floor(Number(data.existingTrimmed)) || 0),
    };
}

/* v0.9.1: run-diff retention per runId group (see RUN_CHANGES_KEEP). Groups
   are counted only when they carry a diff (a failed/neutral run never
   pushes an older undoable burst out). */
function retainRunChanges(records) {
    const groupOf = (record, index) => (record.runId ? `r:${record.runId}` : `i:${index}`);
    const order = [];
    const sizes = new Map();
    records.forEach((record, index) => {
        if (!record.changes) return;
        const key = groupOf(record, index);
        if (!sizes.has(key)) {
            order.push(key);
            sizes.set(key, 0);
        }
        sizes.set(key, sizes.get(key) + JSON.stringify(record.changes).length);
    });
    const keep = new Set();
    let total = 0;
    for (const key of order.slice(0, RUN_CHANGES_KEEP)) {
        total += sizes.get(key);
        if (keep.size && total > RUN_CHANGES_TOTAL_MAX_CHARS) break;
        keep.add(key);
    }
    return records.map((record, index) => {
        if (!record.changes || keep.has(groupOf(record, index))) return record;
        const { changes, ...rest } = record; // eslint-disable-line no-unused-vars
        return rest;
    });
}

export function normalizeRunLog(raw) {
    if (!Array.isArray(raw)) return [];
    return retainRunChanges(raw
        .filter(item => item && typeof item === 'object' && !Array.isArray(item))
        .slice(0, RUN_LOG_MAX)
        .map(makeRunLogRecord));
}

/* Prepends a compact record of `result` (a lastResult-shaped object) to
 * state.runLog (newest first, capped). Mutates `state`; returns the record.
 * `result.changes` (captureRunChanges shape) is kept complete or replaced
 * by the truncated marker (compactRunChanges); `result.runId` groups the
 * records of one burst; `memoryEpoch` defaults to state.memoryEpoch. */
export function pushRunLog(state, result) {
    const input = result && typeof result === 'object' ? result : {};
    const epoch = input.memoryEpoch !== undefined ? input.memoryEpoch : state?.memoryEpoch;
    const record = makeRunLogRecord({
        ...input,
        ...(input.changes ? { changes: compactRunChanges(input.changes) } : {}),
        memoryEpoch: epoch,
    });
    const current = normalizeRunLog(state?.runLog);
    state.runLog = retainRunChanges([record, ...current].slice(0, RUN_LOG_MAX));
    return state.runLog[0];
}

const sameEntities = (a, b) => sanitizeEntities(a).join('\u0001') === sanitizeEntities(b).join('\u0001');

/* v0.9.1 (audit3 #3): a record from before a memory wipe (state.memoryEpoch
 * moved on) is never undoable — restoring its deletes would resurrect wiped
 * memories. A legacy record without memoryEpoch only matches epoch 0. */
function runEpochMatches(state, record) {
    const live = Math.max(0, Math.floor(Number(state?.memoryEpoch)) || 0);
    const stamped = nonNegativeIntOrNull(record?.memoryEpoch);
    return (stamped === null ? 0 : stamped) === live;
}

function findLiveRunRecord(log, record) {
    if (log.includes(record)) return record;
    if (record && typeof record === 'object' && typeof record.jobId === 'string' && record.jobId) {
        return log.find(item => item?.jobId === record.jobId && (record.at === undefined || item.at === record.at)) ?? null;
    }
    return null;
}

/* v0.9 "Hoàn tác cả lượt": reverts one run record's `changes` on `state`
 * (MUTATES — call inside a commitMutation kind 'user' mutator). `record` is
 * a state.runLog member, or any object carrying the same jobId (+ at) — the
 * LIVE record is the one marked. Rules (never touches cursor/coverage):
 * - added ids are removed only while still unchanged since the run (text
 *   equals what was added) and not locked/pinned by the user;
 * - deleted entries are restored only when the id is absent and no entry
 *   carries the exact same text;
 * - updates are reverted to `before` only while text/entities/importance
 *   still equal `after` and the entry is not locked/pinned.
 * Everything else is `skipped`. The live record gets `reverted: true`.
 * Returns `{ ok, removed, restored, reverted, skipped, reason? }` —
 * reason ∈ 'not_found' | 'already_reverted' | 'epoch' (v0.9.1: memory wiped
 * since the run) | 'no_changes' | 'truncated' (v0.9.1: diff too large to
 * keep). A refusal never mutates `state`. */
export function revertRunChanges(state, record) {
    const result = { ok: false, removed: 0, restored: 0, reverted: 0, skipped: 0 };
    const log = Array.isArray(state?.runLog) ? state.runLog : [];
    const live = findLiveRunRecord(log, record);
    if (!live) return { ...result, reason: 'not_found' };
    if (live.reverted === true) return { ...result, reason: 'already_reverted' };
    if (!runEpochMatches(state, live)) return { ...result, reason: 'epoch' };
    const changes = normalizeRunChanges(live.changes);
    if (!changes) return { ...result, reason: 'no_changes' };
    if (changes.undoable === false) return { ...result, reason: 'truncated' };

    state.entries = Array.isArray(state.entries) ? state.entries : [];
    const isUserProtected = entry => entry.locked === true || entry.pinned === true;

    /* 1. Remove adds that are still exactly what the run added. */
    changes.added.forEach((id, i) => {
        const index = state.entries.findIndex(entry => entry && String(entry.id) === id);
        if (index < 0) { result.skipped += 1; return; }
        const entry = state.entries[index];
        const expected = changes.addedTexts[i];
        if (isUserProtected(entry) || !expected || cleanText(entry.text) !== expected) { result.skipped += 1; return; }
        state.entries.splice(index, 1);
        result.removed += 1;
    });

    /* 2. Revert updates still in their post-run form. */
    for (const change of changes.updated) {
        const entry = state.entries.find(item => item && String(item.id) === change.id);
        if (!entry || isUserProtected(entry)
            || cleanText(entry.text) !== change.after.text
            || clampImportance(entry.importance) !== change.after.importance
            || !sameEntities(entry.entities, change.after.entities)) {
            result.skipped += 1;
            continue;
        }
        entry.text = change.before.text;
        entry.entities = [...change.before.entities];
        entry.importance = change.before.importance;
        result.reverted += 1;
    }

    /* 3. Restore deleted entries (no id clash, no exact-text duplicate). */
    for (const clone of changes.deleted) {
        const text = clone.text.toLowerCase();
        const clash = state.entries.some(entry => entry && (String(entry.id) === clone.id || cleanText(entry.text).toLowerCase() === text));
        if (clash) { result.skipped += 1; continue; }
        state.entries.push({ ...clone, entities: [...clone.entities] });
        result.restored += 1;
    }

    live.reverted = true;
    result.ok = true;
    return result;
}

/* v0.9.1 (audit3 #2): reverts EVERY record of one burst (`runId`) as one
 * unit, newest record first (a later chunk's update of an earlier chunk's
 * add unwinds before the add is removed). Refuses ENTIRELY — nothing is
 * touched — when any member is already reverted, from another memory epoch,
 * or carries the truncated marker. Members without a diff (failures,
 * no_change) are ignored. Returns the aggregate
 * `{ ok, removed, restored, reverted, skipped, records, reason? }` —
 * reason ∈ 'not_found' | 'already_reverted' | 'epoch' | 'no_changes' |
 * 'truncated'. MUTATES — call inside a commitMutation kind 'user'. A burst
 * whose oldest records already rolled out of the RUN_LOG_MAX window
 * reverts only the members still in the log. */
export function revertRunGroup(state, runId) {
    const result = { ok: false, removed: 0, restored: 0, reverted: 0, skipped: 0, records: 0 };
    const id = typeof runId === 'string' ? runId : '';
    const log = Array.isArray(state?.runLog) ? state.runLog : [];
    const members = id ? log.filter(item => item && item.runId === id) : [];
    if (!members.length) return { ...result, reason: 'not_found' };
    if (members.some(item => item.reverted === true)) return { ...result, reason: 'already_reverted' };
    if (members.some(item => !runEpochMatches(state, item))) return { ...result, reason: 'epoch' };
    const withChanges = members.filter(item => normalizeRunChanges(item.changes));
    if (!withChanges.length) return { ...result, reason: 'no_changes' };
    if (withChanges.some(item => !isUndoableChanges(item.changes))) return { ...result, reason: 'truncated' };
    /* state.runLog is newest-first, so `withChanges` already is. */
    for (const member of withChanges) {
        const step = revertRunChanges(state, member);
        if (!step.ok) continue; // unreachable after the pre-checks above
        result.removed += step.removed;
        result.restored += step.restored;
        result.reverted += step.reverted;
        result.skipped += step.skipped;
        result.records += 1;
    }
    result.ok = true;
    return result;
}

/* Empty vector manifest (used by clearMemories): the manifest is derived
   bookkeeping for the (now empty) entries; the server collection rebuilds
   or gets diff-cleaned on the next sync. */
export function emptyVectorMeta() {
    return { schema: 1, boundScope: '', indexId: '', embeddingKey: '', syncedAt: null, documents: {} };
}

function normalizeFromMessage(value) {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : -1;
}

export function normalizeState(raw, maxEntries = DEFAULT_MAX_ENTRIES, scheduleCap = DEFAULT_MAX_SCHEDULE) {
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const entries = Array.isArray(data.entries)
        ? data.entries
              .map((entry) => ({
                  id: typeof entry?.id === 'string' && entry.id ? entry.id.slice(0, 16) : makeId(),
                  entities: sanitizeEntities(entry?.entities),
                  text: cleanText(entry?.text),
                  importance: clampImportance(entry?.importance),
                  createdAt: typeof entry?.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
                  /* v0.8: null/undefined stay null (Number(null) === 0 showed
                     "tin #1" for facts with no source message). */
                  fromMessage: normalizeFromMessage(entry?.fromMessage),
                  source: entry?.source === 'manual' ? 'manual' : entry?.source === 'schedule' ? 'schedule' : 'auto',
                  /* v0.6.0 (F5a): a locked entry is user-pinned — the model
                     cannot update/delete it and retention never evicts it. */
                  ...(entry?.locked === true ? { locked: true } : {}),
                  /* v0.8: "Ghim vào prompt" — always packed first into the
                     injection (own quota), never evicted. Never stripped. */
                  ...(entry?.pinned === true ? { pinned: true } : {}),
                  /* v0.8: raw chat index where the source chunk began
                     (additive; absent ≡ null — only a finite non-negative
                     int is kept). */
                  ...(nonNegativeIntOrNull(entry?.sourceStart) !== null ? { sourceStart: nonNegativeIntOrNull(entry.sourceStart) } : {}),
                  ...(entry?.fromScheduleId ? { fromScheduleId: String(entry.fromScheduleId).slice(0, 16) } : {}),
              }))
              .filter(entry => entry.text)
        : [];
    const lastResultRaw = data.lastResult && typeof data.lastResult === 'object' && !Array.isArray(data.lastResult) ? data.lastResult : null;
    const cap = Math.max(1, Number(maxEntries) || DEFAULT_MAX_ENTRIES);
    const processedMessages = Number.isFinite(Number(data.processedMessages)) ? Math.max(0, Math.floor(Number(data.processedMessages))) : 0;
    return {
        version: STORE_VERSION,
        /* READ NO LONGER EVICTS (R1): over-cap entries are kept intact and
           flagged; eviction happens only at write time (planRetention via
           the mutation boundary / applyPatch), with a change record. */
        entries,
        overCap: entries.length > cap,
        schedule: normalizeScheduleList(data.schedule, scheduleCap),
        clock: normalizeClock(data.clock),
        turnCount: Math.max(0, Math.floor(Number(data.turnCount)) || 0),
        vector: normalizeVectorMeta(data.vector),
        processedMessages,
        lastRun: typeof data.lastRun === 'string' ? data.lastRun : null,
        /* "cleared" = the user deliberately wiped the memories; the
           broken-state heal must never resurrect them (see maybeAutoRun). */
        cleared: data.cleared === true,
        /* R1 hardening fields (additive). memoryEpoch invalidates in-flight
           optimizer jobs on clear/reset; memoryRevision changes whenever the
           canonical entries change through the mutation boundary. */
        memoryEpoch: Math.max(0, Math.floor(Number(data.memoryEpoch)) || 0),
        memoryRevision: Math.max(0, Math.floor(Number(data.memoryRevision)) || 0),
        processing: normalizeProcessing(data.processing, entries.length, processedMessages),
        lastResult: lastResultRaw ? normalizeLastResult(lastResultRaw) : null,
        /* v0.6.5: run history (additive; absent → []). */
        runLog: normalizeRunLog(data.runLog),
        /* v0.9: story chapters (additive; absent → []). NOT part of the
           canonical entries fingerprint — never bumps memoryRevision. */
        chapters: normalizeChapters(data.chapters),
        /* v0.9.1: consolidation rotation + auto counter (additive). */
        consolidation: normalizeConsolidation(data.consolidation),
    };
}

/* v0.9.1 (audit3 #7): `state.consolidation = { cursor, sinceAuto }` —
 * cursor = batch offset where the next (unfocused) consolidation run starts
 * (the runner advances it modulo the batch count in its commits, so
 * repeated runs cover every group); sinceAuto = auto bursts that changed
 * memories since the last consolidation commit (bumpAutoRunCounter; every
 * consolidation commit resets it to 0). Absent/invalid → zeros. */
export function normalizeConsolidation(raw) {
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        cursor: nonNegativeIntOrNull(data.cursor) ?? 0,
        sinceAuto: nonNegativeIntOrNull(data.sinceAuto) ?? 0,
    };
}

/* PURE (mutates `state` only): +1 on the auto-burst counter. Call inside a
 * housekeeping commit after an auto burst that changed memories. Returns
 * the new `state.consolidation`. */
export function bumpAutoRunCounter(state) {
    const current = normalizeConsolidation(state?.consolidation);
    state.consolidation = { ...current, sinceAuto: current.sinceAuto + 1 };
    return state.consolidation;
}

/* =========================================================================
 * Story chapters (v0.9, "Tóm tắt truyện") — narrative summaries of the
 * PROCESSED history in fixed raw ranges [startRaw, endRaw). Stored next to
 * the entries; reads never drop rows (the CHAPTERS_MAX cap applies at add
 * time only). Rows without a summary or with an invalid range are dropped
 * as corrupt.
 * ========================================================================= */

export const CHAPTERS_MAX = 60;
export const CHAPTER_TITLE_MAX = 80;
export const CHAPTER_SUMMARY_MAX = 1200;
export const CHAPTERS_HEADER = '[Story so far — chapter summaries of this chat, oldest first]';

function chapterSummaryText(value) {
    return String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, CHAPTER_SUMMARY_MAX);
}

function normalizeChapter(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const startRaw = nonNegativeIntOrNull(raw.startRaw);
    const endRaw = nonNegativeIntOrNull(raw.endRaw);
    const summary = chapterSummaryText(raw.summary);
    if (startRaw === null || endRaw === null || endRaw <= startRaw || !summary) return null;
    return {
        id: typeof raw.id === 'string' && /^[0-9a-f]{8}$/.test(raw.id) ? raw.id : makeId(),
        startRaw,
        endRaw,
        title: cleanText(raw.title, CHAPTER_TITLE_MAX),
        summary,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
        source: raw.source === 'manual' ? 'manual' : 'auto',
        ...(raw.locked === true ? { locked: true } : {}),
        /* v0.9.1 (audit3 #10, additive): rangeFingerprint of [startRaw,
           endRaw) at commit — processing-core.staleChapters compares it
           with the live chat. Absent = unknown (legacy). */
        ...(typeof raw.sourceFingerprint === 'string' && raw.sourceFingerprint && raw.sourceFingerprint.length <= 64 ? { sourceFingerprint: raw.sourceFingerprint } : {}),
    };
}

export function normalizeChapters(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeChapter).filter(Boolean)
        .sort((a, b) => (a.startRaw - b.startRaw) || (a.endRaw - b.endRaw));
}

/* Adds a chapter (MUTATES state; call inside a commit mutator). Refuses an
 * empty summary / invalid range ('invalid'), a range overlapping an existing
 * chapter ('overlap') and a full list ('cap'). Returns
 * `{ ok, chapter?, reason? }`. */
export function addChapter(state, spec = {}) {
    state.chapters = normalizeChapters(state.chapters);
    if (state.chapters.length >= CHAPTERS_MAX) return { ok: false, reason: 'cap' };
    const chapter = normalizeChapter({ ...spec, id: makeId(), createdAt: typeof spec.createdAt === 'string' ? spec.createdAt : new Date().toISOString() });
    if (!chapter) return { ok: false, reason: 'invalid' };
    if (spec.locked !== true) delete chapter.locked;
    const overlaps = state.chapters.some(item => chapter.startRaw < item.endRaw && item.startRaw < chapter.endRaw);
    if (overlaps) return { ok: false, reason: 'overlap' };
    state.chapters.push(chapter);
    state.chapters.sort((a, b) => (a.startRaw - b.startRaw) || (a.endRaw - b.endRaw));
    return { ok: true, chapter };
}

/* User edit: `patch` may carry title / summary / locked (true sets, false
 * clears). An empty summary is refused. Returns `{ ok, reason? }` —
 * reason ∈ 'not_found' | 'empty'. A user edit marks the chapter manual. */
export function updateChapter(state, id, patch = {}) {
    state.chapters = normalizeChapters(state.chapters);
    const chapter = state.chapters.find(item => item.id === String(id ?? ''));
    if (!chapter) return { ok: false, reason: 'not_found' };
    const data = patch && typeof patch === 'object' ? patch : {};
    if (data.summary !== undefined) {
        const summary = chapterSummaryText(data.summary);
        if (!summary) return { ok: false, reason: 'empty' };
        chapter.summary = summary;
        chapter.source = 'manual';
    }
    if (data.title !== undefined) {
        chapter.title = cleanText(data.title, CHAPTER_TITLE_MAX);
        chapter.source = 'manual';
    }
    if (data.locked === true) chapter.locked = true;
    else if (data.locked === false) delete chapter.locked;
    return { ok: true };
}

/* Cuts `text` to ≤ max chars at a word boundary (… appended when cut). */
function cutChapterText(text, max) {
    if (text.length <= max) return text;
    if (max <= 1) return text.slice(0, Math.max(0, max));
    const head = text.slice(0, max - 1);
    const space = head.lastIndexOf(' ');
    return `${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()}…`;
}

/* v0.9.1 (audit3 #11): the 60-chapter cap no longer stops chapters forever
 * — the OLDEST pair of ADJACENT unlocked chapters (no locked chapter
 * between them, so the combined range cannot swallow a locked one) is
 * merged into ONE chapter without an LLM call: range [a.startRaw,
 * b.endRaw), title "a + b" (≤80), summary = both summaries concatenated
 * and trimmed to ≤ CHAPTER_SUMMARY_MAX (each side gets half, an unused
 * half flows to the other; word-boundary cuts). `options.fingerprintOf(
 * start, end)` (optional) stamps sourceFingerprint: both sides fresh →
 * fingerprint of the combined range; either side stale → 'stale' (never
 * matches, staleChapters reports it); either side unknown → none.
 * MUTATES `state.chapters`. Returns `{ ok, chapter?, mergedIds?, reason? }`
 * — reason 'no_pair' when no two adjacent unlocked chapters exist. */
export function mergeOldestChapters(state, { fingerprintOf = null } = {}) {
    state.chapters = normalizeChapters(state.chapters);
    const list = state.chapters;
    let index = -1;
    for (let i = 0; i + 1 < list.length; i++) {
        if (list[i].locked !== true && list[i + 1].locked !== true) { index = i; break; }
    }
    if (index < 0) return { ok: false, reason: 'no_pair' };
    const a = list[index];
    const b = list[index + 1];
    const separator = ' ';
    const room = CHAPTER_SUMMARY_MAX - separator.length;
    let roomA = Math.floor(room / 2);
    let roomB = room - roomA;
    if (a.summary.length < roomA) roomB += roomA - a.summary.length;
    else if (b.summary.length < roomB) roomA += roomB - b.summary.length;
    const summary = chapterSummaryText(`${cutChapterText(a.summary, roomA)}${separator}${cutChapterText(b.summary, roomB)}`);
    const title = cleanText([a.title, b.title].filter(Boolean).join(' + '), CHAPTER_TITLE_MAX);
    let sourceFingerprint;
    if (typeof fingerprintOf === 'function') {
        const fresh = chapter => (chapter.sourceFingerprint ? (fingerprintOf(chapter.startRaw, chapter.endRaw) === chapter.sourceFingerprint) : null);
        const fa = fresh(a);
        const fb = fresh(b);
        if (fa === false || fb === false) sourceFingerprint = 'stale';
        else if (fa === true && fb === true) sourceFingerprint = String(fingerprintOf(a.startRaw, b.endRaw) ?? '') || undefined;
    }
    const merged = normalizeChapter({
        id: makeId(),
        startRaw: a.startRaw,
        endRaw: b.endRaw,
        title,
        summary,
        createdAt: a.createdAt,
        source: a.source === 'manual' || b.source === 'manual' ? 'manual' : 'auto',
        ...(sourceFingerprint ? { sourceFingerprint } : {}),
    });
    if (!merged) return { ok: false, reason: 'no_pair' };
    list.splice(index, 2, merged);
    return { ok: true, chapter: merged, mergedIds: [a.id, b.id] };
}

/* Removes a chapter (user action — a locked chapter may be removed by the
 * user). Returns `{ ok, reason? }` — reason 'not_found'. */
export function removeChapter(state, id) {
    state.chapters = normalizeChapters(state.chapters);
    const index = state.chapters.findIndex(item => item.id === String(id ?? ''));
    if (index < 0) return { ok: false, reason: 'not_found' };
    state.chapters.splice(index, 1);
    return { ok: true };
}

function chapterLine(chapter, number, full) {
    const head = `- Ch.${number}${chapter.title ? ` (${chapter.title})` : ''}`;
    return full ? `${head}: ${chapter.summary}` : head;
}

/* Model-facing "story so far" block. '' when there are no chapters.
 * Budget (chars/4 per line, header excluded — same convention as
 * buildInjectionBlock): title-only lines for every chapter are the base;
 * when even those do not fit, the OLDEST titles are dropped first; then the
 * NEWEST chapters are upgraded to their full summary (newest backward,
 * stopping at the first that does not fit — the full ones are always the
 * newest suffix). Lines are never cut mid-way. */
export function buildChaptersBlock(chapters, budgetTokens = 600) {
    const list = normalizeChapters(chapters);
    if (!list.length) return '';
    const budget = Math.max(0, Number(budgetTokens) || 0);
    const cost = line => Math.ceil(line.length / CHARS_PER_TOKEN);
    const rows = list.map((chapter, index) => ({
        title: chapterLine(chapter, index + 1, false),
        full: chapterLine(chapter, index + 1, true),
        mode: 'title',
    }));
    let used = rows.reduce((sum, row) => sum + cost(row.title), 0);
    let first = 0;
    while (first < rows.length && used > budget) {
        used -= cost(rows[first].title);
        first += 1;
    }
    for (let i = rows.length - 1; i >= first; i--) {
        const delta = cost(rows[i].full) - cost(rows[i].title);
        if (used + delta > budget) break;
        rows[i].mode = 'full';
        used += delta;
    }
    const lines = rows.slice(first).map(row => (row.mode === 'full' ? row.full : row.title));
    if (!lines.length) return '';
    return [CHAPTERS_HEADER, ...lines].join('\n');
}

export function applyPatch(state, patch, meta = {}) {
    let added = 0;
    let updated = 0;
    let deleted = 0;
    /* R1: unknown update/delete ids are REPORTED, not silently skipped —
       the optimizer runner turns a non-empty unknown-id report into an
       atomic batch rejection (protocol 2).
       v0.6.0 (F5a): ops that touch a LOCKED entry are dropped and REPORTED
       in protected_ids — one pinned entry must not be allowed to kill the
       whole pass, so the rest of the batch still applies. */
    const diagnostics = { unknown_update_ids: [], unknown_delete_ids: [], evicted_ids: [], protected_ids: [], near_dupes: [] };
    let entries = Array.isArray(state.entries) ? state.entries : [];
    /* v0.6.5: a state without `entries` must not throw below. */
    state.entries = entries;
    const deleteIds = Array.isArray(patch?.delete) ? patch.delete.map(String) : [];

    if (deleteIds.length) {
        const deleteSet = new Set(deleteIds);
        const removedIds = new Set(entries.filter(entry => deleteSet.has(entry.id) && entry.locked !== true).map(entry => entry.id));
        for (const id of deleteIds) {
            if (!removedIds.has(id)) {
                /* Distinguish "no such entry" from "entry is locked" — both
                   are non-destructive, but the dashboard counts them apart. */
                const target = entries.find(entry => entry.id === id);
                if (target?.locked === true) diagnostics.protected_ids.push(id);
                else diagnostics.unknown_delete_ids.push(id);
            }
        }
        const keep = entries.filter(entry => !deleteSet.has(entry.id) || entry.locked === true);
        deleted = entries.length - keep.length;
        state.entries = keep;
        entries = keep;
    }

    /* v0.6.0 (P8): id → entry Map instead of a find() per update op. */
    const entriesByIdForUpdate = new Map(state.entries.map(item => [String(item.id), item]));
    for (const upd of Array.isArray(patch?.update) ? patch.update : []) {
        const entry = entriesByIdForUpdate.get(String(upd?.id ?? ''));
        if (!entry) {
            diagnostics.unknown_update_ids.push(String(upd?.id ?? ''));
            continue;
        }
        if (entry.locked === true) {
            diagnostics.protected_ids.push(String(upd?.id ?? ''));
            continue;
        }
        if (upd.text) entry.text = cleanText(upd.text);
        /* Array.isArray is the "field present" test: an explicit empty array
           CLEARS the entity tags (manual edit); omitting the field leaves
           them untouched (optimizer patches only carry id + text). */
        if (Array.isArray(upd.entities)) entry.entities = sanitizeEntities(upd.entities);
        if (upd.importance != null) entry.importance = clampImportance(upd.importance);
        updated++;
    }

    /* v0.6.0 (P8): the exact-dedupe lookup is a Set (was an O(n) scan per add). */
    const seenTexts = new Set(entries.map(entry => cleanText(entry?.text).toLowerCase()));
    let addSeq = 0;
    for (const add of Array.isArray(patch?.add) ? patch.add : []) {
        const text = cleanText(add?.text);
        if (!text) continue;
        /* Exact-text dedupe: the model re-adds known facts across passes and
           a manual re-scan replays old messages — never store the same fact
           twice. */
        const normalized = text.toLowerCase();
        if (seenTexts.has(normalized)) continue;
        /* v0.6.0 (F4): opt-in near-dedupe — a paraphrase of an existing fact
           is skipped and reported. Exact mode (default) is byte-identical
           legacy behavior. */
        if (meta.dedupeMode === 'near') {
            const dupe = findNearDuplicate(text, entries, NEAR_DUPE_THRESHOLD, { entities: Array.isArray(add?.entities) ? add.entities : null });
            if (dupe) {
                diagnostics.near_dupes.push(dupe.id);
                continue;
            }
        }
        entries.push({
            id: makeId(),
            entities: sanitizeEntities(add.entities),
            text,
            importance: clampImportance(add.importance ?? 2),
            /* Millisecond-staggered timestamps keep WITHIN-BATCH story order:
               the optimizer lists adds oldest-event-first, so ascending
               timestamps make the dashboard (createdAt desc) show the latest
               event on top and eviction remove the oldest event first. */
            createdAt: new Date(Date.now() + addSeq).toISOString(),
            fromMessage: normalizeFromMessage(meta.fromMessage),
            source: meta.source === 'manual' || meta.source === 'schedule' ? meta.source : 'auto',
            ...(add.fromScheduleId ? { fromScheduleId: String(add.fromScheduleId).slice(0, 16) } : {}),
            /* v0.8: provenance start of the source chunk (meta, never the
               model). `pinned`/`locked` are NEVER copied from a patch op —
               only the user flips them (index.js, inside the boundary). */
            ...(nonNegativeIntOrNull(meta.sourceStart) !== null ? { sourceStart: nonNegativeIntOrNull(meta.sourceStart) } : {}),
        });
        addSeq += 1;
        added++;
        seenTexts.add(normalized);
    }

    /* Retention stays a WRITE-time action (R1): reads never evict, so a
       lowered cap only takes effect on the next write, with a record. */
    const retention = planRetention(entries, meta.maxEntries ?? DEFAULT_MAX_ENTRIES, { charName: meta.charName ?? '' });
    if (retention.evicted.length) {
        diagnostics.evicted_ids = retention.evicted.map(entry => entry.id);
        /* v0.9 (additive): why each entry was evicted. */
        diagnostics.evicted_reasons = { ...retention.reasons };
    }
    state.entries = retention.kept;
    /* Memories exist again after an add — a deliberate "cleared" marker must
       not suppress the broken-state heal forever (see maybeAutoRun). */
    if (added > 0) state.cleared = false;
    return { added, updated, deleted, evicted: diagnostics.evicted_ids.length, protected: diagnostics.protected_ids.length, nearDupes: diagnostics.near_dupes.length, diagnostics };
}

export function filterByEntities(entries, entities) {
    if (!Array.isArray(entities) || !entities.length) return entries;
    const wanted = new Set(entities.map(entity => String(entity).trim()).filter(Boolean));
    return entries.filter(entry => (entry.entities ?? []).some(name => wanted.has(name)));
}

export const INJECTION_HEADER = '[Chat Memories — established facts from earlier in this chat]';
/* v0.8: share of the legacy budget reserved for pinned entries. */
export const PINNED_QUOTA_RATIO = 0.35;

export function injectionLine(entry) {
    const attributes = (entry.entities ?? []).join(', ');
    return `- ${attributes ? `(${attributes}) ` : ''}${entry.text}${entry.importance >= 3 ? ' [core]' : ''}`;
}

/* v0.8: the legacy (retrieval-off) SELECTION, factored out so the dashboard
 * preview and the real injection share one code path. Returns
 * `{ ids, lines, usedTokens, pinnedIds, skippedIds }`:
 * - pinned entries (ids in `pinnedIds` that are present in `entries`) pack
 *   FIRST, same line format, under PINNED_QUOTA_RATIO × budget; a pin that
 *   does not fit its quota is skipped (not fatal) and competes again in the
 *   normal pass;
 * - then the UNCHANGED legacy algorithm (importance desc → createdAt desc,
 *   skip-not-break) over everything not packed yet.
 * Zero pins → byte-identical to the pre-v0.8 buildInjectionBlock.
 * `pinnedIds` (result) = the pins actually packed; `skippedIds` = eligible
 * entries that did not fit the budget. */
export function selectInjectionEntries(entries, budgetTokens = 600, { pinnedIds = [] } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const budget = Number(budgetTokens);
    const sorted = [...list]
        .sort((a, b) => (b.importance - a.importance) || String(b.createdAt).localeCompare(String(a.createdAt)));
    const ids = [];
    const lines = [];
    const packed = new Set();
    const packedPins = [];
    let used = 0;

    const pinSet = new Set((Array.isArray(pinnedIds) ? pinnedIds : []).map(String));
    if (pinSet.size) {
        const pinQuota = Math.floor((Number.isFinite(budget) ? budget : 0) * PINNED_QUOTA_RATIO);
        for (const entry of sorted) {
            if (!pinSet.has(String(entry?.id)) || packed.has(entry)) continue;
            const line = injectionLine(entry);
            const tokens = Math.ceil(line.length / CHARS_PER_TOKEN);
            if (used + tokens > pinQuota) continue;
            lines.push(line);
            ids.push(String(entry.id));
            packedPins.push(String(entry.id));
            packed.add(entry);
            used += tokens;
        }
    }

    const skippedIds = [];
    for (const entry of sorted) {
        if (packed.has(entry)) continue;
        const line = injectionLine(entry);
        const tokens = Math.ceil(line.length / CHARS_PER_TOKEN);
        /* continue (not break): an oversized high-importance line must not
           starve smaller entries that would fit — that yielded an empty
           block even when eligible entries existed. */
        if (used + tokens > budgetTokens) {
            skippedIds.push(String(entry?.id));
            continue;
        }
        lines.push(line);
        ids.push(String(entry?.id));
        packed.add(entry);
        used += tokens;
    }

    return { ids, lines, usedTokens: used, pinnedIds: packedPins, skippedIds };
}

export function buildInjectionBlock(entries, budgetTokens = 600, { pinnedIds = [] } = {}) {
    const { lines } = selectInjectionEntries(entries, budgetTokens, { pinnedIds });
    if (!lines.length) return '';
    return [INJECTION_HEADER, ...lines].join('\n');
}

/* v0.8: entity rename — MUTATES `entries` in place (call inside a commit
 * mutator). Every tag matching one of `fromNames` (NFC, case-insensitive)
 * becomes `toName`; tags are deduped per entry preserving first-occurrence
 * order. Returns the number of entries changed. */
export function renameEntity(entries, fromNames, toName) {
    const target = String(toName ?? '').normalize('NFC').trim().slice(0, 60);
    if (!target || !Array.isArray(entries)) return 0;
    const key = name => String(name ?? '').normalize('NFC').trim().toLowerCase();
    const from = new Set((Array.isArray(fromNames) ? fromNames : [fromNames]).map(key).filter(Boolean));
    if (!from.size) return 0;
    let changed = 0;
    for (const entry of entries) {
        if (!entry || !Array.isArray(entry.entities) || !entry.entities.length) continue;
        const next = [];
        const seen = new Set();
        for (const name of entry.entities) {
            const value = from.has(key(name)) ? target : String(name ?? '').normalize('NFC').trim();
            if (!value || seen.has(key(value))) continue;
            seen.add(key(value));
            next.push(value);
        }
        if (next.length !== entry.entities.length || next.some((name, i) => name !== entry.entities[i])) {
            entry.entities = next;
            changed += 1;
        }
    }
    return changed;
}

/* v0.8: merge duplicates — MUTATES `entries` in place (call inside a commit
 * mutator). The keep entry receives the union of entity tags (keep's order
 * first, ≤8), the max importance, and locked/pinned when ANY member had it;
 * the other ids are removed. Returns `{ ok, removed, reason? }`. */
export function mergeEntries(entries, keepId, removeIds) {
    if (!Array.isArray(entries)) return { ok: false, removed: 0, reason: 'no_entries' };
    const keepKey = String(keepId ?? '');
    const keep = entries.find(entry => entry && String(entry.id) === keepKey);
    if (!keep) return { ok: false, removed: 0, reason: 'keep_not_found' };
    const removeSet = new Set((Array.isArray(removeIds) ? removeIds : []).map(String).filter(id => id && id !== keepKey));
    const members = entries.filter(entry => entry && removeSet.has(String(entry.id)));
    if (!members.length) return { ok: true, removed: 0 };
    keep.entities = sanitizeEntities([...(keep.entities ?? []), ...members.flatMap(entry => entry.entities ?? [])]);
    keep.importance = Math.max(clampImportance(keep.importance), ...members.map(entry => clampImportance(entry.importance)));
    if (members.some(entry => entry.locked === true)) keep.locked = true;
    if (members.some(entry => entry.pinned === true)) keep.pinned = true;
    let removed = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i] && entries[i] !== keep && removeSet.has(String(entries[i].id))) {
            entries.splice(i, 1);
            removed += 1;
        }
    }
    return { ok: true, removed };
}

const TRAILING_MARKER = /\s*\[(core|importance:?\s*[1-3]|locked|pinned)\]\s*$/i;

export function parseMemoryFile(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    const parsed = [];
    let fallbackEntity = '';

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) continue;

        if (/^@char:\s*(.+)$/i.test(line)) {
            fallbackEntity = line.replace(/^@char:\s*/i, '').trim();
            continue;
        }

        let entities = [];
        let work = line;
        let importance = 2;

        const star = work.match(/^\*\s+(.*)$/);
        if (star) {
            importance = 3;
            work = star[1];
        } else {
            const bullet = work.match(/^[-•]\s+(.*)$/);
            if (bullet) work = bullet[1];
        }

        const bracket = work.match(/^\[([^\]]+)\]\s*(.*)$/);
        if (bracket && bracket[1] && bracket[2]) {
            entities = bracket[1].split(/[,;]/).map(item => item.trim()).filter(Boolean);
            work = bracket[2];
        }

        const colon = work.match(/^([^:—–-]{1,40}):\s+(.+)$/);
        if (!entities.length && colon && colon[1] && colon[2]) {
            entities = colon[1].split(/[,;]/).map(item => item.trim()).filter(Boolean);
            work = colon[2];
        }

        const dash = !entities.length ? work.match(/^([^-–—]{1,40})\s+[—–-]\s+(.+)$/) : null;
        if (!entities.length && dash && dash[1] && dash[2]) {
            entities = dash[1].split(/[,;]/).map(item => item.trim()).filter(Boolean);
            work = dash[2];
        }

        /* Trailing marker tokens, any order (v0.8): [core] / [importance:N]
           (N = 1..3) / [locked] / [pinned]. Old files only carry [core] or
           [importance:3] — still read the same way. */
        let locked = false;
        let pinned = false;
        for (let guard = 0; guard < 8; guard++) {
            const marker = work.match(TRAILING_MARKER);
            if (!marker) break;
            const token = marker[1].toLowerCase().replace(/\s+/g, '');
            if (token === 'core') importance = 3;
            else if (token === 'locked') locked = true;
            else if (token === 'pinned') pinned = true;
            else importance = clampImportance(token.replace(/^importance:?/, ''));
            work = work.slice(0, marker.index).trim();
        }

        if (!entities.length) entities = fallbackEntity ? [fallbackEntity] : [];
        if (!work) continue;
        parsed.push({ entities, text: work, importance, ...(locked ? { locked: true } : {}), ...(pinned ? { pinned: true } : {}) });
    }

    return parsed;
}

/* v0.6.0 (T8.1): markdown export that parseMemoryFile round-trips —
 * "- [Alice, USER] text" (imp 1/2), "* [Alice] text" (imp 3/core), exactly
 * the bracket entity format the parser reads (SQUARE brackets; the star
 * bullet sets importance 3). Newlines inside a text are flattened (cleanText
 * already keeps memories single-line); ids/createdAt/source are chat-local
 * and intentionally NOT exported.
 * v0.6.0 review-fix (A1): the parser has NO escape syntax, so an entity-less
 * line whose text looks like "Xxx: "/"Xxx — "/"[Xxx] " re-imports with WRONG
 * entities/text, and ANY line ending with the "[core]" marker re-imports as
 * importance 3. Those entries are REFUSED (skippedUnsafe) instead of
 * writing a file that silently corrupts on re-import. Returns
 * `{ markdown, exported, skippedUnsafe }`. */
/* v0.8: importance 1 exports as a trailing "[importance:1]" (it used to
 * re-import as 2), locked/pinned as "[locked]"/"[pinned]"; any body that
 * itself ENDS with one of those marker tokens is unsafe, and so is an entity
 * containing , ; [ or ] (the bracket head cannot carry it). */
const UNSAFE_BARE_TEXT = /^(?:\[[^\]]+\]\s*|[^:—–-]{1,40}:\s*|[^-–—]{1,40}\s+[—–-]\s*)/;
const UNSAFE_CORE_SUFFIX = /\[(?:core|importance:?\s*[1-3]|locked|pinned)\]\s*$/i;
const UNSAFE_ENTITY = /[,;[\]]/;

export function exportToMarkdown(entries, { title = 'Memory Weaver export' } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const lines = [
        `# ${title}`,
        `# exported ${new Date().toISOString()}`,
        '',
    ];
    let exported = 0;
    let skippedUnsafe = 0;
    for (const entry of list) {
        const entityList = (Array.isArray(entry?.entities) ? entry.entities : []).map(name => String(name ?? '').trim()).filter(Boolean);
        const entities = entityList.join(', ');
        const importance = clampImportance(entry?.importance);
        const prefix = importance >= 3 ? '* ' : '- ';
        const head = entities ? `[${entities}] ` : '';
        const body = String(entry?.text ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
        if (!body) continue;
        const unsafe = entityList.some(name => UNSAFE_ENTITY.test(name))
            || (entities ? UNSAFE_CORE_SUFFIX.test(body) : UNSAFE_BARE_TEXT.test(body) || UNSAFE_CORE_SUFFIX.test(body));
        if (unsafe) {
            skippedUnsafe += 1;
            continue;
        }
        const suffix = `${importance === 1 ? ' [importance:1]' : ''}${entry?.locked === true ? ' [locked]' : ''}${entry?.pinned === true ? ' [pinned]' : ''}`;
        lines.push(`${prefix}${head}${body}${suffix}`);
        exported += 1;
    }
    return { markdown: lines.join('\n'), exported, skippedUnsafe };
}

/* =========================================================================
 * Schedule (v0.3.0) — future appointments / promises / plans with a
 * lifecycle: active → (done | missed | cancelled). Stored in the SAME state
 * variable, completely independent from entries/applyPatch. "Xoá tất cả"
 * memories must carry schedule/clock/turnCount through (see index.js).
 *
 * Frozen P1 semantics:
 * - `turnCount` is a monotonic odometer of COUNTED chat messages (see
 *   isCountedChatMessage): greeting counts, swipe/regenerate/continue and
 *   system/tool lines don't; deletions do NOT rewind it.
 * - mode 'after': dueTurn is an absolute odometer mark (turnCount + N at
 *   creation). mode 'story_day': due day against state.clock.day (P1 clock
 *   is manual-only; unset clock → passive display, never escalates).
 * - `lead` is ONE number whose unit follows the mode: turns for 'after',
 *   story-days for 'story_day'. It opens the "due window" early.
 * - urgency (upcoming/due/overdue) is DERIVED on every read, never stored.
 *   Only done/missed/cancelled are stored terminal states.
 * - dedupe fingerprint = text + mode + anchor, ACTIVE entries only (a done
 *   appointment never blocks re-adding the same plan later).
 * ========================================================================= */

export const SCHEDULE_TEXT_MAX = 300;
export const SCHEDULE_LABEL_MAX = 120;
export const DEFAULT_MAX_SCHEDULE = 20;
const SCHEDULE_TERMINAL_KEEP = 50;
export const SCHEDULE_LEAD = { after: 5, story_day: 1 };
export const SCHEDULE_STATUS = { ACTIVE: 'active', DONE: 'done', MISSED: 'missed', CANCELLED: 'cancelled' };

function normalizeScheduleWhen(raw) {
    const when = raw && typeof raw === 'object' ? raw : {};
    const label = cleanText(when.label, SCHEDULE_LABEL_MAX);
    if (when.mode === 'after') {
        const turns = Number(when.turns);
        const dueTurn = Number(when.dueTurn);
        if (!Number.isFinite(dueTurn)) return null;
        const roundedTurns = Number.isFinite(turns) ? Math.max(0, Math.round(turns)) : null;
        return {
            mode: 'after',
            turns: roundedTurns,
            dueTurn: Math.max(0, Math.round(dueTurn)),
            label: label || (roundedTurns !== null ? `sau ${roundedTurns} tin` : ''),
        };
    }
    if (when.mode === 'story_day') {
        const day = Number(when.storyDay);
        if (!Number.isFinite(day) || day < 1) return null;
        return { mode: 'story_day', storyDay: Math.round(day), label: label || `ngày ${Math.round(day)}` };
    }
    return null;
}

function normalizeScheduleItem(raw) {
    const text = cleanText(raw?.text, SCHEDULE_TEXT_MAX);
    if (!text) return null;
    const when = normalizeScheduleWhen(raw?.when);
    if (!when) return null;
    const terminal = [SCHEDULE_STATUS.DONE, SCHEDULE_STATUS.MISSED, SCHEDULE_STATUS.CANCELLED];
    const status = terminal.includes(raw?.status) ? raw.status : SCHEDULE_STATUS.ACTIVE;
    const fallbackLead = when.mode === 'after' ? SCHEDULE_LEAD.after : SCHEDULE_LEAD.story_day;
    return {
        id: typeof raw?.id === 'string' && raw.id ? raw.id.slice(0, 16) : makeId(),
        text,
        entities: sanitizeEntities(raw?.entities),
        when,
        /* v0.6.5: lead 0 is a legal value ("due exactly at the mark") —
           `|| fallback` made it impossible. Absent/blank → mode default. */
        lead: (() => {
            const rawLead = raw?.lead;
            const n = (rawLead === null || rawLead === undefined || rawLead === '') ? NaN : Number(rawLead);
            return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallbackLead;
        })(),
        status,
        createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
        /* null/undefined must stay null (Number(null) === 0 would silently
           rewrite the marker and break normalizeState idempotency). */
        fromMessage: (raw?.fromMessage === null || raw?.fromMessage === undefined) ? null
            : (Number.isFinite(Number(raw.fromMessage)) ? Number(raw.fromMessage) : null),
        source: raw?.source === 'auto' ? 'auto' : 'manual',
        postponedCount: Math.max(0, Math.floor(Number(raw?.postponedCount)) || 0),
        dueNotifiedAt: typeof raw?.dueNotifiedAt === 'string' ? raw.dueNotifiedAt : null,
        resolvedAt: typeof raw?.resolvedAt === 'string' ? raw.resolvedAt : null,
        resolvedBy: raw?.resolvedBy === 'system' ? 'system' : (status !== SCHEDULE_STATUS.ACTIVE ? 'user' : null),
    };
}

export function scheduleFingerprint(entry) {
    const anchor = entry?.when?.mode === 'after' ? `turn:${entry.when.dueTurn ?? ''}` : `day:${entry?.when?.storyDay ?? ''}`;
    return `${cleanText(entry?.text, SCHEDULE_TEXT_MAX).toLowerCase()}|${entry?.when?.mode ?? ''}|${anchor}`;
}

/* v0.6.5: READS NEVER DROP ACTIVE APPOINTMENTS. The old read path deduped
 * active rows by fingerprint (a postpone/update that collided silently
 * deleted an appointment) and sliced them to maxScheduleActive (lowering the
 * setting deleted appointments). Dedupe and the cap are now ADD-time rules
 * only (addScheduleEntry); postpone/update refuse a colliding result.
 * `maxActive` is accepted for signature compatibility and ignored here.
 * Terminal rows are kept for audit, oldest-resolved pruned first. */
function normalizeScheduleList(raw, maxActive) { // eslint-disable-line no-unused-vars
    if (!Array.isArray(raw)) return [];
    const active = [];
    const terminal = [];
    for (const item of raw.map(normalizeScheduleItem).filter(Boolean)) {
        if (item.status !== SCHEDULE_STATUS.ACTIVE) terminal.push(item);
        else active.push(item);
    }
    active.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    terminal.sort((a, b) => String(b.resolvedAt ?? '').localeCompare(String(a.resolvedAt ?? '')));
    return [...active, ...terminal.slice(0, SCHEDULE_TERMINAL_KEEP)];
}

/* True when another ACTIVE entry (different id) carries `fingerprint`. */
function activeFingerprintTaken(state, fingerprint, exceptId) {
    return (Array.isArray(state.schedule) ? state.schedule : [])
        .some(item => item.status === SCHEDULE_STATUS.ACTIVE && item.id !== exceptId && scheduleFingerprint(item) === fingerprint);
}

function normalizeClock(raw) {
    const day = Number(raw?.day);
    if (!Number.isFinite(day) || day < 1) return { day: null, updatedAt: null, source: null };
    return {
        day: Math.round(day),
        updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
        source: raw?.source === 'auto' ? 'auto' : 'manual',
    };
}

export function addScheduleEntry(state, spec = {}, { maxActive = DEFAULT_MAX_SCHEDULE } = {}) {
    state.schedule = Array.isArray(state.schedule) ? state.schedule : [];
    const text = cleanText(spec.text, SCHEDULE_TEXT_MAX);
    if (!text) return { ok: false, reason: 'empty' };
    const mode = spec.mode === 'story_day' ? 'story_day' : 'after';
    const active = state.schedule.filter(item => item.status === SCHEDULE_STATUS.ACTIVE);
    if (active.length >= Math.max(1, Number(maxActive) || DEFAULT_MAX_SCHEDULE)) return { ok: false, reason: 'cap' };

    let when;
    if (mode === 'after') {
        const turns = Math.max(0, Math.round(Number(spec.turns)));
        if (!Number.isFinite(turns)) return { ok: false, reason: 'when' };
        const base = Math.max(0, Math.round(Number(state.turnCount) || 0));
        when = { mode, turns, dueTurn: base + turns, label: cleanText(spec.label, SCHEDULE_LABEL_MAX) || `sau ${turns} tin` };
    } else {
        const day = Math.round(Number(spec.day));
        if (!Number.isFinite(day) || day < 1) return { ok: false, reason: 'when' };
        when = { mode, storyDay: day, label: cleanText(spec.label, SCHEDULE_LABEL_MAX) || `ngày ${day}` };
    }

    const entry = normalizeScheduleItem({
        id: makeId(),
        text,
        entities: spec.entities,
        when,
        lead: spec.lead,
        status: SCHEDULE_STATUS.ACTIVE,
        createdAt: new Date().toISOString(),
        fromMessage: spec.fromMessage,
        source: spec.source === 'auto' ? 'auto' : 'manual',
    });
    if (!entry) return { ok: false, reason: 'invalid' };
    const fingerprint = scheduleFingerprint(entry);
    if (active.some(item => scheduleFingerprint(item) === fingerprint)) return { ok: false, reason: 'duplicate' };
    state.schedule.push(entry);
    return { ok: true, entry };
}

/* v0.6.5: `{ ok, reason? }` variant — reason ∈ 'not_found' | 'empty' |
 * 'duplicate'. A text edit that would make this appointment identical
 * (fingerprint) to another ACTIVE one is REFUSED (nothing mutated) — reads
 * no longer dedupe, so a collision would otherwise persist two copies. */
export function updateScheduleEntryResult(state, id, patch = {}) {
    state.schedule = Array.isArray(state.schedule) ? state.schedule : [];
    const entry = state.schedule.find(item => item.id === String(id ?? ''));
    if (!entry || entry.status !== SCHEDULE_STATUS.ACTIVE) return { ok: false, reason: 'not_found' };
    /* Timing is NOT editable here on purpose: moving the deadline goes through
       postponeScheduleEntry so the anchor-from-max rule stays in one place. */
    let nextText = entry.text;
    if (patch.text !== undefined) {
        nextText = cleanText(patch.text, SCHEDULE_TEXT_MAX);
        if (!nextText) return { ok: false, reason: 'empty' };
        if (activeFingerprintTaken(state, scheduleFingerprint({ ...entry, text: nextText }), entry.id)) {
            return { ok: false, reason: 'duplicate' };
        }
    }
    entry.text = nextText;
    if (patch.label !== undefined) entry.when.label = cleanText(patch.label, SCHEDULE_LABEL_MAX) || entry.when.label;
    if (patch.entities !== undefined) entry.entities = sanitizeEntities(patch.entities);
    if (patch.lead !== undefined) {
        const lead = Math.round(Number(patch.lead));
        if (Number.isFinite(lead) && lead >= 0) entry.lead = lead;
    }
    return { ok: true };
}

/* Boolean-compatible wrapper (existing callers). */
export function updateScheduleEntry(state, id, patch = {}) {
    return updateScheduleEntryResult(state, id, patch).ok;
}

export function resolveScheduleEntry(state, id, outcome, { by = 'user', at = null } = {}) {
    state.schedule = Array.isArray(state.schedule) ? state.schedule : [];
    const entry = state.schedule.find(item => item.id === String(id ?? ''));
    if (!entry || entry.status !== SCHEDULE_STATUS.ACTIVE) return false;
    if (![SCHEDULE_STATUS.DONE, SCHEDULE_STATUS.MISSED, SCHEDULE_STATUS.CANCELLED].includes(outcome)) return false;
    entry.status = outcome;
    entry.resolvedAt = at ?? new Date().toISOString();
    entry.resolvedBy = by === 'system' ? 'system' : 'user';
    return true;
}

/* v0.6.5: `{ ok, reason? }` variant — reason ∈ 'not_found' | 'amount' |
 * 'when' | 'duplicate'. A postpone whose new anchor collides with another
 * ACTIVE appointment's fingerprint is REFUSED (nothing mutated). */
export function postponeScheduleEntryResult(state, id, amount) {
    state.schedule = Array.isArray(state.schedule) ? state.schedule : [];
    const entry = state.schedule.find(item => item.id === String(id ?? ''));
    if (!entry || entry.status !== SCHEDULE_STATUS.ACTIVE) return { ok: false, reason: 'not_found' };
    const step = Math.round(Number(amount));
    if (!Number.isFinite(step) || step === 0) return { ok: false, reason: 'amount' };
    /* Anchor-from-max: postponing an already-overdue appointment moves it N
       units from NOW, never back into the past. */
    let nextWhen;
    if (entry.when.mode === 'after') {
        const base = Math.max(Math.round(Number(state.turnCount)) || 0, Math.round(Number(entry.when.dueTurn)) || 0);
        nextWhen = { ...entry.when, dueTurn: Math.max(0, base + step) };
    } else if (entry.when.mode === 'story_day') {
        const clockDay = Math.round(Number(state.clock?.day)) || 0;
        const base = Math.max(clockDay, Math.round(Number(entry.when.storyDay)) || 0);
        nextWhen = { ...entry.when, storyDay: Math.max(1, base + step) };
    } else {
        return { ok: false, reason: 'when' };
    }
    if (activeFingerprintTaken(state, scheduleFingerprint({ ...entry, when: nextWhen }), entry.id)) {
        return { ok: false, reason: 'duplicate' };
    }
    entry.when = nextWhen;
    entry.postponedCount += 1;
    entry.dueNotifiedAt = null;
    return { ok: true };
}

/* Boolean-compatible wrapper (existing callers). */
export function postponeScheduleEntry(state, id, amount) {
    return postponeScheduleEntryResult(state, id, amount).ok;
}

export function setStoryClock(state, day, { source = 'manual' } = {}) {
    const value = Math.round(Number(day));
    if (!Number.isFinite(value) || value < 1) return false;
    /* v0.6.0 (S8): the auto path sets source 'auto' — a later manual set
       still wins, and auto clocks never overwrite manual ones. */
    state.clock = { day: value, updatedAt: new Date().toISOString(), source: source === 'auto' ? 'auto' : 'manual' };
    return true;
}

export function clearSchedule(state) {
    const removed = Array.isArray(state.schedule) ? state.schedule.length : 0;
    state.schedule = [];
    return removed;
}

/* Derived urgency for the UI/injection: 'upcoming' | 'due' | 'overdue' for
   active entries, the stored terminal status otherwise. */
export function scheduleStateOf(entry, { turnCount = 0, clockDay = null } = {}) {
    if (!entry) return null;
    if (entry.status && entry.status !== SCHEDULE_STATUS.ACTIVE) return entry.status;
    const lead = Math.max(0, Math.round(Number(entry.lead)) || 0);
    if (entry.when?.mode === 'after') {
        const dueTurn = Number(entry.when.dueTurn);
        if (!Number.isFinite(dueTurn)) return 'upcoming';
        const remaining = dueTurn - (Number(turnCount) || 0);
        if (remaining < 0) return 'overdue';
        if (remaining <= lead) return 'due';
        return 'upcoming';
    }
    if (entry.when?.mode === 'story_day') {
        const day = Number(entry.when.storyDay);
        if (!Number.isFinite(day)) return 'upcoming';
        const today = Number(clockDay);
        if (!Number.isFinite(today) || today < 1) return 'upcoming';
        if (today > day) return 'overdue';
        if (day - today <= lead) return 'due';
        return 'upcoming';
    }
    return 'upcoming';
}

/* Signed distance to the due point, in the entry's own unit (turns or
   story-days); null when it cannot be evaluated (clock unset). */
export function scheduleRemaining(entry, { turnCount = 0, clockDay = null } = {}) {
    if (entry?.when?.mode === 'after') {
        const dueTurn = Number(entry.when.dueTurn);
        return Number.isFinite(dueTurn) ? Math.round(dueTurn) - (Number(turnCount) || 0) : null;
    }
    if (entry?.when?.mode === 'story_day') {
        const day = Number(entry.when.storyDay);
        const today = Number(clockDay);
        if (!Number.isFinite(day) || !Number.isFinite(today) || today < 1) return null;
        return Math.round(day) - Math.round(today);
    }
    return null;
}

const SCHEDULE_MAX_LINES = 7;

function scheduleBlockLine(row) {
    const anchor = row.item.when.label ? `(${row.item.when.label}) ` : '';
    let tail = '';
    if (row.remaining !== null) {
        tail = row.remaining >= 0
            ? ` [in ~${row.remaining} ${row.item.when.mode === 'after' ? 'msgs' : 'days'}]`
            : ' [OVERDUE]';
    }
    if (row.urgency === 'overdue' && !tail.includes('[OVERDUE]')) tail += ' [OVERDUE]';
    return `- ${anchor}${row.item.text}${tail}`;
}

/* Model-facing injection blocks. Pure. Returns { upcoming, due } — either ''
   when empty. Due/overdue escalate into `due` (rendered at a shallower prompt
   depth by the caller); `upcoming` is the passive reminder block. */
export function buildScheduleBlocks(schedule, { turnCount = 0, clockDay = null, budgetTokens = 120 } = {}) {
    const list = Array.isArray(schedule) ? schedule.filter(item => item.status === SCHEDULE_STATUS.ACTIVE) : [];
    if (!list.length) return { upcoming: '', due: '' };

    const rows = list.map(item => ({
        item,
        urgency: scheduleStateOf(item, { turnCount, clockDay }),
        remaining: scheduleRemaining(item, { turnCount, clockDay }),
    }));
    /* Overdue first, then due (closest first), then upcoming closest-first;
       unevaluable rows (clock unset) sink to the bottom. */
    const tier = row => (row.urgency === 'overdue' ? 0 : row.urgency === 'due' ? 1 : row.remaining === null ? 3 : 2);
    rows.sort((a, b) => tier(a) - tier(b) || (a.remaining ?? Infinity) - (b.remaining ?? Infinity));

    const pack = (selected) => {
        const lines = [];
        let used = 0;
        for (const row of selected.slice(0, SCHEDULE_MAX_LINES)) {
            const line = scheduleBlockLine(row);
            const tokens = Math.ceil(line.length / CHARS_PER_TOKEN);
            if (used + tokens > budgetTokens) continue;
            lines.push(line);
            used += tokens;
        }
        return lines;
    };

    const dueRows = rows.filter(row => row.urgency === 'due' || row.urgency === 'overdue');
    const upcomingRows = rows.filter(row => row.urgency === 'upcoming');

    const dueLines = pack(dueRows);
    const due = dueLines.length
        ? ['[Schedule — DUE NOW]', ...dueLines, 'Weave these into the story now (or state why they were delayed).'].join('\n')
        : '';

    const upcomingLines = pack(upcomingRows);
    const upcoming = upcomingLines.length ? ['[Schedule — upcoming events]', ...upcomingLines].join('\n') : '';

    return { upcoming, due };
}

/* Countable chat message — the optimizer's view of "a message":
   - system messages (tool calls / tool results included) are plumbing,
   - narrator-typed entries carry no conversation,
   - an empty text carries nothing.
   The progress counters, the auto-run threshold and `collectChunk` all share
   this predicate: counting raw `chat.length` let every tool call in a
   tool-heavy chat (Storyline + Dice Weaver) inflate the progress bar and
   made the auto pass fire early — N must mean N real messages. */
export function isCountedChatMessage(mes) {
    if (!mes || mes.is_system) return false;
    if (mes.extra?.type === 'narrator') return false;
    return String(mes.mes ?? '').trim().length > 0;
}

/* Counts countable messages in the window [from, to) — a chat INDEX range,
   same unit as the `processedMessages` cursor. Returns 0 for a non-array. */
export function countChatMessages(chat, from = 0, to = null) {
    if (!Array.isArray(chat)) return 0;
    const start = Math.max(0, Math.floor(Number(from) || 0));
    const rawEnd = to == null ? chat.length : Number(to);
    const end = Math.min(chat.length, Number.isFinite(rawEnd) ? Math.max(0, Math.floor(rawEnd)) : chat.length);
    let count = 0;
    for (let i = start; i < end; i++) {
        if (isCountedChatMessage(chat[i])) count++;
    }
    return count;
}
