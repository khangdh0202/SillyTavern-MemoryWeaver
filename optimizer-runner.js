/* optimizer-runner.js — DI orchestration for the optimizer burst loop (R1).
 *
 * Contract (plan §5.2):
 * - deps are injectable and fakeable: generate (AI call), loadState,
 *   getContext, getSettings, commitMutation (the state boundary), clock,
 *   isGenerationActive, getLifecycleEpoch.
 * - ONE await per chunk: the AI call. Everything from the post-await guards
 *   through the commit is a single synchronous JS turn (the mutation
 *   boundary enforces guard→write atomicity).
 * - Batch contract captured at dispatch: batchId, scopeKey, lifecycleEpoch,
 *   memoryEpoch, memoryRevision, baseCanonicalFingerprint, sourcePolicyVersion,
 *   startRawIndex, endRawIndexExclusive, expectedCheckpoint, promptEntryIds,
 *   dispatchTailRawIndex. Committing only advances the cursor to the
 *   dispatched tail; messages appended mid-flight stay pending.
 * - Loop: at most `backlogMaxChunksPerRun` (default 2) chunks per run;
 *   stop conditions: chat switched, mode off/disabled, generation active,
 *   conflict, parse failure, invalid patch, oversized message, burst limit.
 * - Retry markers are RUNTIME-only (never persisted), keyed
 *   `start:end:rangeFingerprint`: an auto pass may fail the same exact range
 *   at most twice (first attempt + one throttled retry) before the marker
 *   blocks further auto dispatches; manual runs are never blocked.
 */

import {
    applyPatch, addScheduleEntry, resolveScheduleEntry, setStoryClock, pushRunLog, captureRunChanges,
    addChapter, removeChapter, normalizeChapters, mergeOldestChapters, normalizeConsolidation, CHAPTERS_MAX, PROCESSING_STATUS,
} from './store.js';
import {
    buildOptimizerPrompt, parseOptimizerResponse, buildStorySoFarSection,
    buildChapterPrompt, parseChapterResponse, buildConsolidationPrompt, CONSOLIDATION_BATCH_MAX,
} from './summarizer.js';
import {
    planNextBatch, validatePatch, makeBatchId, commitPrefixBlocks, mergeDirtyFrom,
    canonicalEntriesFingerprint, rangeFingerprint, recentWindowRange, acknowledgeCoverage,
    planNextChapter, sourceDescriptors, planConsolidationBatches, staleChapters,
    SOURCE_POLICY_VERSION, BACKLOG_CHUNKS_PER_RUN, CHUNK_MAX,
} from './processing-core.js';
import { payloadDigest } from './recall-core.js';

export const OPTIMIZER_RESPONSE_LENGTH = 4096;
const MAX_AUTO_ATTEMPTS_PER_RANGE = 2;
/* v0.6.0 (T9.5): an active appointment is auto-marked missed only after this
   much grace beyond due (counted messages for `after`, story days for
   `story_day`). Sub-toggle, default OFF. */
const AUTO_MISS_GRACE = 10;

/* v0.9.1 (audit3 #1): one run id (8 hex) per runBurst / runConsolidation /
   runReviewFrom invocation — stamped on every runLog record the run pushes
   so the run diff + undo work per BURST, not per chunk. */
