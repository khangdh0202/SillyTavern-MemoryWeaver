/* processing-core.js — PURE processing pipeline core. No ST imports.
 *
 * Responsibilities (R1 hardening):
 * - Source descriptors per message (text/role/name/eligibility, [dice:...] strip)
 * - planNextBatch: earliest-unprocessed range [startRaw, endRawExclusive),
 *   CHUNK_MAX as a CEILING (never "last 60"), input-budget bounded
 * - rangeFingerprint / prefixFingerprintBlocks: ordered canonical fingerprints
 *   used by the mutation boundary and the source-change detector
 * - canonicalEntriesFingerprint: the live-canonical fingerprint guards
 * - validatePatch: structural/semantic patch validation against live state
 * - estimateOptimizerInputTokens: chars/4 + ~15% margin (an ESTIMATE, recorded
 *   in diagnostics — there is no real tokenizer in R1)
 */

import { isCountedChatMessage, cleanText, PROCESSING_STATUS } from './store.js';
import { payloadDigest } from './recall-core.js';
import { optimizerSystemPrompt, rankExistingForPrompt, existingLimitFor } from './summarizer.js';

export const SOURCE_POLICY_VERSION = 1;
export const PREFIX_BLOCK_SIZE = 50;
export const CHUNK_MAX = 60;

