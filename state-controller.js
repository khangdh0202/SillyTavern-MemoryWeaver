/* state-controller.js — THE single mutation boundary for the chat-local
 * memoryWeaverState variable (R1 hardening, plan §5.2/§5.3).
 *
 * Every write path goes through commitMutation: re-read the LIVE state,
 * verify the guards, run a SYNC pure mutator, plan retention when entries
 * changed, bump memoryRevision when the canonical entries fingerprint
 * changed, persist once. There are NO awaits between the first guard and
 * the persist — setLocalVariable mutates chat_metadata synchronously
 * (verified: public/scripts/variables.js), so guard+write+persist run in a
 * single JS turn. Durability is debounced by ST (saveMetadataDebounced).
 *
 * kinds: 'optimizer' | 'user' | 'schedule' | 'housekeeping' | 'vector-meta' | 'chapter' (v0.9)
 * - Only a change in the canonical ENTRIES fingerprint bumps memoryRevision
 *   (schedule/clock/turnCount/vector metadata never do).
 * - Schedule/turnCount/vector metadata always come from the live state —
 *   nothing is restored from a dispatch snapshot.
 */

import { planRetention, DEFAULT_MAX_ENTRIES } from './store.js';

/* v0.9: the allowed mutation kinds. 'chapter' = story-chapter commits
 * (requires settings.enabled like 'optimizer'; never touches entries, so it
 * never bumps memoryRevision). An unknown kind is refused ('unknown_kind');
 * an absent kind stays legal (legacy callers/tests). */
export const MUTATION_KINDS = Object.freeze(['optimizer', 'user', 'schedule', 'housekeeping', 'vector-meta', 'chapter']);
const ENABLED_REQUIRED_KINDS = new Set(['optimizer', 'chapter']);

