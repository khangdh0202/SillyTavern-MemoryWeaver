import { extension_settings, getContext } from '../../../extensions.js';
import { generateRaw, setExtensionPrompt, extension_prompt_types, extension_prompt_roles, saveSettingsDebounced } from '../../../../script.js';
import { eventSource, event_types } from '../../../events.js';
import { getLocalVariable, setLocalVariable } from '../../../variables.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { POPUP_TYPE, POPUP_RESULT, callGenericPopup } from '../../../popup.js';
import { getChatCompletionModel } from '../../../openai.js';
import { STATE_VARIABLE, STORE_VERSION, normalizeState, applyPatch, filterByEntities, buildInjectionBlock, parseMemoryFile, exportToMarkdown, countChatMessages, isCountedChatMessage, addScheduleEntry, updateScheduleEntryResult, resolveScheduleEntry, postponeScheduleEntryResult, setStoryClock, clearSchedule, scheduleStateOf, scheduleRemaining, buildScheduleBlocks, PROCESSING_STATUS, emptyVectorMeta, applyDefaultSettings, countedPrefixArray, selectInjectionEntries, renameEntity, mergeEntries, buildChaptersBlock, updateChapter, removeChapter, revertRunChanges, revertRunGroup, bumpAutoRunCounter } from './store.js';
import { mergeRecall, createMentionTest, shortHash, applyRecentFloor, foundationIdsFor, findDuplicateClusters } from './recall-core.js';
import { initRetriever, bumpEpoch, syncIndex, scheduleSync, refreshRecall, getRecallSelection, peekRecallSelection, awaitFreshRecall, getRecallStamp, getStatus as getRetrieverStatus, isRetrievalEnabled, getWaitBudgetMs, embeddingKeyFor } from './retriever.js';
import { canonicalEntriesFingerprint, rangeFingerprint, prefixFingerprintBlocks, comparePrefixBlocks, SOURCE_POLICY_VERSION, acknowledgeCoverage as acknowledgedProcessing, planNextChapter, staleChapters } from './processing-core.js';
import { createStateController } from './state-controller.js';
import { createOptimizerRunner } from './optimizer-runner.js';
import { createVectorClient } from './vector-client.js';
import { createDashboard } from './dashboard.js';
import { tr, trn, setUiLanguage, resolveUiLanguage, getUiLanguage, uiLocale, UI_LANGUAGE_SETTINGS } from './i18n.js';
import { getCurrentLocale } from '../../../i18n.js';

const MODULE_NAME = 'memoryweaver';
const INJECT_KEY = 'memoryweaver_block';
/* Schedule injection keys (v0.3.0) — written ONLY by updateScheduleInjection:
   upcoming block rides at the memories depth, the due/overdue escalation
   sits shallower so the model cannot miss it. */
const SCHEDULE_KEY = 'memoryweaver_schedule';
const SCHEDULE_DUE_KEY = 'memoryweaver_schedule_due';
/* v0.9.0: chapter summaries ("story so far") ride the main prompt
   (IN_PROMPT, after the story string) — written ONLY by updateInjection. */
const CHAPTERS_KEY = 'memoryweaver_chapters';
/* OpenRouter (and similar providers) count reasoning tokens INSIDE max_tokens:
   a thinking model with a high reasoning effort can burn the budget entirely
   and return empty content. R1 keeps the generous completion budget but NO
   LONGER clamps the user's global reasoning effort (no request-scoped
   override exists in ST 1.18.0 — the old clamp mutated global settings and
   restored them, which could clobber user changes made mid-flight). */
const OPTIMIZER_RESPONSE_LENGTH = 4096;
/* Recovery copy for a corrupt chat state: the raw variable is copied here
   (bounded) before anything may overwrite it; writes are refused until the
   user repairs the state manually. */
const STATE_RECOVERY_VARIABLE = 'memoryWeaverState_recovery';
const RECOVERY_MAX_CHARS = 50000;

const DEFAULT_SETTINGS = {
    enabled: true,
    mode: 'auto',
    threshold: 20,
    maxEntries: 150,
    injectEnabled: true,
    injectBudgetTokens: 600,
    promptOverride: '',
    /* v0.6.0 (F4): 'exact' = legacy byte-identical dedupe; 'near' = opt-in
       paraphrase dedupe (Jaccard token-set, threshold is a constant). */
    dedupeMode: 'exact',
    scheduleEnabled: true,
    scheduleBudgetTokens: 120,
    maxScheduleActive: 20,
    /* v0.6.0 (S8/F10): schedule AUTO ops — OFF by default (the v0.5.x strict
       protocol lesson: the model must earn write access). autoMiss is a
       separate sub-toggle (silently-overdue appointments → missed). */
    scheduleAuto: { enabled: false, autoMiss: false },
    /* R1 hardening settings (plan §B3.1): the optimizer input budget is an
       ESTIMATE (chars/4 + ~15% margin) and the burst processes at most
       backlogMaxChunksPerRun chunks of ≤60 counted messages per run. */
    optimizerInputBudgetTokens: 12000,
    backlogMaxChunksPerRun: 2,
    retrieval: {
        enabled: false,
        source: 'transformers',
        model: '',
        topK: 16,
        queryDepth: 4,
        queryMaxChars: 1200,
        waitBudgetMs: 400,
    },
    /* v0.9.0: story chapters — every N counted (already processed) messages
       the AI writes a chapter summary; the "story so far" rides the main
       prompt and the optimizer prompt for long-arc coherence. */
    chapters: { enabled: true, everyMessages: 100, budgetTokens: 600 },
    /* v0.9.0: AI consolidation pass (merge paraphrases, supersede stale
       facts, drop trivia). autoEvery = run automatically after every N auto
       passes (0 = manual only). */
    consolidation: { autoEvery: 0 },
    /* v0.9.0: how many existing memories the optimizer sees (was a fixed 100). */
    optimizerExistingMax: 150,
    /* v0.9.0: the generate interceptor waits up to this long for a fresh
       vector recall before the prompt is assembled (0 = never wait). */
    recallWaitMs: 1500,
    /* UI language: 'en' (default) | 'vi' | 'auto' (follow the SillyTavern
       locale). UI only — prompts sent to the AI are never translated. */
    uiLanguage: 'en',
};

/* v0.9.0: "Siêu thông minh" preset — quality over token cost. The previous
   values are kept in settings.presetBackup so one click restores them. */
const SMART_PRESET = {
    injectBudgetTokens: 2000,
    optimizerInputBudgetTokens: 24000,
    backlogMaxChunksPerRun: 4,
    optimizerExistingMax: 250,
    maxEntries: 300,
    dedupeMode: 'near',
    recallWaitMs: 2000,
    'retrieval.enabled': true,
    'scheduleAuto.enabled': true,
    'chapters.enabled': true,
    'chapters.everyMessages': 80,
    'chapters.budgetTokens': 1000,
    'consolidation.autoEvery': 5,
};

let runQueued = false;
let runTimer = null;
let generationActive = false;
/* v0.5.3: the ST event pairing is asymmetric — GENERATION_STARTED fires for
   EVERY Generate() call (dryRun included, early aborts included) while
   GENERATION_ENDED only fires from hideStopButton() when the stop button was
   actually shown (dryRun skips deactivateSendButtons entirely). One dry-run
   or early-aborted generation therefore sticks the flag and "Tối ưu ngay"
   forever claims "AI đang trả lời". The flag is now cross-checked against
   hard UI state (stop button visible / body[data-generating]) and heals
   itself when no signal backs it for GENERATION_STALE_MS. */
let generationStartedAt = 0;
const GENERATION_STALE_MS = 10 * 1000;

function generationHardSignal() {
    const stopButton = document.querySelector('#mes_stop');
    if (stopButton && window.getComputedStyle(stopButton).display !== 'none') return true;
    if (document.body && document.body.dataset && document.body.dataset.generating === 'true') return true;
    return false;
}

function isGenerationBusy() {
    if (!generationActive) return false;
    if (generationHardSignal()) return true;
    if (Date.now() - generationStartedAt > GENERATION_STALE_MS) {
        generationActive = false;
        console.warn('[Memory Weaver] generationActive was stuck (GENERATION_STARTED never followed by GENERATION_ENDED — dry-run or early abort) — healed.');
        return false;
    }
    return true;
}
/* Lifecycle epoch: bumped on CHAT_CHANGED; optimizer jobs capture it at
   dispatch and a commit from a previous chat lifetime is rejected (T14). */
let memoryLifecycleEpoch = 0;
/* True while a conflict-triggered requeue is itself in flight — prevents a
   conflict↔requeue LLM-call loop while the user keeps editing (bounded
   re-fetch, plan §5.3). Reset on new messages / chat switch. */
let conflictRequeued = false;
const stateIntegrity = { ok: true, reason: '' };
const busListeners = new Map();
/* v0.6.0 (T2.3): one-level in-memory undo for destructive actions. NEVER
   persisted (a state variable must stay clean); cleared on CHAT_CHANGED. */
let undoSlot = null;

function getSettings() {
    /* v0.6.0 (P7): deep-default IN PLACE — the settings object identity is
       stable across calls (the old Object.assign built a fresh object and
       swapped extension_settings.memoryweaver on every read). */
    const current = extension_settings[MODULE_NAME];
    const normalized = applyDefaultSettings(current ?? {}, DEFAULT_SETTINGS);
    if (current !== normalized) extension_settings[MODULE_NAME] = normalized;
    return normalized;
}

/* =========================================================================
 * State integrity + the single mutation boundary (R1-B1)
 * ========================================================================= */

function markStateCorrupt(raw, reason) {
    stateIntegrity.ok = false;
    stateIntegrity.reason = reason;
    console.warn(`[Memory Weaver] Chat memory state is ${reason}. Writes are BLOCKED so nothing is silently overwritten. A bounded recovery copy was stored in the "${STATE_RECOVERY_VARIABLE}" local variable — inspect/restore it manually (e.g. /setvar), then reload the chat.`);
    try {
        setLocalVariable(STATE_RECOVERY_VARIABLE, String(raw ?? '').slice(0, RECOVERY_MAX_CHARS));
    } catch (error) {
        console.warn('[Memory Weaver] Failed to store the recovery copy:', error);
    }
}

/* v0.6.0 (P2): the parse+normalize+integrity body, cached by raw string +
   caps. loadState() = structuredClone(readState()). */
const readStateCache = { raw: null, capsKey: '', state: null };

function parseStateRaw(raw) {
    if (!raw) {
        stateIntegrity.ok = true;
        stateIntegrity.reason = '';
        return normalizeState(null, stateCap(), scheduleCap());
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        markStateCorrupt(raw, 'unparseable (broken JSON)');
        void error;
        return normalizeState(null, stateCap(), scheduleCap());
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        markStateCorrupt(raw, 'malformed (not a state object)');
        return normalizeState(null, stateCap(), scheduleCap());
    }
    if (Number(parsed.version) > STORE_VERSION) {
        /* Future schema: data stays readable (read-only mode) but is never
           written over — a newer build must own those semantics. */
        stateIntegrity.ok = false;
        stateIntegrity.reason = 'future_schema';
        console.warn(`[Memory Weaver] Chat memory state schema v${parsed.version} is newer than this build (v${STORE_VERSION}) — writes blocked to protect the data.`);
        return normalizeState(parsed, stateCap(), scheduleCap());
    }
    stateIntegrity.ok = true;
    stateIntegrity.reason = '';
    return normalizeState(parsed, stateCap(), scheduleCap());
}

/* READ-ONLY contract: the returned object is a SHARED cache — never mutate
   it. Every write goes through the mutation boundary; renders, stats,
   injection, recall and API reads use this. */
function readState() {
    const raw = String(getLocalVariable(STATE_VARIABLE) ?? '');
    const capsKey = `${stateCap()}:${scheduleCap()}`;
    if (readStateCache.state && readStateCache.raw === raw && readStateCache.capsKey === capsKey) {
        return readStateCache.state;
    }
    const state = parseStateRaw(raw);
    readStateCache.raw = raw;
    readStateCache.capsKey = capsKey;
    readStateCache.state = state;
    return state;
}

/* Mutation-safe clone for the boundary/runner paths (they may mutate the
   object they receive). */
function loadState() {
    return structuredClone(readState());
}

/* Every read evicts over the CONFIGURED cap (settings.maxEntries, 20-500) —
   a hardcoded default here silently truncated larger caps on every read. */
function stateCap() {
    return Math.max(1, Math.min(500, Number(getSettings().maxEntries) || 150));
}

function scheduleCap() {
    return Math.max(5, Math.min(100, Number(getSettings().maxScheduleActive) || 20));
}

function persistState(state) {
    setLocalVariable(STATE_VARIABLE, JSON.stringify(state));
}

/* The ONE mutation boundary: every write path below goes through it. */
const controller = createStateController({
    loadState,
    persistState,
    getContext,
    getSettings,
    getLifecycleEpoch: () => memoryLifecycleEpoch,
    canonicalFingerprint: canonicalEntriesFingerprint,
    rangeFingerprint,
    stateIntegrity: () => ({ ok: stateIntegrity.ok, reason: stateIntegrity.reason }),
});

const optimizerRunner = createOptimizerRunner({
    generate: generateRaw,
    loadState,
    getContext,
    getSettings,
    commitMutation: controller.commitMutation,
    getLifecycleEpoch: () => memoryLifecycleEpoch,
    isGenerationActive: isGenerationBusy,
    /* v0.6.0 (U6a): the execution record shows the real chat-completion model. */
    getModel: () => {
        try {
            return getChatCompletionModel();
        } catch {
            return '';
        }
    },
});

/* User-visible note when a write was rejected by a guard (corrupt state). */
function warnMutationRejection(where, commit) {
    if (commit.reason === 'state_corrupt') {
        toastr.error(`Memory Weaver: ${tr('the memory state of this chat is corrupt — check the {variable} variable (Console) and repair it by hand before writing.', { variable: STATE_RECOVERY_VARIABLE })}`, 'Memory Weaver');
    } else if (commit.reason === 'future_schema') {
        toastr.error(`Memory Weaver: ${tr("this chat's state uses a newer schema than the extension — not overwriting it. Update the extension or restore by hand.")}`, 'Memory Weaver');
    } else {
        console.warn(`[Memory Weaver] ${where} rejected (${commit.reason}).`);
    }
}

function activeCharacterName() {
    const context = getContext();
    const id = context.characterId;
    const entry = Number.isInteger(id) ? context.characters?.[id] : null;
    return String(entry?.name ?? '');
}

function pinnedIdsOf(entries) {
    return (Array.isArray(entries) ? entries : []).filter(entry => entry?.pinned === true).map(entry => String(entry.id));
}

/* Legacy eligibility = the standalone gate PLUS user pins (a pin bypasses
   the gate by definition). With no pins this is exactly filterForStandalone. */
function legacyEligibleEntries(entries) {
    const gated = filterForStandalone(entries);
    const pinned = (Array.isArray(entries) ? entries : []).filter(entry => entry?.pinned === true);
    if (!pinned.length) return gated;
    const seen = new Set(gated.map(entry => String(entry.id)));
    return [...gated, ...pinned.filter(entry => !seen.has(String(entry.id)))];
}

function filterForStandalone(entries) {
    const charName = activeCharacterName();
    /* v0.6.0 (F3): recent floor — the newest 8 entries always survive the
       gate (importance ≥3 / USER / character) so the legacy block never goes
       empty when the model rates everything 2. INTENTIONAL legacy-snapshot
       change (logged in FIXES v0.6.0): the standalone block can now contain
       up to 8 extra newest entries below the gate. */
    const list = Array.isArray(entries) ? entries : [];
    const entriesById = new Map(list.map(entry => [String(entry.id), entry]));
    const gatedIds = new Set(list
        .filter(entry =>
            entry.importance >= 3 ||
            (entry.entities ?? []).includes('USER') ||
            (charName && (entry.entities ?? []).includes(charName)))
        .map(entry => String(entry.id)));
    return applyRecentFloor([...gatedIds], entriesById, 8)
        .map(id => entriesById.get(id))
        .filter(Boolean);
}

/* v0.6.2 (F8): foundation ids come from the pure core — see recall-core.js.
   These are the "how it started" facts that the recency-first SCENE/CORE/
   RECENT tiers keep starving once the store outgrows the budget. */