const DICE_MARKER = /\[dice:#[0-9a-f]+[^\]]*\]/gi;

/* Canonical source text of a raw chat message: dice markers stripped
 * (same rule the old collectChunk used), trimmed. */
export function canonicalSourceText(mes) {
    return String(mes?.mes ?? '').replace(DICE_MARKER, '').trim();
}

/* Per-message source descriptor under policy v1. Eligibility mirrors the
 * optimizer's view of "a message" (isCountedChatMessage) AND requires
 * non-empty canonical text (collectChunk skipped those too). */
export function sourceDescriptor(chat, index) {
    const mes = Array.isArray(chat) ? chat[index] : null;
    if (!mes) return { rawIndex: index, eligible: false, text: '', role: 'unknown', name: '', isUser: false };
    const text = canonicalSourceText(mes);
    const eligible = Boolean(isCountedChatMessage(mes)) && text.length > 0;
    return {
        rawIndex: index,
        eligible,
        text,
        role: mes.is_user ? 'user' : 'assistant',
        name: String(mes.name ?? ''),
        isUser: mes.is_user === true,
    };
}

/* Descriptors for a raw range [start, end). */
export function sourceDescriptors(chat, start = 0, end = null) {
    const list = Array.isArray(chat) ? chat : [];
    const from = Math.max(0, Math.floor(Number(start) || 0));
    const to = end == null ? list.length : Math.min(list.length, Math.max(from, Math.floor(Number(end) || 0)));
    const out = [];
    for (let i = from; i < to; i++) out.push(sourceDescriptor(list, i));
    return out;
}

function descriptorStreamDigest(descriptors) {
    /* Chained digest: each message folds into the previous hash so ANY edit,
     * deletion or reordering inside the covered range changes the digest. */
    let chain = '';
    for (const desc of descriptors) {
        chain = payloadDigest(`${chain}|${desc.rawIndex}|${desc.role}|${desc.name}|${desc.eligible ? 1 : 0}|${desc.text}`);
    }
    return chain;
}

/* Fingerprint of the raw source range [start, end) — content + order +
 * eligibility. An appended message beyond `end` does NOT change it; an edit,
 * delete or swipe inside the range does. */
export function rangeFingerprint(chat, start, end) {
    return descriptorStreamDigest(sourceDescriptors(chat, start, end));
}

/* Cumulative prefix fingerprint blocks: digests[k] = chained digest of the
 * canonical stream over raw indices [0, min((k+1)*blockSize, len)). Blocks are
 * cut at fixed boundaries so a mismatch localizes the earliest CERTAIN block
 * boundary. An empty processed prefix yields []. */
export function prefixFingerprintBlocks(chat, blockSize = PREFIX_BLOCK_SIZE) {
    const list = Array.isArray(chat) ? chat : [];
    const size = Math.max(1, Math.floor(Number(blockSize) || PREFIX_BLOCK_SIZE));
    const digests = [];
    let chain = '';
    for (let start = 0; start < list.length; start += size) {
        const end = Math.min(start + size, list.length);
        for (let i = start; i < end; i++) {
            const desc = sourceDescriptor(list, i);
            chain = payloadDigest(`${chain}|${desc.rawIndex}|${desc.role}|${desc.name}|${desc.eligible ? 1 : 0}|${desc.text}`);
        }
        digests.push(chain);
    }
    return { size, digests };
}

/* Compare stored prefix blocks against a fresh recompute.
 * Returns { clean, dirtyFrom, unverified }:
 * - unverified: no stored digests (legacy state) — NOT a mismatch.
 * - dirtyFrom: earliest certain block boundary whose coverage is suspect;
 *   null when clean. Overshoot (cursor > chat length with a fully matching
 *   computed prefix) reports dirtyFrom = computed digest span end. */
export function comparePrefixBlocks(stored, computed, { cursor = 0, chatLength = 0 } = {}) {
    const storedDigests = Array.isArray(stored?.digests) ? stored.digests : [];
    const computedDigests = Array.isArray(computed?.digests) ? computed.digests : [];
    if (!storedDigests.length) {
        return { clean: false, dirtyFrom: null, unverified: true };
    }
    for (let k = 0; k < computedDigests.length; k++) {
        if (storedDigests[k] !== computedDigests[k]) {
            return { clean: false, dirtyFrom: k * (Number(stored?.size) || PREFIX_BLOCK_SIZE), unverified: false };
        }
    }
    if (storedDigests.length > computedDigests.length || Number(cursor) > Number(chatLength)) {
        /* Processed coverage claims messages that no longer exist (or whose
         * blocks cannot be recomputed). Everything from the end of the
         * verifiable prefix onward is suspect. */
        return { clean: false, dirtyFrom: computedDigests.length * (Number(computed?.size) || PREFIX_BLOCK_SIZE), unverified: false };
    }
    return { clean: true, dirtyFrom: null, unverified: false };
}

/* Canonical fingerprint of the store's entries — the live mutation guard.
 * Includes every entry field the optimizer/user flows may change. */
export function canonicalEntriesFingerprint(entries) {
    const list = Array.isArray(entries) ? entries : [];
    let chain = '';
    for (const entry of list) {
        const part = [
            String(entry?.id ?? ''),
            (Array.isArray(entry?.entities) ? entry.entities : []).join(','),
            String(entry?.text ?? ''),
            String(entry?.importance ?? ''),
            String(entry?.createdAt ?? ''),
            String(entry?.source ?? ''),
            String(entry?.fromMessage ?? ''),
            String(entry?.fromScheduleId ?? ''),
            /* v0.6.0 (F5a): a lock toggle IS a canonical change — in-flight
               jobs that saw the unlocked store must not commit over it. */
            entry?.locked === true ? 'locked' : '',
            /* v0.8: a pin flip changes what the injection carries — canonical
               like a lock. Appended ONLY when pinned so unpinned entries keep
               their pre-v0.8 digest byte-for-byte. */
            ...(entry?.pinned === true ? ['pinned'] : []),
        ].join('\u0001');
        chain = payloadDigest(`${chain}|${part}`);
    }
    return chain;
}

/* Counted messages in the raw window [from, to) — same predicate as the
 * optimizer eligibility (counted AND non-empty canonical text). */
export function countEligible(chat, from = 0, to = null) {
    const list = Array.isArray(chat) ? chat : [];
    const start = Math.max(0, Math.floor(Number(from) || 0));
    const end = to == null ? list.length : Math.min(list.length, Math.max(start, Math.floor(Number(to) || 0)));
    let count = 0;
    for (let i = start; i < end; i++) {
        if (sourceDescriptor(list, i).eligible) count++;
    }
    return count;
}

/* Raw index of the first counted message of the LAST `count` counted
 * messages — the "Quét lại đoạn gần nhất" window (raw indices, cursor-safe:
 * never used to reset the coverage cursor). */
export function recentWindowRange(chat, count = CHUNK_MAX) {
    const list = Array.isArray(chat) ? chat : [];
    const want = Math.max(1, Math.floor(Number(count) || CHUNK_MAX));
    const indexes = [];
    for (let i = list.length - 1; i >= 0 && indexes.length < want; i--) {
        if (sourceDescriptor(list, i).eligible) indexes.push(i);
    }
    if (!indexes.length) return { start: list.length, end: list.length, eligibleCount: 0 };
    const start = indexes[indexes.length - 1];
    return { start, end: list.length, eligibleCount: indexes.length };
}

/* =========================================================================
 * Input budget estimator (approximate — no real tokenizer in R1)
 * chars/4 → tokens, then +15% safety margin. Recorded as an ESTIMATE.
 * ========================================================================= */

const PROMPT_SCAFFOLD_CHARS = 600; // section headers + task instructions
const EXISTING_LINE_OVERHEAD_CHARS = 40; // "- id:xxxx [ents] (importance N) "
/* v0.6.5: minimum counted messages per chunk even when the fixed prompt cost
   (system + scaffold + existing memories) eats the whole budget — without a
   floor every chunk shrank to ONE message (one LLM call per message, the
   backlog never drained). The floor still respects the message-only budget
   and the single-oversized-message block. */
export const MIN_CHUNK_MESSAGES = 10;
/* v0.8: existing-memories trim (fixed cost ≥ budget): target ≤ budget × 1.25,
   never fewer than EXISTING_MIN_IN_PROMPT entries kept for dedupe context. */
export const EXISTING_TRIM_TARGET_RATIO = 1.25;
export const EXISTING_MIN_IN_PROMPT = 20;

function existingCharsOf(existingEntries, limit = existingLimitFor({}), chunk = []) {
    /* Same cap as the prompt (existingLimitFor(settings) — v0.9 knob
       optimizerExistingMax, legacy 100): never budget for entries the
       prompt would not include.
       v0.9.1 (audit3 #12): budget the SAME ranked set the prompt sends
       (rankExistingForPrompt — chunk speakers first, importance, newest);
       the old slice(0, limit) measured the first N in STORAGE order. */
    const list = Array.isArray(existingEntries) ? existingEntries : [];
    const ranked = list.length > limit ? rankExistingForPrompt(list, chunk, limit) : list.slice(0, limit);
    let existingChars = 0;
    for (const entry of ranked) {
        existingChars += EXISTING_LINE_OVERHEAD_CHARS
            + (Array.isArray(entry?.entities) ? entry.entities.join(', ').length : 0)
            + String(entry?.text ?? '').length;
    }
    return existingChars;
}

const charsToTokens = chars => Math.ceil((chars / 4) * 1.15);

export function estimateOptimizerInputTokens({ existingEntries = [], messages = [], systemChars = 0, contextChars = 0, existingLimit = null } = {}) {
    const existingChars = existingCharsOf(existingEntries, existingLimit === null || existingLimit === undefined ? existingLimitFor({}) : existingLimit, messages);
    let messageChars = 0;
    for (const item of (Array.isArray(messages) ? messages : [])) {
        messageChars += String(item?.name ?? '').length + 2 + String(item?.text ?? '').length + 1;
    }
    const system = Math.max(0, Math.floor(Number(systemChars) || 0));
    /* v0.9: extra fixed prompt context (the "Story so far" chapter section). */
    const context = Math.max(0, Math.floor(Number(contextChars) || 0));
    const totalChars = system + PROMPT_SCAFFOLD_CHARS + context + existingChars + messageChars;
    const tokens = charsToTokens(totalChars);
    return { systemChars: system, existingChars, messageChars, totalChars, tokens, ...(context ? { contextChars: context } : {}) };
}

/* v0.8: default raised 6000 → 12000 (index.js DEFAULT_SETTINGS mirrors it). */
export const OPTIMIZER_INPUT_BUDGET = { default: 12000, min: 2000, max: 32000 };
export const BACKLOG_CHUNKS_PER_RUN = { default: 2, min: 1, max: 10 };

function clampSetting(value, bounds) {
    const num = Math.round(Number(value));
    if (!Number.isFinite(num)) return bounds.default;
    return Math.min(bounds.max, Math.max(bounds.min, num));
}

/* Plans the next optimizer batch: the EARLIEST unprocessed eligible range,
 * capped by CHUNK_MAX counted messages AND the estimated input budget.
 * Returns { ok, start, end, eligibleCount, descriptors, estimate, blocked?,
 *           skippedAfter? }:
 * - start/end are RAW chat indices ([start, end)).
 * - Ineligible (system/tool/narrator/empty) messages between eligible ones
 *   are covered by the range (the cursor passes them) but add no input cost.
 * - A single message that exceeds the WHOLE budget by itself is never
 *   truncated: the plan reports blocked { rawIndex, reason } and the caller
 *   must not advance past it.
 * - v0.6.0 (F1): `skipped` lists oversized messages the user chose to pass
 *   over — still-oversized ones are walked past (no cost, no block, no
 *   descriptor); one that SHRANK below the budget self-heals out of the
 *   list (skippedAfter = the list minus healed indexes, persist at commit). */
/* v0.6.5 options:
 * - systemChars: length of the system prompt that will be sent (default:
 *   optimizerSystemPrompt(settings).length) — part of the input cost.
 * - limitEnd: raw exclusive upper bound for the walk (forced/review ranges)
 *   — descriptors never come from beyond it.
 * - resolveName(desc): the speaker name the PROMPT will print (persona /
 *   fallback names) so the estimate and the prompt measure the same text.
 * Result adds `existingOverBudget` (fixed cost ≥ budget — the UI should
 *   warn: the existing-memories block alone fills the input budget) and
 *   `fixedTokens`. */
/* v0.9: `contextChars` = length of extra fixed prompt context (the chapter
 * "Story so far" section) — budgeted like the system prompt; the existing-
 * memories cap follows existingLimitFor(settings) (optimizerExistingMax). */
export function planNextBatch({ chat, cursor = 0, existingEntries = [], settings = {}, skipped = [], systemChars = null, limitEnd = null, resolveName = null, contextChars = 0 } = {}) {
    const list = Array.isArray(chat) ? chat : [];
    const len = list.length;
    const start = Math.max(0, Math.min(Number(cursor) || 0, len));
    const walkEnd = limitEnd === null || limitEnd === undefined || !Number.isFinite(Number(limitEnd))
        ? len
        : Math.max(start, Math.min(len, Math.floor(Number(limitEnd))));
    const budgetTokens = clampSetting(settings.optimizerInputBudgetTokens, OPTIMIZER_INPUT_BUDGET);
    const chunkCap = CHUNK_MAX;
    const skipList = (Array.isArray(skipped) ? skipped : [])
        .map(item => ({ rawIndex: Math.max(0, Math.floor(Number(item?.rawIndex)) || 0), reason: String(item?.reason ?? 'oversized_message').slice(0, 60) }));
    const systemLength = systemChars === null || systemChars === undefined || !Number.isFinite(Number(systemChars))
        ? optimizerSystemPrompt(settings).length
        : Math.max(0, Math.floor(Number(systemChars)));
    const nameOf = desc => {
        if (typeof resolveName === 'function') {
            const resolved = resolveName(desc);
            if (resolved !== null && resolved !== undefined) return String(resolved);
        }
        return desc.name;
    };

    let eligibleCount = 0;
    let end = start;
    const descriptors = [];
    const healed = new Set();

    /* v0.6.0 (P3): the fixed cost is CONSTANT per plan — computed once. */
    const existingCap = existingLimitFor(settings);
    const contextLength = Math.max(0, Math.floor(Number(contextChars) || 0));
    const fixedChars = systemLength + PROMPT_SCAFFOLD_CHARS + contextLength + existingCharsOf(existingEntries, existingCap);
    const fixedTokens = charsToTokens(fixedChars);
    const existingOverBudget = fixedTokens >= budgetTokens;
    /* The floor only engages when the FIXED cost dominates (> half the
       budget) — the starvation case. A normal store keeps the strict
       "never exceed the budget" rule. */
    const floorActive = fixedTokens * 2 > budgetTokens;
    let floorApplied = false;
    let messageCharsSoFar = 0;

    for (let i = start; i < walkEnd; i++) {
        const desc = sourceDescriptor(list, i);
        if (!desc.eligible) continue;
        if (eligibleCount >= chunkCap) break;

        const skipEntry = skipList.find(item => item.rawIndex === i);
        const lineChars = nameOf(desc).length + 2 + desc.text.length + 1;
        const lineTokens = Math.ceil(lineChars / 4);
        if (lineTokens > budgetTokens) {
            /* Already user-skipped: walk past it — no eligibleCount, no
               descriptor, and crucially no blocked marker (the escape hatch). */
            if (skipEntry) continue;
            if (eligibleCount === 0) {
                return {
                    ok: false,
                    start,
                    end: start,
                    eligibleCount: 0,
                    descriptors: [],
                    estimate: null,
                    blocked: { rawIndex: i, reason: 'oversized_message' },
                    skippedAfter: skipList,
                    existingOverBudget,
                    fixedTokens,
                    floorApplied: false,
                    existingTrimmed: 0,
                    existingLimit: null,
                };
            }
            break;
        }
        /* Input budget: the accumulated chunk + the fixed cost must fit the
           budget estimate (chars/4 + ~15% margin). Once at least one message
           is in the range, stop BEFORE the one that would push the estimate
           over the budget.
           v0.6.5 floor: below MIN_CHUNK_MESSAGES only the MESSAGE text has to
           fit the budget — a fixed cost that eats the budget can no longer
           shrink every chunk to a single message. */
        if (eligibleCount > 0) {
            const projectedTokens = charsToTokens(fixedChars + messageCharsSoFar + lineChars);
            if (projectedTokens > budgetTokens) {
                const messageOnlyTokens = charsToTokens(messageCharsSoFar + lineChars);
                const floorAllows = floorActive && eligibleCount < MIN_CHUNK_MESSAGES && messageOnlyTokens <= budgetTokens;
                if (!floorAllows) break;
                floorApplied = true;
            }
        }
        /* Self-heal: a skipped message that fits the budget again leaves the
           list (it is planned normally from now on). */
        if (skipEntry) healed.add(i);
        eligibleCount += 1;
        end = i + 1;
        descriptors.push(desc);
        messageCharsSoFar += lineChars;
    }

    const skippedAfter = skipList.filter(item => !healed.has(item.rawIndex));

    if (eligibleCount === 0) {
        return { ok: true, start, end, eligibleCount: 0, descriptors: [], estimate: null, blocked: null, skippedAfter, existingOverBudget, fixedTokens, floorApplied, existingTrimmed: 0, existingLimit: null };
    }

    const messages = descriptors.map(desc => ({ name: nameOf(desc), text: desc.text }));
    /* v0.8 budget honesty: when the fixed cost alone fills the budget, the
       existing-memories set SENT to the prompt is trimmed from the tail of
       the prompt's own ranking (chunk speakers first, then importance, then
       newest) until the estimate is ≤ budget × 1.25 — never below
       EXISTING_MIN_IN_PROMPT entries (dedupe context). `existingLimit` is
       what the runner passes to buildOptimizerPrompt (null = untrimmed). */
    let existingForEstimate = existingEntries;
    let existingLimit = null;
    let existingTrimmed = 0;
    if (existingOverBudget) {
        const ranked = rankExistingForPrompt(existingEntries, messages, existingCap);
        const target = Math.floor(budgetTokens * EXISTING_TRIM_TARGET_RATIO);
        const lineCharsOf = entry => EXISTING_LINE_OVERHEAD_CHARS
            + (Array.isArray(entry?.entities) ? entry.entities.join(', ').length : 0)
            + String(entry?.text ?? '').length;
        let existingChars = ranked.reduce((sum, entry) => sum + lineCharsOf(entry), 0);
        const baseChars = systemLength + PROMPT_SCAFFOLD_CHARS + contextLength + messageCharsSoFar;
        let keep = ranked.length;
        const floor = Math.min(ranked.length, EXISTING_MIN_IN_PROMPT);
        while (keep > floor && charsToTokens(baseChars + existingChars) > target) {
            keep -= 1;
            existingChars -= lineCharsOf(ranked[keep]);
        }
        if (keep < ranked.length) {
            existingTrimmed = ranked.length - keep;
            existingLimit = keep;
            existingForEstimate = ranked.slice(0, keep);
        }
    }

    const estimate = estimateOptimizerInputTokens({
        existingEntries: existingForEstimate,
        messages,
        systemChars: systemLength,
        contextChars: contextLength,
        existingLimit: existingCap,
    });
    return { ok: true, start, end, eligibleCount, descriptors, estimate, blocked: null, skippedAfter, existingOverBudget, fixedTokens, floorApplied, existingTrimmed, existingLimit };
}

/* v0.8: earliest dirty point — min of the non-null values (null/undefined/
 * non-finite are ignored; both absent → null). index.js reassessCoverage
 * merges the stored dirtyFrom with a fresh verdict through this so a later
 * edit never hides an earlier unreviewed one. */
export function mergeDirtyFrom(current, next) {
    const valid = [current, next]
        .filter(value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)))
        .map(value => Math.max(0, Math.floor(Number(value))));
    return valid.length ? Math.min(...valid) : null;
}