export function makeRunId() {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function clampNumber(value, { min, max, fallback }) {
    const num = Math.round(Number(value));
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
}

export function createOptimizerRunner(deps) {
    for (const name of ['generate', 'loadState', 'getContext', 'getSettings', 'commitMutation']) {
        if (typeof deps?.[name] !== 'function') throw new Error(`optimizer-runner: missing dep ${name}`);
    }

    const runtime = { markers: new Map() };
    const rangeFingerprintFn = typeof deps.rangeFingerprint === 'function' ? deps.rangeFingerprint : rangeFingerprint;
    const canonicalFingerprintFn = typeof deps.canonicalFingerprint === 'function' ? deps.canonicalFingerprint : canonicalEntriesFingerprint;
    const now = () => (typeof deps.clock?.now === 'function' ? deps.clock.now() : Date.now());
    const nowIso = () => new Date(now()).toISOString();

    function settings() { return deps.getSettings() ?? {}; }
    function context() { return deps.getContext() ?? {}; }
    function chatOf(contextArg = null) {
        const resolved = contextArg ?? context();
        return Array.isArray(resolved.chat) ? resolved.chat : [];
    }

    function logWarn(...args) {
        if (typeof deps.logWarn === 'function') deps.logWarn(...args);
        else console.warn('[Memory Weaver]', ...args);
    }
    function logDebug(...args) {
        if (typeof deps.logDebug === 'function') deps.logDebug(...args);
        else console.debug('[Memory Weaver]', ...args);
    }

    /* v0.9: chapters fed to the optimizer/consolidation prompts — on unless
       settings.chapters.enabled === false. */
    function chaptersForPrompt(settingsArg, stateArg) {
        if (settingsArg?.chapters?.enabled === false) return [];
        return Array.isArray(stateArg?.chapters) ? stateArg.chapters : [];
    }

    /* v0.9 run diff helpers. */
    function snapshotEntries(entries) {
        return (Array.isArray(entries) ? entries : []).map(entry => ({ ...entry, entities: Array.isArray(entry?.entities) ? [...entry.entities] : [] }));
    }
    function changesField(before, after) {
        const changes = captureRunChanges(before, after);
        return (changes.added.length || changes.updated.length || changes.deleted.length) ? { changes } : {};
    }
    function retentionCharName(contextArg) {
        return contextArg?.groupId ? '' : String(contextArg?.name2 ?? '');
    }

    /* Prompt speaker name — persona name for user lines, mes.name/character
       fallback otherwise. Shared with the planner (resolveName) so the
       budget estimate measures exactly the text the prompt prints. */
    function speakerNameResolver(contextArg = null) {
        const resolved = contextArg ?? context();
        const user = resolved.name1 ?? 'User';
        const assistantFallback = resolved.name2 || 'Assistant';
        return desc => (desc.isUser ? (user || 'User') : (desc.name || assistantFallback || 'Assistant'));
    }

    /* Prompt message lines. v0.6.5: NO text truncation — the old 1500-char
       slice silently dropped message tails while the cursor advanced past
       them. The planner's budget/blocked logic governs size (a single
       oversized message is blocked, never truncated). */
    function promptMessages(descriptors, contextArg = null) {
        const nameOf = speakerNameResolver(contextArg);
        return descriptors.map(desc => ({ name: nameOf(desc), text: desc.text }));
    }

    /* v0.6.5: retry markers whose range starts behind the cursor are dead
       weight (that range can never be planned again) — prune them. */
    function pruneMarkers(cursor) {
        for (const key of [...runtime.markers.keys()]) {
            const start = Number(String(key).split(':')[0]);
            if (Number.isFinite(start) && start < cursor) runtime.markers.delete(key);
        }
    }

    /* Best-effort failure record for the dashboard (housekeeping write —
       never bumps the revision, never touches the cursor). v0.5.1: the
       error string and the source label are PERSISTED now — a bare
       "failed" outcome made the failure undiagnosable from the state.
       v0.6.0 (S1): callers pass the scopeKey/lifecycleEpoch captured at
       DISPATCH time; if the live context has moved to another chat, the
       record is dropped instead of writing chat A's failure into chat
       B's state. */
    function recordFailure({ outcome = 'failed', error = '', range = null, jobId = null, source = null, scopeKey = undefined, lifecycleEpoch = undefined, execution = null, runId = null, onCommit = null }) {
        const contextNow = context();
        const epochNow = typeof deps.getLifecycleEpoch === 'function' ? deps.getLifecycleEpoch() : undefined;
        if (scopeKey !== undefined && String(contextNow.chatId ?? '') !== String(scopeKey)) return;
        if (lifecycleEpoch !== undefined && epochNow !== lifecycleEpoch) return;
        deps.commitMutation({
            kind: 'housekeeping',
            scopeKey: scopeKey !== undefined ? String(scopeKey) : String(contextNow.chatId ?? ''),
            lifecycleEpoch: lifecycleEpoch !== undefined ? lifecycleEpoch : epochNow,
            reason: 'optimizer failure record',
        }, (live) => {
            live.lastResult = {
                at: nowIso(),
                added: 0,
                updated: 0,
                deleted: 0,
                outcome,
                sourceRange: range,
                coverageCommitted: false,
                jobId,
                error: String(error ?? '').trim().slice(0, 300) || null,
                source: source === 'manual' || source === 'auto' || source === 'consolidate' ? source : null,
                /* v0.6.0 (U6a): execution record — additive, normalize fills nulls. */
                ...(execution && typeof execution === 'object' ? execution : {}),
            };
            /* v0.6.5: run history. v0.9.1: + the burst's runId. */
            pushRunLog(live, { ...live.lastResult, ...(runId ? { runId } : {}) });
            if (typeof onCommit === 'function') onCommit(live);
            return { recorded: true };
        });
    }

    function noteFailure(markerKey, manual) {
        if (manual) return;
        const marker = runtime.markers.get(markerKey) ?? { attempts: 0, at: 0, lastError: '' };
        marker.attempts += 1;
        marker.at = now();
        runtime.markers.set(markerKey, marker);
    }

    /* One full chunk cycle: plan → snapshot → AI call → guards → parse →
       validate → commit. Returns { stopReason|null, terminal, record }.
       advancePolicy: 'tail' = cursor advances to the dispatched tail (normal
       path); 'keepCursor' = the cursor is untouched (targeted recent-window
       pass with a pending gap — a pending gap is never claimed, B4.5). */
    async function runChunk({ sourceLabel = 'auto', manual = false, forcedRange = null, advancePolicy = 'tail', runId = null } = {}) {
        const settingsNow = settings();
        if (settingsNow.enabled === false) {
            return { terminal: true, stopReason: 'disabled', record: null };
        }
        if (!manual && String(settingsNow.mode ?? 'auto') !== 'auto') {
            return { terminal: true, stopReason: 'mode_off', record: null };
        }
        /* A corrupt/future-schema state is never written — refuse BEFORE
           spending the AI call (T22). */
        const integrityNow = typeof deps.stateIntegrity === 'function' ? deps.stateIntegrity() : null;
        if (integrityNow && integrityNow.ok === false) {
            return { terminal: true, stopReason: 'state_corrupt', record: null };
        }

        const contextAtDispatch = context();
        const chat = chatOf(contextAtDispatch);
        const chatIdAtStart = String(contextAtDispatch.chatId ?? '');
        const lifecycleAtStart = typeof deps.getLifecycleEpoch === 'function' ? deps.getLifecycleEpoch() : undefined;
        const stateAtPlan = deps.loadState();
        /* v0.6.0 (F1): user-skipped oversized messages — the walk passes them. */
        const skippedList = Array.isArray(stateAtPlan.processing?.skipped) ? stateAtPlan.processing.skipped : [];

        /* ---- Plan ---- */
        const liveCursorAtPlan = Number(stateAtPlan.processedMessages ?? 0);
        pruneMarkers(liveCursorAtPlan);
        const resolveName = speakerNameResolver(contextAtDispatch);
        /* v0.9: chapter "Story so far" context for the extraction (on unless
           settings.chapters.enabled === false); budgeted as fixed cost. */
        const promptChapters = chaptersForPrompt(settingsNow, stateAtPlan);
        const storySection = buildStorySoFarSection(promptChapters);
        const contextChars = storySection ? storySection.length + 2 : 0;
        let plan;
        if (forcedRange) {
            /* A forced (recent-window / review) range is bounded by ITS OWN
               end: the walk stops there (v0.6.5 limitEnd — descriptors never
               come from beyond it). */
            plan = planNextBatch({
                chat,
                cursor: forcedRange.start,
                existingEntries: stateAtPlan.entries,
                settings: settingsNow,
                skipped: skippedList,
                limitEnd: forcedRange.end,
                resolveName,
                contextChars,
            });
        } else {
            plan = planNextBatch({ chat, cursor: liveCursorAtPlan, existingEntries: stateAtPlan.entries, settings: settingsNow, skipped: skippedList, resolveName, contextChars });
        }

        if (plan.blocked && advancePolicy === 'review') {
            /* A review pass never writes the forward-cursor blocked marker
               (the oversized message sits BELOW the cursor). Report + stop. */
            return {
                terminal: true,
                stopReason: 'blocked',
                record: { batchId: null, outcome: 'blocked', rawIndex: plan.blocked.rawIndex, reason: plan.blocked.reason, added: 0, updated: 0, deleted: 0 },
            };
        }
        if (plan.blocked) {
            /* T05: oversized single message — explicit block, no truncation,
               no advance, no retry loop. Persisted so the UI can show it. */
            deps.commitMutation({
                kind: 'housekeeping',
                scopeKey: chatIdAtStart,
                lifecycleEpoch: lifecycleAtStart,
                reason: 'blocked oversized message',
            }, (live) => {
                live.processing.blocked = { rawIndex: plan.blocked.rawIndex, reason: plan.blocked.reason };
                return { blocked: plan.blocked };
            });
            return {
                terminal: true,
                stopReason: 'blocked',
                record: { batchId: null, outcome: 'blocked', rawIndex: plan.blocked.rawIndex, reason: plan.blocked.reason, added: 0, updated: 0, deleted: 0 },
            };
        }
        if (plan.eligibleCount === 0) {
            return { terminal: true, stopReason: 'no_pending', record: null };
        }

        const rangeFp = rangeFingerprintFn(chat, plan.start, plan.end);
        const markerKey = `${plan.start}:${plan.end}:${rangeFp}`;
        const marker = runtime.markers.get(markerKey);
        if (!manual && (marker?.attempts ?? 0) >= MAX_AUTO_ATTEMPTS_PER_RANGE) {
            return { terminal: true, stopReason: 'retry_blocked', record: null };
        }

        /* ---- Batch contract + prompt (still pre-await). */
        const batchId = makeBatchId();
        /* v0.6.0 (S8): schedule auto ops — OFF by default; when ON the prompt
           lists the active appointments and the patch may carry schedule ops. */
        const scheduleAutoEnabled = settingsNow.scheduleAuto?.enabled === true;
        const scheduleAutoMiss = settingsNow.scheduleAuto?.autoMiss === true;
        const activeSchedule = Array.isArray(stateAtPlan.schedule) ? stateAtPlan.schedule.filter(item => item.status === 'active') : [];
        /* v0.6.5: exactly the ≤20 ids the prompt shows — a resolve of an
           unlisted appointment must reject. */
        const shownSchedule = activeSchedule.slice(0, 20);
        const promptScheduleIds = shownSchedule.map(item => String(item.id));
        const promptSchedule = scheduleAutoEnabled ? {
            active: shownSchedule.map(item => ({
                id: item.id,
                text: item.text,
                when: item.when,
                remaining: item.when?.mode === 'after' ? Math.max(0, Number(item.when.dueTurn) - Number(stateAtPlan.turnCount ?? 0)) : undefined,
            })),
            /* v0.6.0 review-fix (B2): undefined (NOT null) when the clock is
               unset — Number(null) is 0 and made the prompt claim
               "Current story day: 0" on chats without a story clock. */
            storyDay: stateAtPlan.clock?.day ?? undefined,
        } : null;
        const messages = promptMessages(plan.descriptors, contextAtDispatch);
        /* v0.8: the planner may trim the existing-memories set (fixed cost ≥
           budget); includedIds — and therefore validatePatch — reflect
           exactly what is sent. */
        const prompt = buildOptimizerPrompt({ entries: stateAtPlan.entries, chunk: messages, settings: settingsNow, batchId, scheduleAuto: promptSchedule, maxExisting: plan.existingLimit ?? null, chapters: promptChapters });
        /* v0.6.0 (U6a): execution record captured at dispatch — the model
           name comes from the host dep (browser-only openai.js helper), the
           api from the context. Clock-based so tests stay deterministic. */
        const executionBase = {
            model: typeof deps.getModel === 'function' ? (String(deps.getModel() ?? '').trim() || null) : null,
            api: String(contextAtDispatch.mainApi ?? '').trim() || null,
            /* v0.8: planner honesty flags — persisted into lastResult AND
               every runLog record (success and failure paths alike). */
            floorApplied: plan.floorApplied === true,
            existingOverBudget: plan.existingOverBudget === true,
            existingTrimmed: Math.max(0, Number(plan.existingTrimmed) || 0),
        };
        const startedAt = now();
        const batch = {
            batchId,
            scopeKey: chatIdAtStart,
            lifecycleEpoch: lifecycleAtStart,
            memoryEpoch: Number(stateAtPlan.memoryEpoch ?? 0),
            memoryRevision: Number(stateAtPlan.memoryRevision ?? 0),
            baseCanonicalFingerprint: canonicalFingerprintFn(stateAtPlan.entries),
            sourcePolicyVersion: SOURCE_POLICY_VERSION,
            startRawIndex: plan.start,
            endRawIndexExclusive: plan.end,
            expectedCheckpoint: Number(stateAtPlan.processedMessages ?? 0),
            promptEntryIds: prompt.includedIds,
            dispatchTailRawIndex: plan.end,
            requestConfigFingerprint: payloadDigest(prompt.user),
            sourceSnapshot: { messages: structuredClone(messages), estimate: plan.estimate },
        };
        logDebug(`Optimizer batch ${batchId} planned: raw [${plan.start},${plan.end}) = ${plan.eligibleCount} counted message(s), est. input ${plan.estimate?.tokens ?? '?'} tokens.`);

        /* ---- The single await per chunk. */
        let response = '';
        try {
            response = await deps.generate({
                prompt: prompt.user,
                instructOverride: true,
                responseLength: OPTIMIZER_RESPONSE_LENGTH,
                systemPrompt: prompt.system,
            });
        } catch (error) {
            /* v0.6.0 (S1): this is the ONLY failure branch that runs BEFORE
               the post-await chat-switch guard — a generate() rejection
               after the user switched chats must not record anything into
               the new chat's state. */
            const contextAfterError = context();
            const epochAfterError = typeof deps.getLifecycleEpoch === 'function' ? deps.getLifecycleEpoch() : undefined;
            if (String(contextAfterError.chatId ?? '') !== chatIdAtStart || epochAfterError !== lifecycleAtStart) {
                logWarn('Optimizer batch aborted: the chat changed while the AI call was in flight (generate failed; nothing recorded).');
                return { terminal: true, stopReason: 'chat_switched', record: null };
            }
            const reason = String(error?.message ?? error);
            noteFailure(markerKey, manual);
            recordFailure({
                outcome: 'failed',
                error: reason,
                range: { start: plan.start, end: plan.end },
                jobId: batchId,
                source: manual ? 'manual' : 'auto',
                scopeKey: chatIdAtStart,
                lifecycleEpoch: lifecycleAtStart,
                execution: { ...executionBase, durationMs: Math.max(0, now() - startedAt), estInputTokens: Number(plan.estimate?.tokens ?? 0) || null, estOutputChars: 0, estOutputTokens: 0, stopReason: 'generate_failed' },
                runId,
            });
            if (reason === 'No message generated') {
                logWarn('The API returned an EMPTY completion — usually a reasoning (thinking) model whose reasoning consumed the whole max_tokens budget, or a provider hiccup. Lower the reasoning effort manually for reasoning models.');
            }
            return {
                terminal: true,
                stopReason: 'generate_failed',
                record: { batchId, start: plan.start, end: plan.end, outcome: 'failed', error: reason, added: 0, updated: 0, deleted: 0 },
            };
        }

        /* ---- Post-await guards (same synchronous turn until the commit). */
        const contextNow = context();
        if (String(contextNow.chatId ?? '') !== batch.scopeKey) {
            logWarn('Optimizer batch aborted: the chat changed while the AI call was in flight (cross-chat write prevented).');
            return { terminal: true, stopReason: 'chat_switched', record: null };
        }
        /* v0.6.0 (U6a): execution record for this chunk (model/api captured
           at dispatch, duration off the injectable clock). */
        const execution = {
            ...executionBase,
            durationMs: Math.max(0, now() - startedAt),
            estInputTokens: Number(plan.estimate?.tokens ?? 0) || null,
            estOutputChars: response.length,
            estOutputTokens: Math.ceil(response.length / 4),
        };

        const parsed = parseOptimizerResponse(response, { batchId });
        if (!parsed.ok) {
            noteFailure(markerKey, manual);
            recordFailure({ outcome: 'failed', error: parsed.error, range: { start: plan.start, end: plan.end }, jobId: batchId, source: manual ? 'manual' : 'auto', scopeKey: batch.scopeKey, lifecycleEpoch: batch.lifecycleEpoch, runId, execution: { ...execution, stopReason: 'parse_failed' } });
            logWarn('Optimizer output rejected:', parsed.error, 'Raw (first 800 chars):', String(response ?? '').slice(0, 800));
            return {
                terminal: true,
                stopReason: 'parse_failed',
                record: { batchId, start: plan.start, end: plan.end, outcome: 'failed', error: parsed.error, added: 0, updated: 0, deleted: 0 },
            };
        }

        /* Echo-template guard: protocol 2 MUST return the dispatched batchId. */
        if (parsed.protocol === 2 && parsed.batchId !== batchId) {
            noteFailure(markerKey, manual);
            recordFailure({ outcome: 'failed', error: 'batch id mismatch', range: { start: plan.start, end: plan.end }, jobId: batchId, source: manual ? 'manual' : 'auto', scopeKey: batch.scopeKey, lifecycleEpoch: batch.lifecycleEpoch, runId, execution: { ...execution, stopReason: 'batch_mismatch' } });
            logWarn('Optimizer batch rejected: protocol-2 batchId echo mismatch.');
            return {
                terminal: true,
                stopReason: 'batch_mismatch',
                record: { batchId, start: plan.start, end: plan.end, outcome: 'failed', error: 'batch id mismatch', added: 0, updated: 0, deleted: 0 },
            };
        }

        /* Semantic validation against the LIVE store (T07/T10). */
        const liveState = deps.loadState();
        const semantic = validatePatch(parsed.patch, {
            entries: liveState.entries,
            promptEntryIds: batch.promptEntryIds,
            ...(scheduleAutoEnabled ? {
                scheduleOps: { add: parsed.scheduleAdd ?? [], resolve: parsed.scheduleResolve ?? [] },
                promptScheduleIds,
                maxScheduleActive: settingsNow.maxScheduleActive,
                activeScheduleCount: activeSchedule.length,
            } : {}),
        });
        if (!semantic.ok) {
            noteFailure(markerKey, manual);
            const errorText = semantic.errors.join('; ');
            recordFailure({ outcome: 'failed', error: errorText, range: { start: plan.start, end: plan.end }, jobId: batchId, source: manual ? 'manual' : 'auto', scopeKey: batch.scopeKey, lifecycleEpoch: batch.lifecycleEpoch, runId, execution: { ...execution, stopReason: 'invalid_patch' } });
            logWarn('Optimizer patch rejected (semantic validation):', errorText);
            return {
                terminal: true,
                stopReason: 'invalid_patch',
                record: { batchId, start: plan.start, end: plan.end, outcome: 'failed', error: errorText, added: 0, updated: 0, deleted: 0 },
            };
        }

        /* ---- Commit: one coherent mutation with full guards (T12/T13/T15/T18). */
        const isNeutral = parsed.protocol === 2 && parsed.outcome === 'no_change';
        const commit = deps.commitMutation({
            kind: 'optimizer',
            scopeKey: batch.scopeKey,
            lifecycleEpoch: batch.lifecycleEpoch,
            batchId,
            reason: `optimizer ${sourceLabel} range [${plan.start},${plan.end})`,
            expect: {
                memoryEpoch: batch.memoryEpoch,
                memoryRevision: batch.memoryRevision,
                canonicalFingerprint: batch.baseCanonicalFingerprint,
                rangeFingerprint: rangeFp,
                rangeStart: plan.start,
                rangeEnd: plan.end,
                checkpoint: batch.expectedCheckpoint,
            },
        }, (live) => {
            /* v0.6.0 (T9.4): schedule auto op tallies — declared FIRST: the
               lastResult object below reads them before the schedule block
               executes. */
            let scheduleAdded = 0;
            let scheduleResolved = 0;
            let scheduleIgnored = 0;
            let scheduleDropped = 0;
            let applied = { added: 0, updated: 0, deleted: 0, evicted: 0, diagnostics: null };
            /* v0.9 run diff: entries snapshot BEFORE the patch. */
            const entriesBefore = snapshotEntries(live.entries);
            if (!isNeutral) {
                applied = applyPatch(live, parsed.patch, {
                    fromMessage: plan.end - 1,
                    /* v0.8: raw index where the source chunk began. */
                    sourceStart: plan.start,
                    source: manual ? 'manual' : 'auto',
                    maxEntries: settingsNow.maxEntries,
                    /* v0.6.0 (F4): opt-in near-dedupe mode. */
                    dedupeMode: settingsNow.dedupeMode === 'near' ? 'near' : 'exact',
                    charName: retentionCharName(contextNow),
                });
            }
            /* v0.6.0 (T9.4/T9.5): schedule auto ops inside the SAME atomic
               mutation — runs BEFORE the lastResult capture so the tallies
               are the real ones. OFF ⇒ the ops are counted as ignored (never
               lost silently); ON ⇒ add/resolve/clock per the validated patch;
               auto-miss is a separate sub-toggle.
               v0.6.0 review-fix (B1): RESOLVE first, then ADD — validatePatch
               computes the cap as `active − resolves + adds` under that same
               assumption; add-first made mixed patches silently drop new
               appointments when the store sat near the cap. Any add that is
               still rejected (cap/dedupe) surfaces as scheduleDropped. */
            if (scheduleAutoEnabled) {
                for (const id of (parsed.scheduleResolve ?? [])) {
                    if (resolveScheduleEntry(live, id, 'done', { by: 'system' })) scheduleResolved += 1;
                }
                for (const spec of (parsed.scheduleAdd ?? [])) {
                    const result = addScheduleEntry(live, {
                        text: String(spec.text ?? ''),
                        mode: spec.when.mode === 'story_day' ? 'story_day' : 'after',
                        turns: spec.when.mode === 'after' ? Number(spec.when.in) : undefined,
                        day: spec.when.mode === 'story_day' ? Number(spec.when.storyDay) : undefined,
                        label: typeof spec.label === 'string' ? spec.label : undefined,
                        entities: Array.isArray(spec.entities) ? spec.entities : [],
                        lead: spec.lead !== undefined && spec.lead !== null ? Number(spec.lead) : undefined,
                        fromMessage: plan.end - 1,
                        source: 'auto',
                    }, { maxActive: settingsNow.maxScheduleActive });
                    if (result.ok) scheduleAdded += 1;
                    else {
                        scheduleDropped += 1;
                        console.warn(`[Memory Weaver] Schedule add from the optimizer was dropped (${result.reason}).`);
                    }
                }
                /* The model's clock NEVER overrides a manual one. */
                if (parsed.clock && parsed.clock.day && live.clock?.source !== 'manual') {
                    setStoryClock(live, parsed.clock.day, { source: 'auto' });
                }
                if (scheduleAutoMiss) {
                    const turnCount = Number(live.turnCount ?? 0);
                    const clockDay = Number(live.clock?.day ?? 0);
                    const resolvedNow = new Set((parsed.scheduleResolve ?? []).map(String));
                    for (const item of Array.isArray(live.schedule) ? live.schedule : []) {
                        if (item.status !== 'active' || resolvedNow.has(String(item.id))) continue;
                        const overdueAfter = item.when?.mode === 'after'
                            ? Number(item.when.dueTurn) + Number(item.lead ?? 0) + AUTO_MISS_GRACE
                            : item.when?.mode === 'story_day' ? Number(item.when.storyDay) + Number(item.lead ?? 0) + AUTO_MISS_GRACE : null;
                        const liveNow = item.when?.mode === 'after' ? turnCount : item.when?.mode === 'story_day' ? clockDay : null;
                        if (overdueAfter !== null && Number.isFinite(liveNow) && liveNow > overdueAfter) {
                            if (resolveScheduleEntry(live, item.id, 'missed', { by: 'system' })) scheduleResolved += 1;
                        }
                    }
                }
            } else {
                scheduleIgnored = (parsed.scheduleAdd?.length ?? 0) + (parsed.scheduleResolve?.length ?? 0) + (parsed.clock ? 1 : 0);
            }
            const effective = applied.added + applied.updated + applied.deleted;
            const outcome = isNeutral ? 'no_change' : (effective === 0 ? 'deduped' : 'changed');
            live.lastResult = {
                at: nowIso(),
                added: applied.added,
                updated: applied.updated,
                deleted: applied.deleted,
                outcome,
                sourceRange: { start: plan.start, end: plan.end },
                coverageCommitted: true,
                jobId: batchId,
                /* v0.6.0 (F5a): ops dropped because they touched locked entries. */
                protectedSkipped: applied.diagnostics?.protected_ids?.length ?? 0,
                /* v0.6.0 (T9.4): schedule auto op tallies (0 when OFF) — the
                   mutator's own locals (the `commit` binding is still in its
                   temporal dead zone while the mutator runs). */
                scheduleAdded,
                scheduleResolved,
                scheduleIgnored,
                scheduleDropped,
                /* v0.6.0 (U6a): execution record — additive. */
                ...execution,
            };
            /* v0.6.5: run history (lastResult.source stays null on success per
               the v0.5.1 contract; the run record always carries the label). */
            pushRunLog(live, { ...live.lastResult, source: manual ? 'manual' : 'auto', ...(runId ? { runId } : {}), ...changesField(entriesBefore, live.entries) });
            /* Cursor advances ONLY to the dispatched tail (T03); messages
               appended during the AI call stay pending. A targeted
               recent-window pass over a pending gap NEVER advances the
               cursor (B4.5). v0.6.5: the cursor NEVER moves backward — a
               'tail' commit whose range ends at/below the live cursor keeps
               it (recent-window pass whose budget stopped early). */
            const cursorBefore = Number(live.processedMessages ?? 0);
            if (advancePolicy === 'tail' && plan.end > cursorBefore) {
                live.processedMessages = plan.end;
            }
            live.lastRun = nowIso();
            /* Prefix fingerprint blocks are recomputed over the processed
               prefix at commit (B4.1) — digests are the "source state at last
               write" basis for later source-change detection; the trust flag
               stays processing.status. The claim is the (never-decreasing)
               cursor, so the blocks never shrink. */
            const chatNow = Array.isArray(contextNow?.chat) ? contextNow.chat : [];
            const claim = Math.max(0, Math.min(Number(live.processedMessages ?? 0), chatNow.length));
            /* v0.8 (dirty-range correctness): the LIVE processing record is
               the truth — an edit detected while the AI call was in flight
               may have moved dirtyFrom below what this batch saw. */
            const liveNeedsReview = live.processing.status === PROCESSING_STATUS.NEEDS_REVIEW;
            const liveDirty = liveNeedsReview ? mergeDirtyFrom(live.processing.dirtyFrom, null) : null;
            let nextDirty = liveDirty;
            let acknowledge = false;
            if (advancePolicy === 'review' && liveNeedsReview && liveDirty !== null) {
                /* The reviewed range [plan.start, plan.end) re-covers the dirty
                   region ONLY when the live dirty point is where this review
                   was dispatched from. An earlier live dirty point (user edited
                   below plan.start mid-flight) is KEPT: no advance, no
                   acknowledge. A live point inside/after the range (advanced
                   elsewhere) may only move forward. */
                if (liveDirty === plan.start || (liveDirty > plan.start && liveDirty <= plan.end)) {
                    nextDirty = plan.end;
                } else if (liveDirty > plan.end) {
                    nextDirty = liveDirty;
                }
                acknowledge = nextDirty >= Number(live.processedMessages ?? 0) && liveDirty >= plan.start;
            }
            if (acknowledge) {
                /* Review complete: recompute the whole prefix, status ok,
                   dirtyFrom null, shrunkTo null. The cursor is untouched. */
                live.processing = acknowledgeCoverage(live, chatNow);
            } else {
                /* Forward/tail commits (and unfinished reviews) while
                   needs_review keep status + dirtyFrom (+ shrunkTo, untouched)
                   and never rewrite the verified digests BELOW the dirty
                   block; blocks from floor(dirtyFrom/size) on are recomputed
                   over the current claim (commitPrefixBlocks). */
                /* The keep boundary is the PRE-commit live dirty point: a
                   review chunk that just re-covered [plan.start, plan.end)
                   must refresh those blocks (keeping their stale digests
                   would make every later reassess snap back to them). */
                live.processing.prefixBlocks = commitPrefixBlocks(live.processing.prefixBlocks, chatNow.slice(0, claim), liveDirty);
                if (liveNeedsReview) live.processing.dirtyFrom = nextDirty;
            }
            /* A committed range cannot contain the oversized message: clear
               the blocked marker when its index is now behind the cursor. */
            if (live.processing.blocked && Number(live.processing.blocked.rawIndex) < Number(live.processedMessages ?? 0)) {
                live.processing.blocked = null;
            }
            /* v0.6.0 (F1): persist the post-plan skipped list — self-healed
               indexes (message shrank below budget) leave the list. */
            if (Array.isArray(plan.skippedAfter)) {
                live.processing.skipped = plan.skippedAfter;
            }
            return { applied, outcome, isNeutral, batchId, rangeFp, scheduleAdded, scheduleResolved, scheduleIgnored, scheduleDropped };
        });

        if (!commit.ok) {
            /* Conflict: reject the whole batch atomically — nothing was
               written; the caller (index.js) re-queues under control. */
            recordFailure({ outcome: 'conflict', error: commit.reason, range: { start: plan.start, end: plan.end }, jobId: batchId, source: manual ? 'manual' : 'auto', scopeKey: batch.scopeKey, lifecycleEpoch: batch.lifecycleEpoch, runId, execution: { ...execution, stopReason: 'conflict' } });
            logWarn(`Optimizer batch rejected by guard ${commit.reason} — no partial write, batch dropped.`);
            return {
                terminal: true,
                stopReason: 'conflict',
                detail: commit.reason,
                record: { batchId, start: plan.start, end: plan.end, outcome: 'conflict', error: commit.reason, added: 0, updated: 0, deleted: 0 },
            };
        }

        runtime.markers.delete(markerKey);
        const result = commit.result ?? {};
        return {
            terminal: false,
            stopReason: null,
            record: {
                batchId,
                start: plan.start,
                end: plan.end,
                outcome: result.outcome ?? 'changed',
                added: result.applied?.added ?? 0,
                updated: result.applied?.updated ?? 0,
                deleted: result.applied?.deleted ?? 0,
                evicted: result.applied?.evicted ?? 0,
                protected: result.applied?.protected ?? 0,
            },
        };
    }

    /* Burst: up to `backlogMaxChunksPerRun` chunks (T01/T02/T26). */
    async function runBurst({ sourceLabel = 'auto', manual = false, maxChunks = null, forcedRange = null } = {}) {
        const runId = makeRunId();
        const settingsNow = settings();
        if (settingsNow.enabled === false) {
            return { ok: false, skipped: true, error: 'disabled', chunks: [], stopped: 'disabled' };
        }
        if (!manual && String(settingsNow.mode ?? 'auto') !== 'auto') {
            return { ok: false, skipped: true, error: 'mode_off', chunks: [], stopped: 'mode_off' };
        }

        const limit = clampNumber(maxChunks ?? settingsNow.backlogMaxChunksPerRun, { min: 1, max: 10, fallback: BACKLOG_CHUNKS_PER_RUN.default });
        const chunks = [];
        let stopped = null;
        let requeue = false;

        for (let i = 0; i < limit; i++) {
            if (typeof deps.isGenerationActive === 'function' && deps.isGenerationActive()) {
                stopped = 'generation_active';
                requeue = true;
                break;
            }
            const outcome = await runChunk({ sourceLabel, manual, forcedRange: i === 0 ? forcedRange : null, advancePolicy: forcedRange && i === 0 ? forcedRange.advancePolicy ?? 'tail' : 'tail', runId });
            if (outcome.record) chunks.push(outcome.record);
            if (outcome.stopReason === 'no_pending') { stopped = stopped ?? 'done'; break; }
            if (outcome.stopReason) {
                stopped = outcome.stopReason;
                requeue = ['generation_active', 'chat_switched', 'conflict'].includes(outcome.stopReason);
                break;
            }
        }
        if (!stopped && chunks.length >= limit) stopped = 'burst_limit';
        return { ...summarizeRun(chunks, stopped, requeue), runId };
    }

    function summarizeRun(chunks, stopped, requeue) {
        const committed = chunks.filter(chunk => chunk.outcome === 'changed' || chunk.outcome === 'deduped' || chunk.outcome === 'no_change');
        const totals = committed.reduce((acc, chunk) => ({
            added: acc.added + (chunk.added ?? 0),
            updated: acc.updated + (chunk.updated ?? 0),
            deleted: acc.deleted + (chunk.deleted ?? 0),
        }), { added: 0, updated: 0, deleted: 0 });
        const failed = chunks.some(chunk => chunk.outcome === 'failed' || chunk.outcome === 'conflict' || chunk.outcome === 'blocked');

        return {
            ok: committed.length > 0 && !failed,
            partiallyCommitted: committed.length > 0 && failed,
            chunks,
            totals,
            stopped,
            requeue,
            /* v0.5.2: skipped means "genuinely nothing pending" (the walk
               found no work). A burst that stopped before trying (generation
               active, chat switched, retry-blocked…) must NOT report
               skipped:true — that made the manual toast claim "no new
               messages" while 20/20 were waiting. */
            skipped: committed.length === 0 && chunks.length === 0 && (stopped === 'done' || stopped === null),
        };
    }

    /* Manual "Quét lại đoạn gần nhất": targeted pass over the last-60-counted
       window WITHOUT resetting the coverage cursor. The checkpoint advances
       only if the dispatched cursor already covered the whole window (no
       pending gap is ever claimed, plan B4.5). */
    async function runRecentWindow({ manual = true } = {}) {
        const chat = chatOf();
        const state = deps.loadState();
        const window = recentWindowRange(chat, CHUNK_MAX);
        if (window.eligibleCount === 0) {
            return { ok: false, skipped: true, error: 'no messages', chunks: [], stopped: 'no_pending' };
        }
        /* v0.6.0 (S7): a cursor beyond the chat length means the history was
           truncated/deleted below the cursor — NEVER clamp it (invariant 11).
           Surface needs_review and stop; the coverage detector owns the fix. */
        const rawCursor = Number(state.processedMessages ?? 0);
        if (rawCursor > chat.length) {
            return { ok: false, skipped: false, error: 'cursor beyond chat length', chunks: [], stopped: 'needs_review' };
        }
        const cursor = rawCursor;
        const crossesGap = window.start > cursor; // pending gap between cursor and window start
        /* The window is processed; the main checkpoint advances only when the
           dispatched cursor already covered the whole window start (no gap
           crossing). The AI patch still applies either way. */
        const outcome = await runBurst({
            sourceLabel: 'manual',
            manual,
            maxChunks: 1,
            forcedRange: { start: window.start, end: window.end, advancePolicy: crossesGap ? 'keepCursor' : 'tail' },
        });
        return { ...outcome, crossesGap };
    }

    /* v0.6.5: review from a dirty point. When coverage is `needs_review`
       with dirtyFrom D < cursor, re-run the optimizer over [D, cursor) in
       chunks (same guards/batch contract as runChunk; the prompt carries the
       existing memories so the model can update/delete stale ones). The
       cursor NEVER moves; each committed chunk advances processing.dirtyFrom
       to its end; reaching the cursor recomputes the prefix blocks over
       [0, cursor) and sets status ok. A dirty range with no eligible
       messages left is acknowledged directly (housekeeping). */
    async function runReviewFrom({ manual = true, maxChunks = null } = {}) {
        const settingsNow = settings();
        if (settingsNow.enabled === false) {
            return { ok: false, skipped: true, error: 'disabled', chunks: [], stopped: 'disabled' };
        }
        const limit = clampNumber(maxChunks ?? settingsNow.backlogMaxChunksPerRun, { min: 1, max: 10, fallback: BACKLOG_CHUNKS_PER_RUN.default });
        const runId = makeRunId();
        const chunks = [];
        let stopped = null;
        let requeue = false;
        let reviewed = false;

        for (let i = 0; i < limit; i++) {
            const state = deps.loadState();
            const chat = chatOf();
            const cursor = Number(state.processedMessages ?? 0);
            const dirtyFrom = state.processing?.dirtyFrom;
            if (state.processing?.status !== PROCESSING_STATUS.NEEDS_REVIEW || dirtyFrom === null || dirtyFrom === undefined || Number(dirtyFrom) >= cursor) {
                if (i === 0) return { ...summarizeRun(chunks, 'not_needed', false), skipped: true, reviewComplete: state.processing?.status === PROCESSING_STATUS.OK };
                stopped = 'done';
                reviewed = state.processing?.status === PROCESSING_STATUS.OK;
                break;
            }
            /* Deleted history below the cursor cannot be re-read (invariant
               11 — the cursor is never clamped). */
            if (cursor > chat.length) {
                stopped = 'needs_review';
                return { ...summarizeRun(chunks, stopped, false), error: 'cursor beyond chat length', reviewComplete: false };
            }
            if (typeof deps.isGenerationActive === 'function' && deps.isGenerationActive()) {
                stopped = 'generation_active';
                requeue = true;
                break;
            }
            const outcome = await runChunk({
                sourceLabel: 'review',
                manual,
                forcedRange: { start: Number(dirtyFrom), end: cursor },
                advancePolicy: 'review',
                runId,
            });
            if (outcome.record) chunks.push(outcome.record);
            if (outcome.stopReason === 'no_pending') {
                /* Nothing eligible left in [dirtyFrom, cursor): acknowledge. */
                const contextNow = context();
                const ack = deps.commitMutation({
                    kind: 'housekeeping',
                    scopeKey: String(contextNow.chatId ?? ''),
                    lifecycleEpoch: typeof deps.getLifecycleEpoch === 'function' ? deps.getLifecycleEpoch() : undefined,
                    expect: { checkpoint: cursor },
                    reason: 'review: no eligible messages left in the dirty range',
                }, (live) => {
                    live.processing = acknowledgeCoverage(live, chatOf(contextNow));
                    return { acknowledged: live.processing.status === PROCESSING_STATUS.OK };
                });
                stopped = ack.ok ? 'done' : 'conflict';
                reviewed = ack.ok && ack.result?.acknowledged === true;
                break;
            }
            if (outcome.stopReason) {
                stopped = outcome.stopReason;
                requeue = ['generation_active', 'chat_switched', 'conflict'].includes(outcome.stopReason);
                break;
            }
            if (deps.loadState().processing?.status === PROCESSING_STATUS.OK) {
                stopped = 'done';
                reviewed = true;
                break;
            }
        }
        if (!stopped) stopped = 'burst_limit';
        const summary = summarizeRun(chunks, stopped, requeue);
        return { ...summary, skipped: false, reviewComplete: reviewed, runId };
    }

    /* =====================================================================
     * v0.9 — Story chapters. One AI call per chapter; commit kind 'chapter'
     * (requires settings.enabled, never touches entries/cursor/coverage).
     * ===================================================================== */

    function chapterConfig(settingsArg) {
        const raw = settingsArg?.chapters && typeof settingsArg.chapters === 'object' ? settingsArg.chapters : {};
        return {
            enabled: raw.enabled !== false,
            everyMessages: clampNumber(raw.everyMessages, { min: 1, max: 1000, fallback: 100 }),
            budgetTokens: clampNumber(raw.budgetTokens, { min: 0, max: 8000, fallback: 600 }),
        };
    }

    function generationBusy() {
        return typeof deps.isGenerationActive === 'function' && deps.isGenerationActive();
    }

    function chatMovedSince(chatId, lifecycle) {
        const contextNow = context();
        const epochNow = typeof deps.getLifecycleEpoch === 'function' ? deps.getLifecycleEpoch() : undefined;
        return String(contextNow.chatId ?? '') !== chatId || epochNow !== lifecycle;
    }

    /* One chapter cycle. Returns { stopReason|null, record|null }.
       v0.9.1: `chapterId` targets one chapter (regenerated when stale, or
       always with `force`); new chapters plan over trailing stale chapters
       (planNextChapter staleIds/replaces); at CHAPTERS_MAX the two oldest
       adjacent unlocked chapters are merged in the same commit (no LLM
       call); every written chapter stores its sourceFingerprint. */
    async function runChapterStep({ manual, force, cfg, chapterId = null }) {
        const settingsNow = settings();
        if (settingsNow.enabled === false) return { stopReason: 'disabled', record: null };
        const integrityNow = typeof deps.stateIntegrity === 'function' ? deps.stateIntegrity() : null;
        if (integrityNow && integrityNow.ok === false) return { stopReason: 'state_corrupt', record: null };
        if (generationBusy()) return { stopReason: 'generation_active', record: null };

        const contextAtDispatch = context();
        const chat = chatOf(contextAtDispatch);
        const chatIdAtStart = String(contextAtDispatch.chatId ?? '');
        const lifecycleAtStart = typeof deps.getLifecycleEpoch === 'function' ? deps.getLifecycleEpoch() : undefined;
        const state = deps.loadState();
        const chapters = normalizeChapters(state.chapters);
        const staleIds = staleChapters(chapters, chat);
        const fingerprintOf = (from, to) => rangeFingerprintFn(chat, from, to);

        let start;
        let end;
        let target = null;
        let replaces = [];
        let mergeAtCap = false;
        if (chapterId !== null && chapterId !== undefined) {
            target = chapters.find(item => item.id === String(chapterId)) ?? null;
            if (!target) return { stopReason: 'no_chapter', record: null };
            if (target.locked === true) return { stopReason: 'locked', record: { outcome: 'skipped', error: 'chapter is locked', chapterId: target.id } };
            if (!force && !staleIds.includes(target.id)) return { stopReason: 'not_stale', record: null };
            if (target.endRaw > chat.length) return { stopReason: 'source_missing', record: { outcome: 'failed', error: 'chapter source messages no longer exist', chapterId: target.id } };
            start = target.startRaw;
            end = target.endRaw;
        } else if (force) {
            target = chapters[chapters.length - 1] ?? null;
            if (!target) return { stopReason: 'no_chapter', record: null };
            if (target.locked === true) return { stopReason: 'locked', record: { outcome: 'skipped', error: 'chapter is locked', chapterId: target.id } };
            if (target.endRaw > chat.length) return { stopReason: 'source_missing', record: { outcome: 'failed', error: 'chapter source messages no longer exist', chapterId: target.id } };
            start = target.startRaw;
            end = target.endRaw;
        } else {
            const plan = planNextChapter({ chat, cursor: Number(state.processedMessages ?? 0), chapters, everyMessages: cfg.everyMessages, staleIds });
            if (!plan) return { stopReason: 'not_enough', record: null };
            replaces = Array.isArray(plan.replaces) ? plan.replaces : [];
            /* v0.9.1 (audit3 #11): at the cap, merge instead of stopping —
               refuse BEFORE the AI call when nothing can be merged. */
            if (chapters.length - replaces.length >= CHAPTERS_MAX) {
                const probe = { chapters: chapters.filter(item => !replaces.includes(item.id)).map(item => ({ ...item })) };
                if (!mergeOldestChapters(probe).ok) return { stopReason: 'cap', record: null };
                mergeAtCap = true;
            }
            start = plan.start;
            end = plan.end;
        }

        const previousChapters = chapters.filter(item => item.endRaw <= start && item !== target && !replaces.includes(item.id)).slice(-2);
        const chapterNumber = target
            ? chapters.indexOf(target) + 1
            : Math.min(chapters.length - replaces.length, CHAPTERS_MAX - 1) + 1;
        const nameOf = speakerNameResolver(contextAtDispatch);
        const messages = sourceDescriptors(chat, start, end).filter(desc => desc.eligible).map(desc => ({ name: nameOf(desc), text: desc.text }));
        const inRange = value => value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= start && Number(value) < end;
        const memories = (Array.isArray(state.entries) ? state.entries : []).filter(entry => inRange(entry?.sourceStart) || inRange(entry?.fromMessage));
        const batchId = makeBatchId();
        const prompt = buildChapterPrompt({ messages, memories, previousChapters, settings: settingsNow, batchId, chapterNumber });
        const rangeFp = rangeFingerprintFn(chat, start, end);
        logDebug(`Chapter batch ${batchId}: raw [${start},${end}) — ${messages.length} message(s), ${memories.length} memor(ies)${target ? ` (regenerate chapter ${target.id})` : ''}.`);

        let response = '';
        try {
            response = await deps.generate({
                prompt: prompt.user,
                instructOverride: true,
                responseLength: OPTIMIZER_RESPONSE_LENGTH,
                systemPrompt: prompt.system,
            });
        } catch (error) {
            if (chatMovedSince(chatIdAtStart, lifecycleAtStart)) return { stopReason: 'chat_switched', record: null };
            const reason = String(error?.message ?? error);
            logWarn('Chapter summary failed (generate):', reason);
            return { stopReason: 'generate_failed', record: { outcome: 'failed', error: reason, start, end } };
        }
        if (chatMovedSince(chatIdAtStart, lifecycleAtStart)) {
            logWarn('Chapter batch aborted: the chat changed while the AI call was in flight.');
            return { stopReason: 'chat_switched', record: null };
        }

        const parsed = parseChapterResponse(response, { batchId });
        if (!parsed.ok) {
            logWarn('Chapter output rejected:', parsed.error, 'Raw (first 800 chars):', String(response ?? '').slice(0, 800));
            return { stopReason: 'parse_failed', record: { outcome: 'failed', error: parsed.error, start, end } };
        }

        let merged = null;
        const commit = deps.commitMutation({
            kind: 'chapter',
            scopeKey: chatIdAtStart,
            lifecycleEpoch: lifecycleAtStart,
            batchId,
            reason: `chapter ${target ? 'regenerate' : 'add'} [${start},${end})`,
            expect: { rangeFingerprint: rangeFp, rangeStart: start, rangeEnd: end },
        }, (live) => {
            /* Chapter-list guard (same turn as the write): the list must still
               be what this job planned against. A throw → mutator_error →
               nothing persisted. */
            const liveChapters = normalizeChapters(live.chapters);
            live.chapters = liveChapters;
            const sameRow = (row, planned) => Boolean(row) && row.id === planned.id && row.locked !== true && row.startRaw === planned.startRaw && row.endRaw === planned.endRaw;
            if (target) {
                const row = liveChapters.find(item => item.id === target.id);
                if (!sameRow(row, target)) throw new Error('chapter_conflict');
                if ((chapterId === null || chapterId === undefined) && liveChapters[liveChapters.length - 1] !== row) {
                    throw new Error('chapter_conflict');
                }
                removeChapter(live, target.id);
            } else {
                for (const id of replaces) {
                    const planned = chapters.find(item => item.id === id);
                    const row = live.chapters.find(item => item.id === id);
                    if (!planned || !sameRow(row, planned)) throw new Error('chapter_conflict');
                    removeChapter(live, id);
                }
                const lastEnd = live.chapters.reduce((max, item) => Math.max(max, item.endRaw), 0);
                if (lastEnd !== start) throw new Error('chapter_conflict');
                if (mergeAtCap || live.chapters.length >= CHAPTERS_MAX) {
                    const mergedNow = mergeOldestChapters(live, { fingerprintOf });
                    if (!mergedNow.ok) throw new Error('chapter_cap');
                    merged = mergedNow.mergedIds;
                }
            }
            const added = addChapter(live, { startRaw: start, endRaw: end, title: parsed.title, summary: parsed.summary, source: 'auto', sourceFingerprint: rangeFp });
            if (!added.ok) throw new Error(`chapter_${added.reason}`);
            return { chapterId: added.chapter.id };
        });
        if (!commit.ok) {
            const reason = commit.reason === 'mutator_error' ? String(commit.error?.message ?? 'chapter_conflict') : commit.reason;
            logWarn(`Chapter commit rejected (${reason}) — nothing written.`);
            return { stopReason: 'conflict', record: { outcome: 'conflict', error: reason, start, end } };
        }
        return {
            stopReason: null,
            record: {
                outcome: target || replaces.length ? 'replaced' : 'created',
                chapterId: commit.result?.chapterId ?? null,
                start,
                end,
                ...(replaces.length ? { replacedIds: [...replaces] } : {}),
                ...(merged ? { mergedIds: merged } : {}),
            },
        };
    }

    /* runChapters — up to `maxChapters` new chapters over the PROCESSED
       history (`force` = regenerate the LAST chapter, unless locked). Never
       moves the cursor. v0.9.1: `chapterId` = regenerate THAT chapter — only
       when it is stale (staleChapters), or unconditionally with `force`;
       locked → 'locked', not stale → 'not_stale', range beyond the chat →
       'source_missing'. Returns { ok, created, stopped, chunks, error? }.
       stopped ∈ done | not_enough | limit | disabled | chapters_off |
       state_corrupt | generation_active | chat_switched | generate_failed |
       parse_failed | conflict | cap | no_chapter | locked | source_missing |
       not_stale. */
    async function runChapters({ manual = true, maxChapters = 3, force = false, chapterId = null } = {}) {
        const settingsNow = settings();
        const cfg = chapterConfig(settingsNow);
        if (settingsNow.enabled === false) return { ok: false, created: 0, stopped: 'disabled', chunks: [], error: 'disabled' };
        if (!manual && !cfg.enabled) return { ok: false, created: 0, stopped: 'chapters_off', chunks: [], error: 'chapters_off' };
        const targeted = chapterId !== null && chapterId !== undefined && String(chapterId) !== '';
        const limit = force || targeted ? 1 : clampNumber(maxChapters, { min: 1, max: 20, fallback: 3 });
        const chunks = [];
        let created = 0;
        let stopped = null;
        for (let i = 0; i < limit; i++) {
            const step = await runChapterStep({ manual, force: force && i === 0, cfg, chapterId: targeted && i === 0 ? String(chapterId) : null });
            if (step.record) chunks.push(step.record);
            if (step.record && (step.record.outcome === 'created' || step.record.outcome === 'replaced')) created += 1;
            if (step.stopReason) {
                stopped = step.stopReason;
                break;
            }
        }
        if (!stopped) stopped = 'limit';
        if (stopped === 'not_enough' && created > 0) stopped = 'done';
        const failure = chunks.find(chunk => chunk.outcome === 'failed' || chunk.outcome === 'conflict');
        return {
            ok: created > 0 && !failure,
            created,
            stopped,
            chunks,
            ...(failure ? { error: failure.error } : {}),
        };
    }

    /* =====================================================================
     * v0.9 — Consolidation pass ("AI gộp & dọn memory"): update/delete only,
     * commit kind 'optimizer' with the memory guards but NO cursor/coverage
     * change and NO range fingerprint. lastResult/runLog source
     * 'consolidate'.
     * ===================================================================== */

    const CONSOLIDATION_MAX_DELETE_RATIO = 0.75;

    /* v0.9.1 (audit3 #7): every consolidation commit resets
       consolidation.sinceAuto and (unfocused runs) moves the rotation
       cursor past this batch; a failure record advances the cursor only
       (a batch the model keeps failing must not pin the rotation). */
    function consolidationAfter(live, nextCursor, { resetCounter }) {
        const current = normalizeConsolidation(live.consolidation);
        live.consolidation = {
            cursor: nextCursor === null || nextCursor === undefined ? current.cursor : nextCursor,
            sinceAuto: resetCounter ? 0 : current.sinceAuto,
        };
    }

    async function runConsolidationBatch({ batch, manual, focusEntity, runId = null, nextCursor = null }) {
        const settingsNow = settings();
        if (settingsNow.enabled === false) return { stopReason: 'disabled', record: null };
        const integrityNow = typeof deps.stateIntegrity === 'function' ? deps.stateIntegrity() : null;
        if (integrityNow && integrityNow.ok === false) return { stopReason: 'state_corrupt', record: null };

        const contextAtDispatch = context();
        const chatIdAtStart = String(contextAtDispatch.chatId ?? '');
        const lifecycleAtStart = typeof deps.getLifecycleEpoch === 'function' ? deps.getLifecycleEpoch() : undefined;
        const state = deps.loadState();
        const byId = new Map((Array.isArray(state.entries) ? state.entries : []).map(entry => [String(entry.id), entry]));
        const editable = batch.ids.map(id => byId.get(String(id))).filter(entry => entry && entry.locked !== true && entry.pinned !== true);
        if (!editable.length) return { stopReason: null, record: null }; // every id vanished / got locked since planning
        const readOnly = (batch.readOnlyIds ?? []).map(id => byId.get(String(id))).filter(entry => entry && (entry.locked === true || entry.pinned === true));
        const batchId = makeBatchId();
        const prompt = buildConsolidationPrompt({ entries: [...editable, ...readOnly], settings: settingsNow, batchId, focusEntity, chapters: chaptersForPrompt(settingsNow, state) });
        const snapshot = {
            memoryEpoch: Number(state.memoryEpoch ?? 0),
            memoryRevision: Number(state.memoryRevision ?? 0),
            fingerprint: canonicalFingerprintFn(state.entries),
        };
        const source = 'consolidate';
        const executionBase = {
            model: typeof deps.getModel === 'function' ? (String(deps.getModel() ?? '').trim() || null) : null,
            api: String(contextAtDispatch.mainApi ?? '').trim() || null,
        };
        const startedAt = now();
        const estInputTokens = Math.ceil(((prompt.system.length + prompt.user.length) / 4) * 1.15);
        const fail = (stopReason, error, execution, outcome = 'failed') => {
            recordFailure({
                outcome, error, range: null, jobId: batchId, source, scopeKey: chatIdAtStart, lifecycleEpoch: lifecycleAtStart, execution: { ...execution, stopReason }, runId,
                onCommit: nextCursor === null ? null : live => consolidationAfter(live, nextCursor, { resetCounter: false }),
            });
            return { stopReason, record: { batchId, outcome, error, added: 0, updated: 0, deleted: 0 } };
        };

        let response = '';
        try {
            response = await deps.generate({
                prompt: prompt.user,
                instructOverride: true,
                responseLength: OPTIMIZER_RESPONSE_LENGTH,
                systemPrompt: prompt.system,
            });
        } catch (error) {
            if (chatMovedSince(chatIdAtStart, lifecycleAtStart)) return { stopReason: 'chat_switched', record: null };
            return fail('generate_failed', String(error?.message ?? error), { ...executionBase, durationMs: Math.max(0, now() - startedAt), estInputTokens, estOutputChars: 0, estOutputTokens: 0 });
        }
        if (chatMovedSince(chatIdAtStart, lifecycleAtStart)) {
            logWarn('Consolidation batch aborted: the chat changed while the AI call was in flight.');
            return { stopReason: 'chat_switched', record: null };
        }
        const execution = { ...executionBase, durationMs: Math.max(0, now() - startedAt), estInputTokens, estOutputChars: response.length, estOutputTokens: Math.ceil(response.length / 4) };

        const parsed = parseOptimizerResponse(response, { batchId });
        if (!parsed.ok) return fail('parse_failed', parsed.error, execution);
        if (parsed.protocol !== 2) return fail('parse_failed', 'consolidation requires the protocol-2 envelope', execution);
        if (parsed.batchId !== batchId) return fail('batch_mismatch', 'batch id mismatch', execution);
        if ((parsed.patch.add ?? []).length) return fail('invalid_patch', 'consolidation may not add new memories', execution);
        const patch = { add: [], update: parsed.patch.update ?? [], delete: parsed.patch.delete ?? [] };
        if (patch.delete.length > 10 && patch.delete.length > editable.length * CONSOLIDATION_MAX_DELETE_RATIO) {
            return fail('invalid_patch', `consolidation tried to delete ${patch.delete.length} of ${editable.length} memories — refused`, execution);
        }
        const liveState = deps.loadState();
        const semantic = validatePatch(patch, { entries: liveState.entries, promptEntryIds: prompt.includedIds });
        if (!semantic.ok) return fail('invalid_patch', semantic.errors.join('; '), execution);

        const isNeutral = parsed.outcome === 'no_change';
        const commit = deps.commitMutation({
            kind: 'optimizer',
            scopeKey: chatIdAtStart,
            lifecycleEpoch: lifecycleAtStart,
            batchId,
            reason: 'consolidation pass',
            expect: {
                memoryEpoch: snapshot.memoryEpoch,
                memoryRevision: snapshot.memoryRevision,
                canonicalFingerprint: snapshot.fingerprint,
            },
        }, (live) => {
            const entriesBefore = snapshotEntries(live.entries);
            let applied = { added: 0, updated: 0, deleted: 0, evicted: 0, protected: 0, diagnostics: null };
            if (!isNeutral) {
                applied = applyPatch(live, patch, {
                    maxEntries: settingsNow.maxEntries,
                    dedupeMode: 'exact',
                    charName: retentionCharName(context()),
                });
            }
            const effective = applied.updated + applied.deleted;
            const outcome = isNeutral ? 'no_change' : (effective === 0 ? 'deduped' : 'changed');
            live.lastResult = {
                at: nowIso(),
                added: 0,
                updated: applied.updated,
                deleted: applied.deleted,
                outcome,
                sourceRange: null,
                coverageCommitted: false,
                jobId: batchId,
                source,
                protectedSkipped: applied.diagnostics?.protected_ids?.length ?? 0,
                ...execution,
            };
            pushRunLog(live, { ...live.lastResult, ...(runId ? { runId } : {}), ...changesField(entriesBefore, live.entries) });
            consolidationAfter(live, nextCursor, { resetCounter: true });
            return { applied, outcome };
        });
        if (!commit.ok) return fail('conflict', commit.reason, execution, 'conflict');
        const result = commit.result ?? {};
        return {
            stopReason: null,
            record: {
                batchId,
                outcome: result.outcome ?? 'changed',
                added: 0,
                updated: result.applied?.updated ?? 0,
                deleted: result.applied?.deleted ?? 0,
                evicted: result.applied?.evicted ?? 0,
                protected: result.applied?.protected ?? 0,
            },
        };
    }

    /* runConsolidation — up to `maxBatches` batches (≤80 entries each,
       grouped by primary entity, largest groups first). Returns the runBurst
       aggregate shape { ok, chunks, totals, stopped, requeue, skipped,
       partiallyCommitted, error? }. */
    async function runConsolidation({ manual = true, focusEntity = null, maxBatches = 4 } = {}) {
        const settingsNow = settings();
        if (settingsNow.enabled === false) {
            return { ok: false, skipped: true, error: 'disabled', chunks: [], totals: { added: 0, updated: 0, deleted: 0 }, stopped: 'disabled', requeue: false, partiallyCommitted: false };
        }
        const integrityNow = typeof deps.stateIntegrity === 'function' ? deps.stateIntegrity() : null;
        if (integrityNow && integrityNow.ok === false) {
            return { ok: false, skipped: false, error: 'state_corrupt', chunks: [], totals: { added: 0, updated: 0, deleted: 0 }, stopped: 'state_corrupt', requeue: false, partiallyCommitted: false };
        }
        /* v0.9.1 (audit3 #7): unfocused runs start at the persisted rotation
           cursor (a batch offset) and advance it in their commits, so
           repeated runs cover every group; a focused run neither reads nor
           moves it. */
        const stateAtPlan = deps.loadState();
        const rotate = !focusEntity;
        const startGroup = rotate ? normalizeConsolidation(stateAtPlan.consolidation).cursor : 0;
        const batches = planConsolidationBatches(stateAtPlan.entries, { focusEntity, batchMax: CONSOLIDATION_BATCH_MAX, startGroup });
        const limit = clampNumber(maxBatches, { min: 1, max: 20, fallback: 4 });
        const runId = makeRunId();
        const chunks = [];
        let stopped = null;
        let requeue = false;
        const runnable = batches.slice(0, limit);
        for (const batch of runnable) {
            if (generationBusy()) {
                stopped = 'generation_active';
                requeue = true;
                break;
            }
            const nextCursor = rotate ? (batch.index + 1) % batches.length : null;
            const outcome = await runConsolidationBatch({ batch, manual, focusEntity, runId, nextCursor });
            if (outcome.record) chunks.push(outcome.record);
            if (outcome.stopReason) {
                stopped = outcome.stopReason;
                requeue = ['generation_active', 'chat_switched', 'conflict'].includes(outcome.stopReason);
                break;
            }
        }
        if (!stopped) stopped = batches.length > limit ? 'burst_limit' : 'done';
        const summary = summarizeRun(chunks, stopped, requeue);
        const failure = chunks.find(chunk => chunk.outcome === 'failed' || chunk.outcome === 'conflict');
        return { ...summary, runId, ...(failure ? { error: failure.error } : {}) };
    }

    function resetRetryMarkers() {
        runtime.markers.clear();
    }

    function retryMarkerCount() {
        return runtime.markers.size;
    }

    return { runBurst, runChunk, runRecentWindow, runReviewFrom, runChapters, runConsolidation, resetRetryMarkers, retryMarkerCount };
}