function updateInjection() {
    const settings = getSettings();
    let text = '';
    if (settings.enabled && settings.injectEnabled && getContext().chatMetadata) {
        const state = readState();
        /* Hybrid recall (v0.4.0): when vector retrieval is enabled the block
           selection switches to tiered recall (scene/core/recent); with
           retrieval off the legacy importance filter runs untouched. */
        text = settings.retrieval?.enabled
            ? buildRecallInjection(state, settings)
            : buildInjectionBlock(legacyEligibleEntries(state.entries), settings.injectBudgetTokens, { pinnedIds: pinnedIdsOf(state.entries) });
    }
    setExtensionPrompt(INJECT_KEY, text, extension_prompt_types.IN_CHAT, 4, false, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(CHAPTERS_KEY, chaptersInjectionText(), extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
    updateScheduleInjection();
}

function chaptersSettings() {
    const raw = getSettings().chapters ?? {};
    return {
        enabled: raw.enabled !== false,
        everyMessages: Math.max(20, Math.min(400, Math.round(Number(raw.everyMessages)) || 100)),
        budgetTokens: Math.max(100, Math.min(4000, Math.round(Number(raw.budgetTokens)) || 600)),
    };
}

function chaptersInjectionText() {
    const settings = getSettings();
    const chapters = chaptersSettings();
    if (!settings.enabled || !settings.injectEnabled || !chapters.enabled || !getContext().chatMetadata) return '';
    const list = readState().chapters ?? [];
    if (!list.length) return '';
    return buildChaptersBlock(list, chapters.budgetTokens);
}

/* v0.9.0: generate interceptor (manifest "generate_interceptor"). ST awaits
   it on every non-dry generation BEFORE the prompt is assembled, so a vector
   recall for the newest message can land in THIS turn's block instead of the
   next one. Bounded wait; any failure falls back to the cached selection.
   (Deliberate, bounded relaxation of invariant 9's "generation never awaits"
   — the sync getRecallSelection path is still what builds the block.) */
globalThis.memoryWeaverGenerateInterceptor = async (_chat, _contextSize, _abort, type) => {
    try {
        const settings = getSettings();
        if (!settings.enabled || !getContext().chatMetadata) return;
        if (type === 'quiet' || type === 'impersonate') return;
        const waitMs = Math.max(0, Math.min(5000, Number(settings.recallWaitMs ?? 1500)));
        if (settings.retrieval?.enabled && settings.injectEnabled && waitMs > 0) await awaitFreshRecall(waitMs);
        updateInjection();
    } catch (error) {
        console.warn('[Memory Weaver] Generate interceptor failed (falling back to the cached selection):', error);
    }
};

/* Hybrid standalone block. Scene = vector hits (fresh recall cache) UNION
   entity mentions in the last counted messages; core = remaining importance-3
   facts; recent = newest anchor. Line format, header and budget are byte-
   identical to the legacy block — only the SELECTION changes. */
function buildRecallInjection(state, settings) {
    const result = buildRecallSelection(state, settings);
    if (!result.lines.length) return '';
    return ['[Chat Memories — established facts from earlier in this chat]', ...result.lines].join('\n');
}

/* v0.7.0: the selection half of buildRecallInjection, shared with the
   dashboard's "Trong prompt" preview (ids + tiers + token estimate). */
function buildRecallSelection(state, settings, { peek = false } = {}) {
    const context = getContext();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    /* peek: the dashboard preview must never schedule a vector query. */
    const recall = peek ? peekRecallSelection() : getRecallSelection();

    const recentTexts = [];
    let counted = 0;
    for (let i = chat.length - 1; i >= 0 && counted < 6; i--) {
        const mes = chat[i];
        if (!isCountedChatMessage(mes)) continue;
        recentTexts.push(String(mes.mes ?? ''));
        counted++;
    }
    const blob = recentTexts.join('\n').toLowerCase();

    const entriesById = new Map();
    const mentionIds = [];
    const coreCandidateIds = [];
    const recentIds = [];
    const sorted = [...state.entries].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    sorted.forEach((entry, index) => {
        const id = String(entry.id);
        entriesById.set(id, entry);
        if (blob && (entry.entities ?? []).some(name => name && blob.includes(String(name).toLowerCase()))) mentionIds.push(id);
        if (Number(entry.importance) >= 3) coreCandidateIds.push(id);
        if (index < 12) recentIds.push(id);
    });

    const result = mergeRecall({
        entriesById,
        budgetTokens: settings.injectBudgetTokens,
        lineFormatter: entry => {
            const attributes = (entry.entities ?? []).join(', ');
            return `- ${attributes ? `(${attributes}) ` : ''}${entry.text}${entry.importance >= 3 ? ' [core]' : ''}`;
        },
        vectorRankedIds: recall.ids,
        mentionIds,
        coreCandidateIds,
        recentIds,
        /* v0.6.2 (F8): the oldest relationship facts lead the block under a
           reserved quota so a long chat cannot erase how it started. Group
           chats pass no char name (name2 cycles per member during generation)
           so foundation degrades to USER-tagged entries there. */
        foundationIds: foundationIdsFor(state.entries, { charName: context.groupId ? '' : String(context.name2 ?? '').trim() }),
        foundationQuotaRatio: 0.25,
        /* v0.8: user pins lead the block under their own quota. */
        pinnedIds: pinnedIdsOf(state.entries),
    });
    /* Diagnostics for the dashboard: which entries were candidates at all
       (relevant this turn) vs never considered. */
    result.candidateIds = [...new Set([...(recall.ids ?? []), ...mentionIds, ...coreCandidateIds, ...recentIds].map(String))];
    result.vectorIds = (recall.ids ?? []).map(String);
    result.recallMode = recall.mode;
    result.fallbackReason = recall.fallbackReason ?? '';
    return result;
}

/* Recall envelope for the API (v0.4.0) and the Storyline bridge. Selection is
   ALWAYS the tiered hybrid — consumers keep their own header/tail so legacy
   formatting survives byte-for-byte. `mode` reports what actually ran:
   'hybrid' (vector hits included) or 'lexical' (mention/core/recent only). */
function buildRecallEnvelope(options = {}) {
    const profile = options.profile === 'standalone' ? 'standalone' : 'narrative';
    const settings = getSettings();
    const state = readState();
    const retrievalOn = isRetrievalEnabled();
    const context = getContext();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const recallSelection = retrievalOn ? getRecallSelection() : { ids: [], mode: 'off', fallbackReason: 'retrieval disabled' };

    let recentTexts = Array.isArray(options.recentTexts) ? options.recentTexts.map(String)
        : (options.recentTexts ? [String(options.recentTexts)] : []);
    let entityNames = Array.isArray(options.entityNames) ? options.entityNames.map(String) : [];
    if (profile === 'standalone') {
        recentTexts = [];
        let counted = 0;
        for (let i = chat.length - 1; i >= 0 && counted < 6; i--) {
            const mes = chat[i];
            if (!isCountedChatMessage(mes)) continue;
            recentTexts.push(String(mes.mes ?? ''));
            counted++;
        }
        const persona = String(context.name1 ?? '').trim();
        entityNames = [persona, 'user', '{{user}}'].filter(Boolean);
    }

    const blob = recentTexts.join('\n').toLowerCase();
    const nameSet = new Set(entityNames.map(name => name.toLowerCase()).filter(Boolean));
    const isMentioned = createMentionTest(recentTexts.join('\n'));
    const entriesById = new Map();
    const mentionIds = [];
    const coreCandidateIds = [];
    const recentIds = [];
    const sorted = [...state.entries].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const recentCount = Math.max(1, Math.round(Number(options.recentCount)) || 12);
    sorted.forEach((entry, index) => {
        const id = String(entry.id);
        entriesById.set(id, entry);
        const entities = (entry.entities ?? []).map(name => String(name).toLowerCase());
        const mentioned = blob ? entities.some(name => isMentioned(name)) : false;
        const named = entityNames.length ? entities.some(name => nameSet.has(name)) : false;
        if (mentioned || named) mentionIds.push(id);
        if (Number(entry.importance) >= 3) coreCandidateIds.push(id);
        if (index < recentCount) recentIds.push(id);
    });
    /* Relevance gate (mirrors the legacy standalone filter / v0.1.19 bridge
       gate): a line must be core, tagged with a known entity, or be part of
       the recency anchor. Gating happens BEFORE packing so quota is never
       spent on lines that would be dropped anyway. */
    const passesGate = entry => Number(entry.importance) >= 3
        || (entry.entities ?? []).some(name => nameSet.has(String(name).toLowerCase()))
        || recentIds.includes(String(entry.id));
    /* v0.6.0 (F3): recent floor — the newest 8 entries survive the gate even
       when the model rates everything importance 2 (never an empty block). */
    const gate = ids => applyRecentFloor(ids.filter(id => passesGate(entriesById.get(id))), entriesById, 8);

    const lineMaxChars = Math.max(60, Math.round(Number(options.lineMaxChars)) || 200);
    const lineFormatter = typeof options.lineFormatter === 'function'
        ? options.lineFormatter
        : entry => {
            const attributes = (entry.entities ?? []).join(', ');
            const text = String(entry.text ?? '');
            const body = text.length > lineMaxChars ? `${text.slice(0, lineMaxChars - 1).trimEnd()}…` : text;
            return `- ${attributes ? `(${attributes}) ` : ''}${body}${Number(entry.importance) >= 3 ? ' [core]' : ''}`;
        };

    const result = mergeRecall({
        entriesById,
        budgetTokens: Number.isFinite(Number(options.budgetTokens)) ? Number(options.budgetTokens) : (profile === 'standalone' ? Number(settings.injectBudgetTokens ?? 600) : 1000),
        coreQuotaRatio: Number.isFinite(Number(options.coreQuotaRatio)) ? Number(options.coreQuotaRatio) : 0.3,
        lineFormatter,
        vectorRankedIds: retrievalOn ? gate(recallSelection.ids) : [],
        mentionIds: gate(mentionIds),
        coreCandidateIds: gate(coreCandidateIds),
        recentIds,
        /* v0.6.2 (F8): foundation ids are entity-filtered by construction
           (USER/char tags), so they deliberately skip the relevance gate —
           their quota exists precisely to carry lines the gate would drop.
           Group chats pass no char name (name2 cycles per member). */
        foundationIds: foundationIdsFor(state.entries, { charName: context.groupId ? '' : String(context.name2 ?? '').trim() }),
        foundationQuotaRatio: Number.isFinite(Number(options.foundationQuotaRatio)) ? Number(options.foundationQuotaRatio) : 0.25,
        /* v0.8: user pins ride the narrative envelope too (Storyline bridge). */
        pinnedIds: pinnedIdsOf(state.entries),
    });

    return {
        mode: retrievalOn && recallSelection.mode === 'hybrid' ? 'hybrid' : 'lexical',
        fallbackReason: retrievalOn ? (recallSelection.fallbackReason ?? '') : 'retrieval disabled',
        ids: [...result.ids],
        entries: result.ids.map(id => structuredClone(entriesById.get(id))),
        tiers: result.tiers,
        lines: [...result.lines],
        estimatedTokens: result.estimatedTokens,
        contextStamp: getRecallStamp(),
        /* v0.9.0 (additive): the chapter "story so far" block, for consumers
           whose prompt replaces ours (Storyline). '' when none/disabled. */
        storySoFar: chaptersSettings().enabled && (state.chapters ?? []).length ? buildChaptersBlock(state.chapters, chaptersSettings().budgetTokens) : '',
    };
}

/* Schedule injection (v0.3.0): upcoming lines ride at the memories depth,
   due/overdue escalate to depth 2 so the model cannot miss them. Independent
   toggle (scheduleEnabled) — memories and schedules turn off separately. */
function updateScheduleInjection() {
    const settings = getSettings();
    let upcoming = '';
    let due = '';
    if (settings.enabled && settings.scheduleEnabled && getContext().chatMetadata) {
        const state = readState();
        const blocks = buildScheduleBlocks(state.schedule, {
            turnCount: state.turnCount,
            clockDay: state.clock?.day ?? null,
            budgetTokens: settings.scheduleBudgetTokens,
        });
        upcoming = blocks.upcoming;
        due = blocks.due;
    }
    setExtensionPrompt(SCHEDULE_KEY, upcoming, extension_prompt_types.IN_CHAT, 4, false, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(SCHEDULE_DUE_KEY, due, extension_prompt_types.IN_CHAT, 2, false, extension_prompt_roles.SYSTEM);
}

/* Scope snapshot for a dispatch: guards use it to reject writes from a
   previous chat lifetime or after a switch. */
function dispatchScope() {
    const context = getContext();
    return { scopeKey: String(context.chatId ?? ''), lifecycleEpoch: memoryLifecycleEpoch };
}

/* One-shot "đến hạn" toast per appointment per window (dueNotifiedAt);
   postpone resets the marker so the new window notifies again. Housekeeping
   write — never bumps memoryRevision (T16: it must not conflict with
   in-flight optimizer batches). */
function evaluateScheduleToasts() {
    const state = readState();
    const clockDay = state.clock?.day ?? null;
    const dueItems = [];
    for (const item of state.schedule ?? []) {
        if (item.status !== 'active' || item.dueNotifiedAt) continue;
        const urgency = scheduleStateOf(item, { turnCount: state.turnCount, clockDay });
        if (urgency !== 'due' && urgency !== 'overdue') continue;
        dueItems.push(item);
    }
    if (!dueItems.length) return;

    const scope = dispatchScope();
    const commit = controller.commitMutation({ kind: 'housekeeping', ...scope, reason: 'schedule due toast markers' }, (live) => {
        let marked = 0;
        for (const dueItem of dueItems) {
            const row = (live.schedule ?? []).find(entry => entry.id === dueItem.id && entry.status === 'active' && !entry.dueNotifiedAt);
            if (!row) continue;
            row.dueNotifiedAt = new Date().toISOString();
            marked++;
        }
        return { marked };
    });
    if (!commit.ok || !commit.result?.marked) {
        if (!commit.ok) warnMutationRejection('schedule toast markers', commit);
        return;
    }
    /* Opening an old chat can mark MANY appointments at once — toast the
       first few, silently mark the rest (the dashboard still lists them). */
    for (const item of dueItems.slice(0, 3)) {
        toastr.info(`Memory Weaver: ${tr('due — {text} ({when}).', { text: item.text, when: item.when.label })}`, 'Memory Weaver');
    }
    updateInjection();
}

/* Schedule odometer (v0.3.0): monotonic count of COUNTED chat messages.
   Greeting counts; swipe/regenerate/continue and system/tool lines don't;
   deletions never rewind it (frozen P1 trade-off). Hooks: MESSAGE_RECEIVED
   (AI/system) + MESSAGE_SENT (user). Housekeeping write — never conflicts
   with an in-flight optimizer batch (T16). */
function bumpTurnCount() {
    const scope = dispatchScope();
    const commit = controller.commitMutation({ kind: 'housekeeping', ...scope, reason: 'turn count' }, (live) => {
        live.turnCount = (Number(live.turnCount) || 0) + 1;
        return { turnCount: live.turnCount };
    });
    if (!commit.ok) {
        warnMutationRejection('turn count', commit);
        return;
    }
    updateInjection();
    evaluateScheduleToasts();
    /* Coalesced (one rebuild per frame) — the odometer ticks on every message. */
    dashboard.requestRender();
}

function scheduleContext(state) {
    return { turnCount: state.turnCount, clockDay: state.clock?.day ?? null };
}

function createScheduleEntry(spec) {
    const context = getContext();
    const scope = { scopeKey: String(context.chatId ?? ''), lifecycleEpoch: memoryLifecycleEpoch };
    const fromMessage = context.chat.length ? context.chat.length - 1 : null;
    const commit = controller.commitMutation({ kind: 'schedule', ...scope, reason: 'schedule add' }, (live) => {
        return addScheduleEntry(live, { ...spec, fromMessage }, { maxActive: getSettings().maxScheduleActive });
    });
    if (!commit.ok) {
        warnMutationRejection('schedule add', commit);
        return { ok: false, reason: commit.reason === 'state_corrupt' ? 'state' : 'invalid' };
    }
    /* v0.7.0: a refused add (duplicate/cap/when/empty) commits nothing —
       reading entry.id here used to throw and swallow the reason toast. */
    if (!commit.result?.ok) return commit.result ?? { ok: false, reason: 'invalid' };
    updateInjection();
    emitBus('schedule.added', { id: commit.result.entry.id });
    return commit.result;
}

/* Done resolves the appointment AND (default) graduates it into a regular
   memory with provenance. Order matters (memory first, then resolve) and the
   fromScheduleId guard makes a retry idempotent — no duplicate memories.
   The memory add inside the SAME mutation bumps memoryRevision automatically
   (canonical fingerprint changed); the resolve alone does not. */
function resolveScheduleById(id, outcome, { createMemory = false } = {}) {
    const context = getContext();
    const scope = { scopeKey: String(context.chatId ?? ''), lifecycleEpoch: memoryLifecycleEpoch };
    const fromMessage = context.chat.length - 1;
    /* v0.6.0 (T2.3): cancel/miss drop the appointment — offer an undo.
       'done' is not undone here (it also creates a memory). */
    const undoable = outcome === 'cancelled' || outcome === 'missed';
    /* v0.6.4: a failed action must not overwrite the previous undo slot. */
    const previousUndo = undoSlot;
    if (undoable) snapshotUndoFor(`schedule ${outcome}`, { includeSchedule: true });
    const commit = controller.commitMutation({ kind: 'schedule', ...scope, reason: 'schedule resolve' }, (live) => {
        const entry = (live.schedule ?? []).find(item => item.id === String(id ?? ''));
        if (!entry || entry.status !== 'active') return { ok: false, reason: 'missing' };

        let memoryCreated = false;
        if (createMemory && outcome === 'done') {
            const exists = (live.entries ?? []).some(item => item.fromScheduleId === entry.id);
            if (!exists) {
                const text = `${entry.when.label ? `${entry.when.label}: ` : ''}${entry.text}`;
                const entities = (entry.entities ?? []).length ? entry.entities : [activeCharacterName() || 'USER'];
                applyPatch(live, { add: [{ text, entities, importance: 2, fromScheduleId: entry.id }] }, {
                    fromMessage,
                    source: 'schedule',
                    maxEntries: getSettings().maxEntries,
                });
                memoryCreated = true;
            }
        }

        if (!resolveScheduleEntry(live, id, outcome, { by: 'user' })) return { ok: false, reason: 'missing' };
        return { ok: true, memoryCreated };
    });
    if (!commit.ok) {
        if (undoable) undoSlot = previousUndo;
        warnMutationRejection('schedule resolve', commit);
        return { ok: false, reason: commit.reason === 'state_corrupt' ? 'state' : 'missing' };
    }
    if (!commit.result.ok) {
        if (undoable) undoSlot = previousUndo;
        return commit.result;
    }
    updateInjection();
    if (commit.result.memoryCreated) emitBus('memories.added', { added: 1 });
    emitBus('schedule.resolved', { id, outcome });
    if (undoable) notifyUndo(outcome === 'cancelled' ? tr('appointment cancelled') : tr('appointment marked as missed'));
    return commit.result;
}

function postponeScheduleById(id, amount) {
    const scope = dispatchScope();
    const commit = controller.commitMutation({ kind: 'schedule', ...scope, reason: 'schedule postpone' }, (live) => {
        const changed = postponeScheduleEntryResult(live, id, amount).ok;
        return { changed };
    });
    if (!commit.ok || !commit.result?.changed) {
        if (!commit.ok) warnMutationRejection('schedule postpone', commit);
        return false;
    }
    updateInjection();
    emitBus('schedule.updated', { id, postponed: true });
    return true;
}

function editScheduleById(id, patch) {
    const scope = dispatchScope();
    const commit = controller.commitMutation({ kind: 'schedule', ...scope, reason: 'schedule edit' }, (live) => {
        const changed = updateScheduleEntryResult(live, id, patch ?? {}).ok;
        return { changed };
    });
    if (!commit.ok || !commit.result?.changed) {
        if (!commit.ok) warnMutationRejection('schedule edit', commit);
        return false;
    }
    updateInjection();
    emitBus('schedule.updated', { id, edited: true });
    return true;
}

function setStoryClockDay(day) {
    const scope = dispatchScope();
    const commit = controller.commitMutation({ kind: 'schedule', ...scope, reason: 'story clock' }, (live) => {
        if (!setStoryClock(live, day)) return { changed: false };
        return { changed: true, day: live.clock.day };
    });
    if (!commit.ok || !commit.result?.changed) {
        if (!commit.ok) warnMutationRejection('story clock', commit);
        return false;
    }
    updateInjection();
    evaluateScheduleToasts();
    emitBus('schedule.updated', { clock: commit.result.day });
    return true;
}

function wipeSchedule() {
    const scope = dispatchScope();
    /* v0.6.0 (T2.3): undoable — the schedule snapshot rides the slot. */
    const previousUndo = undoSlot;
    snapshotUndoFor('schedule wipe', { includeSchedule: true });
    const commit = controller.commitMutation({ kind: 'schedule', ...scope, reason: 'schedule wipe' }, (live) => {
        const removed = clearSchedule(live);
        return { removed };
    });
    if (!commit.ok) {
        undoSlot = previousUndo;
        warnMutationRejection('schedule wipe', commit);
        return 0;
    }
    if (!commit.result.removed) undoSlot = previousUndo;
    updateInjection();
    emitBus('schedule.updated', { removed: commit.result.removed });
    if (commit.result.removed > 0) notifyUndo(tr('schedule cleared'));
    return commit.result.removed;
}

function emitBus(name, payload) {
    const set = busListeners.get(name);
    if (!set) return;
    for (const handler of set) {
        try {
            handler(payload);
        } catch (error) {
            console.warn('[Memory Weaver] Event handler failed:', error);
        }
    }
}

/* =========================================================================
 * v0.6.0 (T2.3): one-level in-memory undo for destructive actions.
 * The snapshot lives ONLY in the module variable `undoSlot` — never a state
 * variable (the store contract stays clean) — and CHAT_CHANGED drops it.
 * Restore goes through the mutation boundary (kind 'user'); memoryRevision
 * bumps automatically because the canonical entries fingerprint changes.
 * ========================================================================= */

function snapshotUndoFor(label, { includeSchedule = false } = {}) {
    try {
        const state = readState();
        undoSlot = {
            chatId: String(getContext().chatId ?? ''),
            entries: structuredClone(state.entries ?? []),
            schedule: includeSchedule ? structuredClone(state.schedule ?? []) : null,
            /* review-fix (C5): revision drift between snapshot and restore
               means newer writes would be silently discarded — restore asks. */
            revision: Number(state.memoryRevision ?? 0),
            label: String(label ?? ''),
            at: Date.now(),
        };
    } catch (error) {
        console.warn('[Memory Weaver] Undo snapshot failed:', error);
        undoSlot = null;
    }
}

function notifyUndo(toastText) {
    if (!undoSlot) return;
    /* v0.8: drift is measured against the state RIGHT AFTER the action (the
       action itself bumps the revision / edits the schedule, so comparing to
       the pre-action snapshot asked for confirmation on every undo, and
       schedule drift was never detected at all). */
    const after = readState();
    undoSlot.afterRevision = Number(after.memoryRevision ?? 0);
    undoSlot.afterSchedule = JSON.stringify(after.schedule ?? []);
    toastr.info(`Memory Weaver: ${tr('{action} — click this notice to undo.', { action: toastText })}`, 'Memory Weaver', {
        timeOut: 8000,
        extendedTimeOut: 4000,
        onclick: () => restoreUndoSlot(),
    });
}

async function restoreUndoSlot() {
    const slot = undoSlot;
    if (!slot) return false;
    const scope = dispatchScope();
    /* A snapshot from another chat is stale by definition. */
    if (slot.chatId !== scope.scopeKey) {
        undoSlot = null;
        return false;
    }
    /* review-fix (C5): an optimizer pass (or the user) may have committed new
       memories inside the undo window — a blind restore silently discards
       them. Ask before overwriting. */
    const live = readState();
    const memoryDrift = Number(slot.afterRevision ?? slot.revision ?? 0) !== Number(live.memoryRevision ?? 0);
    const scheduleDrift = Boolean(slot.schedule) && slot.afterSchedule !== undefined && slot.afterSchedule !== JSON.stringify(live.schedule ?? []);
    if (memoryDrift || scheduleDrift) {
        const confirmed = await callGenericPopup(scheduleDrift
            ? tr('The schedule has changed since this action — undoing will OVERWRITE the newest changes. Continue?')
            : tr('Memories have changed since this action — undoing will OVERWRITE the newest changes. Continue?'), POPUP_TYPE.CONFIRM);
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return false;
    }
    const commit = controller.commitMutation({ kind: 'user', ...scope, reason: 'undo restore' }, (live) => {
        live.entries = structuredClone(slot.entries ?? []);
        if (slot.schedule) live.schedule = structuredClone(slot.schedule);
        /* A restore after a deliberate wipe means memories exist again. */
        live.cleared = false;
        return { restored: true };
    });
    if (!commit.ok) {
        warnMutationRejection('undo restore', commit);
        return false;
    }
    undoSlot = null;
    updateInjection();
    emitBus('memories.updated', { restored: true });
    toastr.success(`Memory Weaver: ${tr('undone.')}`, 'Memory Weaver');
    return true;
}

function addManualEntry(text, entities, importance) {
    const context = getContext();
    const scope = { scopeKey: String(context.chatId ?? ''), lifecycleEpoch: memoryLifecycleEpoch };
    const commit = controller.commitMutation({ kind: 'user', ...scope, reason: 'manual add' }, (live) => {
        return applyPatch(live, { add: [{ entities, text, importance }] }, {
            fromMessage: context.chat.length - 1,
            source: 'manual',
            maxEntries: getSettings().maxEntries,
            dedupeMode: getSettings().dedupeMode === 'near' ? 'near' : 'exact',
        });
    });
    if (!commit.ok) {
        warnMutationRejection('manual add', commit);
        return { added: 0, updated: 0, deleted: 0 };
    }
    updateInjection();
    emitBus('memories.added', { added: commit.result.added });
    return commit.result;
}

/* v0.6.4: USER deletes bypass the lock. A lock protects an entry from the
   MODEL (applyPatch drops model ops on locked ids); routing user deletes
   through applyPatch made locked entries undeletable with no feedback. */
function removeMemories(ids) {
    const wanted = new Set((Array.isArray(ids) ? ids : [ids]).map(id => String(id ?? '')).filter(Boolean));
    if (!wanted.size) return 0;
    const scope = dispatchScope();
    const commit = controller.commitMutation({ kind: 'user', ...scope, reason: wanted.size > 1 ? 'manual bulk delete' : 'manual delete' }, (live) => {
        const before = live.entries.length;
        live.entries = live.entries.filter(entry => !wanted.has(String(entry.id)));
        return { deleted: before - live.entries.length };
    });
    if (!commit.ok) {
        warnMutationRejection('manual delete', commit);
        return 0;
    }
    if (commit.result.deleted > 0) {
        updateInjection();
        emitBus('memories.deleted', { deleted: commit.result.deleted });
    }
    return commit.result.deleted;
}

function removeMemory(id) {
    return removeMemories([id]) > 0;
}

/* v0.6.4: bulk user edits from the dashboard selection bar — one commit. */
/* v0.8: "Ghim vào prompt" — a pinned entry is always injected (own tier,
   ≤35% of the budget) and implies the lock. Capped so pins cannot starve
   the rest of the block. */
const MAX_PINNED = 10;

function bulkUpdateMemories(ids, { locked, importance, pinned } = {}) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
    if (!wanted.size) return 0;
    const scope = dispatchScope();
    const commit = controller.commitMutation({ kind: 'user', ...scope, reason: 'manual bulk update' }, (live) => {
        let changed = 0;
        let pinnedCount = live.entries.filter(entry => entry.pinned === true).length;
        let pinRefused = 0;
        for (const entry of live.entries) {
            if (!wanted.has(String(entry.id))) continue;
            let touched = false;
            if (pinned === true && entry.pinned !== true) {
                if (pinnedCount >= MAX_PINNED) {
                    pinRefused++;
                } else {
                    entry.pinned = true;
                    entry.locked = true;
                    pinnedCount++;
                    touched = true;
                }
            }
            if (pinned === false && entry.pinned === true) { delete entry.pinned; touched = true; }
            if (locked === true && entry.locked !== true) { entry.locked = true; touched = true; }
            /* Unlocking a pinned entry unpins it too (a pin implies the lock). */
            if (locked === false && entry.locked === true) {
                delete entry.locked;
                delete entry.pinned;
                touched = true;
            }
            const imp = Math.round(Number(importance));
            if (imp >= 1 && imp <= 3 && entry.importance !== imp) { entry.importance = imp; touched = true; }
            if (touched) changed++;
        }
        return { changed, pinRefused };
    });
    if (!commit.ok) {
        warnMutationRejection('bulk update', commit);
        return 0;
    }
    if (commit.result.pinRefused) {
        toastr.warning(`Memory Weaver: ${tr('at most {max} memories can be pinned to the prompt — unpin some to pin more.', { max: MAX_PINNED })}`, 'Memory Weaver');
    }
    if (commit.result.changed > 0) {
        updateInjection();
        emitBus('memories.updated', { updated: commit.result.changed });
    }
    return commit.result.changed;
}

/* Bulk edit with a one-level undo (dashboard selection bar + per-row pin). */
function bulkUpdateWithUndo(ids, patch, label) {
    const previousUndo = undoSlot;
    snapshotUndoFor(label || 'bulk update');
    const changed = bulkUpdateMemories(ids, patch);
    /* label = an English template with {n} from the dashboard (translated here). */
    if (changed > 0) notifyUndo(tr(label || 'Updated {n} memories', { n: changed }));
    else undoSlot = previousUndo;
    return changed;
}

function togglePinMemory(id) {
    const entry = readState().entries.find(item => String(item.id) === String(id ?? ''));
    if (!entry) return 0;
    return bulkUpdateMemories([id], { pinned: entry.pinned !== true });
}

/* v0.8: entity rename/merge ("Yamada Rika", "Rika-chan" → "Rika") — model
   tags drift and every exact-match gate (standalone filter, foundation tier,
   mention test) silently loses facts tagged with the variant. */
function renameEntityEverywhere(fromNames, toName) {
    const from = (Array.isArray(fromNames) ? fromNames : [fromNames]).map(name => String(name ?? '').trim()).filter(Boolean);
    const target = String(toName ?? '').normalize('NFC').trim();
    if (!from.length || !target) return 0;
    const previousUndo = undoSlot;
    snapshotUndoFor('rename entity');
    const commit = controller.commitMutation({ kind: 'user', ...dispatchScope(), reason: 'rename entity' }, (live) => {
        return { changed: renameEntity(live.entries, from, target) };
    });
    if (!commit.ok || !commit.result.changed) {
        undoSlot = previousUndo;
        if (!commit.ok) warnMutationRejection('rename entity', commit);
        return 0;
    }
    updateInjection();
    emitBus('memories.updated', { updated: commit.result.changed });
    notifyUndo(trn('renamed "{from}" → "{to}" on {n} memory', 'renamed "{from}" → "{to}" on {n} memories', commit.result.changed, { from: from.join(', '), to: target }));
    return commit.result.changed;
}

/* v0.8: merge a near-duplicate cluster — keep one, union entities, max
   importance, carry lock/pin; one commit, undoable. Never automatic. */
function mergeMemoryCluster(keepId, removeIds) {
    const removes = (Array.isArray(removeIds) ? removeIds : []).map(String).filter(id => id && id !== String(keepId));
    if (!removes.length) return 0;
    const previousUndo = undoSlot;
    snapshotUndoFor('merge duplicates');
    const commit = controller.commitMutation({ kind: 'user', ...dispatchScope(), reason: 'merge duplicates' }, (live) => {
        return mergeEntries(live.entries, String(keepId), removes);
    });
    if (!commit.ok || !commit.result?.ok || !commit.result.removed) {
        undoSlot = previousUndo;
        if (!commit.ok) warnMutationRejection('merge duplicates', commit);
        return 0;
    }
    updateInjection();
    emitBus('memories.deleted', { deleted: commit.result.removed });
    notifyUndo(tr('merged {n} duplicate memories into 1', { n: commit.result.removed + 1 }));
    return commit.result.removed;
}

function duplicateClusters() {
    try {
        return findDuplicateClusters(readState().entries);
    } catch (error) {
        console.warn('[Memory Weaver] Duplicate scan failed:', error);
        return [];
    }
}

/* v0.8: jump the chat to a memory's source message (ST /chat-jump loads
   older messages when needed). Raw chat index. */
async function jumpToMessage(rawIndex) {
    const index = Math.floor(Number(rawIndex));
    const chat = getContext().chat ?? [];
    if (!Number.isFinite(index) || index < 0 || index >= chat.length) {
        toastr.warning(`Memory Weaver: ${tr('the source message is no longer in the chat.')}`, 'Memory Weaver');
        return false;
    }
    try {
        await getContext().executeSlashCommandsWithOptions(`/chat-jump ${index}`, { handleExecutionErrors: true });
        const node = document.querySelector(`#chat .mes[mesid="${index}"]`);
        if (node) {
            node.classList.add('mw-flash');
            window.setTimeout(() => node.classList.remove('mw-flash'), 1800);
        }
        return true;
    } catch (error) {
        console.warn('[Memory Weaver] chat-jump failed:', error);
        return false;
    }
}

/* v0.8: "Ghi nhớ toàn bộ" — drain a long backlog with repeated bursts under
   the optimizer lock; stoppable between bursts. Each burst is a normal
   guarded runBurst (cursor advances only on commits). */
const backlogRun = { active: false, stop: false, done: 0 };

function pendingCountedMessages() {
    const chat = getContext().chat ?? [];
    const cursor = Math.max(0, Math.min(Number(readState().processedMessages ?? 0), chat.length));
    return countChatMessages(chat, cursor);
}

async function runFullBacklog() {
    if (backlogRun.active) {
        backlogRun.stop = true;
        return { stopping: true };
    }
    const scope = String(getContext().chatId ?? '');
    backlogRun.active = true;
    backlogRun.stop = false;
    backlogRun.done = 0;
    dashboard.requestRender();
    let last = null;
    try {
        for (let guard = 0; guard < 200; guard++) {
            if (backlogRun.stop || String(getContext().chatId ?? '') !== scope) break;
            if (pendingCountedMessages() <= 0) break;
            const before = Number(readState().processedMessages ?? 0);
            last = await runOptimizer('manual', { maxChunks: Math.max(1, Number(getSettings().backlogMaxChunksPerRun) || 2) });
            backlogRun.done++;
            dashboard.requestRender();
            const advanced = Number(readState().processedMessages ?? 0) > before;
            if (!last?.ok || !advanced) break;
        }
    } finally {
        backlogRun.active = false;
        dashboard.requestRender();
    }
    if (String(getContext().chatId ?? '') !== scope) {
        backlogRun.stop = false;
        toastr.info(`Memory Weaver: ${tr('the chat changed — "Remember everything" stopped.')}`, 'Memory Weaver');
        return last;
    }
    const left = pendingCountedMessages();
    if (backlogRun.stop) toastr.info(`Memory Weaver: ${trn('stopped — {n} message not remembered yet.', 'stopped — {n} messages not remembered yet.', left)}`, 'Memory Weaver');
    else if (left <= 0) toastr.success(`Memory Weaver: ${trn('the whole chat is remembered ({n} pass).', 'the whole chat is remembered ({n} passes).', backlogRun.done)}`, 'Memory Weaver');
    else if (last) toastOptimizerResult(last);
    backlogRun.stop = false;
    return last;
}

/* v0.6.0 (F5b): pin/unpin an entry. A locked entry rejects model
   update/delete ops (applyPatch drops them into diagnostics.protected_ids)
   and is never evicted by planRetention — it may push the store over the
   cap (overCap flag). The lock flip changes the canonical fingerprint, so
   in-flight optimizer jobs conflict honestly instead of overwriting. */
function toggleLockMemory(id) {
    const scope = dispatchScope();
    const commit = controller.commitMutation({ kind: 'user', ...scope, reason: 'toggle entry lock' }, (live) => {
        const target = live.entries.find(item => String(item.id) === String(id ?? ''));
        if (!target) return { toggled: false };
        if (target.locked === true) {
            delete target.locked;
            delete target.pinned; /* a pin implies the lock */
        }
        else target.locked = true;
        return { toggled: true, locked: target.locked === true };
    });
    if (!commit.ok || !commit.result?.toggled) {
        if (!commit.ok) warnMutationRejection('toggle entry lock', commit);
        return false;
    }
    updateInjection();
    emitBus('memories.updated', { id, locked: commit.result.locked });
    return true;
}

/* Manual entry edit (dashboard inline editor). Text is pre-cleaned the same
   way store.cleanText does it so the duplicate check compares like for like;
   an exact-text duplicate of ANOTHER entry is refused (same mental model as
   applyPatch add-dedupe) instead of silently creating twin facts. */
function editMemory(id, { text, entities, importance } = {}) {
    const state = readState();
    const entry = state.entries.find(item => item.id === String(id ?? ''));
    if (!entry) return { ok: false, error: 'missing' };

    const content = String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!content) return { ok: false, error: 'empty' };

    const normalized = content.toLowerCase();
    if (state.entries.some(item => item.id !== entry.id && String(item.text).normalize('NFC').toLowerCase() === normalized)) {
        return { ok: false, error: 'duplicate' };
    }

    const scope = dispatchScope();
    const commit = controller.commitMutation({ kind: 'user', ...scope, reason: 'manual edit' }, (live) => {
        /* v0.6.4: the lock guards against the MODEL only — a user edit of a
           locked entry unlocks it for this one applyPatch and relocks it. */
        const target = live.entries.find(item => item.id === entry.id);
        const wasLocked = target?.locked === true;
        if (wasLocked) delete target.locked;
        const result = applyPatch(live, {
            add: [],
            update: [{ id: entry.id, text: content, entities, importance }],
            delete: [],
        /* No retention here: the briefly-unlocked entry must not join the
           eviction pool; the controller runs retention after the mutator,
           once the lock is back. */
        }, { maxEntries: Number.MAX_SAFE_INTEGER });
        const after = live.entries.find(item => item.id === entry.id);
        if (wasLocked && after) after.locked = true;
        return result;
    });

    if (!commit.ok) {
        warnMutationRejection('manual edit', commit);
        return { ok: false, error: 'blocked' };
    }
    if (!commit.result?.updated) {
        /* v0.6.4: saving an unchanged entry is a no-op, not "missing". */
        return entryExists(entry.id) ? { ok: true, error: null, unchanged: true } : { ok: false, error: 'missing' };
    }
    updateInjection();
    emitBus('memories.updated', { updated: commit.result.updated });
    return { ok: true, error: null };
}

function entryExists(id) {
    return readState().entries.some(item => item.id === String(id ?? ''));
}

function clearMemories() {
    /* cleared = deliberate wipe. R1: the clear goes through the boundary and
       bumps memoryEpoch — an in-flight optimizer job from BEFORE the clear is
       rejected at commit time, so a wipe can never be resurrected by a
       returning batch (T13). Schedule, clock and the odometer are INDEPENDENT
       of memories — a memory wipe must never drop appointments.
       v0.6.0 (T2.3): a one-level undo snapshot is taken BEFORE the wipe
       (in-memory only) and offered via toast. */
    snapshotUndoFor('clear', { includeSchedule: false });
    const context = getContext();
    const scope = { scopeKey: String(context.chatId ?? ''), lifecycleEpoch: memoryLifecycleEpoch };
    const chatLength = context.chat?.length ?? 0;
    const commit = controller.commitMutation({ kind: 'user', ...scope, reason: 'clear memories' }, (live) => {
        live.entries = [];
        live.cleared = true;
        live.processedMessages = chatLength;
        live.lastResult = null;
        live.lastRun = null;
        live.vector = emptyVectorMeta();
        live.memoryEpoch = (Number(live.memoryEpoch ?? 0)) + 1;
        live.processing = {
            schema: 1,
            policyVersion: SOURCE_POLICY_VERSION,
            status: PROCESSING_STATUS.OK,
            /* v0.6.4: the wipe claims [0, chatLength) as handled — store its
               digests so the next reassess is clean instead of flipping the
               fresh store to legacy_unverified. */
            prefixBlocks: prefixFingerprintBlocks((context.chat ?? []).slice(0, chatLength)),
            dirtyFrom: null,
            blocked: null,
            skipped: [],
        };
        return { cleared: true };
    });
    if (!commit.ok) {
        warnMutationRejection('clear memories', commit);
        return { ok: false, reason: commit.reason };
    }
    /* Invalidate everything derived from the old entries. */
    optimizerRunner.resetRetryMarkers();
    conflictRequeued = false;
    bumpEpoch();
    updateInjection();
    emitBus('memories.cleared');
    notifyUndo(tr('chat memories cleared'));
    return { ok: true };
}

/* v0.6.0 (F1): user escape hatch for an oversized message — record it in
   processing.skipped (housekeeping write), clear the blocked marker and
   rerun the pass. The planner walks skipped messages forever after; one
   that shrinks below the budget self-heals out of the list. */
async function skipBlockedMessage(rawIndex, { review = false } = {}) {
    const scope = dispatchScope();
    const commit = controller.commitMutation({ kind: 'housekeeping', ...scope, reason: 'skip oversized message' }, (live) => {
        const list = Array.isArray(live.processing.skipped) ? live.processing.skipped : [];
        const idx = Math.max(0, Math.floor(Number(rawIndex)) || 0);
        if (!list.some(item => Number(item.rawIndex) === idx)) list.push({ rawIndex: idx, reason: 'oversized_message' });
        live.processing.skipped = list.slice(-20);
        if (live.processing.blocked && Number(live.processing.blocked.rawIndex) === idx) live.processing.blocked = null;
        return { skipped: true };
    });
    if (!commit.ok) {
        warnMutationRejection('skip oversized message', commit);
        return false;
    }
    dashboard.requestRender();
    /* v0.8: a skip triggered from a REVIEW continues the review, not a
       forward pass over new messages. */
    if (review) {
        toastr.info(`Memory Weaver: ${tr('skipped the oversized message — continuing the review.')}`, 'Memory Weaver');
        const reviewResult = await runReviewPass();
        if (!reviewResult?.toasted) toastOptimizerResult(reviewResult);
        return true;
    }
    toastr.info(`Memory Weaver: ${tr('skipped the oversized message — running the memory pass again.')}`, 'Memory Weaver');
    const result = await runOptimizer('manual');
    toastOptimizerResult(result);
    return true;
}

/* Source-change detector (R1-B4.1): recompute the processed-prefix
   fingerprint blocks and compare with the stored ones. A mismatch (or a
   cursor overshooting the chat) flips processing.status to needs_review with
   the earliest CERTAIN block boundary as dirtyFrom. NEVER auto-replays
   history and never rewrites the cursor — the user decides what to reprocess.
   Housekeeping write: does not bump memoryRevision, does not conflict with
   in-flight optimizer batches. */
function minDirty(a, b) {
    const values = [a, b].filter(value => value !== null && value !== undefined && Number.isFinite(Number(value))).map(Number);
    return values.length ? Math.min(...values) : null;
}

function reassessCoverage(reason = '') {
    const context = getContext();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    if (!context.chatMetadata || !chat.length) return;
    const state = readState();
    const cursor = Number(state.processedMessages ?? 0);
    /* The blocks cover the PROCESSED PREFIX only ([0, min(cursor, len))) —
       messages appended beyond the cursor must not change the digests. */
    const processedPrefix = chat.slice(0, Math.max(0, Math.min(cursor, chat.length)));
    const computed = prefixFingerprintBlocks(processedPrefix);
    const verdict = comparePrefixBlocks(state.processing?.prefixBlocks, computed, { cursor, chatLength: chat.length });

    let status = state.processing?.status ?? PROCESSING_STATUS.OK;
    let dirtyFrom = state.processing?.dirtyFrom ?? null;
    if (verdict.unverified) {
        /* v0.6.4: no stored digests. A cursor at 0 claims NO coverage, so
           there is nothing to verify (every fresh chat used to get stuck on
           legacy_unverified forever). A cursor > 0 without digests is a real
           legacy (pre-v0.5) claim and keeps the honest flag. */
        status = cursor > 0 ? PROCESSING_STATUS.LEGACY_UNVERIFIED : PROCESSING_STATUS.OK;
        dirtyFrom = null;
    } else if (!verdict.clean) {
        /* v0.8: an existing dirty point is never overwritten by a LATER one —
           the earliest unreviewed edit wins (a second edit further down used
           to drop [first, second) from review silently). */
        const wasDirty = state.processing?.status === PROCESSING_STATUS.NEEDS_REVIEW;
        status = PROCESSING_STATUS.NEEDS_REVIEW;
        dirtyFrom = wasDirty ? minDirty(state.processing?.dirtyFrom, verdict.dirtyFrom) : verdict.dirtyFrom;
    } else if (status === PROCESSING_STATUS.LEGACY_UNVERIFIED) {
        /* v0.6.4: digests now exist (written by a post-v0.5 commit) and match
           the live prefix — the legacy flag has nothing left to say. A clean
           verdict never clears needs_review (the user decides there). */
        status = PROCESSING_STATUS.OK;
        dirtyFrom = null;
    }

    /* v0.8: remember the SHORTEST length the chat had while the cursor was
       past its end — messages appended after a deletion sit below the old
       cursor but were never read; "acknowledge" pulls the cursor back here. */
    const currentShrunk = Number.isFinite(state.processing?.shrunkTo) ? state.processing.shrunkTo : null;
    const shrunkTo = cursor > chat.length ? minDirty(currentShrunk, chat.length) : currentShrunk;

    const currentStatus = state.processing?.status;
    const currentDirty = state.processing?.dirtyFrom ?? null;
    if (status === currentStatus && (dirtyFrom ?? null) === (currentDirty ?? null) && shrunkTo === currentShrunk) return;

    const scope = dispatchScope();
    const commit = controller.commitMutation({ kind: 'housekeeping', ...scope, reason: `coverage reassess (${reason})` }, (live) => {
        live.processing.status = status;
        live.processing.dirtyFrom = dirtyFrom;
        live.processing.shrunkTo = shrunkTo;
        return { status, dirtyFrom };
    });
    if (!commit.ok) {
        console.warn(`[Memory Weaver] Coverage reassess rejected (${commit.reason}).`);
        return;
    }
    if (status === PROCESSING_STATUS.NEEDS_REVIEW) {
        console.warn(`[Memory Weaver] Coverage marked needs_review (${reason}) — dirty from raw #${dirtyFrom}. Memories are NOT auto-repaired; review in the dashboard or run the targeted re-scan.`);
    }
    updateSendFormBadge();
    dashboard.requestRender();
}

function requestOptimizerRun() {
    runQueued = true;
    if (!runTimer) {
        runTimer = window.setTimeout(attemptOptimizerRun, 3000);
    }
}

function attemptOptimizerRun() {
    runTimer = null;
    if (!runQueued) return;
    if (isGenerationBusy()) {
        runTimer = window.setTimeout(attemptOptimizerRun, 5000);
        return;
    }
    /* Keep the queue while a manual pass is in flight: clearing runQueued
       here (before runOptimizer reports "busy") silently dropped the auto
       chunk and pushed the retry a full threshold away. Retry instead. */
    if (optimizerRunning) {
        runTimer = window.setTimeout(attemptOptimizerRun, 5000);
        return;
    }
    runQueued = false;
    runOptimizer('auto', { manual: false });
}

function maybeAutoRun() {
    const settings = getSettings();
    if (!settings.enabled || settings.mode !== 'auto') return;
    const state = readState();
    const context = getContext();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const total = chat.length;
    /* processedMessages is the cursor of already-summarized chat lines
       (a chat index, NOT a turn counter): trigger when at least `threshold`
       new messages have accumulated since the last optimizer run. */
    const stored = Number(state.processedMessages ?? 0);
    /* R1: a cursor beyond the chat length is NO LONGER silently clamped —
       reassessCoverage() flags needs_review instead (a deletion below the
       cursor invalidates coverage, it does not shrink it). */
    const cursor = Math.max(0, Math.min(stored, total));
    /* Counted messages, not raw slots (v0.2.1): tool-call/system messages and
       narrator-typed entries must not shorten the N-message window — in a
       tool-heavy chat (Storyline + Dice Weaver) raw counting fired the pass
       early and burned tokens. `total`/`cursor` stay chat INDICES. */
    let pending = countChatMessages(chat, cursor);
    /* R1 removed the v0.4.1 broken-state auto-heal (cursor at end + zero
       entries → rescan): with the honest cursor protocol that heal would
       reprocess claimed coverage automatically. The dashboard now surfaces
       the state and the user decides via "Quét lại đoạn gần nhất". */
    if (pending >= Number(settings.threshold ?? 20)) {
        console.debug(`[Memory Weaver] Auto optimization queued: ${pending} new message(s), cursor ${cursor}/${total}, threshold ${settings.threshold}.`);
        requestOptimizerRun();
    }
}

let optimizerRunning = false;

/* Re-queue a run whose stop condition warrants a controlled re-fetch
   (generation ended, chat switched back, conflict). Conflict requeues are
   bounded by conflictRequeued so an editing user cannot trigger an LLM loop. */
function handleRunRequeue(run) {
    if (!run?.requeue) return;
    if (run.stopped === 'conflict' && conflictRequeued) {
        conflictRequeued = false;
        return;
    }
    if (run.stopped === 'conflict') conflictRequeued = true;
    requestOptimizerRun();
}

/* Aggregate a runner burst into the shape the existing callers consume
   ({ ok, added, updated, deleted, skipped, error, outcome }). */
function aggregateOptimizerResult(run) {
    const totals = run.totals ?? { added: 0, updated: 0, deleted: 0 };
    const last = run.chunks?.[run.chunks.length - 1] ?? null;
    const failed = run.chunks?.find(chunk => chunk.outcome === 'failed' || chunk.outcome === 'conflict') ?? null;
    return {
        ok: run.ok === true,
        skipped: run.skipped === true,
        added: totals.added,
        updated: totals.updated,
        deleted: totals.deleted,
        chunks: run.chunks ?? [],
        stopped: run.stopped ?? null,
        outcome: last?.outcome ?? null,
        error: failed?.error ?? (run.error ?? null),
    };
}

/* v0.6.4: every runner entry point (burst, recent-window rescan, review)
   shares ONE in-flight flag — the rescan used to bypass it and could run
   in parallel with an auto burst (two LLM calls, a guaranteed conflict).
   The flag also drives the "đang ghi…" state of the send-form button. */
async function withOptimizerLock(task) {
    if (optimizerRunning) return { ok: false, skipped: false, stopped: 'busy', chunks: [], added: 0, updated: 0, deleted: 0, outcome: null, error: null };
    optimizerRunning = true;
    emitBus('optimizer.state', { running: true });
    try {
        return await task();
    } finally {
        optimizerRunning = false;
        emitBus('optimizer.state', { running: false });
    }
}

async function runOptimizer(sourceLabel = 'manual', { manual = true, maxChunks = null } = {}) {
    return withOptimizerLock(async () => {
        const startScope = dispatchScope();
        const run = await optimizerRunner.runBurst({ sourceLabel, manual, maxChunks });
        handleRunRequeue(run);
        const result = aggregateOptimizerResult(run);
        /* v0.9.1: follow-ups belong to the chat the burst ran on. */
        const sameChat = () => {
            const now = dispatchScope();
            return now.scopeKey === startScope.scopeKey && now.lifecycleEpoch === startScope.lifecycleEpoch;
        };
        if (!sameChat()) return result;
        if (!manual && (run.chunks ?? []).some(chunk => chunk.outcome === 'changed')) bumpAutoConsolidationCounter();
        /* v0.9.0: follow-ups inside the SAME lock once new coverage landed —
           write the next chapter summary when enough processed history has
           accumulated, and (auto cadence) let the AI consolidate the store. */
        const committed = (run.chunks ?? []).some(chunk => chunk.committed || ['changed', 'no_change', 'deduped'].includes(chunk.outcome));
        if (committed && sameChat()) await runFollowUps({ auto: !manual, sameChat });
        return result;
    });
}

/* Chapters whose source range was edited/deleted since they were written. */
function safeStaleIds(state, chat) {
    try {
        return staleChapters(state.chapters ?? [], chat);
    } catch {
        return [];
    }
}

function chapterDue() {
    const chapters = chaptersSettings();
    if (!getSettings().enabled || !chapters.enabled) return false;
    const state = readState();
    const chat = getContext().chat ?? [];
    try {
        return Boolean(planNextChapter({ chat, cursor: Math.min(Number(state.processedMessages ?? 0), chat.length), chapters: state.chapters ?? [], everyMessages: chapters.everyMessages, staleIds: safeStaleIds(state, chat) }));
    } catch (error) {
        console.warn('[Memory Weaver] Chapter planning failed:', error);
        return false;
    }
}

/* v0.9.1: a persisted counter of auto bursts that changed memories since the
   last consolidation (runLog is capped at 10 records and counts chunks, so
   "every 11–50 passes" could never fire). Reset by any consolidation commit. */
function consolidationDue() {
    const every = Math.max(0, Math.round(Number(getSettings().consolidation?.autoEvery)) || 0);
    if (!every) return false;
    return Number(readState().consolidation?.sinceAuto ?? 0) >= every;
}

function bumpAutoConsolidationCounter() {
    if (!(Math.round(Number(getSettings().consolidation?.autoEvery)) > 0)) return;
    const commit = controller.commitMutation({ kind: 'housekeeping', ...dispatchScope(), reason: 'consolidation counter' }, (live) => {
        bumpAutoRunCounter(live);
        return { sinceAuto: live.consolidation?.sinceAuto };
    });
    if (!commit.ok) console.warn(`[Memory Weaver] Consolidation counter rejected (${commit.reason}).`);
}

/* v0.9.1: an auto chapter that fails (generate/parse) persists nothing, so
   chapterDue() stayed true and every later pass re-called the LLM for the
   same range. Max 2 auto attempts per range start; manual is never blocked;
   cleared on CHAT_CHANGED. */
const chapterAutoAttempts = new Map();

function nextChapterStart() {
    const chapters = chaptersSettings();
    const state = readState();
    const chat = getContext().chat ?? [];
    try {
        return planNextChapter({ chat, cursor: Math.min(Number(state.processedMessages ?? 0), chat.length), chapters: state.chapters ?? [], everyMessages: chapters.everyMessages, staleIds: safeStaleIds(state, chat) })?.start ?? null;
    } catch {
        return null;
    }
}

/* Runs with the optimizer lock ALREADY held by the caller. */
async function runFollowUps({ auto, sameChat = () => true }) {
    try {
        const chapterStart = chapterDue() ? nextChapterStart() : null;
        const attempts = chapterStart === null ? 0 : (chapterAutoAttempts.get(chapterStart) ?? 0);
        if (chapterStart !== null && (!auto || attempts < 2)) {
            if (auto) chapterAutoAttempts.set(chapterStart, attempts + 1);
            const chapterRun = await optimizerRunner.runChapters({ manual: !auto, maxChapters: 3 });
            if (chapterRun?.created > 0) chapterAutoAttempts.delete(chapterStart);
            if (!sameChat()) return;
            if (chapterRun?.created > 0) {
                emitBus('chapters.updated', { created: chapterRun.created });
                updateInjection();
                if (!auto) toastr.success(`Memory Weaver: ${trn('wrote {n} story chapter summary.', 'wrote {n} story chapter summaries.', chapterRun.created)}`, 'Memory Weaver');
            }
        }
        if (auto && sameChat() && consolidationDue()) {
            const consolidation = await optimizerRunner.runConsolidation({ manual: false, maxBatches: 4 });
            if (consolidation?.ok) {
                updateInjection();
                emitBus('memories.updated', { consolidated: true });
            }
        }
    } catch (error) {
        console.warn('[Memory Weaver] Follow-up pass failed:', error);
    }
}

/* v0.9.0: manual "Viết chương tiếp theo" / "Viết lại chương cuối". */
async function runChaptersPass({ force = false, chapterId = null } = {}) {
    return withOptimizerLock(async () => {
        const run = await optimizerRunner.runChapters({ manual: true, force, maxChapters: force || chapterId ? 1 : 3, ...(chapterId ? { chapterId } : {}) });
        if (run?.created > 0) {
            emitBus('chapters.updated', { created: run.created });
            updateInjection();
        }
        return run;
    });
}

/* v0.9.0: manual "AI gộp & dọn memory" (optionally for one entity). */
async function runConsolidationPass({ focusEntity = null } = {}) {
    return withOptimizerLock(async () => {
        const run = await optimizerRunner.runConsolidation({ manual: true, focusEntity, maxBatches: 6 });
        updateInjection();
        if ((run?.totals?.updated ?? 0) + (run?.totals?.deleted ?? 0) > 0) emitBus('memories.updated', { consolidated: true });
        return aggregateOptimizerResult(run ?? {});
    });
}

/* v0.9.0: undo a whole optimizer/consolidation run from its runLog diff. */
async function undoRun(index, runId = null) {
    const log = readState().runLog ?? [];
    const record = runId ? log.find(item => item.runId === runId) : log[index];
    if (record?.changes && (record.changes.truncated || record.changes.undoable === false)) {
        toastr.warning(`Memory Weaver: ${tr('this pass was too large — not enough was saved to undo it safely.')}`, 'Memory Weaver');
        return false;
    }
    if (!record?.changes || record.reverted) {
        toastr.info(`Memory Weaver: ${tr('this pass can no longer be undone.')}`, 'Memory Weaver');
        return false;
    }
    const scope = String(getContext().chatId ?? '');
    const confirmed = await callGenericPopup(tr('Undo every change from this pass? The messages it read will NOT be remembered again automatically (use "Review again" or "Scan again" if needed).'), POPUP_TYPE.CONFIRM);
    if (confirmed !== POPUP_RESULT.AFFIRMATIVE || String(getContext().chatId ?? '') !== scope) return false;
    const commit = controller.commitMutation({ kind: 'user', ...dispatchScope(), reason: 'undo run' }, (live) => {
        /* v0.9.1: a whole burst (all chunk/batch records of its runId)
           reverts as one unit; legacy records revert alone. */
        if (record.runId) return revertRunGroup(live, record.runId);
        const target = (live.runLog ?? []).find(item => item.at === record.at && (item.jobId ?? null) === (record.jobId ?? null));
        if (!target) return { ok: false, reason: 'moved' };
        return revertRunChanges(live, target);
    });
    if (!commit.ok || !commit.result?.ok) {
        if (!commit.ok) warnMutationRejection('undo run', commit);
        const why = { epoch: tr('memories were cleared after that pass'), truncated: tr('the pass was too large to save enough for an undo'), already_reverted: tr('already undone') }[commit.result?.reason] ?? tr('the run history has changed');
        toastr.warning(`Memory Weaver: ${tr('could not undo ({reason}).', { reason: why })}`, 'Memory Weaver');
        return false;
    }
    const r = commit.result;
    updateInjection();
    emitBus('memories.updated', { revertedRun: true });
    const undoCounts = { removed: r.removed ?? 0, restored: r.restored ?? 0, reverted: r.reverted ?? 0, skipped: r.skipped ?? 0 };
    toastr.success(`Memory Weaver: ${r.skipped
        ? tr('pass undone (−{removed} added · +{restored} restored · ~{reverted} edited · skipped {skipped} changed since).', undoCounts)
        : tr('pass undone (−{removed} added · +{restored} restored · ~{reverted} edited).', undoCounts)}`, 'Memory Weaver');
    return true;
}

/* v0.9.0: user edits of chapters (title/summary/lock) and deletion. */
function editChapterById(id, patch) {
    const commit = controller.commitMutation({ kind: 'user', ...dispatchScope(), reason: 'chapter edit' }, (live) => updateChapter(live, String(id ?? ''), patch ?? {}));
    if (!commit.ok || !commit.result?.ok) {
        if (!commit.ok) warnMutationRejection('chapter edit', commit);
        return false;
    }
    updateInjection();
    emitBus('chapters.updated', { id });
    return true;
}

function deleteChapterById(id) {
    const commit = controller.commitMutation({ kind: 'user', ...dispatchScope(), reason: 'chapter delete' }, (live) => removeChapter(live, String(id ?? '')));
    if (!commit.ok || !commit.result?.ok) {
        if (!commit.ok) warnMutationRejection('chapter delete', commit);
        return false;
    }
    updateInjection();
    emitBus('chapters.updated', { id, deleted: true });
    return true;
}

/* v0.9.0: "Siêu thông minh" preset — dotted keys set nested settings. */
function readSettingPath(settings, path) {
    return path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), settings);
}