/* v0.8: prefix digests for a commit while coverage is needs_review. The
 * digests of blocks wholly below the dirty point (k < floor(dirtyFrom/size))
 * are KEPT from the stored list (they were verified); blocks from the dirty
 * block onward are recomputed over the current claim. The unreviewed region
 * stays visible through processing.status/dirtyFrom (which the commit keeps)
 * — the digests only serve later edit detection. Without a dirty point this
 * is a plain recompute. */
export function commitPrefixBlocks(stored, claimedChat, dirtyFrom = null, blockSize = PREFIX_BLOCK_SIZE) {
    const computed = prefixFingerprintBlocks(claimedChat, blockSize);
    const dirty = mergeDirtyFrom(dirtyFrom, null);
    const storedDigests = Array.isArray(stored?.digests) ? stored.digests : [];
    if (dirty === null || Number(stored?.size) !== computed.size) return computed;
    const keepCount = Math.min(Math.floor(dirty / computed.size), storedDigests.length, computed.digests.length);
    return { size: computed.size, digests: [...storedDigests.slice(0, keepCount), ...computed.digests.slice(keepCount)] };
}

/* v0.6.5: "acknowledge source changes" — the user accepts the current source
 * as the covered prefix: prefix blocks are recomputed over [0, cursor) and
 * the status becomes ok (dirtyFrom null). PURE: returns the NEW processing
 * object (call inside commitMutation kind 'housekeeping' and assign it to
 * live.processing). The cursor is never touched. A cursor beyond the chat
 * length cannot be acknowledged (coverage claims messages that no longer
 * exist — invariant 11): the processing object comes back unchanged
 * (status stays as it was — callers can detect that by `status !== 'ok'`). */