export function createStateController(deps) {
    const required = ['loadState', 'persistState'];
    for (const name of required) {
        if (typeof deps?.[name] !== 'function') throw new Error(`state-controller: missing dep ${name}`);
    }

    function contextChat() {
        const context = typeof deps.getContext === 'function' ? deps.getContext() : null;
        return Array.isArray(context?.chat) ? context.chat : [];
    }

    function entriesCap() {
        const settings = typeof deps.getSettings === 'function' ? (deps.getSettings() ?? {}) : {};
        return Math.max(1, Math.min(500, Number(settings.maxEntries) || DEFAULT_MAX_ENTRIES));
    }

    /* The one and only state mutation entry point. Fully synchronous. */
    function commitMutation(request, mutator) {
        const req = request ?? {};
        const expect = req.expect ?? {};

        /* 0. Kind allow-list (v0.9). */
        if (req.kind !== undefined && !MUTATION_KINDS.includes(req.kind)) {
            return { ok: false, reason: 'unknown_kind', live: null };
        }

        /* 1. Scope guard: the dispatching chat must still be open. */
        if (req.scopeKey !== undefined) {
            const context = typeof deps.getContext === 'function' ? deps.getContext() : null;
            if (String(context?.chatId ?? '') !== String(req.scopeKey)) {
                return { ok: false, reason: 'scope', live: null };
            }
        }

        /* 2. Lifecycle epoch: chat switch (A→B→A) invalidates old jobs. */
        if (req.lifecycleEpoch !== undefined && typeof deps.getLifecycleEpoch === 'function') {
            if (deps.getLifecycleEpoch() !== req.lifecycleEpoch) {
                return { ok: false, reason: 'lifecycle', live: null };
            }
        }

        /* 3. State integrity: corrupt/unparseable/future-schema raw is never
           overwritten (the recovery copy keeps the original data). */
        const integrity = typeof deps.stateIntegrity === 'function' ? deps.stateIntegrity() : null;
        if (integrity && integrity.ok === false) {
            return { ok: false, reason: integrity.reason || 'state_corrupt', live: null };
        }

        /* 4. Re-read the live state — everything below runs on THIS object
           in ONE synchronous turn (no await is legal from here on). */
        const live = deps.loadState();
        const settings = typeof deps.getSettings === 'function' ? (deps.getSettings() ?? {}) : {};

        /* 5. Expectation guards (reject BEFORE any mutation happens). */
        if (expect.memoryEpoch !== undefined && Number(live.memoryEpoch ?? 0) !== expect.memoryEpoch) {
            return { ok: false, reason: 'memory_epoch', live };
        }
        if (expect.memoryRevision !== undefined && Number(live.memoryRevision ?? 0) !== expect.memoryRevision) {
            return { ok: false, reason: 'memory_revision', live };
        }
        if (expect.canonicalFingerprint !== undefined && typeof deps.canonicalFingerprint === 'function') {
            const liveFingerprint = deps.canonicalFingerprint(live.entries);
            if (liveFingerprint !== expect.canonicalFingerprint) {
                return { ok: false, reason: 'canonical_fingerprint', live };
            }
        }
        if (expect.rangeFingerprint !== undefined && typeof deps.rangeFingerprint === 'function') {
            const chat = contextChat();
            const liveFingerprint = deps.rangeFingerprint(chat, expect.rangeStart ?? 0, expect.rangeEnd ?? chat.length);
            if (liveFingerprint !== expect.rangeFingerprint) {
                return { ok: false, reason: 'source_range', live };
            }
        }
        if (expect.checkpoint !== undefined && Number(live.processedMessages ?? 0) !== expect.checkpoint) {
            return { ok: false, reason: 'checkpoint', live };
        }

        /* 6. Permission gate (only the optimizer write path requires the
           extension to stay enabled through the flight). */
        if (ENABLED_REQUIRED_KINDS.has(req.kind) && settings.enabled === false) {
            return { ok: false, reason: 'permission', live };
        }

        /* 7. Run the pure mutator. An async mutator is a contract violation
           — reject instead of persisting a half-mutated object. */
        const beforeFingerprint = typeof deps.canonicalFingerprint === 'function' ? deps.canonicalFingerprint(live.entries) : null;
        let result;
        try {
            result = mutator(live);
        } catch (error) {
            return { ok: false, reason: 'mutator_error', error, live };
        }
        if (result && typeof result.then === 'function') {
            return { ok: false, reason: 'mutator_async', live };
        }

        /* 8. Write-time retention: reads never evict, so every commit
           converges the store to the configured cap with a change record. */
        /* v0.9 retention v2: foundation protection needs the character name
           (group chats rotate name2 → USER-tag only, same as recall). */
        const retentionContext = typeof deps.getContext === 'function' ? (deps.getContext() ?? {}) : {};
        const charName = retentionContext.groupId ? '' : String(retentionContext.name2 ?? '');
        const retention = planRetention(live.entries, entriesCap(), { charName });
        const changeDescription = { evicted: 0 };
        if (retention.evicted.length) {
            live.entries = retention.kept;
            changeDescription.evicted = retention.evicted.length;
            changeDescription.evictedIds = retention.evicted.map(entry => entry.id);
            changeDescription.evictedReasons = { ...(retention.reasons ?? {}) };
        }

        /* v0.6.5: overCap is a POST-mutation fact (the loaded flag described
           the pre-mutation store). Locked entries can keep it true. */
        live.overCap = (Array.isArray(live.entries) ? live.entries.length : 0) > entriesCap();

        /* 9. Revision bump ONLY when the canonical entries changed. */
        if (typeof deps.canonicalFingerprint === 'function') {
            const afterFingerprint = deps.canonicalFingerprint(live.entries);
            if (afterFingerprint !== beforeFingerprint) {
                live.memoryRevision = (Number(live.memoryRevision ?? 0)) + 1;
            }
        }

        /* 10. One coherent persist (sync; guarded — a persist throw means
           NO success result is reported, T25).
           v0.6.0 (S9) — NO-ROLLBACK CONTRACT: when persistState throws, the
           mutated `live` object is NOT rolled back — it is simply dropped.
           This is safe ONLY because the host's loadState() returns a FRESH
           normalized object on every call (the mutated object is never
           cached anywhere). Any future host that caches loadState results
           must add an explicit rollback here first. */
        try {
            deps.persistState(live);
        } catch (error) {
            return { ok: false, reason: 'persist_failed', error, live };
        }

        return {
            ok: true,
            result,
            revision: Number(live.memoryRevision ?? 0),
            epoch: Number(live.memoryEpoch ?? 0),
            overCap: live.overCap === true,
            changeDescription,
        };
    }

    return { commitMutation };
}