function writeSettingPath(settings, path, value) {
    const keys = path.split('.');
    let node = settings;
    for (const key of keys.slice(0, -1)) {
        if (!node[key] || typeof node[key] !== 'object') node[key] = {};
        node = node[key];
    }
    node[keys[keys.length - 1]] = value;
}

function smartPresetActive() {
    const settings = getSettings();
    return Object.entries(SMART_PRESET).every(([path, value]) => readSettingPath(settings, path) === value);
}

function applySmartPreset() {
    const settings = getSettings();
    if (!settings.presetBackup) {
        settings.presetBackup = Object.fromEntries(Object.keys(SMART_PRESET).map(path => [path, readSettingPath(settings, path)]));
    }
    for (const [path, value] of Object.entries(SMART_PRESET)) writeSettingPath(settings, path, value);
    saveSettingsDebounced();
    afterBulkSettingsChange();
    if (settings.retrieval?.enabled) scheduleSync();
    toastr.success(`Memory Weaver: ${tr('Super Smart mode is on (large budgets + every feature). You can restore your previous settings at any time.')}`, 'Memory Weaver');
}

async function restorePresetBackup() {
    const settings = getSettings();
    const backup = settings.presetBackup;
    if (!backup) return;
    /* v0.9.1: restoring a smaller "max memories" would evict the overflow
       permanently at the next commit (no undo) — ask, or keep the larger cap. */
    const count = readState().entries.length;
    const restoreCap = Number(backup.maxEntries);
    let keepCap = false;
    if (Number.isFinite(restoreCap) && restoreCap < count) {
        const answer = await callGenericPopup(tr('This chat has {count} memories. Restoring "Max memories per chat" = {cap} will PERMANENTLY DELETE about {excess} less important memories at the next write (locked/pinned ones are kept).\n\nOK = restore that limit too. Cancel = restore everything else but KEEP the current limit ({current}).', { count, cap: restoreCap, excess: count - restoreCap, current: settings.maxEntries }), POPUP_TYPE.CONFIRM);
        keepCap = answer !== POPUP_RESULT.AFFIRMATIVE;
    }
    for (const [path, value] of Object.entries(backup)) {
        if (value === undefined) continue;
        if (keepCap && path === 'maxEntries') continue;
        writeSettingPath(settings, path, value);
    }
    delete settings.presetBackup;
    saveSettingsDebounced();
    afterBulkSettingsChange();
    toastr.info(`Memory Weaver: ${tr('restored the settings from before Super Smart mode.')}`, 'Memory Weaver');
}