export function acknowledgeCoverage(state, chat) {
    const list = Array.isArray(chat) ? chat : [];
    const processing = state?.processing && typeof state.processing === 'object' ? state.processing : {};
    const cursor = Math.max(0, Math.floor(Number(state?.processedMessages ?? 0)) || 0);
    if (cursor > list.length) {
        return { ...processing };
    }
    return {
        ...processing,
        prefixBlocks: prefixFingerprintBlocks(list.slice(0, cursor)),
        status: PROCESSING_STATUS.OK,
        dirtyFrom: null,
        /* v0.8: an acknowledged/reviewed prefix has no pending shrink
           (index.js pulls the cursor back BEFORE calling this). */
        shrunkTo: null,
    };
}

/* =========================================================================
 * Patch validation (B2.3) — pure, against live state + the prompt's entry
 * ids. Structural problems are ERRORS (no coercion); unknown or un-prompted
 * ids reject the batch atomically; an update that would create an
 * exact-text duplicate of ANOTHER entry rejects too.
 * ========================================================================= */

export function validatePatch(patch, { entries = [], promptEntryIds = [], scheduleOps = null, promptScheduleIds = [], maxScheduleActive = null, activeScheduleCount = null } = {}) {
    const errors = [];
    const list = Array.isArray(entries) ? entries : [];
    const storeIds = new Set(list.map(entry => String(entry?.id ?? '')));
    const promptIds = new Set((Array.isArray(promptEntryIds) ? promptEntryIds : []).map(String));

    const adds = Array.isArray(patch?.add) ? patch.add : [];
    adds.forEach((add, i) => {
        if (!add || typeof add !== 'object' || Array.isArray(add)) { errors.push(`add[${i}]: not an object`); return; }
        if (!String(add?.text ?? '').trim()) errors.push(`add[${i}]: empty text`);
    });

    const deletes = Array.isArray(patch?.delete) ? patch.delete : [];
    /* v0.6.5: ids deleted by this same patch are not duplicate targets —
       "update a → b's text + delete b" is a legal merge. */
    const deletedInPatch = new Set(deletes.map(id => String(id ?? '')));
    /* v0.6.5: compare exactly what applyPatch stores (cleanText: NFC +
       whitespace collapse + length cap), case-insensitive. */
    const comparable = value => cleanText(value).toLowerCase();
    const updateTexts = new Map();

    const updates = Array.isArray(patch?.update) ? patch.update : [];
    for (let i = 0; i < updates.length; i++) {
        const upd = updates[i];
        if (!upd || typeof upd !== 'object' || Array.isArray(upd)) { errors.push(`update[${i}]: not an object`); continue; }
        const id = String(upd?.id ?? '');
        if (!id) { errors.push(`update[${i}]: missing id`); continue; }
        if (!storeIds.has(id)) { errors.push(`update[${i}]: unknown id ${id}`); continue; }
        if (!promptIds.has(id)) { errors.push(`update[${i}]: id ${id} was not shown to the model`); continue; }
        const normalized = comparable(upd?.text ?? '');
        if (normalized) {
            const duplicateOf = list.find(entry => String(entry?.id ?? '') !== id
                && !deletedInPatch.has(String(entry?.id ?? ''))
                && comparable(entry?.text ?? '') === normalized);
            if (duplicateOf) { errors.push(`update[${i}]: exact duplicate of ${duplicateOf.id}`); continue; }
            /* v0.6.5: two updates in one patch may not converge on one text. */
            const previousIndex = updateTexts.get(normalized);
            if (previousIndex !== undefined) { errors.push(`update[${i}]: same text as update[${previousIndex}]`); continue; }
            updateTexts.set(normalized, i);
        }
    }

    deletes.forEach((id, i) => {
        const key = String(id ?? '');
        if (!storeIds.has(key)) { errors.push(`delete[${i}]: unknown id ${key}`); return; }
        if (!promptIds.has(key)) errors.push(`delete[${i}]: id ${key} was not shown to the model`);
    });

    /* v0.6.0 (T9.2): schedule ops — validated ONLY when the runner passes
       `scheduleOps` (i.e. scheduleAuto.enabled). The resolve ids must come
       from the prompt's own active list; `when` shapes are re-checked; and
       (active − resolves + adds) may not exceed the configured cap. */
    if (scheduleOps && typeof scheduleOps === 'object') {
        const schedulePromptIds = new Set((Array.isArray(promptScheduleIds) ? promptScheduleIds : []).map(String));
        const schedAdds = Array.isArray(scheduleOps.add) ? scheduleOps.add : [];
        const schedResolves = Array.isArray(scheduleOps.resolve) ? scheduleOps.resolve : [];
        schedResolves.forEach((id, i) => {
            const key = String(id ?? '');
            if (!schedulePromptIds.has(key)) errors.push(`schedule_resolve[${i}]: id ${key} was not shown to the model`);
        });
        schedAdds.forEach((item, i) => {
            const when = item?.when;
            if (!when || typeof when !== 'object') { errors.push(`schedule_add[${i}]: missing when`); return; }
            if (when.mode === 'after') {
                const turns = Number(when.in);
                if (!Number.isFinite(turns) || turns < 1) errors.push(`schedule_add[${i}]: when.in must be ≥ 1`);
            } else if (when.mode === 'story_day') {
                const day = Number(when.storyDay);
                if (!Number.isFinite(day) || day < 1) errors.push(`schedule_add[${i}]: when.storyDay must be ≥ 1`);
            } else {
                errors.push(`schedule_add[${i}]: when.mode must be "after" or "story_day"`);
            }
            if (!String(item?.text ?? '').trim()) errors.push(`schedule_add[${i}]: empty text`);
        });
        if (maxScheduleActive !== null && Number.isFinite(Number(maxScheduleActive)) && activeScheduleCount !== null) {
            /* v0.6.0 review-fix (A2): dedupe resolve ids — the runtime resolve
               is idempotent per entry, so counting duplicate resolves
               over-credited the cap estimate. */
            const distinctResolves = new Set(schedResolves.map(String)).size;
            const activeCount = Math.max(0, Number(activeScheduleCount) - distinctResolves + schedAdds.length);
            if (activeCount > Number(maxScheduleActive)) errors.push(`schedule_add: would exceed the active appointment cap (${activeCount} > ${maxScheduleActive})`);
        }
    }

    return { ok: errors.length === 0, errors };
}

/* =========================================================================
 * Story chapters (v0.9) — range planner. Only PROCESSED history (raw
 * indices below the coverage cursor) is ever summarized.
 * ========================================================================= */

export const CHAPTER_EVERY_DEFAULT = 100;
export const CHAPTER_EVERY_BOUNDS = { min: 1, max: 1000 };

/* Next chapter range: starts at the last chapter's endRaw (or 0) and ends at
 * the SMALLEST raw index ≤ cursor (and ≤ chat length) where the eligible
 * message count of [start, end) reaches `everyMessages`. Returns
 * `{ start, end, countedInRange, replaces }` or null when not enough
 * processed messages are pending.
 * v0.9.1 (audit3 #10) — `staleIds` (from staleChapters; default [] = the
 * v0.9.0 behavior, `replaces` always []): the TRAILING run of stale,
 * UNLOCKED chapters (e.g. their messages were deleted, so their range now
 * points past the chat and appending after them could never fire again) is
 * planned OVER — the next chapter starts at the end of the last NON-stale
 * chapter, but ONLY when that end is contiguous with the first trailing
 * stale chapter's start (no gap, nothing locked in between); the plan then
 * lists those chapters in `replaces` and the committer must remove them in
 * the same commit. A stale chapter followed by a fresh one is never planned
 * over (regenerate it with runChapters({ chapterId })); a gap falls back to
 * the legacy start (after the last chapter). */