/* Drawer controls are plain inputs — re-sync all of them after a preset. */
function afterBulkSettingsChange() {
    const settings = getSettings();
    const chapters = chaptersSettings();
    $('#mw_budget').val(settings.injectBudgetTokens);
    $('#mw_input_budget').val(settings.optimizerInputBudgetTokens);
    $('#mw_burst').val(settings.backlogMaxChunksPerRun);
    $('#mw_max_entries').val(settings.maxEntries);
    $('#mw_existing_max').val(settings.optimizerExistingMax);
    $('#mw_recall_wait').val(settings.recallWaitMs);
    $('#mw_dedupe_mode').val(settings.dedupeMode === 'near' ? 'near' : 'exact');
    $('#mw_recall_enabled').prop('checked', Boolean(settings.retrieval?.enabled));
    $('#mw_sched_auto').prop('checked', Boolean(settings.scheduleAuto?.enabled));
    $('#mw_chapters_enabled').prop('checked', chapters.enabled);
    $('#mw_chapters_every').val(chapters.everyMessages);
    $('#mw_chapters_budget').val(chapters.budgetTokens);
    $('#mw_consolidate_every').val(Math.max(0, Math.round(Number(settings.consolidation?.autoEvery)) || 0));
    updateRecallStatusText();
    updatePresetButton();
    updateInjection();
    syncSettingsControls();
    updateSendFormBadge();
    dashboard.requestRender();
}