export function planNextChapter({ chat, cursor = 0, chapters = [], everyMessages = CHAPTER_EVERY_DEFAULT, staleIds = [] } = {}) {
    const list = Array.isArray(chat) ? chat : [];
    const every = Number.isFinite(Number(everyMessages)) && Number(everyMessages) > 0
        ? Math.min(CHAPTER_EVERY_BOUNDS.max, Math.max(CHAPTER_EVERY_BOUNDS.min, Math.floor(Number(everyMessages))))
        : CHAPTER_EVERY_DEFAULT;
    const sorted = (Array.isArray(chapters) ? chapters : [])
        .filter(item => item && typeof item === 'object')
        .map(item => ({ item, start: Math.floor(Number(item.startRaw)) || 0, end: Math.floor(Number(item.endRaw)) || 0 }))
        .sort((a, b) => (a.start - b.start) || (a.end - b.end));
    let startAt = sorted.reduce((max, row) => Math.max(max, row.end), 0);
    let replaces = [];
    const stale = new Set((Array.isArray(staleIds) ? staleIds : []).map(String));
    if (stale.size && sorted.length) {
        let first = sorted.length;
        while (first > 0 && stale.has(String(sorted[first - 1].item.id ?? '')) && sorted[first - 1].item.locked !== true) first -= 1;
        if (first < sorted.length) {
            const freshEnd = sorted.slice(0, first).reduce((max, row) => Math.max(max, row.end), 0);
            if (freshEnd === sorted[first].start) {
                startAt = freshEnd;
                replaces = sorted.slice(first).map(row => String(row.item.id ?? ''));
            }
        }
    }
    const limit = Math.min(list.length, Math.max(0, Math.floor(Number(cursor) || 0)));
    let counted = 0;
    for (let i = startAt; i < limit; i++) {
        if (sourceDescriptor(list, i).eligible) counted += 1;
        if (counted >= every) return { start: startAt, end: i + 1, countedInRange: counted, replaces };
    }
    return null;
}

/* v0.9.1 (audit3 #10): ids of chapters whose source no longer matches —
 * range beyond the chat (history deleted) or a stored sourceFingerprint
 * that differs from rangeFingerprint(chat, startRaw, endRaw) (edit / delete
 * / reorder inside the range; deletions BELOW a chapter shift its raw
 * indices, which also changes the digest). A chapter without
 * sourceFingerprint (pre-v0.9.1) is stale only when its range is beyond the
 * chat. PURE. */
export function staleChapters(chapters, chat) {
    const list = Array.isArray(chat) ? chat : [];
    const out = [];
    for (const chapter of Array.isArray(chapters) ? chapters : []) {
        if (!chapter || typeof chapter !== 'object') continue;
        const start = Math.floor(Number(chapter.startRaw));
        const end = Math.floor(Number(chapter.endRaw));
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        const beyond = end > list.length;
        const mismatch = !beyond && typeof chapter.sourceFingerprint === 'string' && chapter.sourceFingerprint
            && rangeFingerprint(list, start, end) !== chapter.sourceFingerprint;
        if (beyond || mismatch) out.push(String(chapter.id ?? ''));
    }
    return out;
}

/* =========================================================================
 * Consolidation batches (v0.9) — pure planner for the AI merge/cleanup pass.
 * ========================================================================= */