function updatePresetButton() {
    const active = smartPresetActive();
    const hasBackup = Boolean(getSettings().presetBackup);
    $('#mw_smart_preset').toggleClass('mw-on', active).find('span').text(active ? tr('Super Smart: on') : tr('Turn on Super Smart mode'));
    $('#mw_smart_restore').toggle(hasBackup);
}

/* v0.7.0: "Rà soát lại" — re-read the dirty range [dirtyFrom, cursor) so
   the model can fix memories about edited/deleted history. The cursor never
   moves; dirtyFrom advances per chunk and status returns to ok at the end. */
async function runReviewPass() {
    return withOptimizerLock(async () => {
        const run = await optimizerRunner.runReviewFrom({ manual: true });
        const result = aggregateOptimizerResult(run);
        /* Review-specific outcomes get their own wording; `toasted` tells
           the caller not to run the generic optimizer toast on top. */
        const changes = tr('+{added} new · ~{updated} edited · −{deleted} deleted', { added: result.added, updated: result.updated, deleted: result.deleted });
        if (run.stopped === 'not_needed') {
            toastr.info(`Memory Weaver: ${tr('nothing needs reviewing.')}`, 'Memory Weaver');
            result.toasted = true;
        } else if (run.reviewComplete) {
            toastr.success(`Memory Weaver: ${run.chunks?.length ? tr('review finished ({changes}).', { changes }) : tr('the edited range has no messages left to read — marked as reviewed.')}`, 'Memory Weaver');
            result.toasted = true;
        } else if (run.ok && run.stopped === 'burst_limit') {
            toastr.info(`Memory Weaver: ${tr('partly reviewed ({changes}) — press "Review again" once more to continue.', { changes })}`, 'Memory Weaver');
            result.toasted = true;
        } else if (run.stopped === 'generation_active') {
            /* v0.8: a review is never auto-requeued — say so honestly. */
            toastr.info(`Memory Weaver: ${tr('the AI is replying — wait for it to finish, then press "Review again".')}`, 'Memory Weaver');
            result.toasted = true;
        } else if (run.stopped === 'chat_switched') {
            toastr.info(`Memory Weaver: ${tr('the chat changed midway — the review was cancelled.')}`, 'Memory Weaver');
            result.toasted = true;
        } else if (run.stopped === 'blocked') {
            const blockedIndex = (run.chunks ?? []).find(chunk => chunk.outcome === 'blocked')?.rawIndex ?? readState().processing?.blocked?.rawIndex;
            toastr.warning(`Memory Weaver: ${tr('the review hit an oversized message — click this notice to SKIP it and keep reviewing.')}`, 'Memory Weaver', {
                timeOut: 8000,
                extendedTimeOut: 4000,
                onclick: () => {
                    if (Number.isFinite(Number(blockedIndex))) skipBlockedMessage(blockedIndex, { review: true });
                },
            });
            result.toasted = true;
        } else if (!run.ok && result.error) {
            toastr.warning(`Memory Weaver: ${tr('review failed ({error}) — the unreviewed range is kept; press "Review again" to retry.', { error: result.error })}`, 'Memory Weaver');
            result.toasted = true;
        }
        updateInjection();
        updateSendFormBadge();
        dashboard.requestRender();
        return result;
    });
}

/* v0.7.0: "Bỏ qua" / "Đánh dấu đã kiểm tra" — accept the current history as
   the processed prefix (recompute digests, status ok). Housekeeping write:
   memories are untouched, nothing is replayed. */
function acknowledgeCoverage() {
    const chat = getContext().chat ?? [];
    const commit = controller.commitMutation({ kind: 'housekeeping', ...dispatchScope(), reason: 'acknowledge coverage' }, (live) => {
        /* A cursor past the end of the chat (history deleted after it was
           processed) is pulled back ONLY here, on the user's explicit
           "Chấp nhận lịch sử hiện tại" — never automatically (invariant 11). */
        /* v0.8: also pull back to the shortest length seen since the
           deletion — messages appended afterwards (below the old cursor)
           were never read and must stay pending, not be "acknowledged". */
        const floor = minDirty(chat.length, live.processing?.shrunkTo);
        const shortened = Number(live.processedMessages ?? 0) > floor;
        if (shortened) live.processedMessages = floor;
        live.processing = acknowledgedProcessing(live, chat);
        live.processing.shrunkTo = null;
        return { status: live.processing.status, shortened };
    });
    if (!commit.ok) {
        warnMutationRejection('acknowledge coverage', commit);
        return false;
    }
    if (commit.result.status !== PROCESSING_STATUS.OK) {
        toastr.warning(`Memory Weaver: ${tr('could not mark it — see the Console (F12).')}`, 'Memory Weaver');
    } else {
        toastr.success(`Memory Weaver: ${commit.result.shortened ? tr('accepted the current history — remembering continues from new messages.') : tr('marked as checked.')}`, 'Memory Weaver');
    }
    updateSendFormBadge();
    updateSettingsSummary();
    dashboard.requestRender();
    return true;
}

async function runRecentWindowScan() {
    return withOptimizerLock(async () => {
        const run = await optimizerRunner.runRecentWindow({ manual: true });
        const result = aggregateOptimizerResult(run);
        result.crossesGap = run.crossesGap === true;
        return result;
    });
}

function registerMemoriesCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'memories',
        helpString: 'Memory Weaver: view, add, summarize, delete or clear the chat-local memories; manage the schedule. Named args come BEFORE the text. Examples: /memories (opens the dashboard) | /memories action=add entity=Alice importance=3 Alice learns the hidden passage | /memories action=sched_add when=after:40 Breakfast with Alice | /memories action=sched_add when=day:13 Sword duel with Bob | /memories action=clock day=13 | /memories action=summarize',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Memory text (for action=add, sched_add).',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'action',
                description: 'view | add | summarize | recall | delete | clear | sched_add | sched_done | sched_cancel | sched_miss | sched_postpone | sched_clear | clock | vindex',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'view',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'rebuild',
                description: 'vindex=true forces a full index rebuild.',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'entity',
                description: 'Entity names the memory/appointment is about (repeatable).',
                typeList: [ARGUMENT_TYPE.STRING],
                acceptsMultiple: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'importance',
                description: 'Importance 1-3 (3 = core fact).',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'id',
                description: 'Entry/appointment id (for delete, sched_done, sched_cancel, sched_miss, sched_postpone).',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'when',
                description: 'sched_add timing: after:<N messages> or day:<story day>. Example: when=after:40',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'lead',
                description: 'sched_add: remind this many turns (after) / story-days (day) early.',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'amount',
                description: 'sched_postpone: units to move the appointment by.',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'day',
                description: 'clock: set the current story day.',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
        ],
        callback: async (args, value) => {
            const action = String(args?.action ?? 'view').trim().toLowerCase();
            const text = String(value ?? '').trim();

            if (action === 'view') {
                await showMemoriesPopup();
                return '';
            }

            if (action === 'add') {
                if (!text) {
                    toastr.warning(`Memory Weaver: ${tr('enter the memory text.')}`, 'Memory Weaver');
                    return '';
                }
                let entities = Array.isArray(args?.entity) ? args.entity.map(String) : (args?.entity ? [String(args.entity)] : []);
                entities = entities.map(entity => entity.trim()).filter(Boolean);
                if (!entities.length) entities.push(activeCharacterName() || 'USER');
                const importance = Number(args?.importance);
                const result = addManualEntry(text, entities, Number.isFinite(importance) ? importance : 2);
                if ((result?.added ?? 0) > 0) toastr.success(`Memory Weaver: ${trn('added {n} memory.', 'added {n} memories.', result.added)}`, 'Memory Weaver');
                else toastr.warning(`Memory Weaver: ${tr('nothing added — the memory already exists or writing is blocked.')}`, 'Memory Weaver');
                return '';
            }

            if (action === 'summarize') {
                /* v0.6.4: same feedback path as the dashboard button — stop
                   reasons without an error string were silent here. */
                toastOptimizerResult(await runOptimizer('manual'));
                return '';
            }

            if (action === 'recall') {
                /* v0.6.0 (T7.2) review-fix (C1): the query text drives the
                   envelope's mention/lexical tiers via recentTexts (the same
                   path the Storyline bridge uses — plan T7.2's exact API);
                   refreshRecall() first just warms the vector cache so the
                   hits are current. Text is OPTIONAL: without it this is the
                   context inspector. */
                if (!getSettings().retrieval?.enabled) {
                    toastr.info(`Memory Weaver: ${tr('turn on "Vector recall" in the settings to use this command.')}`, 'Memory Weaver');
                    return '';
                }
                const query = String(text ?? '').trim();
                const started = Date.now();
                await refreshRecall();
                const envelope = buildRecallEnvelope({ recentTexts: query ? [query] : [], profile: 'narrative' });
                const elapsed = Date.now() - started;
                const hitIds = Array.isArray(envelope.ids) ? envelope.ids : [];
                if (!hitIds.length) {
                    toastr.info(`Memory Weaver: ${query ? tr('no hits ({ms} ms) for "{query}".', { ms: elapsed, query }) : tr('no hits ({ms} ms).', { ms: elapsed })}`, 'Memory Weaver');
                    return '';
                }
                const lines = (Array.isArray(envelope.lines) && envelope.lines.length ? envelope.lines : hitIds.map(id => `- ${id}`)).slice(0, 6);
                toastr.info(`Memory Weaver: ${trn('{n} hit · mode {mode} ({ms} ms)', '{n} hits · mode {mode} ({ms} ms)', hitIds.length, { mode: envelope.mode, ms: elapsed })}\n${lines.join('\n')}`, 'Memory Weaver', { timeOut: 10000 });
                return '';
            }

            if (action === 'delete') {
                const id = String(args?.id ?? '').trim();
                if (!id) {
                    toastr.warning(`Memory Weaver: ${tr('give id=... (see /memories view).')}`, 'Memory Weaver');
                    return '';
                }
                const removed = removeMemory(id);
                toastr[removed ? 'success' : 'warning'](`Memory Weaver: ${removed ? tr('memory deleted.') : tr('no memory with this id.')}`, 'Memory Weaver');
                return '';
            }

            if (action === 'clear') {
                const scopeAtConfirm = String(getContext().chatId ?? '');
                const confirmed = await callGenericPopup(tr('Delete ALL memories of this chat?'), POPUP_TYPE.CONFIRM);
                /* v0.6.0 (U8): the confirm is async — an AFFIRMATIVE answered
                   after a chat switch must not wipe the wrong chat. */
                if (confirmed === POPUP_RESULT.AFFIRMATIVE && String(getContext().chatId ?? '') === scopeAtConfirm) {
                    clearMemories();
                    toastr.info(`Memory Weaver: ${tr('chat memories cleared.')}`, 'Memory Weaver');
                } else if (confirmed === POPUP_RESULT.AFFIRMATIVE) {
                    toastr.warning(`Memory Weaver: ${tr('you switched chats — the delete was skipped.')}`, 'Memory Weaver');
                }
                return '';
            }

            if (action === 'sched_add') {
                if (!text) {
                    toastr.warning(`Memory Weaver: ${tr('enter the appointment text.')}`, 'Memory Weaver');
                    return '';
                }
                const when = String(args?.when ?? '').trim();
                const afterMatch = when.match(/^after:(\d+)$/i);
                const dayMatch = when.match(/^day:(\d+)$/i);
                if (!afterMatch && !dayMatch) {
                    toastr.warning(`Memory Weaver: ${tr('needs when=after:<N> or when=day:<story day>.')}`, 'Memory Weaver');
                    return '';
                }
                let entities = Array.isArray(args?.entity) ? args.entity.map(String) : (args?.entity ? [String(args.entity)] : []);
                entities = entities.map(entity => entity.trim()).filter(Boolean);
                const lead = Number(args?.lead);
                const result = createScheduleEntry({
                    text,
                    mode: afterMatch ? 'after' : 'story_day',
                    turns: afterMatch ? Number(afterMatch[1]) : undefined,
                    day: dayMatch ? Number(dayMatch[1]) : undefined,
                    entities,
                    lead: Number.isFinite(lead) ? lead : undefined,
                });
                if (result.ok) toastr.success(`Memory Weaver: ${tr('appointment added.')}`, 'Memory Weaver');
                else if (result.reason === 'duplicate') toastr.warning(`Memory Weaver: ${tr('a similar active appointment already exists.')}`, 'Memory Weaver');
                else if (result.reason === 'cap') toastr.warning(`Memory Weaver: ${tr('the active appointment limit ({max}) is reached.', { max: getSettings().maxScheduleActive })}`, 'Memory Weaver');
                else toastr.warning(`Memory Weaver: ${tr('could not add the appointment.')}`, 'Memory Weaver');
                return '';
            }

            if (action === 'sched_done' || action === 'sched_cancel' || action === 'sched_miss') {
                const id = String(args?.id ?? '').trim();
                if (!id) {
                    toastr.warning(`Memory Weaver: ${tr('give id=... (see /memories view).')}`, 'Memory Weaver');
                    return '';
                }
                const outcome = action === 'sched_done' ? 'done' : action === 'sched_cancel' ? 'cancelled' : 'missed';
                const result = resolveScheduleById(id, outcome, { createMemory: action === 'sched_done' });
                if (result.ok) {
                    const done = result.memoryCreated ? tr('appointment completed and saved as a memory.') : tr('appointment completed.');
                    toastr.success(`Memory Weaver: ${action === 'sched_done' ? done : (outcome === 'cancelled' ? tr('appointment marked "cancelled".') : tr('appointment marked "missed".'))}`, 'Memory Weaver');
                }
                else toastr.warning(`Memory Weaver: ${tr('no active appointment with this id.')}`, 'Memory Weaver');
                return '';
            }

            if (action === 'sched_postpone') {
                const id = String(args?.id ?? '').trim();
                const amount = Number(args?.amount);
                if (!id || !Number.isFinite(amount) || amount === 0) {
                    toastr.warning(`Memory Weaver: ${tr('give id=... and a non-zero amount=....')}`, 'Memory Weaver');
                    return '';
                }
                if (postponeScheduleById(id, amount)) toastr.success(`Memory Weaver: ${tr('appointment postponed.')}`, 'Memory Weaver');
                else toastr.warning(`Memory Weaver: ${tr('could not postpone — no pending appointment with this id, or it would duplicate another one.')}`, 'Memory Weaver');
                return '';
            }

            if (action === 'sched_clear') {
                const scopeAtConfirm = String(getContext().chatId ?? '');
                const confirmed = await callGenericPopup(tr('Delete the WHOLE schedule of this chat (memories are not touched)?'), POPUP_TYPE.CONFIRM);
                if (confirmed === POPUP_RESULT.AFFIRMATIVE && String(getContext().chatId ?? '') === scopeAtConfirm) {
                    const removed = wipeSchedule();
                    toastr.info(`Memory Weaver: ${trn('deleted {n} appointment.', 'deleted {n} appointments.', removed)}`, 'Memory Weaver');
                } else if (confirmed === POPUP_RESULT.AFFIRMATIVE) {
                    toastr.warning(`Memory Weaver: ${tr('you switched chats — the delete was skipped.')}`, 'Memory Weaver');
                }
                return '';
            }

            if (action === 'clock') {
                const day = Number(args?.day);
                if (!Number.isFinite(day) || day < 1) {
                    toastr.warning(`Memory Weaver: ${tr('give day=<current story day> (≥ 1).')}`, 'Memory Weaver');
                    return '';
                }
                if (setStoryClockDay(day)) toastr.success(`Memory Weaver: ${tr('today is story day {day}.', { day })}`, 'Memory Weaver');
                else toastr.info(`Memory Weaver: ${tr('the story clock is already on day {day} (or writing is blocked).', { day })}`, 'Memory Weaver');
                return '';
            }

            if (action === 'vindex') {
                const rebuild = String(args?.rebuild ?? '').toLowerCase() === 'true';
                void syncIndex({ force: rebuild });
                const status = getRetrieverStatus();
                const indexInfo = { status: status.status, documents: status.documents, entries: status.entries };
                toastr.info(`Memory Weaver: ${rebuild ? tr('vector index {status} — {documents}/{entries} documents (rebuild requested).', indexInfo) : tr('vector index {status} — {documents}/{entries} documents.', indexInfo)}`, 'Memory Weaver');
                return '';
            }

            toastr.warning(`Memory Weaver: ${tr('invalid action "{action}".', { action })}`, 'Memory Weaver');
            return '';
        },
    }));
}

/* Toast feedback for an optimizer run (aggregated result shape).
   v0.5.1: every manual click now lands in a visible branch — the old
   `result.ok && result.skipped` guard was dead code (a skipped burst always
   reports ok:false) and stop reasons without a chunk error fell through to
   silence, so "Tối ưu ngay" sometimes did NOTHING visible.
   v0.5.2: stop reasons are checked BEFORE the skipped branch — a burst
   stopped by generation_active/disabled/etc used to inherit the "no new
   messages" message while pending messages were waiting. */