const entityKey = name => String(name ?? '').normalize('NFC').trim().toLowerCase();

/* v0.9.1 (audit3 #7): canonical primary entity — the entry's entity keys
 * SORTED, first non-USER key (USER only when it is the sole tag), so the
 * same fact tagged ['Rika','USER'] and ['USER','Rika'] (or ['Minh','Rika']
 * vs ['Rika','Minh']) lands in the SAME group/batch. Untagged → ''. */
export function canonicalPrimaryEntity(entities) {
    const keys = [...new Set((Array.isArray(entities) ? entities : []).map(entityKey).filter(Boolean))].sort();
    return keys.find(key => key !== 'user') ?? keys[0] ?? '';
}

/* Groups the EDITABLE entries (not locked/pinned) by canonical primary
 * entity (canonicalPrimaryEntity; untagged entries form one group) and
 * packs them into batches of ≤ batchMax ids (a group larger than batchMax is
 * split, oldest first). v0.9.1: groups are ordered by KEY (stable — the old
 * largest-first order reshuffled as consolidation shrank groups, so a
 * rotating cursor skipped groups), the untagged group last; `startGroup`
 * (= state.consolidation.cursor, a BATCH offset) rotates the returned list
 * so it starts at batch `startGroup mod batches.length` — the runner
 * advances the cursor so repeated runs cover every batch. `focusEntity`
 * restricts the pool to entries tagged with it (NFC, case-insensitive).
 * Each batch carries `readOnlyIds`: locked/pinned entries sharing the
 * batch's primary entities (≤ readOnlyMax) — prompt context the model may
 * not target — and `index` (its position BEFORE rotation). Returns
 * `[{ ids, readOnlyIds, entities, index }]`. */
export function planConsolidationBatches(entries, { focusEntity = null, batchMax = 80, readOnlyMax = 30, startGroup = 0 } = {}) {
    const list = (Array.isArray(entries) ? entries : []).filter(entry => entry && String(entry.id ?? '') !== '' && String(entry.text ?? '').trim());
    const max = Math.max(1, Math.floor(Number(batchMax) || 80));
    const focus = entityKey(focusEntity);
    const tagged = entry => (Array.isArray(entry.entities) ? entry.entities : []);
    const inFocus = entry => !focus || tagged(entry).some(name => entityKey(name) === focus);
    const isProtected = entry => entry.locked === true || entry.pinned === true;
    const primary = entry => canonicalPrimaryEntity(tagged(entry));
    const displayName = (entry, key) => String(tagged(entry).find(name => entityKey(name) === key) ?? '').trim();
    const byAge = (a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));

    const groups = new Map();
    for (const entry of list) {
        if (isProtected(entry) || !inFocus(entry)) continue;
        const key = primary(entry);
        if (!groups.has(key)) groups.set(key, { key, name: displayName(entry, key), members: [] });
        groups.get(key).members.push(entry);
    }
    const ordered = [...groups.values()].sort((a, b) => ((a.key === '') - (b.key === '')) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const batches = [];
    let current = null;
    const flush = () => { if (current && current.ids.length) batches.push(current); current = null; };
    for (const group of ordered) {
        const members = [...group.members].sort(byAge);
        if (members.length > max) {
            flush();
            for (let i = 0; i < members.length; i += max) {
                batches.push({ ids: members.slice(i, i + max).map(entry => String(entry.id)), keys: new Set([group.key]), entities: [group.name] });
            }
            continue;
        }
        if (current && current.ids.length + members.length > max) flush();
        if (!current) current = { ids: [], keys: new Set(), entities: [] };
        current.ids.push(...members.map(entry => String(entry.id)));
        current.keys.add(group.key);
        current.entities.push(group.name);
    }
    flush();

    const protectedEntries = list.filter(isProtected).sort(byAge);
    const planned = batches.map((batch, index) => ({
        ids: batch.ids,
        readOnlyIds: protectedEntries.filter(entry => batch.keys.has(primary(entry))).slice(0, Math.max(0, Math.floor(Number(readOnlyMax) || 0))).map(entry => String(entry.id)),
        entities: batch.entities,
        index,
    }));
    const offset = planned.length ? (Math.max(0, Math.floor(Number(startGroup) || 0)) % planned.length) : 0;
    return offset ? [...planned.slice(offset), ...planned.slice(0, offset)] : planned;
}

/* Batch id: code-generated nonce for the echo-template guard (protocol 2
 * must echo it back). */
export function makeBatchId() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