function toastOptimizerResult(result, { auto = false } = {}) {
    const stopped = result.stopped ?? null;
    /* v0.6.0 (F5a): ops dropped because they touched locked entries surface
       in every committed outcome instead of vanishing silently. */
    const protectedCount = (Array.isArray(result.chunks) ? result.chunks : [])
        .reduce((acc, chunk) => acc + (chunk.protected ?? 0), 0);
    const protectedNote = protectedCount > 0 ? ` ${trn('(skipped {n} change to a locked memory)', '(skipped {n} changes to locked memories)', protectedCount)}` : '';
    if (stopped === 'busy') {
        if (!auto) toastr.info(`Memory Weaver: ${tr('a memory pass is already running — wait for it to finish, then try again.')}`, 'Memory Weaver');
        return;
    }
    if (stopped === 'generation_active') {
        if (!auto) toastr.info(`Memory Weaver: ${tr('the AI is replying — the memory pass will run by itself once the reply is done.')}`, 'Memory Weaver');
        return;
    }
    if (stopped === 'disabled') {
        toastr.warning(`Memory Weaver: ${tr('the extension is off — turn it back on in Extensions → Memory Weaver.')}`, 'Memory Weaver');
        return;
    }
    if (stopped === 'mode_off') {
        toastr.info(`Memory Weaver: ${tr('automatic memory is off — memories are only written by hand.')}`, 'Memory Weaver');
        return;
    }
    if (stopped === 'state_corrupt') {
        toastr.warning(`Memory Weaver: ${tr('the chat state is corrupt (a recovery copy was saved) — all writes are blocked until it is repaired by hand.')}`, 'Memory Weaver');
        return;
    }
    if (stopped === 'retry_blocked') {
        toastr.warning(`Memory Weaver: ${tr('this range already failed twice — wait for new messages and try again, or use "Rescan last 60 messages".')}`, 'Memory Weaver');
        return;
    }
    if (stopped === 'blocked') {
        /* v0.6.0 (F1): the toast IS the escape hatch — clicking it skips the
           blocking message and reruns the pass. */
        const blockedIndex = (Array.isArray(result.chunks) ? result.chunks : [])
            .find(chunk => chunk.outcome === 'blocked')?.rawIndex;
        toastr.warning(
            `Memory Weaver: ${tr('blocked by a message larger than the memory pass budget — click this notice to SKIP it and continue.')}`,
            'Memory Weaver',
            {
                timeOut: 8000,
                extendedTimeOut: 4000,
                onclick: () => {
                    if (Number.isFinite(Number(blockedIndex))) skipBlockedMessage(blockedIndex);
                },
            },
        );
        return;
    }
    if (stopped === 'needs_review') {
        /* v0.6.0 (S7): a cursor beyond the chat length is never clamped —
           the run refuses and the coverage note on the dashboard explains. */
        toastr.warning(`Memory Weaver: ${tr('the cursor is past the end of the chat (history was deleted) — not running; see the review warning on the dashboard.')}`, 'Memory Weaver');
        return;
    }
    if (stopped === 'conflict') {
        toastr.warning(`Memory Weaver: ${tr('the memory pass conflicted with a state change ({error}) — nothing was written, it will retry.', { error: result.error ?? tr('changed elsewhere') })}`, 'Memory Weaver');
        return;
    }
    if (stopped === 'chat_switched') {
        toastr.info(`Memory Weaver: ${tr('the chat changed midway — the memory pass moved to the new chat.')}`, 'Memory Weaver');
        return;
    }
    if (result.skipped) {
        if (!auto) toastr.info(`Memory Weaver: ${tr('no new messages to remember.')}`, 'Memory Weaver');
        return;
    }
    if (result.ok) {
        if (result.outcome === 'no_change') {
            if (!auto) toastr.info(`Memory Weaver: ${tr('done — nothing new to save.')}${protectedNote}`, 'Memory Weaver');
            return;
        }
        if (result.outcome === 'deduped') {
            if (!auto) toastr.info(`Memory Weaver: ${tr('nothing new — everything is already in memory.')}${protectedNote}`, 'Memory Weaver');
            return;
        }
        toastr.info(`Memory Weaver: ${tr('memories updated (+{added} new · ~{updated} edited · −{deleted} deleted).', { added: result.added, updated: result.updated, deleted: result.deleted })}${protectedNote}`, 'Memory Weaver');
        return;
    }
    if (result.error) {
        toastr.warning(`Memory Weaver: ${tr('memory pass failed ({error}) — the cursor was kept; it will retry once enough new messages arrive.', { error: result.error })}`, 'Memory Weaver');
        return;
    }
    /* v0.5.1 fallback: a failed run without an error string must never be
       silent again (was the "bấm xong chẳng thấy gì" hole). */
    if (!auto) toastr.warning(`Memory Weaver: ${tr('memory pass failed (unknown cause — check the Console, F12).')}`, 'Memory Weaver');
}

/* ---------------------------------------------------------------------------
 * Dashboard (v0.7.0) — the UI lives in dashboard.js; this section only wires
 * it to the domain operations above (every write still goes through the
 * mutation boundary) and computes the read-only injection preview.
 * ------------------------------------------------------------------------- */

function tierOfId(tiers, id) {
    for (const [tier, ids] of Object.entries(tiers ?? {})) {
        if (Array.isArray(ids) && ids.includes(id)) return tier;
    }
    return '';
}

/* What the NEXT generation will carry: the exact [Chat Memories] text, the
   entry ids inside it, tiers (hybrid), the schedule blocks AND (v0.8) a
   per-entry verdict for the "AI có nhớ chuyện này không?" diagnostic:
   in | budget (eligible/candidate but did not fit) | gate (legacy filter:
   not core, not tagged USER/char, not among the newest) | irrelevant
   (hybrid: not mentioned / no vector hit this turn). Read-only — the legacy
   text comes from the same selectInjectionEntries the real injection uses. */
function getInjectionPreview() {
    const settings = getSettings();
    const context = getContext();
    const base = { active: false, ids: [], text: '', budget: Number(settings.injectBudgetTokens ?? 600), eligible: 0, estimatedTokens: 0, mode: 'off', tiers: null, scheduleText: '', reasons: {}, pinnedIds: [] };
    if (!context.chatMetadata || !context.chatId) return { ...base, reason: tr('No chat is open.') };
    if (!settings.enabled) return { ...base, reason: tr('Memory Weaver is off — nothing is added to the prompt.') };
    const state = readState();
    base.pinnedIds = pinnedIdsOf(state.entries);
    if (settings.scheduleEnabled) {
        const blocks = buildScheduleBlocks(state.schedule, { turnCount: state.turnCount, clockDay: state.clock?.day ?? null, budgetTokens: settings.scheduleBudgetTokens });
        base.scheduleText = [blocks.upcoming, blocks.due].filter(Boolean).join('\n\n');
    }
    if (!settings.injectEnabled) return { ...base, reason: tr('"Add memories to the prompt" is off — the AI sees no memories.') };
    const reasons = {};
    if (settings.retrieval?.enabled) {
        const result = buildRecallSelection(state, settings, { peek: true });
        const included = new Set([...result.ids].map(String));
        const candidates = new Set(result.candidateIds ?? []);
        const skipped = new Set((result.skippedIds ?? []).map(String));
        for (const entry of state.entries) {
            const id = String(entry.id);
            if (included.has(id)) reasons[id] = { status: 'in', tier: tierOfId(result.tiers, id) };
            else if (candidates.has(id) || skipped.has(id) || entry.pinned === true) reasons[id] = { status: 'budget' };
            else reasons[id] = { status: 'irrelevant' };
        }
        return {
            ...base,
            active: true,
            ids: [...included],
            text: result.lines.length ? ['[Chat Memories — established facts from earlier in this chat]', ...result.lines].join('\n') : '',
            eligible: state.entries.length,
            estimatedTokens: result.estimatedTokens ?? 0,
            mode: result.recallMode === 'hybrid' ? 'hybrid' : 'lexical',
            fallbackReason: result.fallbackReason ?? '',
            tiers: result.tiers ?? null,
            reasons,
        };
    }
    const eligibleEntries = legacyEligibleEntries(state.entries);
    const selection = selectInjectionEntries(eligibleEntries, base.budget, { pinnedIds: base.pinnedIds });
    const included = new Set(selection.ids.map(String));
    const pinnedIn = new Set((selection.pinnedIds ?? []).map(String));
    const eligibleIds = new Set(eligibleEntries.map(entry => String(entry.id)));
    for (const entry of state.entries) {
        const id = String(entry.id);
        if (included.has(id)) reasons[id] = { status: 'in', tier: pinnedIn.has(id) ? 'pinned' : '' };
        else if (eligibleIds.has(id)) reasons[id] = { status: 'budget' };
        else reasons[id] = { status: 'gate' };
    }
    return {
        ...base,
        active: true,
        ids: [...included],
        text: selection.lines.length ? ['[Chat Memories — established facts from earlier in this chat]', ...selection.lines].join('\n') : '',
        eligible: eligibleEntries.length,
        estimatedTokens: selection.usedTokens ?? 0,
        mode: 'legacy',
        tiers: pinnedIn.size ? { pinned: [...pinnedIn] } : null,
        reasons,
    };
}

/* v0.8: unprocessed-history search for the diagnostic — a fact the user
   remembers may simply not have been memorized yet. */
function searchUnprocessedMessages(query, limit = 3) {
    const needle = String(query ?? '').trim();
    if (needle.length < 2) return [];
    const foldChar = char => char.normalize('NFD').replace(/\p{M}+/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
    const fold = value => [...String(value ?? '').normalize('NFC')].map(foldChar).join('');
    /* Folded string + map from every folded index to its original index. */
    const foldWithMap = (value) => {
        const chars = [...String(value ?? '').normalize('NFC')];
        let foldedText = '';
        const map = [];
        let offset = 0;
        for (const char of chars) {
            const piece = foldChar(char);
            for (let k = 0; k < piece.length; k++) map.push(offset);
            foldedText += piece;
            offset += char.length;
        }
        map.push(offset);
        return { foldedText, map, original: chars.join('') };
    };
    const folded = fold(needle);
    const chat = getContext().chat ?? [];
    const cursor = Math.max(0, Math.min(Number(readState().processedMessages ?? 0), chat.length));
    const prefix = countedPrefixArray(chat);
    const hits = [];
    for (let i = cursor; i < chat.length && hits.length < limit; i++) {
        if (!isCountedChatMessage(chat[i])) continue;
        const { foldedText, map, original } = foldWithMap(chat[i]?.mes ?? '');
        const at = foldedText.indexOf(folded);
        if (at < 0) continue;
        const start = map[at] ?? 0;
        const end = map[Math.min(at + folded.length, map.length - 1)] ?? start;
        hits.push({ rawIndex: i, ordinal: (prefix[i] ?? 0) + 1, snippet: original.slice(Math.max(0, start - 40), end + 60).replace(/\s+/g, ' ').trim() });
    }
    return hits;
}

/* Dashboard delete = one commit + a one-level undo offered by toast. */
function deleteMemoriesWithUndo(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).map(String);
    const previousUndo = undoSlot;
    snapshotUndoFor(list.length > 1 ? 'bulk delete' : 'delete');
    const removed = removeMemories(list);
    if (removed > 0) notifyUndo(trn('deleted {n} memory', 'deleted {n} memories', removed));
    else undoSlot = previousUndo;
    return removed;
}

function setSettingAndRefresh(mutator) {
    mutator(getSettings());
    saveSettingsDebounced();
    updateInjection();
    syncSettingsControls();
    updateSendFormBadge();
    dashboard.requestRender();
}

const dashboard = createDashboard({
    readState,
    getSettings,
    getContext,
    stateIntegrity: () => ({ ok: stateIntegrity.ok, reason: stateIntegrity.reason }),
    countedPrefixArray,
    scheduleStateOf,
    scheduleRemaining,
    filterByEntities,
    isOptimizerRunning: () => optimizerRunning,
    backlogState: () => ({ active: backlogRun.active, done: backlogRun.done, stopping: backlogRun.stop }),
    maxPinned: MAX_PINNED,
    chaptersSettings,
    chaptersText: chaptersInjectionText,
    chapterProgress: () => {
        /* How many counted processed messages until the next chapter. */
        const chapters = chaptersSettings();
        const state = readState();
        const chat = getContext().chat ?? [];
        const prefix = countedPrefixArray(chat);
        const last = (state.chapters ?? []).at(-1);
        const from = Math.min(Number(last?.endRaw ?? 0), chat.length);
        const cursor = Math.min(Number(state.processedMessages ?? 0), chat.length);
        const sinceLast = Math.max(0, (prefix[cursor] ?? 0) - (prefix[from] ?? 0));
        return { enabled: chapters.enabled, every: chapters.everyMessages, sinceLast, due: chapterDue() };
    },
    staleChapterIds: () => safeStaleIds(readState(), getContext().chat ?? []),
    smartPresetActive,
    hasPresetBackup: () => Boolean(getSettings().presetBackup),
    isStorylineChat: () => {
        /* Storyline chats deliver memory through its memory_keeper bridge,
           not this extension's injected block — the preview says so. */
        /* Read-only metadata probe (no import, no API call): a Storyline chat
           carries chat_metadata.storyline.storylineId. */
        try {
            const marker = getContext().chatMetadata?.storyline;
            return Boolean(marker && typeof marker === 'object' && typeof marker.storylineId === 'string' && marker.storylineId);
        } catch {
            return false;
        }
    },
    getInjectionPreview,
    getRetrieverStatus,
    isRetrievalEnabled,
    activeCharacterName,
    callGenericPopup,
    POPUP_TYPE,
    POPUP_RESULT,
    actions: {
        runOptimizer: () => runOptimizer('manual'),
        runRecentWindowScan,
        runReviewFrom: runReviewPass,
        acknowledgeCoverage,
        skipBlockedMessage,
        toastOptimizerResult,
        addMemory: addManualEntry,
        editMemory,
        deleteMemories: deleteMemoriesWithUndo,
        toggleLock: toggleLockMemory,
        togglePin: togglePinMemory,
        bulkUpdate: (ids, patch, label) => bulkUpdateWithUndo(ids, patch, label),
        renameEntity: renameEntityEverywhere,
        mergeCluster: mergeMemoryCluster,
        findDuplicates: duplicateClusters,
        jumpToMessage,
        searchUnprocessed: searchUnprocessedMessages,
        runFullBacklog,
        runChapters: runChaptersPass,
        editChapter: editChapterById,
        deleteChapter: deleteChapterById,
        runConsolidation: runConsolidationPass,
        undoRun,
        applySmartPreset,
        restorePresetBackup,
        clearMemories,
        createSchedule: createScheduleEntry,
        resolveSchedule: resolveScheduleById,
        postponeSchedule: postponeScheduleById,
        editSchedule: editScheduleById,
        setClock: setStoryClockDay,
        wipeSchedule,
        exportMarkdown: exportMemoriesMarkdown,
        importFile: importMemoriesFile,
        syncIndex: (force) => syncIndex({ force: Boolean(force) }),
        refreshRecall: async () => {
            await refreshRecall();
            updateInjection();
        },
        setEnabled: (value) => setSettingAndRefresh(settings => { settings.enabled = Boolean(value); }),
        setInjectEnabled: (value) => setSettingAndRefresh(settings => { settings.injectEnabled = Boolean(value); }),
        setScheduleEnabled: (value) => setSettingAndRefresh(settings => { settings.scheduleEnabled = Boolean(value); }),
        setInjectBudget: (value) => {
            setSettingAndRefresh(settings => { settings.injectBudgetTokens = Math.max(100, Math.min(4000, Math.round(Number(value) || 600))); });
            toastr.success(`Memory Weaver: ${tr('memory budget in the prompt = {n} tokens.', { n: getSettings().injectBudgetTokens })}`, 'Memory Weaver');
        },
    },
});

function showMemoriesPopup(tab = null) {
    return dashboard.open(tab);
}

function escapeHtml(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/* v0.7.0: the settings drawer only holds SETTINGS. The memory viewer, the
   manual add row and import/export moved into the dashboard (they used to be
   duplicated here). A summary card at the top opens the dashboard. */
function updateSettingsSummary() {
    const node = document.querySelector('#mw_summary_text');
    if (!node) return;
    const settings = getSettings();
    const state = readState();
    const context = getContext();
    const chatOpen = Boolean(context.chatMetadata && context.chatId);
    const active = (state.schedule ?? []).filter(item => item.status === 'active').length;
    const title = document.querySelector('#mw_summary_title');
    if (title) title.textContent = chatOpen ? tr('This chat: {memories} · {appointments}', { memories: trn('{n} memory', '{n} memories', state.entries.length), appointments: trn('{n} pending appointment', '{n} pending appointments', active) }) : tr('No chat open');
    const failed = state.lastResult && (state.lastResult.outcome === 'failed' || state.lastResult.outcome === 'conflict');
    const review = state.processing?.status === 'needs_review' || Boolean(state.processing?.blocked);
    let text;
    let tone;
    if (!settings.enabled) [text, tone] = [tr('Off'), 'muted'];
    else if (!chatOpen) [text, tone] = [tr('Open a chat to start'), 'muted'];
    else if (failed) [text, tone] = [tr('The last memory pass failed — open the dashboard to see why'), 'bad'];
    else if (review) [text, tone] = [tr('Something needs attention — open the dashboard'), 'warn'];
    else [text, tone] = [settings.mode === 'auto' ? tr('All good · remembering automatically') : settings.mode === 'manual' ? tr('All good · remembering on demand') : tr('Manual memories only'), 'ok'];
    node.textContent = text;
    node.className = `mw-summary-status mw-text-${tone}`;
    const budgetLabel = document.querySelector('#mw_budget_value');
    if (budgetLabel) budgetLabel.textContent = tr('~{n} tokens', { n: settings.injectBudgetTokens });
    const thresholdLabel = document.querySelector('#mw_threshold_value');
    if (thresholdLabel) thresholdLabel.textContent = trn('{n} message', '{n} messages', settings.threshold);
}

function updateRecallStatusText() {
    const node = document.querySelector('#mw_recall_status');
    if (!node) return;
    const status = getRetrieverStatus();
    const label = status.enabled
        ? (status.status === 'ready' ? tr('ready · {documents}/{entries} indexed', { documents: status.documents, entries: status.entries }) : status.status === 'error' ? tr('error: {error}', { error: status.lastError }) : String(status.status ?? '—'))
        : tr('off');
    node.textContent = tr('Vector recall: {status}', { status: label });
}

/* Keep drawer controls in sync when a setting changes from the dashboard
   (e.g. "Đặt 1000 token" or "Bật lại"). */
function syncSettingsControls() {
    const settings = getSettings();
    $('#mw_enabled').prop('checked', Boolean(settings.enabled));
    $('#mw_inject').prop('checked', Boolean(settings.injectEnabled));
    $('#mw_budget').val(settings.injectBudgetTokens);
    $('#mw_sched_enabled').prop('checked', Boolean(settings.scheduleEnabled));
    updateSettingsSummary();
}

/* UI language: resolve the setting (en | vi | auto → ST locale) into the
   active i18n language. Called at init and whenever the selector changes. */
function applyUiLanguage() {
    let locale = '';
    try {
        locale = getCurrentLocale();
    } catch {
        locale = '';
    }
    return setUiLanguage(resolveUiLanguage(getSettings().uiLanguage, locale));
}

/* Settings drawer markup. Every UI string goes through tr() and is escaped
   (escapeHtml) because it lands in an HTML string. */
function settingsDrawerHtml() {
    const settings = getSettings();
    const t = (text, params) => escapeHtml(tr(text, params));
    const experimental = `<small class="mw-tag">${t('experimental')}</small>`;
    const uiLanguage = UI_LANGUAGE_SETTINGS.includes(settings.uiLanguage) ? settings.uiLanguage : 'en';
    return `
    <div id="memoryweaver-settings" class="extension_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Memory Weaver</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content mw-settings">
                <div class="mw-label-row mw-lang-row">
                    <label for="mw_ui_language"><i class="fa-solid fa-language"></i> ${t('Language')}</label>
                    <select id="mw_ui_language" class="text_pole">
                        <option value="en" ${uiLanguage === 'en' ? 'selected' : ''}>English</option>
                        <option value="vi" ${uiLanguage === 'vi' ? 'selected' : ''}>Tiếng Việt</option>
                        <option value="auto" ${uiLanguage === 'auto' ? 'selected' : ''}>${t('Auto (follow SillyTavern)')}</option>
                    </select>
                </div>
                <div class="mw-summary">
                    <div class="mw-summary-main">
                        <div id="mw_summary_title" class="mw-summary-title">—</div>
                        <div id="mw_summary_text" class="mw-summary-status">—</div>
                    </div>
                    <button id="mw_open_dashboard" type="button" class="menu_button mw-settings-primary"><i class="fa-solid fa-brain"></i><span>${t('Open dashboard')}</span></button>
                </div>
                <div class="mw-preset">
                    <button id="mw_smart_preset" type="button" class="menu_button mw-preset-btn" title="${t('2000-token memory budget, 24k memory-pass budget, 300 memories, vector recall, near-duplicate blocking, AI-written appointments, a chapter summary every 80 messages, automatic memory merge every 5 passes')}"><i class="fa-solid fa-bolt"></i><span>${t('Turn on Super Smart mode')}</span></button>
                    <button id="mw_smart_restore" type="button" class="menu_button" style="display:none">${t('Restore previous settings')}</button>
                    <small class="mw-settings-hint">${t('Quality over cost: the AI sees more memories, gets a story summary and duplicates are cleaned up automatically. Uses more tokens per turn.')}</small>
                </div>

                <div class="mw-settings-section">${t('Basics')}</div>
                <label class="checkbox_label">
                    <input id="mw_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
                    <span>${t('Enable Memory Weaver')}</span>
                </label>
                <label for="mw_mode">${t('How memories are made')}</label>
                <select id="mw_mode" class="text_pole">
                    <option value="auto" ${settings.mode === 'auto' ? 'selected' : ''}>${t('Automatic — the AI records memories every N messages')}</option>
                    <option value="manual" ${settings.mode === 'manual' ? 'selected' : ''}>${t('On demand — runs only when you press "Remember now"')}</option>
                    <option value="off" ${settings.mode === 'off' ? 'selected' : ''}>${t('Manual only — the AI never writes memories')}</option>
                </select>
                <label for="mw_threshold" class="mw-label-row"><span>${t('Remember every')}</span><b id="mw_threshold_value"></b></label>
                <input id="mw_threshold" type="range" min="5" max="100" step="1" value="${escapeHtml(settings.threshold)}">
                <label class="checkbox_label">
                    <input id="mw_inject" type="checkbox" ${settings.injectEnabled ? 'checked' : ''}>
                    <span>${t('Add memories to the prompt')}</span>
                </label>
                <label for="mw_budget" class="mw-label-row"><span>${t('Memory budget in the prompt')}</span><b id="mw_budget_value"></b></label>
                <input id="mw_budget" type="range" min="100" max="4000" step="50" value="${escapeHtml(settings.injectBudgetTokens)}">
                <small class="mw-settings-hint">${t('Higher = the AI remembers more facts but uses more tokens every turn. See what the AI gets on the dashboard\'s "In prompt" tab.')}</small>

                <div class="mw-settings-section">${t('Features')}</div>
                <label class="checkbox_label">
                    <input id="mw_chapters_enabled" type="checkbox" ${chaptersSettings().enabled ? 'checked' : ''}>
                    <span>${t('Story chapters — the AI writes a "story so far" summary and adds it to the prompt')}</span>
                </label>
                <div class="mw-indent mw-settings-grid">
                    <label for="mw_chapters_every">${t('Messages per chapter (approx.)')}</label>
                    <input id="mw_chapters_every" class="text_pole" type="number" min="20" max="400" step="10" value="${escapeHtml(chaptersSettings().everyMessages)}">
                    <label for="mw_chapters_budget">${t('Tokens for the summary block')}</label>
                    <input id="mw_chapters_budget" class="text_pole" type="number" min="100" max="4000" step="50" value="${escapeHtml(chaptersSettings().budgetTokens)}">
                </div>
                <label class="checkbox_label">
                    <input id="mw_sched_enabled" type="checkbox" ${settings.scheduleEnabled ? 'checked' : ''}>
                    <span>${t('Schedule — remind the AI of appointments / future events')}</span>
                </label>
                <label class="checkbox_label mw-indent">
                    <input id="mw_sched_auto" type="checkbox" ${settings.scheduleAuto?.enabled ? 'checked' : ''}>
                    <span>${t('Let the AI add appointments while remembering')} ${experimental}</span>
                </label>
                <label class="checkbox_label mw-indent">
                    <input id="mw_sched_auto_miss" type="checkbox" ${settings.scheduleAuto?.autoMiss ? 'checked' : ''}>
                    <span>${t('Mark long-overdue appointments as "missed" automatically (needs the option above)')}</span>
                </label>
                <label class="checkbox_label">
                    <input id="mw_recall_enabled" type="checkbox" ${settings.retrieval?.enabled ? 'checked' : ''}>
                    <span>${t('Vector recall — find older memories about the current topic')} ${experimental}</span>
                </label>
                <div class="mw-indent mw-label-row">
                    <small id="mw_recall_status" aria-live="polite">${t('Vector recall: {status}', { status: tr('off') })}</small>
                    <button id="mw_vindex_sync" type="button" class="menu_button" title="${t('Rebuild the vector index of this chat')}">${t('Resync')}</button>
                </div>

                <details class="mw-settings-advanced">
                    <summary>${t('Advanced')}</summary>
                    <label for="mw_input_budget">${t('Token budget per memory pass (2000–32000)')}</label>
                    <input id="mw_input_budget" class="text_pole" type="number" min="2000" max="32000" step="500" value="${escapeHtml(settings.optimizerInputBudgetTokens)}">
                    <label for="mw_burst">${t('Max chunks processed per pass (1–10)')}</label>
                    <input id="mw_burst" class="text_pole" type="number" min="1" max="10" step="1" value="${escapeHtml(settings.backlogMaxChunksPerRun)}">
                    <label for="mw_max_entries">${t('Max memories per chat (20–500)')}</label>
                    <input id="mw_max_entries" class="text_pole" type="number" min="20" max="500" step="10" value="${escapeHtml(settings.maxEntries)}">
                    <label for="mw_sched_budget">${t('Max tokens for the schedule block')}</label>
                    <input id="mw_sched_budget" class="text_pole" type="number" min="40" max="400" step="10" value="${escapeHtml(settings.scheduleBudgetTokens)}">
                    <label for="mw_sched_cap">${t('Max pending appointments per chat')}</label>
                    <input id="mw_sched_cap" class="text_pole" type="number" min="5" max="100" step="5" value="${escapeHtml(settings.maxScheduleActive)}">
                    <label for="mw_existing_max">${t('Existing memories the AI reviews per pass (50–300)')}</label>
                    <input id="mw_existing_max" class="text_pole" type="number" min="50" max="300" step="10" value="${escapeHtml(settings.optimizerExistingMax ?? 150)}">
                    <label for="mw_consolidate_every">${t('Let the AI merge & clean up memories every N automatic passes (0 = manual only)')}</label>
                    <input id="mw_consolidate_every" class="text_pole" type="number" min="0" max="50" step="1" value="${escapeHtml(Math.max(0, Math.round(Number(settings.consolidation?.autoEvery)) || 0))}">
                    <label for="mw_recall_wait">${t('Wait for vector recall before the AI replies (ms, 0 = never wait)')}</label>
                    <input id="mw_recall_wait" class="text_pole" type="number" min="0" max="5000" step="100" value="${escapeHtml(settings.recallWaitMs ?? 1500)}">
                    <label for="mw_dedupe_mode">${t('Duplicate blocking when adding memories')}</label>
                    <select id="mw_dedupe_mode" class="text_pole">
                        <option value="exact" ${settings.dedupeMode === 'near' ? '' : 'selected'}>${t('Exact — blocks identical text only')}</option>
                        <option value="near" ${settings.dedupeMode === 'near' ? 'selected' : ''}>${t('Near — also blocks rephrased sentences (experimental)')}</option>
                    </select>
                    <label for="mw_prompt">${t('Custom system prompt for memory passes (empty = default)')}</label>
                    <textarea id="mw_prompt" class="text_pole" rows="4" spellcheck="false">${escapeHtml(settings.promptOverride)}</textarea>
                </details>
            </div>
        </div>
    </div>`;
}

function addSettingsUI() {
    $('#extensions_settings2').append(settingsDrawerHtml());
    bindSettingsDrawer();
}

/* Language switch: rebuild the drawer in place (same position, same open
   state of the drawer and of "Advanced"), then re-bind its handlers. */
function rerenderSettingsDrawer() {
    const old = $('#memoryweaver-settings');
    if (!old.length) return;
    /* Not :visible — the Extensions panel itself may be hidden. ST marks an
       open drawer with the `up` icon class / an inline display:block. */
    const oldContent = old.find('.inline-drawer-content').first();
    const wasOpen = old.find('.inline-drawer-icon').first().hasClass('up') || oldContent.css('display') === 'block';
    const advancedOpen = Boolean(old.find('details.mw-settings-advanced').prop('open'));
    const fresh = $(settingsDrawerHtml());
    if (wasOpen) {
        fresh.find('.inline-drawer-content').first().css('display', 'block');
        fresh.find('.inline-drawer-icon').first().removeClass('down fa-circle-chevron-down').addClass('up fa-circle-chevron-up');
    }
    if (advancedOpen) fresh.find('details.mw-settings-advanced').prop('open', true);
    old.replaceWith(fresh);
    bindSettingsDrawer();
    updateRecallStatusText();
}

function bindSettingsDrawer() {
    $('#mw_ui_language').on('change', function () {
        const value = String($(this).val());
        getSettings().uiLanguage = UI_LANGUAGE_SETTINGS.includes(value) ? value : 'en';
        saveSettingsDebounced();
        applyUiLanguage();
        rerenderSettingsDrawer();
        updateSendFormBadge();
        if (dashboard.isOpen()) dashboard.requestRender();
        $('#mw_ui_language').trigger('focus');
    });

    /* v0.8: number fields commit on `change` (blur/Enter), never per
       keystroke — typing "300" into "max memories" used to pass through 20
       and the next commit's retention evicted everything above it, forever.
       Range sliders keep live `input`. Empty/NaN is ignored, never clamped. */
    const bindNumber = (selector, key, min, max, after) => {
        const eventName = $(selector).attr('type') === 'range' ? 'input' : 'change';
        $(selector).on(eventName, function () {
            const raw = String($(this).val() ?? '').trim();
            const value = Number(raw);
            if (!raw || !Number.isFinite(value)) {
                $(this).val(getSettings()[key]);
                return;
            }
            if (key === 'maxEntries' && Math.round(value) < readState().entries.length && Math.round(value) < Number(getSettings().maxEntries)) {
                toastr.warning(`Memory Weaver: ${tr('this chat has {count} memories — a limit of {cap} will trim the less important ones at the next write (locked/pinned ones are kept).', { count: readState().entries.length, cap: Math.max(min, Math.round(value)) })}`, 'Memory Weaver', { timeOut: 8000 });
            }
            getSettings()[key] = Math.max(min, Math.min(max, Math.round(value)));
            saveSettingsDebounced();
            updatePresetButton();
            after?.();
        });
    };
    const settingsChanged = () => {
        updatePresetButton();
        updateSettingsSummary();
        updateSendFormBadge();
        dashboard.requestRender();
    };

    $('#mw_open_dashboard').on('click', () => showMemoriesPopup());
    $('#mw_enabled').on('change', function () {
        getSettings().enabled = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
        updateInjection();
        settingsChanged();
    });
    $('#mw_mode').on('change', function () {
        getSettings().mode = String($(this).val());
        saveSettingsDebounced();
        settingsChanged();
    });
    bindNumber('#mw_threshold', 'threshold', 5, 100, settingsChanged);
    bindNumber('#mw_input_budget', 'optimizerInputBudgetTokens', 2000, 32000);
    bindNumber('#mw_burst', 'backlogMaxChunksPerRun', 1, 10);
    bindNumber('#mw_max_entries', 'maxEntries', 20, 500, settingsChanged);
    $('#mw_inject').on('change', function () {
        getSettings().injectEnabled = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
        updateInjection();
        settingsChanged();
    });
    bindNumber('#mw_budget', 'injectBudgetTokens', 100, 4000, () => {
        updateInjection();
        settingsChanged();
    });
    $('#mw_sched_enabled').on('change', function () {
        getSettings().scheduleEnabled = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
        updateInjection();
        settingsChanged();
    });
    bindNumber('#mw_sched_budget', 'scheduleBudgetTokens', 40, 400, updateInjection);
    bindNumber('#mw_sched_cap', 'maxScheduleActive', 5, 100);
    bindNumber('#mw_existing_max', 'optimizerExistingMax', 50, 300);
    bindNumber('#mw_recall_wait', 'recallWaitMs', 0, 5000);
    /* Nested settings (chapters / consolidation) — same change-only rule. */
    const bindNested = (selector, group, key, min, max, after) => {
        $(selector).on('change', function () {
            const raw = String($(this).val() ?? '').trim();
            const value = Number(raw);
            const current = getSettings()[group] ?? {};
            if (!raw || !Number.isFinite(value)) {
                $(this).val(current[key]);
                return;
            }
            getSettings()[group] = { ...current, [key]: Math.max(min, Math.min(max, Math.round(value))) };
            saveSettingsDebounced();
            after?.();
        });
    };
    bindNested('#mw_chapters_every', 'chapters', 'everyMessages', 20, 400, () => dashboard.requestRender());
    bindNested('#mw_chapters_budget', 'chapters', 'budgetTokens', 100, 4000, updateInjection);
    bindNested('#mw_consolidate_every', 'consolidation', 'autoEvery', 0, 50);
    $('#mw_chapters_enabled').on('change', function () {
        getSettings().chapters = { ...(getSettings().chapters ?? {}), enabled: Boolean($(this).prop('checked')) };
        saveSettingsDebounced();
        updateInjection();
        dashboard.requestRender();
        updatePresetButton();
    });
    $('#mw_smart_preset').on('click', async () => {
        if (smartPresetActive()) return;
        /* Plain-text body (popup content is HTML) — pre-line keeps the list. */
        const presetInfo = document.createElement('div');
        presetInfo.style.whiteSpace = 'pre-line';
        presetInfo.style.textAlign = 'left';
        presetInfo.textContent = tr('Turn on Super Smart mode?\n\n• Memory budget in the prompt: 2000 tokens\n• Budget per memory pass: 24000 tokens, 4 chunks per pass\n• Up to 300 memories; the AI reviews 250 existing memories per pass\n• Vector recall + waits up to 2 seconds for recall before the AI replies\n• Near-duplicate blocking; the AI adds appointments itself\n• A chapter summary every 80 messages (1000 tokens)\n• The AI merges & cleans up memories every 5 passes\n\nUses more tokens. A button restores your previous settings.');
        const ok = await callGenericPopup(presetInfo, POPUP_TYPE.CONFIRM);
        if (ok === POPUP_RESULT.AFFIRMATIVE) applySmartPreset();
    });
    $('#mw_smart_restore').on('click', () => restorePresetBackup());
    updatePresetButton();
    $('#mw_sched_auto').on('change', function () {
        getSettings().scheduleAuto = { ...(getSettings().scheduleAuto ?? {}), enabled: Boolean($(this).prop('checked')) };
        saveSettingsDebounced();
        settingsChanged();
    });
    $('#mw_sched_auto_miss').on('change', function () {
        getSettings().scheduleAuto = { ...(getSettings().scheduleAuto ?? {}), autoMiss: Boolean($(this).prop('checked')) };
        saveSettingsDebounced();
    });
    $('#mw_recall_enabled').on('change', function () {
        getSettings().retrieval.enabled = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
        updateRecallStatusText();
        updateInjection();
        if (getSettings().retrieval.enabled) scheduleSync();
        settingsChanged();
    });
    window.setTimeout(updateRecallStatusText, 2000);
    $('#mw_dedupe_mode').on('change', function () {
        getSettings().dedupeMode = String($(this).val()) === 'near' ? 'near' : 'exact';
        saveSettingsDebounced();
    });
    $('#mw_prompt').on('input', function () {
        getSettings().promptOverride = String($(this).val());
        saveSettingsDebounced();
    });
    $('#mw_vindex_sync').on('click', async () => {
        if (!getSettings().retrieval.enabled) {
            toastr.info(`Memory Weaver: ${tr('turn on "Vector recall" before syncing.')}`, 'Memory Weaver');
            return;
        }
        const $btn = $('#mw_vindex_sync');
        if ($btn.prop('disabled')) return;
        $btn.prop('disabled', true).addClass('mw-busy');
        try {
            const ok = await syncIndex({ force: true });
            toastr[ok ? 'success' : 'warning'](`Memory Weaver: ${ok ? tr('vector index synced.') : tr('vector index sync failed (see the Console, F12).')}`, 'Memory Weaver');
        } finally {
            $btn.prop('disabled', false).removeClass('mw-busy');
        }
        updateRecallStatusText();
    });

    updateSettingsSummary();
}

/* v0.6.0 (T8.1) markdown export — parseMemoryFile-compatible. */
function exportMemoriesMarkdown() {
    const state = readState();
    const chatLabel = String(getContext().chatId ?? 'chat') || 'chat';
    if (!state.entries.length) {
        toastr.info(`Memory Weaver: ${tr('this chat has no memories to export yet.')}`, 'Memory Weaver');
        return;
    }
    const { markdown, exported, skippedUnsafe } = exportToMarkdown(state.entries, { title: `Memory Weaver — ${chatLabel}` });
    if (!exported) {
        toastr.warning(`Memory Weaver: ${tr('no entry could be exported safely (its text clashes with the file format).')}`, 'Memory Weaver');
        return;
    }
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `memoryweaver-${chatLabel.replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    toastr.success(`Memory Weaver: ${skippedUnsafe
        ? tr('exported {n} memories (skipped {skipped} whose format could not be imported back).', { n: exported, skipped: skippedUnsafe })
        : trn('exported {n} memory.', 'exported {n} memories.', exported)}`, 'Memory Weaver');
}

async function importMemoriesFile(file) {
    try {
        const text = await file.text();
        const parsed = parseMemoryFile(text);
        if (!parsed.length) {
            toastr.warning(`Memory Weaver: ${tr('no valid memories found in the file. One memory per line, e.g. "- Alice: text" or "[Alice, Bob] text".')}`, 'Memory Weaver');
            return;
        }
        const known = new Set(readState().entries.map(entry => String(entry.text).normalize('NFC')));
        const fresh = parsed.filter(item => !known.has(String(item.text).normalize('NFC')));
        if (!fresh.length) {
            toastr.info(`Memory Weaver: ${tr('every memory in the file already exists.')}`, 'Memory Weaver');
            return;
        }
        const context = getContext();
        const scope = { scopeKey: String(context.chatId ?? ''), lifecycleEpoch: memoryLifecycleEpoch };
        const fromMessage = null; /* imported facts have no source message (v0.8) */
        const commit = controller.commitMutation({ kind: 'user', ...scope, reason: 'file import' }, (live) => {
            const result = applyPatch(live, { add: fresh.map(item => ({ entities: item.entities, text: item.text, importance: item.importance })) }, {
                fromMessage,
                source: 'manual',
                maxEntries: getSettings().maxEntries,
            });
            /* v0.8: applyPatch never takes lock/pin flags from an add (the
               model must not set them) — the USER's file does, so apply the
               [locked]/[pinned] markers here, within the same commit. */
            const flagged = new Map(fresh.filter(item => item.locked || item.pinned).map(item => [String(item.text).normalize('NFC'), item]));
            let pins = live.entries.filter(entry => entry.pinned === true).length;
            for (const entry of live.entries) {
                const item = flagged.get(String(entry.text).normalize('NFC'));
                if (!item) continue;
                if (item.locked || item.pinned) entry.locked = true;
                if (item.pinned && pins < MAX_PINNED && entry.pinned !== true) {
                    entry.pinned = true;
                    pins++;
                }
            }
            return result;
        });
        if (!commit.ok || !commit.result?.added) {
            if (!commit.ok) warnMutationRejection('import', commit);
            toastr.info(`Memory Weaver: ${tr('no memories were imported (duplicates or writing is blocked).')}`, 'Memory Weaver');
            return;
        }
        updateInjection();
        emitBus('memories.added', { added: commit.result.added });
        toastr.success(`Memory Weaver: ${tr('imported {n} memories ({skipped} duplicates skipped).', { n: commit.result.added, skipped: parsed.length - fresh.length })}`, 'Memory Weaver');
    } catch (error) {
        console.error('[Memory Weaver] Import failed:', error);
        toastr.error(`Memory Weaver: ${tr('import failed.')}`, 'Memory Weaver');
    }
}

const MemoryWeaverAPI = Object.freeze({
    apiVersion: 3,
    capabilities: ['add', 'list', 'update', 'delete', 'events', 'stats', 'schedule', 'recall'],
    isEnabled: () => Boolean(getSettings().enabled),
    /* v0.6.0 (T11.1): every options-taking method is null-safe — passing
       null/undefined/primitives no longer throws (destructured defaults do
       not trigger on `null`). */
    list: (options) => {
        const opts = (options && typeof options === 'object') ? options : {};
        const entities = Array.isArray(opts.entities) ? opts.entities : null;
        const limit = Number(opts.limit);
        const state = readState();
        let entries = [...state.entries];
        if (entities && entities.length) entries = filterByEntities(entries, entities);
        entries.sort((a, b) => (b.importance - a.importance) || String(b.createdAt).localeCompare(String(a.createdAt)));
        return entries.slice(0, Math.max(0, Number.isFinite(limit) ? limit : 50)).map(entry => structuredClone(entry));
    },
    add: (options) => {
        const opts = (options && typeof options === 'object') ? options : {};
        /* v0.6.0 (T11.2): a consistent result shape — ok + tallies + a reason
           when nothing landed. */
        const importance = Number(opts.importance);
        const result = addManualEntry(
            typeof opts.text === 'string' ? opts.text : '',
            Array.isArray(opts.entities) ? opts.entities : [],
            Number.isFinite(importance) ? importance : 2,
        );
        const added = result?.added ?? 0;
        return {
            ok: added > 0,
            added,
            updated: result?.updated ?? 0,
            deleted: result?.deleted ?? 0,
            ...(added > 0 ? {} : { reason: 'duplicate_or_blocked' }),
        };
    },
    update: (id, patch) => {
        const safePatch = (patch && typeof patch === 'object') ? patch : {};
        const context = getContext();
        const scope = { scopeKey: String(context.chatId ?? ''), lifecycleEpoch: memoryLifecycleEpoch };
        const commit = controller.commitMutation({ kind: 'user', ...scope, reason: 'api update' }, (live) => {
            return applyPatch(live, { add: [], update: [{ ...safePatch, id }], delete: [] }, { maxEntries: getSettings().maxEntries });
        });
        if (!commit.ok) {
            warnMutationRejection('api update', commit);
            return false;
        }
        if (commit.result?.updated) {
            updateInjection();
            emitBus('memories.updated', { updated: commit.result.updated });
        }
        return (commit.result?.updated ?? 0) > 0;
    },
    remove: (id) => {
        /* API callers can be model-driven (e.g. a function tool), so the
           lock keeps protecting the entry here — unlike the user's own
           dashboard delete. */
        const target = readState().entries.find(entry => entry.id === String(id ?? ''));
        if (!target || target.locked === true) return false;
        return removeMemory(id);
    },
    clear: () => {
        /* v0.6.0 (T11.2): the boundary result flows through ({ ok, reason? }). */
        return clearMemories();
    },
    stats: () => {
        const state = readState();
        const entities = new Set();
        for (const entry of state.entries) {
            for (const name of entry.entities ?? []) entities.add(name);
        }
        /* R1: processing status exposed so consumers can see coverage trust.
           v0.6.0 (T11.3): lastResult (clone) rides along. */
        return {
            count: state.entries.length,
            entities: [...entities],
            lastRun: state.lastRun,
            processedMessages: state.processedMessages,
            processing: state.processing?.status ?? null,
            overCap: state.overCap === true,
            lastResult: state.lastResult ? structuredClone(state.lastResult) : null,
        };
    },
    /* Schedule (v0.3.0) — apiVersion 3 since v0.6.0. */
    scheduleList: (options) => {
        const opts = (options && typeof options === 'object') ? options : {};
        const status = String(opts.status ?? 'active');
        const state = readState();
        const context = scheduleContext(state);
        return (state.schedule ?? [])
            .filter(item => status === 'all' ? true : item.status === status)
            .map(item => ({ ...structuredClone(item), urgency: scheduleStateOf(item, context), remaining: scheduleRemaining(item, context) }));
    },
    scheduleAdd: (spec) => {
        const safeSpec = (spec && typeof spec === 'object') ? spec : {};
        const result = createScheduleEntry({
            text: safeSpec.text,
            mode: safeSpec.when?.mode,
            turns: safeSpec.when?.turns,
            day: safeSpec.when?.storyDay ?? safeSpec.when?.day,
            label: safeSpec.label,
            entities: safeSpec.entities,
            lead: safeSpec.lead,
            source: 'manual',
        });
        /* v0.6.0 (T11.2): success now carries { ok, entry }; failure keeps the
           legacy null for one version (old truthy checks keep working). */
        return result.ok ? { ok: true, entry: structuredClone(result.entry) } : null;
    },
    scheduleResolve: (id, outcome, options) => {
        const opts = (options && typeof options === 'object') ? options : {};
        const resolvedOutcome = ['done', 'cancelled', 'missed'].includes(String(outcome)) ? String(outcome) : 'done';
        const result = resolveScheduleById(id, resolvedOutcome, { createMemory: opts.createMemory !== false });
        /* v0.6.0 (T11.2): { ok, reason? } instead of a bare boolean. */
        return result?.ok
            ? { ok: true, memoryCreated: Boolean(result.memoryCreated) }
            : { ok: false, reason: String(result?.reason ?? 'missing') };
    },
    schedulePostpone: (id, amount) => {
        const changed = postponeScheduleById(id, amount);
        /* v0.6.0 (T11.2): { ok, reason? } instead of a bare boolean. */
        return changed ? { ok: true } : { ok: false, reason: 'not_changed' };
    },
    setStoryClock: (day) => setStoryClockDay(day),
    /* Recall (v0.4.0, additive over v2): tiered selection over the CURRENT
       chat's store. `recall` is synchronous (valid cache or current-context
       lexical fallback); `recallAsync` bounds the wait for a fresh vector
       query before falling back the same way. Scope is ALWAYS the open chat —
       callers cannot point the recall at another chat's index. */
    recall: (options) => buildRecallEnvelope((options && typeof options === 'object') ? options : {}),
    recallAsync: async (options) => {
        const opts = (options && typeof options === 'object') ? options : {};
        const deadline = Number.isFinite(Number(opts.deadlineMs)) ? Number(opts.deadlineMs) : getWaitBudgetMs();
        /* v0.9.1: the single-flight wait — never a second query when the
           interceptor already fetched recall for this turn. */
        await awaitFreshRecall(Math.max(0, deadline));
        return buildRecallEnvelope(opts);
    },
    retrievalStatus: () => getRetrieverStatus(),
    events: {
        on: (name, handler) => {
            if (typeof handler !== 'function') return;
            if (!busListeners.has(name)) busListeners.set(name, new Set());
            busListeners.get(name).add(handler);
        },
        off: (name, handler) => {
            busListeners.get(name)?.delete(handler);
        },
    },
});

globalThis.MemoryWeaverAPI = MemoryWeaverAPI;

/* ---------------------------------------------------------------------------
 * Send-form button (anchored next to the Character Sheet button when present)
 * ------------------------------------------------------------------------- */

/* v0.7.0: the badge shows the countdown to the next pass (pending/threshold)
   instead of covered/total, and the button carries a state: running (pass in
   flight), error (last run failed / needs review / blocked), schedule due,
   ready, off. Clicking it opens the dashboard on the tab that state is about. */
function sendFormState() {
    const settings = getSettings();
    const state = readState();
    const context = getContext();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const rawTotal = chat.length;
    const cursor = Math.max(0, Math.min(Number(state.processedMessages ?? 0), rawTotal));
    const countedPrefix = countedPrefixArray(chat);
    const total = countedPrefix[rawTotal];
    const covered = countedPrefix[cursor];
    const pending = total - covered;
    const threshold = Math.max(1, Number(settings.threshold ?? 20));
    const ready = settings.enabled && settings.mode === 'auto' && pending >= threshold;
    let scheduleDue = 0;
    for (const item of state.schedule ?? []) {
        if (item.status !== 'active') continue;
        const urgency = scheduleStateOf(item, scheduleContext(state));
        if (urgency === 'due' || urgency === 'overdue') scheduleDue++;
    }
    /* v0.8: red "lỗi" only for real failures; a needs_review after an edit
       (common in RP: swipes/edits) is amber "cần xem"; a conflict is
       requeued automatically and shows nothing. */
    const lastFailed = state.lastResult && state.lastResult.outcome === 'failed';
    const needsAttention = !stateIntegrity.ok || lastFailed || Boolean(state.processing?.blocked);
    const needsReview = state.processing?.status === 'needs_review' || state.processing?.status === 'legacy_unverified' || Number(state.processedMessages ?? 0) > chat.length;
    return { settings, state, total, covered, pending, threshold, ready, scheduleDue, lastFailed, needsAttention, needsReview };
}

function updateSendFormBadge() {
    const button = document.getElementById('memoryweaver_button');
    if (!button) return;
    const info = sendFormState();
    const { settings } = info;
    let mode = 'normal';
    let badge = settings.mode === 'auto' ? `${Math.min(info.pending, info.threshold)}/${info.threshold}` : tr('{n} waiting', { n: info.pending });
    let title = `Memory Weaver — ${tr('remembered {covered}/{total} messages', { covered: info.covered, total: info.total })}`;
    if (!settings.enabled) {
        mode = 'off';
        badge = tr('off');
        title = `Memory Weaver — ${tr('off')}`;
    } else if (optimizerRunning || backlogRun.active) {
        mode = 'running';
        badge = backlogRun.active ? tr('saving… ({n})', { n: backlogRun.done }) : tr('saving…');
        title = `Memory Weaver — ${tr('remembering')}`;
    } else if (info.needsAttention) {
        mode = 'error';
        badge = tr('error');
        title = `Memory Weaver — ${tr('something needs attention (click to see)')}`;
    } else if (info.needsReview) {
        mode = 'review';
        badge = tr('review');
        title = `Memory Weaver — ${tr('history was edited after it was remembered (click to see)')}`;
    } else if (info.scheduleDue) {
        mode = 'sched';
        badge = tr('{n} due', { n: info.scheduleDue });
        title = `Memory Weaver — ${trn('{n} appointment due', '{n} appointments due', info.scheduleDue)}`;
    } else if (info.ready) {
        mode = 'ready';
        badge = tr('ready');
        title = `Memory Weaver — ${tr('{n} messages reached — memories will be recorded after the next AI reply', { n: info.threshold })}`;
    } else if (settings.mode === 'auto') {
        title += ` · ${trn('{n} message until the next memory pass', '{n} messages until the next memory pass', Math.max(0, info.threshold - info.pending))}`;
    }
    const badgeNode = button.querySelector('.mw-sendform-badge');
    if (badgeNode) badgeNode.textContent = badge;
    for (const name of ['off', 'running', 'error', 'review', 'sched', 'ready']) button.classList.toggle(`mw-${name}`, mode === name);
    button.dataset.mwTarget = mode === 'error' || mode === 'review' ? 'health' : mode === 'sched' ? 'schedule' : '';
    button.title = title;
    button.setAttribute('aria-label', title);
}

function ensureSendFormButton() {
    const sendForm = document.querySelector('#send_form');
    if (!sendForm) return false;

    let button = document.getElementById('memoryweaver_button');
    if (!button) {
        button = document.createElement('div');
        button.id = 'memoryweaver_button';
        button.className = 'menu_button mw-sendform-btn';
        button.tabIndex = 0;
        button.setAttribute('role', 'button');
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-brain';
        const label = document.createElement('span');
        label.className = 'mw-sendform-label';
        label.textContent = 'Memory';
        const badge = document.createElement('span');
        badge.className = 'mw-sendform-badge';
        button.append(icon, label, badge);
        const openFromButton = () => showMemoriesPopup(button.dataset.mwTarget || null);
        button.addEventListener('click', openFromButton);
        button.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openFromButton();
            }
        });
    }

    /* Visual anchor only: sit right after the Character Sheet button when the
       character-state extension is present; otherwise fall back to the plain
       send-form row. No data/API crosses the extensions. */
    const anchor = document.getElementById('character-state-button');
    if (anchor && anchor.parentElement === sendForm) {
        if (anchor.nextElementSibling !== button) anchor.after(button);
    } else if (button.parentElement !== sendForm) {
        sendForm.prepend(button);
    }

    updateSendFormBadge();
    return Boolean(anchor);
}

function initSendFormButton() {
    let attempts = 0;
    const tryAdd = () => {
        if (ensureSendFormButton() || ++attempts >= 40) return;
        window.setTimeout(tryAdd, 250);
    };
    tryAdd();
}

/* v0.6.0 (T11.4): double-init guard — ST can re-run the jQuery ready callback
   (e.g. a reload of the extension settings group); a second run would
   duplicate every listener and bus subscription. */
let initialized = false;

jQuery(() => {
    if (initialized) {
        console.debug('[Memory Weaver] Init skipped — already initialized.');
        return;
    }
    initialized = true;
    getSettings();
    applyUiLanguage();
    addSettingsUI();
    registerMemoriesCommand();
    initRetriever({
        loadState: readState,
        getSettings,
        getContext,
        getLifecycleEpoch: () => memoryLifecycleEpoch,
        commitMutation: controller.commitMutation,
        isCountedChatMessage,
        onRecallUpdated: () => {
            updateInjection();
            updateSendFormBadge();
            dashboard.requestRender();
        },
    });
    updateInjection();
    initSendFormButton();

    /* Keep the send-form badge, the open dashboard and the settings summary
       in sync with every memory AND schedule change, including writes made
       through MemoryWeaverAPI. The dashboard render is coalesced per frame. */
    for (const eventName of ['memories.updated', 'memories.added', 'memories.deleted', 'memories.cleared', 'schedule.added', 'schedule.resolved', 'schedule.updated', 'chapters.updated']) {
        MemoryWeaverAPI.events.on(eventName, () => {
            updateSendFormBadge();
            updateSettingsSummary();
            dashboard.requestRender();
            scheduleSync();
        });
    }
    /* v0.7.0: optimizer in-flight state drives the "đang ghi…" button state. */
    MemoryWeaverAPI.events.on('optimizer.state', () => {
        updateSendFormBadge();
        updateSettingsSummary();
        dashboard.requestRender();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId, type) => {
        if (!Number.isInteger(messageId)) return;
        conflictRequeued = false;
        /* Schedule odometer counts every NEW counted line — including the
           greeting (first_message). Swipe/regenerate/continue re-emit or
           extend existing lines and must not double-count. */
        const reEmit = type === 'swipe' || type === 'regenerate' || type === 'continue';
        const chat = getContext().chat ?? [];
        const mes = chat[messageId];
        /* v0.6.4: ST re-emits first_message every time a greeting-only chat is
           (re)opened — count the greeting once, on a fresh odometer only. */
        const greetingRepeat = type === 'first_message' && !(chat.length === 1 && Number(readState().turnCount ?? 0) === 0);
        /* v0.6.4: a line inserted (/sendas at=, /sys at=) or continued BELOW
           the coverage cursor changes already-processed history — reassess
           before the next commit silently re-fingerprints the shifted prefix. */
        if (messageId < Number(readState().processedMessages ?? 0)) reassessCoverage(`message ${type || 'received'} below cursor`);
        if (!reEmit && !greetingRepeat && isCountedChatMessage(mes)) bumpTurnCount();
        /* first_message/continue are not new conversation content; swipes and
           regenerates re-emit existing lines and are skipped as well. */
        if (type === 'swipe' || type === 'regenerate' || type === 'first_message' || type === 'continue') return;
        if (!mes || mes.is_system) return;
        void refreshRecall();
        maybeAutoRun();
        updateSendFormBadge();
    });
    eventSource.on(event_types.MESSAGE_SENT, (messageId) => {
        if (!Number.isInteger(messageId)) return;
        conflictRequeued = false;
        if (messageId < Number(readState().processedMessages ?? 0)) reassessCoverage('message sent below cursor');
        const mes = getContext().chat[messageId];
        if (!isCountedChatMessage(mes)) return;
        bumpTurnCount();
        void refreshRecall();
        updateSendFormBadge();
    });
    /* Source-change detection (R1-B4): an edit/swipe/update of an ALREADY
       PROCESSED message invalidates the processed prefix (block-conservative
       dirty marking) — entries are kept, nothing is auto-replayed. */
    eventSource.on(event_types.MESSAGE_EDITED, (messageId) => {
        void refreshRecall();
        if (Number.isInteger(messageId)) {
            const cursor = Number(readState().processedMessages ?? 0);
            if (messageId < cursor) reassessCoverage('message edited below cursor');
        }
    });
    eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => {
        void refreshRecall();
        if (Number.isInteger(messageId)) {
            const cursor = Number(readState().processedMessages ?? 0);
            if (messageId < cursor) reassessCoverage('message swiped below cursor');
        }
    });
    /* MESSAGE_UPDATED fires for programmatic/extended edits (script.js and
       /slash continue); same coverage rule as MESSAGE_EDITED. */
    eventSource.on(event_types.MESSAGE_UPDATED, (messageId) => {
        void refreshRecall();
        if (Number.isInteger(messageId)) {
            const cursor = Number(readState().processedMessages ?? 0);
            if (messageId < cursor) reassessCoverage('message updated below cursor');
        }
    });
    /* MESSAGE_DELETED payload = the chat length AFTER deletion. A deletion
       below the cursor shrinks the chat; the fingerprint recompute detects
       the dirty block precisely, so one reassess covers every case. */
    eventSource.on(event_types.MESSAGE_DELETED, () => {
        void refreshRecall();
        reassessCoverage('message deleted');
        updateSendFormBadge();
    });
    eventSource.on(event_types.GENERATION_STARTED, (_type, _options, dryRun) => {
        /* v0.6.4: dry runs (prompt builds/token counts) never emit ENDED. */
        if (dryRun) return;
        generationActive = true;
        generationStartedAt = Date.now();
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        generationActive = false;
        if (runQueued && !runTimer) {
            runTimer = window.setTimeout(attemptOptimizerRun, 2000);
        }
    });
    /* R1-B5: an aborted generation no longer leaves the optimizer waiting
       forever. VERIFY AT RUNTIME (recorded as blocked_runtime in
       HARDENING-STATUS until a live abort is observed). */
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        generationActive = false;
        console.debug('[Memory Weaver] Generation stopped (abort) — optimizer wait released.');
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        runQueued = false;
        memoryLifecycleEpoch++;
        conflictRequeued = false;
        optimizerRunner.resetRetryMarkers();
        /* Edits, selection, drafts and filters belong to the previous chat's
           ids — they must not leak into the new chat (U1). */
        dashboard.resetForChat();
        chapterAutoAttempts.clear();
        undoSlot = null;
        bumpEpoch();
        scheduleSync();
        void refreshRecall();
        if (runTimer) {
            window.clearTimeout(runTimer);
            runTimer = null;
        }
        updateInjection();
        ensureSendFormButton();
        updateSettingsSummary();
        dashboard.requestRender();
        reassessCoverage('chat changed');
        maybeAutoRun();
        evaluateScheduleToasts();
    });
    /* v0.6.0 (F9): a deleted chat's vector collection would stay orphaned on
       the server (the store died with the chat). The CHAT_DELETED payload IS
       the chat file name — the same string that scoped the collection hash —
       so purge directly by hash. Events for the CURRENT scope are ignored (a
       chat cannot be deleted while it is open). Known limit: group-chat
       deletion carries a different payload — out of scope; the orphan is
       harmless (per-chat collection, rebuildable, never read again). */
    eventSource.on(event_types.CHAT_DELETED, (fileName) => {
        const deletedScope = String(fileName ?? '').trim();
        if (!deletedScope) return;
        const currentScope = String(getContext().chatId ?? '').trim();
        if (deletedScope === currentScope) return;
        if (!isRetrievalEnabled()) return;
        try {
            const retrieval = getSettings().retrieval ?? {};
            const config = { source: String(retrieval.source ?? 'transformers'), model: String(retrieval.model ?? '') };
            const collectionId = `memoryweaver_${shortHash(`${deletedScope}|${embeddingKeyFor(config)}`)}`;
            createVectorClient(config).purgeCollection(collectionId)
                .then(() => console.log(`[Memory Weaver] Purged vector index of the deleted chat (${collectionId}).`))
                .catch((error) => console.warn('[Memory Weaver] Vector purge for the deleted chat failed:', error));
        } catch (error) {
            console.warn('[Memory Weaver] Vector purge for the deleted chat failed:', error);
        }
    });
    eventSource.on(event_types.APP_READY, () => {
        updateInjection();
        ensureSendFormButton();
        updateSettingsSummary();
        updateRecallStatusText();
        dashboard.requestRender();
        reassessCoverage('app ready');
        maybeAutoRun();
        evaluateScheduleToasts();
        scheduleSync();
        void refreshRecall();
    });
});
