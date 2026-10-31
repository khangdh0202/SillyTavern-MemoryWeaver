/* ===========================================================================
 * Memory Weaver — dashboard popup (v0.7.0)
 *
 * UI-only module: it owns NO data. Every read goes through deps.readState()
 * (the shared READ-ONLY cache — never mutate what it returns) and every write
 * goes through deps.actions.*, which index.js routes through the mutation
 * boundary. No ST imports here: index.js injects everything (popup helpers
 * included), so the module graph stays node-importable.
 *
 * Layout: header (status + primary action + ⋯ menu) → coverage strip →
 * one-line alert banner → tabs [Memories | Trong prompt | Lịch trình |
 * Tình trạng]. ONE scroll container (ST's .popup-content); the tab bar and
 * the memories toolbar are sticky, the bulk-selection bar sticks to the
 * bottom.
 *
 * Rendering: requestRender() coalesces bus events into one rebuild per
 * animation frame (an auto pass used to rebuild the whole popup several times
 * synchronously). Scroll position and the focused field (data-fk + caret)
 * survive every rebuild. All dynamic text goes through textContent.
 * ========================================================================= */

import { tr, trn, uiLocale } from './i18n.js';

/* Tab ids are logic keys; labels are translated at render time (tabLabel). */
const TABS = [
    ['memories', 'Memories'],
    ['prompt', 'In prompt'],
    ['story', 'Story'],
    ['schedule', 'Schedule'],
    ['health', 'Health'],
];

function tabLabel(id) {
    const found = TABS.find(([key]) => key === id);
    return found ? tr(found[1]) : id;
}

const LIST_PAGE = 150;

/* Diacritic-insensitive search key: "sieu thi" finds "siêu thị". NFD strips
   combining marks; đ/Đ is a base letter in Unicode, so it is mapped by hand. */
export function foldSearch(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .toLowerCase();
}

export function relativeTime(iso) {
    if (!iso) return tr('never');
    const time = new Date(iso).getTime();
    if (!Number.isFinite(time)) return tr('unknown');
    const diff = Date.now() - time;
    if (diff < 60_000) return tr('just now');
    if (diff < 3_600_000) return trn('{n} minute ago', '{n} minutes ago', Math.floor(diff / 60_000));
    if (diff < 86_400_000) return trn('{n} hour ago', '{n} hours ago', Math.floor(diff / 3_600_000));
    if (diff < 604_800_000) return trn('{n} day ago', '{n} days ago', Math.floor(diff / 86_400_000));
    return new Date(iso).toLocaleDateString(uiLocale());
}

export function importanceLabel(value) {
    if (value >= 3) return tr('Core');
    if (value === 2) return tr('Important');
    return tr('Normal');
}

/* Run outcome → one short translated phrase (shared by the coverage strip,
   the health tab history and the send-form tooltip). */
export function outcomeText(result) {
    if (!result) return '';
    switch (result.outcome) {
        case 'changed': return tr('+{added} new · ~{updated} edited · −{deleted} deleted', { added: result.added ?? 0, updated: result.updated ?? 0, deleted: result.deleted ?? 0 });
        case 'no_change': return tr('Nothing new to save');
        case 'deduped': return tr('Everything was already stored');
        case 'conflict': return tr('Cancelled — data changed mid-run');
        case 'failed': return tr('Failed');
        case 'blocked': return tr('Blocked by an overlong message');
        default: return '';
    }
}

/* Raw runner/parser error → human hint. The raw text stays visible as detail. */
export function explainError(error) {
    const raw = String(error ?? '').trim();
    if (!raw) return '';
    if (/no message generated|empty (completion|response)|returned empty|empty_completion/i.test(raw)) {
        return tr('The model returned nothing — "thinking" models often use up all the tokens. Try lowering Reasoning Effort to low/auto, or switch models.');
    }
    if (/batch ?id/i.test(raw)) return tr('The model copied the example block instead of answering — this usually fixes itself on the next run.');
    if (/json|parse|unexpected token/i.test(raw)) return tr('The model returned broken JSON — retry, or use a model that follows formats better.');
    if (/missing <?memory_update/i.test(raw)) return tr('The model did not return a <MEMORY_UPDATE> block — retry, or check your custom prompt (if any).');
    if (/unknown|foreign/i.test(raw)) return tr('The model tried to edit/delete a memory that does not exist — the whole pass was rejected to be safe.');
    if (/abort|timeout|network|fetch|50\d|429/i.test(raw)) return tr('Could not reach the API — check your connection/quota and try again.');
    return '';
}

export function createDashboard(deps) {
    const { actions } = deps;
    const ui = {
        root: null,
        tab: 'memories',
        filter: { text: '', level: 'all', entity: '', prompt: 'all' },
        sort: 'newest',
        selected: new Set(),
        edit: null,
        add: { open: false, text: '', entities: '', importance: '2' },
        sched: { open: false, text: '', mode: 'after', when: '', lead: '', label: '', entities: '' },
        schedEdit: null,
        schedMenu: null,
        schedPostpone: null,
        termOpen: false,
        listLimit: LIST_PAGE,
        renderQueued: false,
        searchTimer: null,
        listEl: null,
        countEl: null,
        bulkEl: null,
        snapshot: null,
        busy: new Set(),
        menuCloser: null,
        menuOpen: false,
        composing: false,
        diag: '',
        diagTimer: null,
        clockDraft: null,
        postponeDraft: '',
        dupes: null,
        openRuns: new Set(),
        chapterEdit: null,
    };

    /* ------------------------------------------------------------------ */
    /* DOM helpers                                                         */
    /* ------------------------------------------------------------------ */

    function el(tag, className = '', text = null) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== null && text !== undefined) node.textContent = String(text);
        return node;
    }

    function icon(name, extra = '') {
        return el('i', `fa-solid fa-${name}${extra ? ` ${extra}` : ''}`);
    }

    function button({ label = '', iconName = '', cls = '', title = '', fk = '', disabled = false, onClick } = {}) {
        const node = el('button', `mw-btn${cls ? ` ${cls}` : ''}`);
        node.type = 'button';
        if (iconName) node.append(icon(iconName));
        if (label) node.append(el('span', '', label));
        if (title) {
            node.title = title;
            if (!label) node.setAttribute('aria-label', title);
        }
        if (fk) node.dataset.fk = fk;
        node.disabled = Boolean(disabled);
        if (onClick) node.addEventListener('click', onClick);
        return node;
    }

    function input(type, cls, { value = '', placeholder = '', fk = '', label = '', onInput } = {}) {
        const node = el('input', `text_pole mw-input${cls ? ` ${cls}` : ''}`);
        node.type = type;
        node.value = value;
        if (placeholder) node.placeholder = placeholder;
        if (label) node.setAttribute('aria-label', label);
        if (fk) node.dataset.fk = fk;
        if (onInput) node.addEventListener('input', () => onInput(node.value, node));
        return node;
    }

    function select(cls, options, value, { fk = '', label = '', onChange } = {}) {
        const node = el('select', `text_pole mw-select${cls ? ` ${cls}` : ''}`);
        for (const [optValue, optLabel] of options) {
            const option = el('option', '', optLabel);
            option.value = String(optValue);
            if (String(optValue) === String(value)) option.selected = true;
            node.append(option);
        }
        if (label) node.setAttribute('aria-label', label);
        if (fk) node.dataset.fk = fk;
        if (onChange) node.addEventListener('change', () => onChange(node.value));
        return node;
    }

    function chip(text, cls = '') {
        return el('span', `mw-chip${cls ? ` ${cls}` : ''}`, text);
    }

    function stopEscape(node, onEscape) {
        /* ESC inside an editor cancels the edit instead of closing the popup. */
        node.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onEscape?.();
            }
        });
    }

    function progressBar(parts, label) {
        const track = el('div', 'mw-bar');
        track.setAttribute('role', 'progressbar');
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', '100');
        track.setAttribute('aria-valuenow', String(Math.round(parts[0]?.pct ?? 0)));
        if (label) track.setAttribute('aria-label', label);
        for (const part of parts) {
            const fill = el('div', `mw-bar-fill ${part.cls ?? ''}`);
            fill.style.width = `${Math.max(0, Math.min(100, part.pct))}%`;
            track.append(fill);
        }
        return track;
    }

    async function confirmAction(text) {
        const scope = String(deps.getContext().chatId ?? '');
        const answer = await deps.callGenericPopup(text, deps.POPUP_TYPE.CONFIRM);
        if (answer !== deps.POPUP_RESULT.AFFIRMATIVE) return false;
        /* Async confirm: a chat switch while the dialog was open must not let
           the action land on the wrong chat. */
        if (String(deps.getContext().chatId ?? '') !== scope) {
            toastr.warning(tr('Memory Weaver: you switched chats — the action was skipped.'), 'Memory Weaver');
            return false;
        }
        return true;
    }

    /* Run an async action with a busy key so its button shows a spinner and
       cannot be double-clicked; the render after it reflects the result. */
    async function busyRun(key, task) {
        if (ui.busy.has(key)) return;
        ui.busy.add(key);
        requestRender();
        try {
            await task();
        } catch (error) {
            console.error('[Memory Weaver] Dashboard action failed:', error);
            toastr.error(tr('Memory Weaver: the action failed (see Console, F12).'), 'Memory Weaver');
        } finally {
            ui.busy.delete(key);
            requestRender();
        }
    }

    /* ------------------------------------------------------------------ */
    /* Derived snapshot (computed once per render)                          */
    /* ------------------------------------------------------------------ */

    function computeSnapshot() {
        const settings = deps.getSettings();
        const state = deps.readState();
        const context = deps.getContext();
        const chat = Array.isArray(context.chat) ? context.chat : [];
        const prefix = deps.countedPrefixArray(chat);
        const rawTotal = chat.length;
        const cursorRaw = Math.max(0, Number(state.processedMessages ?? 0));
        const cursor = Math.min(cursorRaw, rawTotal);
        const total = prefix[rawTotal] ?? 0;
        const covered = prefix[cursor] ?? 0;
        const pending = Math.max(0, total - covered);
        const threshold = Math.max(1, Number(settings.threshold ?? 20));
        const running = deps.isOptimizerRunning();
        const ready = settings.enabled && settings.mode === 'auto' && pending >= threshold;
        const preview = safePreview();
        const inPrompt = new Set((preview.ids ?? []).map(String));
        const schedCtx = { turnCount: state.turnCount, clockDay: state.clock?.day ?? null };
        const schedule = { upcoming: 0, due: 0, overdue: 0, active: [] , terminal: [] };
        for (const item of state.schedule ?? []) {
            if (item.status !== 'active') {
                schedule.terminal.push(item);
                continue;
            }
            const urgency = deps.scheduleStateOf(item, schedCtx);
            schedule[urgency] = (schedule[urgency] ?? 0) + 1;
            schedule.active.push({ item, urgency, remaining: deps.scheduleRemaining(item, schedCtx) });
        }
        const snapshot = { settings, state, context, chat, prefix, rawTotal, cursor, cursorRaw, total, covered, pending, threshold, running, ready, preview, inPrompt, schedCtx, schedule };
        snapshot.alerts = computeAlerts(snapshot);
        return snapshot;
    }

    function safePreview() {
        try {
            return deps.getInjectionPreview() ?? { ids: [], lines: [] };
        } catch (error) {
            console.warn('[Memory Weaver] Injection preview failed:', error);
            return { ids: [], lines: [], error: true };
        }
    }

    function ordinalOf(snapshot, rawIndex) {
        const index = Math.max(0, Math.min(Number(rawIndex) || 0, snapshot.prefix.length - 1));
        return (snapshot.prefix[index] ?? 0) + 1;
    }

    /* Every condition the user may need to act on, most severe first. Each
       alert carries its own fix button(s) — the old dashboard only printed
       notes. */
    function computeAlerts(s) {
        const alerts = [];
        const integrity = deps.stateIntegrity();
        const processing = s.state.processing ?? {};
        if (!integrity.ok) {
            alerts.push({
                tone: 'bad', key: 'corrupt',
                title: tr('This chat\'s memory data is corrupted — all writes are blocked'),
                body: tr('Reason: {reason}. A recovery copy is in the chat variable "memoryWeaverState_recovery" — fix it by hand with /getvar, /setvar, then reload the chat.', { reason: integrity.reason }),
                actions: [],
            });
        }
        if (!s.settings.enabled) {
            alerts.push({
                tone: 'warn', key: 'disabled', title: tr('Memory Weaver is off'), body: tr('Nothing is remembered and nothing is added to the prompt.'),
                actions: [{ label: tr('Turn back on'), primary: true, run: () => actions.setEnabled(true) }],
            });
        }
        if (processing.blocked) {
            const rawIndex = Number(processing.blocked.rawIndex);
            alerts.push({
                tone: 'bad', key: 'blocked',
                title: tr('Message #{n} is too long to remember in one pass', { n: ordinalOf(s, rawIndex) }),
                body: tr('It is never cut or skipped automatically. Skip this message to continue, or raise "Token budget per memory pass" in the advanced settings.'),
                actions: [{ label: tr('Skip this message'), primary: true, run: () => actions.skipBlockedMessage(rawIndex) }],
            });
        }
        const last = s.state.lastResult;
        if (last && (last.outcome === 'failed' || last.outcome === 'conflict')) {
            const hint = explainError(last.error);
            alerts.push({
                tone: 'bad', key: 'failed',
                title: tr(last.outcome === 'conflict' ? '{what} {when} was cancelled' : '{what} {when} failed', {
                    what: last.source === 'consolidate' ? tr('The AI cleanup pass') : last.source === 'auto' ? tr('The automatic memory pass') : tr('The last memory pass'),
                    when: relativeTime(last.at),
                }),
                body: [hint, last.error ? tr('Details: {error}', { error: last.error }) : ''].filter(Boolean).join(' '),
                actions: last.source === 'consolidate'
                    ? [{ label: tr('Retry cleanup'), primary: true, busyKey: 'consolidate', run: () => runConsolidate() }]
                    : [{ label: tr('Retry'), primary: true, busyKey: 'optimize', run: runOptimizeNow }],
            });
        }
        const overshoot = s.cursorRaw > s.rawTotal;
        if (overshoot) {
            /* Review/rescan both refuse while the processed cursor points past
               the end of the chat — the only useful action is the user
               accepting the shortened history (explicit, never automatic). */
            alerts.push({
                tone: 'warn', key: 'overshoot',
                title: tr('The chat is shorter than what was remembered — messages were deleted after being remembered'),
                body: tr('Some memories may refer to messages that no longer exist (delete them by hand if needed). "Accept" treats the current history as correct and keeps remembering normally from new messages.'),
                actions: [{ label: tr('Accept current history'), primary: true, run: () => actions.acknowledgeCoverage() }],
            });
        } else if (processing.status === 'needs_review') {
            const from = processing.dirtyFrom ?? 0;
            alerts.push({
                tone: 'warn', key: 'review',
                title: tr('History from message #{n} was edited/deleted after being remembered', { n: ordinalOf(s, from) }),
                body: tr('Old memories do not update on their own. "Review again" has the AI re-read that part and fix the memories to match; "Ignore" if the change does not matter.'),
                actions: [
                    ...(typeof actions.runReviewFrom === 'function'
                        ? [{ label: tr('Review again'), primary: true, busyKey: 'review', run: runReview }]
                        : [{ label: tr('Rescan last 60 messages'), primary: true, busyKey: 'rescan', run: runRescan }]),
                    { label: tr('Ignore'), run: () => actions.acknowledgeCoverage() },
                ],
            });
        }
        if (!overshoot && !s.state.entries.length && s.cursor >= s.rawTotal && s.rawTotal > 1 && s.cursor > 0 && !s.state.cleared) {
            alerts.push({
                tone: 'warn', key: 'empty', title: tr('Memory is empty although the chat is marked as remembered'),
                body: tr('Earlier passes may have failed. Rescan the last 60 messages to rebuild it.'),
                actions: [{ label: tr('Rescan last 60 messages'), primary: true, busyKey: 'rescan', run: runRescan }],
            });
        }
        if (last && (last.existingOverBudget || last.floorApplied)) {
            alerts.push({
                tone: 'info', key: 'planner',
                title: tr('The last memory pass went over the "token budget per memory pass"'),
                body: tr('The current memory store already uses most of the budget{trimmed}{tokens}. If your model has a small context, lower "Max memories per chat"; if it is large, raise the budget in Settings → Advanced.', {
                    trimmed: last.existingTrimmed ? tr(' ({n} old memories were left out of that pass)', { n: last.existingTrimmed }) : '',
                    tokens: last.estInputTokens ? tr(' — that pass sent ~{n} input tokens', { n: last.estInputTokens }) : '',
                }),
                actions: [],
            });
        }
        const retrieval = deps.isRetrievalEnabled() ? deps.getRetrieverStatus() : null;
        if (retrieval && retrieval.status === 'error') {
            alerts.push({
                tone: 'warn', key: 'vector', title: tr('Vector recall has an error — using the fallback selection'),
                body: String(retrieval.lastError ?? ''),
                actions: [{ label: tr('Resync'), busyKey: 'vsync', run: runVectorSync }],
            });
        }
        if (s.state.overCap) {
            alerts.push({
                tone: 'info', key: 'overcap',
                title: tr('{n} memories, over the limit of {max}', { n: s.state.entries.length, max: deps.getSettings().maxEntries }),
                body: tr('The next write will trim the least important entries (pinned entries are never trimmed).'),
                actions: [],
            });
        }
        const budgetHint = budgetSuggestion(s);
        if (budgetHint) {
            alerts.push({
                tone: 'info', key: 'budget',
                title: tr('The prompt only fits {included}/{total} memories', { included: budgetHint.included, total: budgetHint.total }),
                body: tr('The {budget}-token budget is cutting many facts. Raising it to ~{next} tokens lets the AI remember more (costs more tokens per turn).', { budget: budgetHint.budget, next: budgetHint.next }),
                actions: [{ label: tr('Set {n} tokens', { n: budgetHint.next }), run: () => actions.setInjectBudget(budgetHint.next) }],
            });
        }
        if (processing.status === 'legacy_unverified') {
            alerts.push({
                tone: 'info', key: 'legacy', title: tr('Coverage from an older version has not been verified'),
                body: tr('This does not affect new memories. Mark it as checked if the chat history was not edited much.'),
                actions: [{ label: tr('Mark as checked'), run: () => actions.acknowledgeCoverage() }],
            });
        }
        return alerts;
    }

    function budgetSuggestion(s) {
        const preview = s.preview;
        if (!preview || !preview.active) return null;
        const total = s.state.entries.length;
        const included = (preview.ids ?? []).length;
        const budget = Number(preview.budget ?? 0);
        if (total < 25 || budget >= 2000) return null;
        /* Only when the budget is what is cutting: a selection that leaves
           room unused is tier-limited, more tokens would not change it. */
        if (Number(preview.estimatedTokens ?? 0) < budget * 0.8) return null;
        if (included / total >= 0.35) return null;
        const next = Math.min(4000, Math.max(budget + 200, Math.round((budget * 1.7) / 100) * 100));
        return { total, included, budget, next };
    }

    /* ------------------------------------------------------------------ */
    /* Actions with feedback                                               */
    /* ------------------------------------------------------------------ */

    function runOptimizeNow() {
        return busyRun('optimize', async () => {
            const result = await actions.runOptimizer();
            actions.toastOptimizerResult(result);
        });
    }

    function runRescan() {
        return busyRun('rescan', async () => {
            const ok = await confirmAction(tr('Have the AI re-read the last 60 messages? Existing memories are kept and duplicates are filtered out. Coverage is not reset.'));
            if (!ok) return;
            const result = await actions.runRecentWindowScan();
            actions.toastOptimizerResult(result);
            if (result?.crossesGap) toastr.info(tr('Memory Weaver: rescanned the last 60 messages — the unprocessed part in between still waits for a normal memory pass.'), 'Memory Weaver');
        });
    }

    function runReview() {
        return busyRun('review', async () => {
            const result = await actions.runReviewFrom();
            if (!result?.toasted) actions.toastOptimizerResult(result);
        });
    }

    function runConsolidate(focusEntity = null) {
        return busyRun('consolidate', async () => {
            const ok = await confirmAction(focusEntity
                ? tr('Have the AI re-read the memories about "{name}" to merge duplicates, replace outdated facts with newer ones, drop trivia and normalize names? The AI may not invent anything; locked/pinned memories are not touched. The whole pass can be undone in the Health tab.', { name: focusEntity })
                : tr('Have the AI re-read all memories to merge duplicates, replace outdated facts with newer ones, drop trivia and normalize names? The AI may not invent anything; locked/pinned memories are not touched. The whole pass can be undone in the Health tab.'));
            if (!ok) return;
            const result = await actions.runConsolidation({ focusEntity });
            if (result?.ok && (result.updated || result.deleted)) toastr.success(tr('Memory Weaver: AI cleanup done — ~{updated} edited · −{deleted} merged/deleted. Review or undo it in the Health tab.', { updated: result.updated, deleted: result.deleted }), 'Memory Weaver');
            else if (result?.ok) toastr.info(tr('Memory Weaver: AI review done — the store is already tidy, nothing to change.'), 'Memory Weaver');
            else actions.toastOptimizerResult(result);
        });
    }

    function runChapterNow(force = false) {
        return busyRun(force ? 'chapter-redo' : 'chapter', async () => {
            const run = await actions.runChapters({ force });
            if (run?.created > 0) toastr.success(force ? tr('Memory Weaver: rewrote the last chapter.') : trn('Memory Weaver: wrote {n} new chapter.', 'Memory Weaver: wrote {n} new chapters.', run.created), 'Memory Weaver');
            else if (run?.stopped === 'busy' || run?.stopped === 'generation_active') toastr.info(tr('Memory Weaver: another pass is running or the AI is replying — try again later.'), 'Memory Weaver');
            else if (run?.stopped === 'locked') toastr.info(tr('Memory Weaver: the last chapter is locked — unlock it to rewrite.'), 'Memory Weaver');
            else if (run?.stopped === 'cap') toastr.warning(tr('Memory Weaver: 60 chapters reached — delete some old chapters to keep writing.'), 'Memory Weaver');
            else if (run?.stopped === 'disabled' || run?.stopped === 'chapters_off') toastr.info(tr('Memory Weaver: Memory Weaver or chapter summaries are off (Settings → Features).'), 'Memory Weaver');
            else if (run?.stopped === 'chat_switched') toastr.info(tr('Memory Weaver: the chat changed midway — chapter writing cancelled.'), 'Memory Weaver');
            else if (run?.stopped === 'no_chapter') toastr.info(tr('Memory Weaver: there is no chapter to rewrite yet.'), 'Memory Weaver');
            else if (run?.stopped === 'not_enough' || run?.stopped === 'no_range' || run?.stopped === 'done' || !run?.chunks?.length) toastr.info(tr('Memory Weaver: not enough REMEMBERED messages for a new chapter yet — remember more, or lower "Messages per chapter".'), 'Memory Weaver');
            else toastr.warning(run?.error ? tr('Memory Weaver: chapter writing failed ({error}).', { error: run.error }) : tr('Memory Weaver: chapter writing failed.'), 'Memory Weaver');
        });
    }

    function runVectorSync() {
        return busyRun('vsync', async () => {
            const ok = await actions.syncIndex(true);
            toastr[ok ? 'success' : 'warning'](ok ? tr('Memory Weaver: vector index synced.') : tr('Memory Weaver: vector index sync failed (see Console, F12).'), 'Memory Weaver');
        });
    }

    async function deleteIds(ids, { confirm = false } = {}) {
        const list = [...ids];
        if (!list.length) return;
        if (confirm && !(await confirmAction(trn('Delete {n} selected memory?', 'Delete {n} selected memories?', list.length)))) return;
        const removed = actions.deleteMemories(list);
        for (const id of list) ui.selected.delete(id);
        if (ui.edit && list.includes(ui.edit.id)) ui.edit = null;
        if (!removed) toastr.warning(tr('Memory Weaver: could not delete (writes are blocked or the memory is gone).'), 'Memory Weaver');
        requestRender();
    }

    /* ------------------------------------------------------------------ */
    /* Header, coverage strip, alert banner, tabs                          */
    /* ------------------------------------------------------------------ */

    function statusPill(s) {
        let text;
        let tone;
        if (!s.settings.enabled) [text, tone] = [tr('Off'), 'muted'];
        else if (s.running) [text, tone] = [tr('Remembering…'), 'accent'];
        else if (s.settings.mode === 'off') [text, tone] = [tr('Manual entries only'), 'muted'];
        else if (s.settings.mode === 'manual') [text, tone] = [trn('On demand · {n} message waiting', 'On demand · {n} messages waiting', s.pending), 'info'];
        else if (s.ready) [text, tone] = [tr('Will remember after the next AI reply'), 'ok'];
        else [text, tone] = [trn('Auto · next pass in {n} message', 'Auto · next pass in {n} messages', Math.max(0, s.threshold - s.pending)), 'ok'];
        const pill = el('div', `mw-pill mw-tone-${tone}`);
        pill.append(el('span', `mw-dot${s.running ? ' mw-pulse' : ''}`), el('span', '', text));
        pill.setAttribute('aria-live', 'polite');
        return pill;
    }

    function buildHeader(s) {
        const header = el('div', 'mw-header');
        const logo = el('div', 'mw-logo');
        logo.append(icon('brain'));
        const titles = el('div', 'mw-titles');
        const charName = s.context.groupId ? tr('Group chat') : String(s.context.name2 ?? '').trim();
        const clock = s.state.clock?.day ? tr(' · Story day {n}', { n: s.state.clock.day }) : '';
        const titleRow = el('div', 'mw-title-row');
        titleRow.append(el('span', 'mw-title', 'Memory Weaver'), statusPill(s));
        titles.append(titleRow, el('div', 'mw-subtitle', `${charName || tr('Current chat')}${clock}`));

        const optimizeBusy = ui.busy.has('optimize') || s.running;
        const primary = button({
            label: optimizeBusy ? tr('Remembering…') : tr('Remember now'),
            iconName: optimizeBusy ? 'spinner' : 'wand-magic-sparkles',
            cls: `mw-btn-primary${optimizeBusy ? ' mw-busy' : ''}`,
            title: tr('Have the AI read the unprocessed messages and update memory now'),
            fk: 'optimize',
            disabled: optimizeBusy,
            onClick: runOptimizeNow,
        });
        if (optimizeBusy) primary.querySelector('i')?.classList.add('fa-spin');

        header.append(logo, titles, primary, buildMenu(s));
        return header;
    }

    function buildMenu(s) {
        const details = el('details', 'mw-menu');
        const summary = el('summary', 'mw-btn mw-btn-icon');
        summary.title = tr('More actions');
        summary.setAttribute('aria-label', tr('More actions'));
        summary.append(icon('ellipsis'));
        details.append(summary);
        const panel = el('div', 'mw-menu-panel');
        const item = (label, iconName, run, cls = '') => {
            const node = button({ label, iconName, cls: `mw-menu-item${cls ? ` ${cls}` : ''}` });
            node.addEventListener('click', () => {
                ui.menuOpen = false;
                details.open = false;
                run();
            });
            return node;
        };
        panel.append(
            item(tr('Rescan last 60 messages'), 'rotate-left', runRescan),
            item(tr('AI merge & clean up memories'), 'broom', runConsolidate),
            item(tr('Export memories to .md'), 'file-export', () => actions.exportMarkdown()),
            item(tr('Import memories from .txt/.md'), 'file-import', () => importInput.click()),
        );
        if (deps.isRetrievalEnabled()) panel.append(item(tr('Resync vector index'), 'arrows-rotate', runVectorSync));
        panel.append(el('div', 'mw-menu-sep'));
        panel.append(
            item(tr('Clear the whole schedule…'), 'calendar-xmark', async () => {
                if (!(s.state.schedule ?? []).length) {
                    toastr.info(tr('Memory Weaver: there are no appointments to delete.'), 'Memory Weaver');
                    return;
                }
                if (await confirmAction(tr('Delete the ENTIRE schedule of this chat? (memories are not affected)'))) {
                    const removed = actions.wipeSchedule();
                    toastr.info(trn('Memory Weaver: deleted {n} appointment.', 'Memory Weaver: deleted {n} appointments.', removed), 'Memory Weaver');
                }
            }, 'mw-danger'),
            item(tr('Clear all memories…'), 'trash-can', async () => {
                if (await confirmAction(tr('Delete ALL memories of this chat? The schedule is kept. You can undo right after.'))) {
                    actions.clearMemories();
                    ui.selected.clear();
                    ui.edit = null;
                }
            }, 'mw-danger'),
        );
        details.append(panel);
        /* The open state survives re-renders (bus events rebuild the header
           while the menu is open); the outside-click closer is a single
           document listener re-bound to the CURRENT menu element. */
        details.open = ui.menuOpen;
        const bindCloser = () => {
            dropMenuCloser();
            if (!details.open) return;
            ui.menuCloser = (event) => {
                if (!details.contains(event.target)) {
                    ui.menuOpen = false;
                    details.open = false;
                }
            };
            document.addEventListener('pointerdown', ui.menuCloser, true);
        };
        details.addEventListener('toggle', () => {
            ui.menuOpen = details.open;
            bindCloser();
        });
        if (details.open) bindCloser();
        return details;
    }

    /* Hidden file input shared by the ⋯ menu (lives outside the rebuilt DOM). */
    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.accept = '.txt,.md,text/plain,text/markdown';
    importInput.style.display = 'none';
    importInput.addEventListener('change', async () => {
        const file = importInput.files?.[0];
        importInput.value = '';
        if (file) await actions.importFile(file);
    });

    function buildCoverage(s) {
        const wrap = el('div', 'mw-coverage');
        const line = el('div', 'mw-coverage-line');
        const left = el('span');
        left.append(el('b', '', tr('Remembered {covered} / {total} messages', { covered: s.covered, total: s.total })));
        if (s.pending) left.append(document.createTextNode(trn(' · {n} message waiting', ' · {n} messages waiting', s.pending)));
        line.append(left);
        const last = s.state.lastResult;
        if (last) {
            const right = el('span', 'mw-coverage-last');
            right.append(document.createTextNode(tr('Last run {when}: ', { when: relativeTime(last.at) })));
            const tone = last.outcome === 'changed' ? 'ok' : (last.outcome === 'failed' || last.outcome === 'conflict' || last.outcome === 'blocked') ? 'bad' : 'muted';
            right.append(el('span', `mw-text-${tone}`, outcomeText(last)));
            line.append(right);
        }
        wrap.append(line);
        const backlog = deps.backlogState?.() ?? { active: false, done: 0 };
        if (backlog.active || s.pending > Math.max(60, s.threshold * 2)) {
            const runs = Math.max(1, Math.ceil(s.pending / 60));
            const bar = el('div', 'mw-backlog');
            bar.append(el('span', '', backlog.active
                ? tr('Remembering everything… {done} passes done · {pending} messages left', { done: backlog.done, pending: s.pending })
                : tr('{pending} messages not remembered yet · about {runs} passes (≤ 60 messages each)', { pending: s.pending, runs })));
            bar.append(button({
                label: backlog.active ? (backlog.stopping ? tr('Stopping…') : tr('Stop')) : tr('Remember everything'),
                iconName: backlog.active ? 'stop' : 'forward',
                cls: backlog.active ? 'mw-btn-sm' : 'mw-btn-soft mw-btn-sm',
                disabled: Boolean(backlog.stopping) || (!backlog.active && s.running),
                onClick: () => { void actions.runFullBacklog(); requestRender(); },
            }));
            wrap.append(bar);
        }
        const coveredPct = s.total ? (s.covered / s.total) * 100 : 0;
        const pendingPct = s.total ? (Math.min(s.pending, s.threshold) / s.total) * 100 : 0;
        wrap.append(progressBar([
            { pct: coveredPct, cls: 'mw-fill-accent' },
            { pct: pendingPct, cls: s.ready ? 'mw-fill-ok' : 'mw-fill-pending' },
        ], tr('Remembered {covered} of {total} messages', { covered: s.covered, total: s.total })));
        return wrap;
    }

    function alertCard(alert, { compact = false } = {}) {
        const card = el('div', `mw-alert mw-tone-${alert.tone}${compact ? ' mw-alert-compact' : ''}`);
        card.setAttribute('role', alert.tone === 'bad' ? 'alert' : 'status');
        card.append(icon(alert.tone === 'bad' ? 'triangle-exclamation' : alert.tone === 'warn' ? 'circle-exclamation' : 'circle-info', 'mw-alert-icon'));
        const body = el('div', 'mw-alert-body');
        body.append(el('div', 'mw-alert-title', alert.title));
        if (alert.body && !compact) body.append(el('div', 'mw-alert-text', alert.body));
        card.append(body);
        const actionsWrap = el('div', 'mw-alert-actions');
        (alert.actions ?? []).forEach((action, actionIndex) => {
            const busy = action.busyKey && ui.busy.has(action.busyKey);
            actionsWrap.append(button({
                fk: `alert-${alert.key ?? 'x'}-${actionIndex}${compact ? '-c' : ''}`,
                label: busy ? tr('Running…') : action.label,
                cls: action.primary ? 'mw-btn-primary mw-btn-sm' : 'mw-btn-sm',
                disabled: busy,
                onClick: () => {
                    const outcome = action.run();
                    if (!(outcome instanceof Promise)) requestRender();
                },
            }));
        });
        if (compact) {
            actionsWrap.append(button({ label: tr('Details'), cls: 'mw-btn-ghost mw-btn-sm', onClick: () => switchTab('health') }));
        }
        card.append(actionsWrap);
        return card;
    }

    function buildTabs(s) {
        const nav = el('div', 'mw-tabs');
        nav.setAttribute('role', 'tablist');
        const counts = {
            memories: String(s.state.entries.length),
            prompt: s.preview.active ? String((s.preview.ids ?? []).length) : tr('off'),
            story: (s.state.chapters ?? []).length ? String(s.state.chapters.length) : '',
            schedule: '',
            health: '',
        };
        for (const [key] of TABS) {
            const tab = el('button', `mw-tab${ui.tab === key ? ' mw-tab-active' : ''}`);
            tab.type = 'button';
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', ui.tab === key ? 'true' : 'false');
            tab.setAttribute('aria-controls', 'mw_tabpanel');
            tab.tabIndex = ui.tab === key ? 0 : -1;
            tab.dataset.fk = `tab-${key}`;
            tab.append(el('span', 'mw-tab-label', tabLabel(key)));
            if (counts[key]) tab.append(el('span', 'mw-tab-count', counts[key]));
            if (key === 'schedule') {
                const urgent = s.schedule.due + s.schedule.overdue;
                if (urgent) tab.append(el('span', 'mw-tab-badge mw-tone-bad', tr('{n} due', { n: urgent })));
                else if (s.schedule.active.length) tab.append(el('span', 'mw-tab-count', String(s.schedule.active.length)));
            }
            if (key === 'health') {
                const worst = s.alerts.find(alert => alert.tone === 'bad') ?? s.alerts.find(alert => alert.tone === 'warn');
                if (worst) tab.append(el('span', `mw-tab-dot mw-tone-${worst.tone}`));
            }
            tab.addEventListener('click', () => switchTab(key));
            nav.append(tab);
        }
        nav.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
            const keys = TABS.map(([key]) => key);
            const next = keys[(keys.indexOf(ui.tab) + (event.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length];
            event.preventDefault();
            switchTab(next);
            ui.root?.querySelector(`[data-fk="tab-${next}"]`)?.focus();
        });
        return nav;
    }

    function switchTab(key) {
        if (ui.tab === key) return;
        ui.tab = key;
        renderNow({ resetScroll: true });
    }

    /* ------------------------------------------------------------------ */
    /* Tab: Memories                                                       */
    /* ------------------------------------------------------------------ */

    /* Story position: the chunk start when known (v0.8 sourceStart), else
       the recorded-at message; imported/unknown sort last. */
    function storyPos(entry) {
        const start = Number(entry.sourceStart);
        if (entry.sourceStart !== null && entry.sourceStart !== undefined && Number.isFinite(start)) return start;
        const from = Number(entry.fromMessage);
        if (entry.fromMessage !== null && entry.fromMessage !== undefined && Number.isFinite(from) && from >= 0) return from;
        return Number.MAX_SAFE_INTEGER;
    }

    function filteredEntries(s) {
        let entries = [...s.state.entries];
        if (ui.filter.level !== 'all') entries = entries.filter(entry => String(Math.min(3, Math.max(1, Number(entry.importance) || 1))) === ui.filter.level);
        if (ui.filter.entity) entries = deps.filterByEntities(entries, [ui.filter.entity]);
        if (ui.filter.prompt === 'in') entries = entries.filter(entry => s.inPrompt.has(String(entry.id)));
        else if (ui.filter.prompt === 'out') entries = entries.filter(entry => !s.inPrompt.has(String(entry.id)));
        const query = foldSearch(ui.filter.text.trim());
        if (query) {
            entries = entries.filter(entry => foldSearch(entry.text).includes(query)
                || (entry.entities ?? []).some(name => foldSearch(name).includes(query)));
        }
        const created = entry => String(entry.createdAt ?? '');
        entries.sort((a, b) => {
            if (ui.sort === 'oldest') return created(a).localeCompare(created(b));
            if (ui.sort === 'importance') return (b.importance - a.importance) || created(b).localeCompare(created(a));
            if (ui.sort === 'story') return (storyPos(a) - storyPos(b)) || created(a).localeCompare(created(b));
            return created(b).localeCompare(created(a));
        });
        return entries;
    }

    /* "tin #A–B" when the source chunk start is known (v0.8 sourceStart),
       else "≈ tin #N" (fromMessage is the LAST message of a ≤60 chunk, so
       the old exact-looking "tin #N" could be off by a whole chunk). */
    function provenance(entry, s) {
        const from = entry.fromMessage;
        if (from === null || from === undefined || !Number.isFinite(Number(from)) || Number(from) < 0) return null;
        const end = ordinalOf(s, from);
        const startRaw = entry.sourceStart;
        if (startRaw !== null && startRaw !== undefined && Number.isFinite(Number(startRaw)) && Number(startRaw) <= Number(from)) {
            const start = ordinalOf(s, startRaw);
            return { label: start === end ? tr('msg #{n}', { n: end }) : tr('msg #{start}–{end}', { start, end }), jumpTo: Number(startRaw) };
        }
        return { label: tr('≈ msg #{n}', { n: end }), jumpTo: Number(from) };
    }

    function closePopup() {
        ui.root?.closest('dialog')?.querySelector('.popup-button-ok')?.click();
    }

    function jumpTo(rawIndex) {
        if (!Number.isFinite(rawIndex)) return;
        closePopup();
        /* Let the dialog finish closing before ST scrolls the chat. */
        window.setTimeout(() => { void actions.jumpToMessage(rawIndex); }, 150);
    }

    /* Character sheet for the active entity filter + rename/merge (v0.8).
       Model-generated tags drift ("Rika" / "Yamada Rika" / "Rika-chan") and
       every exact-match gate silently drops the variants. */
    function buildEntityCard(s, name, entityCounts) {
        const card = el('div', 'mw-card mw-entity-card');
        const tagged = s.state.entries.filter(entry => (entry.entities ?? []).includes(name));
        const core = tagged.filter(entry => entry.importance >= 3).length;
        const seen = tagged.filter(entry => s.inPrompt.has(String(entry.id))).length;
        const appointments = s.schedule.active.filter(row => (row.item.entities ?? []).includes(name)).length;
        const head = el('div', 'mw-entity-head');
        const title = el('div', 'mw-entity-title');
        title.append(icon('user'), el('b', '', name));
        head.append(title, el('span', 'mw-muted', tr('{n} memories · {core} core · AI sees {seen}{appointments}', {
            n: tagged.length, core, seen,
            appointments: appointments ? trn(' · {n} appointment', ' · {n} appointments', appointments) : '',
        })));
        card.append(head);

        const folded = foldSearch(name);
        /* Whole-word containment only ("Rika" ~ "Yamada Rika", NOT "Erika";
           "An" never matches "Lan Anh") and at least 3 letters. */
        const words = value => foldSearch(value).split(/[\s\-_.·,]+/).filter(Boolean);
        const mine = words(name);
        const similar = folded.length < 3 ? [] : [...entityCounts.keys()].filter(other => {
            if (other === name || foldSearch(other).length < 3) return false;
            const theirs = words(other);
            const contains = (big, small) => small.length > 0 && small.every(word => big.includes(word));
            return contains(theirs, mine) || contains(mine, theirs);
        });
        const actionsRow = el('div', 'mw-form-row');
        if (similar.length) {
            actionsRow.append(el('span', 'mw-hint', tr('Possibly the same person: {names}', { names: similar.join(', ') })));
            actionsRow.append(button({
                label: trn('Merge {n} name into "{name}"', 'Merge {n} names into "{name}"', similar.length, { name }), iconName: 'code-merge', cls: 'mw-btn-soft mw-btn-sm',
                onClick: async () => {
                    if (!(await confirmAction(tr('Change every tag {tags} to "{name}"? You can undo right after.', { tags: similar.map(item => `"${item}"`).join(', '), name })))) return;
                    actions.renameEntity(similar, name);
                },
            }));
        }
        actionsRow.append(button({
            label: tr('Rename…'), iconName: 'pen', cls: 'mw-btn-sm',
            onClick: async () => {
                const next = await deps.callGenericPopup(tr('Rename "{name}" to (type an existing name to merge into it):', { name }), deps.POPUP_TYPE.INPUT, name);
                const target = typeof next === 'string' ? next.trim() : '';
                if (!target || target === name) return;
                if (actions.renameEntity([name], target)) {
                    ui.filter.entity = target;
                    requestRender();
                }
            },
        }));
        actionsRow.append(button({ label: tr('AI clean up this name\'s memories'), iconName: 'broom', cls: 'mw-btn-sm', disabled: ui.busy.has('consolidate') || s.running, onClick: () => runConsolidate(name) }));
        actionsRow.append(button({ label: tr('Clear filter'), cls: 'mw-btn-ghost mw-btn-sm', onClick: () => { ui.filter.entity = ''; renderNow(); } }));
        card.append(actionsRow);
        return card;
    }

    function buildMemoriesTab(s) {
        const wrap = el('div', 'mw-tabpanel');

        const toolbar = el('div', 'mw-toolbar mw-sticky-2');
        const row1 = el('div', 'mw-toolbar-row');
        const searchWrap = el('label', 'mw-search');
        searchWrap.append(icon('magnifying-glass'));
        const search = input('search', 'mw-search-input', {
            value: ui.filter.text,
            placeholder: tr('Search memories — accents optional'),
            label: tr('Search memories'),
            fk: 'search',
            onInput: (value) => {
                ui.filter.text = value;
                window.clearTimeout(ui.searchTimer);
                ui.searchTimer = window.setTimeout(() => renderList({ resetScroll: true }), 150);
            },
        });
        search.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || !search.value) return;
            event.preventDefault();
            event.stopPropagation();
            search.value = '';
            ui.filter.text = '';
            renderList({ resetScroll: true });
        });
        searchWrap.append(search);
        row1.append(
            searchWrap,
            select('mw-sort', [['newest', tr('Newest first')], ['importance', tr('Most important first')], ['story', tr('Story order')], ['oldest', tr('Oldest first')]], ui.sort, {
                fk: 'sort', label: tr('Sort'), onChange: (value) => {
                    ui.sort = value;
                    renderList({ resetScroll: true });
                },
            }),
            button({
                label: ui.add.open ? tr('Close') : tr('Add memory'), iconName: ui.add.open ? 'xmark' : 'plus', cls: 'mw-btn-soft', fk: 'add-toggle',
                onClick: () => {
                    ui.add.open = !ui.add.open;
                    renderNow();
                    if (ui.add.open) ui.root?.querySelector('[data-fk="add-text"]')?.focus();
                },
            }),
        );
        toolbar.append(row1);

        const row2 = el('div', 'mw-toolbar-row mw-chips-row');
        const levelCounts = { all: s.state.entries.length, 3: 0, 2: 0, 1: 0 };
        const entityCounts = new Map();
        for (const entry of s.state.entries) {
            levelCounts[Math.min(3, Math.max(1, Number(entry.importance) || 1))]++;
            for (const name of entry.entities ?? []) entityCounts.set(name, (entityCounts.get(name) ?? 0) + 1);
        }
        if (ui.filter.entity && !entityCounts.has(ui.filter.entity)) ui.filter.entity = '';
        for (const [key, label] of [['all', tr('All')], ['3', tr('Core')], ['2', tr('Important')], ['1', tr('Normal')]]) {
            const active = ui.filter.level === key;
            const node = button({ label: `${label} ${levelCounts[key]}`, cls: `mw-filter${active ? ' mw-filter-on' : ''} mw-lvl-${key}`, fk: `lvl-${key}` });
            node.setAttribute('aria-pressed', active ? 'true' : 'false');
            node.addEventListener('click', () => {
                ui.filter.level = key;
                renderNow();
            });
            row2.append(node);
        }
        if (s.preview.active) {
            row2.append(el('span', 'mw-chip-sep'));
            const inCount = s.state.entries.filter(entry => s.inPrompt.has(String(entry.id))).length;
            for (const [key, label] of [['in', tr('In prompt {n}', { n: inCount })], ['out', tr('Not in prompt {n}', { n: s.state.entries.length - inCount })]]) {
                const active = ui.filter.prompt === key;
                const node = button({ label, cls: `mw-filter mw-filter-prompt${active ? ' mw-filter-on' : ''}`, fk: `prompt-${key}` });
                node.setAttribute('aria-pressed', active ? 'true' : 'false');
                node.addEventListener('click', () => {
                    ui.filter.prompt = active ? 'all' : key;
                    renderNow();
                });
                row2.append(node);
            }
        }
        if (entityCounts.size) {
            row2.append(el('span', 'mw-chip-sep'));
            const ranked = [...entityCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'vi'));
            const shown = ranked.slice(0, 6);
            if (ui.filter.entity && !shown.some(([name]) => name === ui.filter.entity)) shown.push([ui.filter.entity, entityCounts.get(ui.filter.entity)]);
            for (const [name, count] of shown) {
                const active = ui.filter.entity === name;
                const node = button({ label: `${name} ${count}`, cls: `mw-filter mw-filter-entity${active ? ' mw-filter-on' : ''}`, fk: `ent-${name}` });
                node.setAttribute('aria-pressed', active ? 'true' : 'false');
                node.addEventListener('click', () => {
                    ui.filter.entity = active ? '' : name;
                    renderNow();
                });
                row2.append(node);
            }
            if (ranked.length > shown.length) {
                const rest = ranked.filter(([name]) => !shown.some(([shownName]) => shownName === name));
                row2.append(select('mw-entity-more', [['', tr('+{n} more names…', { n: rest.length })], ...rest.map(([name, count]) => [name, `${name} (${count})`])], '', {
                    label: tr('Filter by another name'), fk: 'ent-more', onChange: (value) => {
                        ui.filter.entity = value;
                        renderNow();
                    },
                }));
            }
        }
        toolbar.append(row2);
        wrap.append(toolbar);

        if (ui.filter.entity) wrap.append(buildEntityCard(s, ui.filter.entity, entityCounts));
        if (ui.add.open) wrap.append(buildAddForm(s));

        const head = el('div', 'mw-list-head');
        ui.countEl = el('span', 'mw-list-count');
        const selectAll = button({
            label: tr('Select all shown'), cls: 'mw-btn-ghost mw-btn-sm', fk: 'select-all',
            onClick: () => {
                /* Only what is actually rendered (current page) — never
                   rows hidden past "Hiện thêm". */
                for (const entry of filteredEntries(ui.snapshot).slice(0, ui.listLimit)) ui.selected.add(String(entry.id));
                renderNow();
            },
        });
        head.append(ui.countEl, selectAll);
        wrap.append(head);

        ui.listEl = el('div', 'mw-list');
        ui.listEl.addEventListener('click', onListClick);
        ui.listEl.addEventListener('change', onListChange);
        wrap.append(ui.listEl);

        ui.bulkEl = el('div', 'mw-bulk');
        wrap.append(ui.bulkEl);
        renderList({ snapshot: s });
        return wrap;
    }

    function renderList({ snapshot = null, resetScroll = false } = {}) {
        if (!ui.listEl) return;
        /* A list-only refresh (search, sort, select, edit toggle) reads the
           live state — the cached snapshot may predate a write whose full
           render is still queued. */
        if (!snapshot) ui.snapshot = computeSnapshot();
        const s = snapshot ?? ui.snapshot;
        if (resetScroll) {
            ui.listLimit = LIST_PAGE;
            const host = scrollHost();
            const listTop = ui.listEl.offsetTop - 120;
            if (host && host.scrollTop > listTop) host.scrollTop = Math.max(0, listTop);
        }
        const entries = filteredEntries(s);
        ui.listEl.replaceChildren();
        if (ui.countEl) {
            const filtered = entries.length !== s.state.entries.length;
            ui.countEl.textContent = filtered
                ? tr('{shown} / {total} memories match the filter', { shown: entries.length, total: s.state.entries.length })
                : trn('{n} memory', '{n} memories', entries.length);
        }
        if (!entries.length) {
            const empty = el('div', 'mw-empty');
            empty.append(icon('brain', 'mw-empty-icon'));
            if (s.state.entries.length) {
                empty.append(el('div', 'mw-empty-title', tr('No memories match the filter.')));
                empty.append(button({
                    label: tr('Clear filters'), cls: 'mw-btn-soft', onClick: () => {
                        ui.filter = { text: '', level: 'all', entity: '', prompt: 'all' };
                        renderNow();
                    },
                }));
            } else {
                empty.append(el('div', 'mw-empty-title', tr('This chat has no memories yet.')));
                empty.append(el('div', 'mw-empty-text', s.settings.mode === 'auto'
                    ? tr('Just keep chatting — every {n} messages, Memory Weaver records the important events on its own. Or press "Remember now".', { n: s.threshold })
                    : tr('Press "Remember now" to have the AI read the chat and record the important events, or add memories yourself.')));
            }
            ui.listEl.append(empty);
            renderBulk(s);
            return;
        }
        const fragment = document.createDocumentFragment();
        for (const entry of entries.slice(0, ui.listLimit)) fragment.append(buildRow(entry, s));
        ui.listEl.append(fragment);
        if (entries.length > ui.listLimit) {
            ui.listEl.append(button({
                label: tr('Show more ({n} more memories)', { n: entries.length - ui.listLimit }), cls: 'mw-btn-soft mw-more',
                onClick: () => {
                    ui.listLimit += LIST_PAGE;
                    renderList();
                },
            }));
        }
        renderBulk(s);
    }

    function buildRow(entry, s) {
        const id = String(entry.id);
        if (ui.edit && ui.edit.id === id) return buildRowEditor(entry);
        const importance = Math.min(3, Math.max(1, Number(entry.importance) || 1));
        const locked = entry.locked === true;
        const selected = ui.selected.has(id);
        const row = el('div', `mw-row mw-imp-${importance}${selected ? ' mw-row-selected' : ''}`);
        row.dataset.id = id;

        const check = el('input', 'mw-check');
        check.type = 'checkbox';
        check.checked = selected;
        check.dataset.action = 'select';
        check.setAttribute('aria-label', tr('Select this memory'));

        const main = el('div', 'mw-row-main');
        const top = el('div', 'mw-row-top');
        top.append(el('span', `mw-badge mw-badge-${importance}`, importanceLabel(importance)));
        top.append(el('span', 'mw-row-text', entry.text));
        main.append(top);

        const meta = el('div', 'mw-row-meta');
        for (const name of entry.entities ?? []) meta.append(el('span', 'mw-entity', name));
        const source = provenance(entry, s);
        if (source) {
            const link = el('button', 'mw-link', source.label);
            link.type = 'button';
            link.dataset.action = 'jump';
            link.dataset.raw = String(source.jumpTo);
            link.title = tr('Open the source messages');
            meta.append(link);
        }
        const bits = [];
        bits.push(relativeTime(entry.createdAt));
        bits.push(entry.source === 'manual' ? tr('manual') : entry.source === 'schedule' ? tr('from schedule') : tr('auto'));
        meta.append(el('span', 'mw-row-bits', bits.join(' · ')));
        if (s.inPrompt.has(id)) {
            const seen = el('span', 'mw-seen');
            seen.title = tr('This memory is in the block injected into the prompt');
            seen.append(el('span', 'mw-dot'), el('span', '', tr('AI sees this')));
            meta.append(seen);
        }
        if (entry.pinned === true) {
            const pin = el('span', 'mw-pinned mw-pinned-prompt');
            pin.title = tr('Pinned to prompt — always injected for the AI (also locked)');
            pin.append(icon('thumbtack'), el('span', '', tr('Pinned to prompt')));
            meta.append(pin);
        } else if (locked) {
            const lockTag = el('span', 'mw-pinned');
            lockTag.title = tr('Locked — the AI cannot edit/delete it, and it is never trimmed');
            lockTag.append(icon('lock'), el('span', '', tr('Locked')));
            meta.append(lockTag);
        }
        main.append(meta);

        const rowActions = el('div', 'mw-row-actions');
        const pinned = entry.pinned === true;
        const pinBtn = button({ fk: `row-${id}-pin`, iconName: 'thumbtack', cls: `mw-btn-icon${pinned ? ' mw-on' : ''}`, title: pinned ? tr('Unpin from prompt') : tr('Pin to prompt — the AI always sees this memory (max {n})', { n: deps.maxPinned ?? 10 }) });
        pinBtn.dataset.action = 'pin';
        pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
        const lockBtn = button({ fk: `row-${id}-lock`, iconName: locked ? 'lock' : 'lock-open', cls: `mw-btn-icon${locked ? ' mw-on' : ''}`, title: locked ? tr('Unlock — allow the AI to edit/delete') : tr('Lock — the AI cannot edit/delete this memory') });
        lockBtn.dataset.action = 'lock';
        lockBtn.setAttribute('aria-pressed', locked ? 'true' : 'false');
        const editBtn = button({ fk: `row-${id}-edit`, iconName: 'pen', cls: 'mw-btn-icon', title: tr('Edit memory') });
        editBtn.dataset.action = 'edit';
        const delBtn = button({ fk: `row-${id}-del`, iconName: 'trash-can', cls: 'mw-btn-icon mw-danger', title: tr('Delete memory (undoable)') });
        delBtn.dataset.action = 'delete';
        rowActions.append(pinBtn, lockBtn, editBtn, delBtn);

        row.append(check, main, rowActions);
        return row;
    }

    function onListClick(event) {
        const target = event.target.closest('[data-action]');
        if (!target || !ui.listEl?.contains(target) || target.dataset.action === 'select') return;
        const row = target.closest('.mw-row');
        const id = row?.dataset.id;
        if (!id) return;
        const entry = deps.readState().entries.find(item => String(item.id) === id);
        if (!entry) return;
        if (target.dataset.action === 'edit') {
            ui.edit = {
                id,
                text: String(entry.text ?? ''),
                entities: (entry.entities ?? []).join(', '),
                importance: String(Math.min(3, Math.max(1, Number(entry.importance) || 1))),
            };
            renderList();
            ui.listEl.querySelector('[data-fk="edit-text"]')?.focus();
        } else if (target.dataset.action === 'lock') {
            actions.toggleLock(id);
        } else if (target.dataset.action === 'pin') {
            actions.togglePin(id);
        } else if (target.dataset.action === 'jump') {
            jumpTo(Number(target.dataset.raw));
        } else if (target.dataset.action === 'delete') {
            void deleteIds([id]);
        }
    }

    function onListChange(event) {
        const target = event.target;
        if (target?.dataset?.action !== 'select') return;
        const id = target.closest('.mw-row')?.dataset.id;
        if (!id) return;
        if (target.checked) ui.selected.add(id);
        else ui.selected.delete(id);
        target.closest('.mw-row')?.classList.toggle('mw-row-selected', target.checked);
        renderBulk(ui.snapshot);
    }

    function buildRowEditor(entry) {
        const draft = ui.edit;
        const row = el('div', 'mw-row mw-row-editing');
        const form = el('div', 'mw-edit');
        const text = el('textarea', 'text_pole mw-textarea');
        text.rows = 3;
        text.value = draft.text;
        text.dataset.fk = 'edit-text';
        text.setAttribute('aria-label', tr('Memory text'));
        text.addEventListener('input', () => { draft.text = text.value; });
        const entities = input('text', 'mw-grow', {
            value: draft.entities, placeholder: tr('Related names, comma-separated (e.g. Rika, USER)'), fk: 'edit-entities', label: tr('Related names'),
            onInput: (value) => { draft.entities = value; },
        });
        entities.spellcheck = false;
        const importance = select('', [[1, tr('Normal')], [2, tr('Important')], [3, tr('Core')]], draft.importance, {
            fk: 'edit-importance', label: tr('Importance'), onChange: (value) => { draft.importance = value; },
        });
        const cancel = () => {
            ui.edit = null;
            renderList();
        };
        const save = () => {
            const content = text.value.trim();
            if (!content) {
                toastr.warning(tr('Memory Weaver: memory text cannot be empty.'), 'Memory Weaver');
                text.focus();
                return;
            }
            const names = entities.value.split(',').map(item => item.trim()).filter(Boolean);
            const outcome = actions.editMemory(entry.id, { text: content, entities: names, importance: Number(importance.value) || 2 });
            if (outcome.ok) {
                ui.edit = null;
                if (!outcome.unchanged) toastr.success(tr('Memory Weaver: changes saved.'), 'Memory Weaver');
                requestRender();
                return;
            }
            if (outcome.error === 'duplicate') toastr.warning(tr('Memory Weaver: another memory already has exactly this text.'), 'Memory Weaver');
            else if (outcome.error === 'missing') {
                toastr.warning(tr('Memory Weaver: this memory no longer exists.'), 'Memory Weaver');
                ui.edit = null;
                requestRender();
            } else toastr.warning(tr('Memory Weaver: could not save (writes are blocked).'), 'Memory Weaver');
        };
        for (const node of [text, entities]) {
            stopEscape(node, cancel);
            node.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && event.keyCode !== 229) {
                    event.preventDefault();
                    save();
                }
            });
        }
        const fields = el('div', 'mw-form-row');
        fields.append(entities, importance);
        const buttons = el('div', 'mw-form-row mw-form-actions');
        buttons.append(
            el('span', 'mw-hint', tr('Ctrl+Enter to save · Esc to cancel')),
            button({ label: tr('Cancel'), cls: 'mw-btn-ghost', onClick: cancel }),
            button({ label: tr('Save'), iconName: 'check', cls: 'mw-btn-primary', onClick: save }),
        );
        form.append(text, fields, buttons);
        row.append(form);
        return row;
    }

    function buildAddForm(s) {
        const draft = ui.add;
        const card = el('div', 'mw-card mw-addform');
        const text = el('textarea', 'text_pole mw-textarea');
        text.rows = 2;
        text.value = draft.text;
        text.placeholder = tr('A fact that happened in the story, e.g. Rika hid the cat-shaped tote bag');
        text.dataset.fk = 'add-text';
        text.setAttribute('aria-label', tr('New memory text'));
        text.addEventListener('input', () => { draft.text = text.value; });
        const charName = deps.activeCharacterName();
        const entities = input('text', 'mw-grow', {
            value: draft.entities, placeholder: tr('Related names (empty = {name})', { name: charName || 'USER' }), fk: 'add-entities', label: tr('Related names'),
            onInput: (value) => { draft.entities = value; },
        });
        entities.spellcheck = false;
        const importance = select('', [[1, tr('Normal')], [2, tr('Important')], [3, tr('Core')]], draft.importance, {
            fk: 'add-importance', label: tr('Importance'), onChange: (value) => { draft.importance = value; },
        });
        const submit = () => {
            const content = text.value.trim();
            if (!content) {
                toastr.warning(tr('Memory Weaver: enter the memory text.'), 'Memory Weaver');
                text.focus();
                return;
            }
            const names = entities.value.split(',').map(item => item.trim()).filter(Boolean);
            const result = actions.addMemory(content, names.length ? names : [charName || 'USER'], Number(importance.value) || 2);
            if ((result?.added ?? 0) > 0) {
                /* The bus render is coalesced to the next frame, so clearing
                   the draft here is what that render shows (v0.6.4 fix: the
                   old synchronous render kept the submitted text). */
                draft.text = '';
                draft.entities = '';
                draft.importance = '2';
                toastr.success(tr('Memory Weaver: memory added.'), 'Memory Weaver');
                requestRender();
            } else {
                toastr.warning(tr('Memory Weaver: could not add — the memory already exists or writes are blocked.'), 'Memory Weaver');
            }
        };
        text.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                submit();
            }
        });
        stopEscape(text, () => {
            ui.add.open = false;
            renderNow();
        });
        const row = el('div', 'mw-form-row');
        row.append(entities, importance, button({ label: tr('Add'), iconName: 'plus', cls: 'mw-btn-primary', onClick: submit }));
        card.append(text, row);
        void s;
        return card;
    }

    function renderBulk(s) {
        if (!ui.bulkEl) return;
        /* Selection ids from a previous state (deleted elsewhere) drop out. */
        const live = new Set((s?.state.entries ?? []).map(entry => String(entry.id)));
        for (const id of [...ui.selected]) if (!live.has(id)) ui.selected.delete(id);
        ui.bulkEl.replaceChildren();
        ui.bulkEl.classList.toggle('mw-bulk-on', ui.selected.size > 0);
        if (!ui.selected.size) return;
        const ids = () => [...ui.selected];
        /* Selected rows the current filter/page hides are counted out loud —
           a bulk action must never surprise the user. */
        const visible = new Set(filteredEntries(s).slice(0, ui.listLimit).map(entry => String(entry.id)));
        const hidden = ids().filter(id => !visible.has(id)).length;
        ui.bulkEl.append(
            el('span', 'mw-bulk-count', hidden
                ? tr('{n} memories selected ({hidden} hidden by the filter)', { n: ui.selected.size, hidden })
                : trn('{n} memory selected', '{n} memories selected', ui.selected.size)),
            /* The 3rd bulkUpdate arg is an UNTRANSLATED English template with
               {n}; index.js translates it when it builds the undo toast. */
            button({ fk: 'bulk-pin', label: tr('Pin to prompt'), iconName: 'thumbtack', cls: 'mw-btn-sm', onClick: () => actions.bulkUpdate(ids(), { pinned: true }, 'Pinned {n} memories') }),
            button({ fk: 'bulk-lock', label: tr('Lock'), iconName: 'lock', cls: 'mw-btn-sm', onClick: () => actions.bulkUpdate(ids(), { locked: true }, 'Locked {n} memories') }),
            button({ fk: 'bulk-unlock', label: tr('Unlock'), iconName: 'lock-open', cls: 'mw-btn-sm', onClick: () => actions.bulkUpdate(ids(), { locked: false }, 'Unlocked {n} memories') }),
            select('mw-select-sm', [['', tr('Change level…')], [3, tr('Core')], [2, tr('Important')], [1, tr('Normal')]], '', {
                label: tr('Change the importance of the selected memories'), onChange: (value) => {
                    if (value) actions.bulkUpdate(ids(), { importance: Number(value) }, 'Changed the level of {n} memories');
                },
            }),
            button({ label: tr('Delete'), iconName: 'trash-can', cls: 'mw-btn-sm mw-btn-danger', onClick: () => deleteIds(ids(), { confirm: ui.selected.size > 1 || hidden > 0 }) }),
            button({
                label: tr('Deselect'), cls: 'mw-btn-sm mw-btn-ghost', onClick: () => {
                    ui.selected.clear();
                    renderList();
                },
            }),
        );
    }

    /* ------------------------------------------------------------------ */
    /* Tab: Trong prompt                                                   */
    /* ------------------------------------------------------------------ */

    /* "AI có nhớ chuyện này không?" (v0.8) — type what the AI forgot and get
       a verdict per matching memory with a one-click fix, or learn that the
       fact was never memorized (unprocessed history / nothing at all). */
    /* English source text; translated where rendered (tr(VERDICT[x][1]), tierName). */
    const VERDICT = {
        in: ['ok', 'In the prompt — the AI sees this memory'],
        budget: ['warn', 'Eligible, but did not fit the budget / tier quota this turn'],
        gate: ['warn', 'Filtered out: not Core, not tagged USER/the character, not among the newest entries'],
        irrelevant: ['muted', 'Not relevant this turn: not mentioned in the latest messages and no vector match'],
    };
    const TIER_NAMES = { pinned: 'Pinned', foundation: 'Foundation', scene: 'Current scene', core: 'Core', recent: 'Recent' };
    const tierName = tier => (TIER_NAMES[tier] ? tr(TIER_NAMES[tier]) : tier);

    function buildDiagnostic(s) {
        const card = el('div', 'mw-card mw-diag');
        card.append(el('div', 'mw-diag-title', tr('Does the AI remember this?')));
        const searchWrap = el('label', 'mw-search');
        searchWrap.append(icon('magnifying-glass'));
        const field = input('search', 'mw-search-input', {
            value: ui.diag, placeholder: tr('Type what the AI forgot, e.g. tote bag, supermarket…'), label: tr('What the AI forgot'), fk: 'diag',
            onInput: (value) => {
                ui.diag = value;
                window.clearTimeout(ui.diagTimer);
                ui.diagTimer = window.setTimeout(() => requestRender(), 250);
            },
        });
        field.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || !field.value) return;
            event.preventDefault();
            event.stopPropagation();
            ui.diag = '';
            renderNow();
        });
        searchWrap.append(field);
        card.append(searchWrap);
        const query = foldSearch(ui.diag.trim());
        if (query.length < 2) return card;
        if (!s.preview.active) {
            const row = el('div', 'mw-diag-row mw-tone-warn');
            row.append(icon('circle-exclamation', 'mw-alert-icon'));
            const body = el('div', 'mw-alert-body');
            body.append(el('div', 'mw-diag-text', s.preview.reason || tr('No memories are being injected into the prompt right now.')), el('div', 'mw-alert-text', tr('The AI sees NO memories at all — turn it back on to check individual facts.')));
            row.append(body);
            card.append(row);
            return card;
        }

        const matches = s.state.entries.filter(entry => foldSearch(entry.text).includes(query)
            || (entry.entities ?? []).some(name => foldSearch(name).includes(query))).slice(0, 8);
        const results = el('div', 'mw-diag-results');
        for (const entry of matches) {
            const id = String(entry.id);
            const reason = s.preview.reasons?.[id] ?? { status: s.inPrompt.has(id) ? 'in' : 'irrelevant' };
            const [tone, verdictText] = VERDICT[reason.status] ?? VERDICT.irrelevant;
            const text = tr(verdictText);
            const row = el('div', `mw-diag-row mw-tone-${tone}`);
            row.append(icon(reason.status === 'in' ? 'circle-check' : reason.status === 'irrelevant' ? 'moon' : 'circle-exclamation', 'mw-alert-icon'));
            const body = el('div', 'mw-alert-body');
            body.append(el('div', 'mw-diag-text', entry.text));
            body.append(el('div', 'mw-alert-text', reason.status === 'in' && reason.tier ? tr('{text} · tier {tier}', { text, tier: tierName(reason.tier) }) : text));
            row.append(body);
            const fixes = el('div', 'mw-alert-actions');
            if (reason.status !== 'in') {
                if (entry.pinned !== true) fixes.append(button({ label: tr('Pin to prompt'), iconName: 'thumbtack', cls: 'mw-btn-primary mw-btn-sm', onClick: () => actions.togglePin(id) }));
                if (reason.status === 'gate' && entry.importance < 3) fixes.append(button({ label: tr('Make Core'), cls: 'mw-btn-sm', onClick: () => actions.bulkUpdate([id], { importance: 3 }, 'Promoted {n} memories to Core') }));
                if (reason.status === 'budget') {
                    const next = Math.min(4000, Math.max(Number(s.preview.budget) + 200, Math.round((Number(s.preview.budget) * 1.5) / 100) * 100));
                    fixes.append(button({ label: tr('Set {n} tokens', { n: next }), cls: 'mw-btn-sm', onClick: () => actions.setInjectBudget(next) }));
                }
            }
            row.append(fixes);
            results.append(row);
        }
        if (!matches.length) {
            const cacheKey = `${ui.diag.trim()}|${s.cursorRaw}|${s.rawTotal}`;
            if (ui.unprocessedCache?.key !== cacheKey) ui.unprocessedCache = { key: cacheKey, hits: actions.searchUnprocessed(ui.diag.trim()) };
            const hits = ui.unprocessedCache.hits;
            if (hits.length) {
                for (const hit of hits) {
                    const row = el('div', 'mw-diag-row mw-tone-warn');
                    row.append(icon('hourglass-half', 'mw-alert-icon'));
                    const body = el('div', 'mw-alert-body');
                    body.append(el('div', 'mw-diag-text', tr('This is in message #{n} — NOT remembered yet', { n: hit.ordinal })), el('div', 'mw-alert-text', `"…${hit.snippet}…"`));
                    row.append(body);
                    const fixes = el('div', 'mw-alert-actions');
                    fixes.append(button({ label: tr('Remember now'), cls: 'mw-btn-primary mw-btn-sm', onClick: runOptimizeNow }));
                    fixes.append(button({ label: tr('Open message'), cls: 'mw-btn-sm', onClick: () => jumpTo(hit.rawIndex) }));
                    row.append(fixes);
                    results.append(row);
                }
            } else {
                const row = el('div', 'mw-diag-row mw-tone-muted');
                row.append(icon('circle-question', 'mw-alert-icon'));
                const body = el('div', 'mw-alert-body');
                body.append(el('div', 'mw-diag-text', tr('No memory covers this, and it is not in the unremembered messages either.')), el('div', 'mw-alert-text', tr('If it did happen, add it as a memory so the AI always remembers.')));
                row.append(body);
                const fixes = el('div', 'mw-alert-actions');
                fixes.append(button({
                    label: tr('Add this memory'), iconName: 'plus', cls: 'mw-btn-primary mw-btn-sm', onClick: () => {
                        ui.add.open = true;
                        ui.add.text = ui.diag.trim();
                        ui.tab = 'memories';
                        renderNow({ resetScroll: true });
                        ui.root?.querySelector('[data-fk="add-text"]')?.focus();
                    },
                }));
                row.append(fixes);
                results.append(row);
            }
        }
        card.append(results);
        return card;
    }

    function buildPromptTab(s) {
        const wrap = el('div', 'mw-tabpanel mw-stack');
        const preview = s.preview;
        wrap.append(el('p', 'mw-lead', tr('This is the [Chat Memories] block sent with the next message. If the AI "forgets" something, check here first — a memory that is not in this block is invisible to the AI.')));
        if (deps.isStorylineChat?.()) {
            wrap.append(alertCard({ tone: 'info', title: tr('Storyline chat: memories reach the AI through Storyline\'s memory_keeper function'), body: tr('Storyline replaces the whole prompt, so the block below is for reference only — the selection is identical (same Pinned / Foundation / Scene / Core / Recent tiers).'), actions: [] }));
        }
        wrap.append(buildDiagnostic(s));
        if (!preview.active) {
            wrap.append(alertCard({
                tone: 'warn', title: preview.reason || tr('No memories are being injected into the prompt right now.'),
                body: '', actions: s.settings.enabled && !s.settings.injectEnabled ? [{ label: tr('Turn on prompt injection'), primary: true, run: () => actions.setInjectEnabled(true) }] : [],
            }));
            return wrap;
        }
        const total = s.state.entries.length;
        const included = (preview.ids ?? []).length;
        const stats = el('div', 'mw-stats');
        const stat = (value, label, tone = '') => {
            const card = el('div', `mw-stat${tone ? ` mw-tone-${tone}` : ''}`);
            card.append(el('div', 'mw-stat-value', value), el('div', 'mw-stat-label', label));
            return card;
        };
        stats.append(
            stat(`${included} / ${total}`, tr('memories injected')),
            stat(`~${preview.estimatedTokens ?? 0} / ${preview.budget}`, tr('tokens used')),
            stat(preview.mode === 'hybrid' ? tr('Vector') : preview.mode === 'lexical' ? tr('Keyword') : tr('Basic'), preview.mode === 'hybrid' ? tr('picked by context') : preview.mode === 'lexical' ? (preview.fallbackReason ? tr('fallback — {reason}', { reason: preview.fallbackReason }) : tr('fallback')) : tr('by importance'), preview.mode === 'hybrid' ? 'ok' : ''),
            stat(String(Math.max(0, preview.eligible - included)), (preview.estimatedTokens ?? 0) >= preview.budget * 0.8 ? tr('did not fit the budget') : tr('not picked this turn'), preview.eligible - included > 0 && (preview.estimatedTokens ?? 0) >= preview.budget * 0.8 ? 'warn' : ''),
        );
        wrap.append(stats);

        const tiers = preview.tiers ?? null;
        if (tiers && typeof tiers === 'object') {
            const tierRow = el('div', 'mw-chips-row');
            for (const key of Object.keys(TIER_NAMES)) {
                const count = Array.isArray(tiers[key]) ? tiers[key].length : Number(tiers[key]) || 0;
                if (count) tierRow.append(chip(`${tierName(key)} ${count}`, `mw-tier-${key}`));
            }
            if (tierRow.childElementCount) wrap.append(tierRow);
        }

        const hint = budgetSuggestion(s);
        if (hint) wrap.append(alertCard(s.alerts.find(alert => alert.key === 'budget')));

        const block = el('pre', 'mw-block');
        block.textContent = preview.text || tr('(empty block — no memory passed the filter yet)');
        wrap.append(block);
        const storyBlock = deps.chaptersText?.() ?? '';
        if (storyBlock) {
            wrap.append(el('div', 'mw-section-title', tr('Story summary injected too (top of the prompt)')));
            const story = el('pre', 'mw-block');
            story.textContent = storyBlock;
            wrap.append(story);
        }
        if (preview.scheduleText) {
            wrap.append(el('div', 'mw-section-title', tr('Schedule injected too')));
            const sched = el('pre', 'mw-block');
            sched.textContent = preview.scheduleText;
            wrap.append(sched);
        }

        const buttons = el('div', 'mw-form-row');
        if (deps.isRetrievalEnabled()) {
            buttons.append(button({
                label: ui.busy.has('recall') ? tr('Refreshing…') : tr('Refresh from the latest messages'), iconName: 'rotate', disabled: ui.busy.has('recall'),
                onClick: () => busyRun('recall', () => actions.refreshRecall()),
            }));
        }
        buttons.append(button({
            label: tr('Copy block'), iconName: 'copy', onClick: async () => {
                try {
                    await navigator.clipboard.writeText([preview.text, preview.scheduleText].filter(Boolean).join('\n\n'));
                    toastr.success(tr('Memory Weaver: copied.'), 'Memory Weaver');
                } catch {
                    toastr.warning(tr('Memory Weaver: the browser blocked copying.'), 'Memory Weaver');
                }
            },
        }));
        wrap.append(buttons);
        return wrap;
    }

    /* ------------------------------------------------------------------ */
    /* Tab: Lịch trình                                                     */
    /* ------------------------------------------------------------------ */

    function countdown(row) {
        const isAfter = row.item.when.mode === 'after';
        if (row.remaining === null || row.remaining === undefined) return { big: '?', small: tr('no date set') };
        if (row.remaining === 0) return { big: '0', small: tr('due') };
        if (row.remaining > 0) {
            return { big: String(row.remaining), small: isAfter ? trn('message left', 'messages left', row.remaining) : trn('day left', 'days left', row.remaining) };
        }
        return { big: `−${-row.remaining}`, small: isAfter ? trn('message overdue', 'messages overdue', -row.remaining) : trn('day overdue', 'days overdue', -row.remaining) };
    }

    function buildScheduleTab(s) {
        const wrap = el('div', 'mw-tabpanel mw-stack');
        if (!s.settings.scheduleEnabled) {
            wrap.append(alertCard({ tone: 'info', title: tr('The schedule is off — appointments are not injected into the prompt.'), actions: [{ label: tr('Turn on schedule'), primary: true, run: () => actions.setScheduleEnabled(true) }] }));
        }

        const bar = el('div', 'mw-form-row mw-sched-bar');
        const clock = el('div', 'mw-clock');
        const day = s.state.clock?.day ?? null;
        clock.append(el('span', 'mw-clock-label', tr('Story day')));
        clock.append(button({ iconName: 'minus', cls: 'mw-btn-icon', title: tr('Back one day'), disabled: !day || day <= 1, onClick: () => actions.setClock(day - 1) }));
        const dayInput = input('number', 'mw-clock-input', {
            value: ui.clockDraft ?? (day ? String(day) : ''), placeholder: '—', label: tr('Story day'), fk: 'clock-day',
            onInput: (value) => { ui.clockDraft = value; },
        });
        dayInput.min = '1';
        dayInput.addEventListener('change', () => {
            const value = Number(dayInput.value);
            ui.clockDraft = null;
            if (Number.isFinite(value) && value >= 1) actions.setClock(Math.round(value));
        });
        clock.append(dayInput);
        clock.append(button({ iconName: 'plus', cls: 'mw-btn-icon', title: tr('Next day'), onClick: () => actions.setClock((day ?? 0) + 1) }));
        bar.append(clock, el('span', 'mw-hint mw-grow', tr('Only needed for "story day" appointments. Message-count appointments count themselves.')));
        bar.append(button({
            label: ui.sched.open ? tr('Close') : tr('Add appointment'), iconName: ui.sched.open ? 'xmark' : 'plus', cls: 'mw-btn-soft', fk: 'sched-toggle',
            onClick: () => {
                ui.sched.open = !ui.sched.open;
                renderNow();
                if (ui.sched.open) ui.root?.querySelector('[data-fk="sched-text"]')?.focus();
            },
        }));
        wrap.append(bar);
        wrap.append(el('div', 'mw-hint', s.settings.scheduleAuto?.enabled
            ? tr('AI records appointments from the conversation: on (change it in the extension settings).')
            : tr('AI records appointments from the conversation: off (change it in the extension settings).')));

        if (ui.sched.open) wrap.append(buildScheduleForm());

        const tier = urgency => (urgency === 'overdue' ? 0 : urgency === 'due' ? 1 : 2);
        const active = [...s.schedule.active].sort((a, b) => tier(a.urgency) - tier(b.urgency) || (a.remaining ?? Infinity) - (b.remaining ?? Infinity));
        wrap.append(el('div', 'mw-section-title', tr('Pending ({n})', { n: active.length })));
        if (!active.length) {
            wrap.append(el('div', 'mw-empty mw-empty-sm', tr('No appointments yet. Add one when the story promises a future event — the AI gets reminded when it is due.')));
        }
        for (const row of active) wrap.append(buildScheduleRow(row));

        if (s.schedule.terminal.length) {
            const term = el('details', 'mw-term');
            term.open = ui.termOpen;
            term.addEventListener('toggle', () => { ui.termOpen = term.open; });
            term.append(el('summary', '', tr('Done / cancelled / missed ({n})', { n: s.schedule.terminal.length })));
            const label = { done: tr('Done'), missed: tr('Missed'), cancelled: tr('Cancelled') };
            for (const item of [...s.schedule.terminal].sort((a, b) => String(b.resolvedAt ?? '').localeCompare(String(a.resolvedAt ?? '')))) {
                const row = el('div', `mw-term-row mw-term-${item.status}`);
                row.append(chip(label[item.status] ?? item.status), el('span', 'mw-grow', `${item.when.label ? `(${item.when.label}) ` : ''}${item.text}`), el('span', 'mw-hint', relativeTime(item.resolvedAt)));
                term.append(row);
            }
            wrap.append(term);
        }
        return wrap;
    }

    function buildScheduleRow(row) {
        const { item, urgency } = row;
        const isAfter = item.when.mode === 'after';
        const unit = isAfter ? tr('messages') : tr('days');
        const card = el('div', `mw-sched mw-sched-${urgency}`);
        const left = el('div', 'mw-sched-count');
        const cd = countdown(row);
        left.append(el('div', 'mw-sched-big', cd.big), el('div', 'mw-sched-small', cd.small));
        const main = el('div', 'mw-sched-main');
        main.append(el('div', 'mw-sched-text', item.text));
        const meta = [item.when.label, item.source === 'auto' ? tr('recorded by AI') : tr('manual')];
        if (item.postponedCount) meta.push(trn('postponed {n} time', 'postponed {n} times', item.postponedCount));
        if (item.entities?.length) meta.push(item.entities.join(', '));
        main.append(el('div', 'mw-sched-meta', meta.filter(Boolean).join(' · ')));
        card.append(left, main);

        if (ui.schedEdit?.id === item.id) {
            main.append(buildScheduleEditor(item));
            return card;
        }
        if (ui.schedPostpone === item.id) {
            const sub = el('div', 'mw-form-row');
            const custom = input('number', 'mw-num', { value: ui.postponeDraft, placeholder: tr('number'), label: isAfter ? tr('Postpone by how many messages') : tr('Postpone by how many days'), fk: 'sched-postpone', onInput: (value) => { ui.postponeDraft = value; } });
            custom.min = '1';
            const apply = (amount) => {
                const value = Number(amount);
                if (!Number.isFinite(value) || value <= 0) {
                    toastr.warning(tr('Memory Weaver: enter how much to postpone (> 0).'), 'Memory Weaver');
                    return;
                }
                ui.schedPostpone = null;
                ui.postponeDraft = '';
                if (actions.postponeSchedule(item.id, value)) {
                    toastr.info(isAfter
                        ? trn('Memory Weaver: postponed by +{n} message.', 'Memory Weaver: postponed by +{n} messages.', value)
                        : trn('Memory Weaver: postponed by +{n} day.', 'Memory Weaver: postponed by +{n} days.', value), 'Memory Weaver');
                } else toastr.warning(tr('Memory Weaver: could not postpone (it would duplicate another appointment?).'), 'Memory Weaver');
                requestRender();
            };
            sub.append(el('span', 'mw-hint', tr('Postpone by')), custom, el('span', 'mw-hint', unit), button({ label: tr('Postpone'), cls: 'mw-btn-primary mw-btn-sm', onClick: () => apply(custom.value) }), button({ label: tr('Cancel'), cls: 'mw-btn-ghost mw-btn-sm', onClick: () => { ui.schedPostpone = null; renderNow(); } }));
            main.append(sub);
            return card;
        }

        const step = item.when.mode === 'after' ? 10 : 1;
        const rowActions = el('div', 'mw-sched-actions');
        rowActions.append(
            button({
                label: tr('It happened'), iconName: 'check', cls: 'mw-btn-ok mw-btn-sm', title: tr('Mark as happened and save it as a memory'),
                onClick: () => {
                    const result = actions.resolveSchedule(item.id, 'done', { createMemory: true });
                    toastr[result.ok ? 'success' : 'warning'](result.ok ? (result.memoryCreated ? tr('Memory Weaver: done — saved as a memory.') : tr('Memory Weaver: done.')) : tr('Memory Weaver: appointment not found.'), 'Memory Weaver');
                },
            }),
            button({
                label: isAfter ? tr('Postpone +{n}', { n: step }) : trn('Postpone +{n} day', 'Postpone +{n} days', step), cls: 'mw-btn-sm',
                onClick: () => {
                    if (!actions.postponeSchedule(item.id, step)) toastr.warning(tr('Memory Weaver: could not postpone (it would duplicate another appointment?).'), 'Memory Weaver');
                },
            }),
        );
        const menu = el('details', 'mw-menu mw-menu-sm');
        menu.open = ui.schedMenu === item.id;
        const summary = el('summary', 'mw-btn mw-btn-icon mw-btn-sm');
        summary.setAttribute('aria-label', tr('More appointment actions'));
        summary.title = tr('More actions');
        summary.append(icon('ellipsis'));
        menu.append(summary);
        menu.addEventListener('toggle', () => { ui.schedMenu = menu.open ? item.id : (ui.schedMenu === item.id ? null : ui.schedMenu); });
        const panel = el('div', 'mw-menu-panel');
        const menuItem = (label, iconName, run, cls = '') => {
            const node = button({ label, iconName, cls: `mw-menu-item${cls ? ` ${cls}` : ''}` });
            node.addEventListener('click', () => {
                ui.schedMenu = null;
                run();
                requestRender();
            });
            return node;
        };
        panel.append(
            menuItem(tr('Postpone by…'), 'clock-rotate-left', () => { ui.schedPostpone = item.id; ui.schedEdit = null; }),
            menuItem(tr('Edit'), 'pen', () => {
                ui.schedEdit = { id: item.id, text: item.text, label: item.when.label ?? '', lead: String(item.lead ?? '') };
                ui.schedPostpone = null;
            }),
            menuItem(tr('Mark as missed'), 'circle-xmark', () => {
                const result = actions.resolveSchedule(item.id, 'missed');
                if (!result.ok) toastr.warning(tr('Memory Weaver: appointment not found.'), 'Memory Weaver');
            }),
            menuItem(tr('Cancel appointment'), 'xmark', () => {
                const result = actions.resolveSchedule(item.id, 'cancelled');
                if (!result.ok) toastr.warning(tr('Memory Weaver: appointment not found.'), 'Memory Weaver');
            }, 'mw-danger'),
        );
        menu.append(panel);
        rowActions.append(menu);
        card.append(rowActions);
        return card;
    }

    function buildScheduleEditor(item) {
        const draft = ui.schedEdit;
        const form = el('div', 'mw-edit');
        const text = input('text', '', { value: draft.text, label: tr('Appointment text'), fk: 'sched-edit-text', onInput: (v) => { draft.text = v; } });
        const label = input('text', 'mw-grow', { value: draft.label, placeholder: tr('Display label'), label: tr('Label'), fk: 'sched-edit-label', onInput: (v) => { draft.label = v; } });
        const lead = input('number', 'mw-num', { value: draft.lead, placeholder: tr('remind early'), label: tr('Remind early'), fk: 'sched-edit-lead', onInput: (v) => { draft.lead = v; } });
        lead.min = '0';
        const cancel = () => {
            ui.schedEdit = null;
            renderNow();
        };
        const save = () => {
            if (!text.value.trim()) {
                toastr.warning(tr('Memory Weaver: appointment text cannot be empty.'), 'Memory Weaver');
                return;
            }
            const nextLead = lead.value === '' ? undefined : Number(lead.value);
            const unchanged = text.value.trim() === String(item.text ?? '').trim()
                && label.value.trim() === String(item.when.label ?? '').trim()
                && (nextLead === undefined || nextLead === Number(item.lead));
            ui.schedEdit = null;
            if (unchanged) {
                requestRender();
                return;
            }
            const changed = actions.editSchedule(item.id, { text: text.value, label: label.value, lead: nextLead });
            if (changed) toastr.success(tr('Memory Weaver: appointment updated.'), 'Memory Weaver');
            else toastr.warning(tr('Memory Weaver: could not save — it would duplicate another pending appointment.'), 'Memory Weaver');
            requestRender();
        };
        for (const node of [text, label, lead]) stopEscape(node, cancel);
        const row = el('div', 'mw-form-row');
        row.append(label, lead, button({ label: tr('Cancel'), cls: 'mw-btn-ghost mw-btn-sm', onClick: cancel }), button({ label: tr('Save'), iconName: 'check', cls: 'mw-btn-primary mw-btn-sm', onClick: save }));
        form.append(text, row);
        return form;
    }

    function buildScheduleForm() {
        const draft = ui.sched;
        const card = el('div', 'mw-card mw-addform');
        const text = input('text', '', { value: draft.text, placeholder: tr('A future event, e.g. Watch the fireworks with Rika'), label: tr('Appointment text'), fk: 'sched-text', onInput: (v) => { draft.text = v; } });
        const isDay = draft.mode === 'story_day';
        const modeWrap = el('div', 'mw-segment');
        for (const [value, label] of [['after', tr('after … messages')], ['story_day', tr('on story day …')]]) {
            const node = button({ label, cls: `mw-seg${draft.mode === value ? ' mw-seg-on' : ''}` });
            node.setAttribute('aria-pressed', draft.mode === value ? 'true' : 'false');
            node.addEventListener('click', () => {
                draft.mode = value;
                renderNow();
            });
            modeWrap.append(node);
        }
        const when = input('number', 'mw-num', { value: draft.when, placeholder: isDay ? tr('day') : tr('messages'), label: isDay ? tr('Story day') : tr('Message count'), fk: 'sched-when', onInput: (v) => { draft.when = v; } });
        when.min = isDay ? '1' : '0';
        const lead = input('number', 'mw-num', { value: draft.lead, placeholder: isDay ? '1' : '5', label: tr('Remind early'), fk: 'sched-lead', onInput: (v) => { draft.lead = v; } });
        lead.min = '0';
        const label = input('text', 'mw-grow', { value: draft.label, placeholder: tr('Label (empty = automatic)'), label: tr('Label'), fk: 'sched-label', onInput: (v) => { draft.label = v; } });
        const entities = input('text', 'mw-grow', { value: draft.entities, placeholder: tr('Related names (e.g. Rika, USER)'), label: tr('Related names'), fk: 'sched-entities', onInput: (v) => { draft.entities = v; } });
        const submit = () => {
            const content = text.value.trim();
            if (!content) {
                toastr.warning(tr('Memory Weaver: enter the appointment text.'), 'Memory Weaver');
                text.focus();
                return;
            }
            const whenValue = Number(when.value);
            if (when.value === '' || !Number.isFinite(whenValue) || whenValue < (isDay ? 1 : 0)) {
                toastr.warning(isDay ? tr('Memory Weaver: enter the story day (≥ 1).') : tr('Memory Weaver: enter the message count (≥ 0).'), 'Memory Weaver');
                when.focus();
                return;
            }
            const result = actions.createSchedule({
                text: content,
                mode: draft.mode,
                turns: isDay ? undefined : whenValue,
                day: isDay ? whenValue : undefined,
                label: label.value,
                entities: entities.value.split(',').map(name => name.trim()).filter(Boolean),
                lead: lead.value === '' ? undefined : Number(lead.value),
            });
            if (!result.ok) {
                if (result.reason === 'duplicate') toastr.warning(tr('Memory Weaver: a matching appointment already exists (same text + time).'), 'Memory Weaver');
                else if (result.reason === 'cap') toastr.warning(tr('Memory Weaver: {n} pending appointments reached — complete or cancel some.', { n: deps.getSettings().maxScheduleActive }), 'Memory Weaver');
                else toastr.warning(tr('Memory Weaver: could not add the appointment (check the time).'), 'Memory Weaver');
                return;
            }
            Object.assign(draft, { text: '', when: '', lead: '', label: '', entities: '' });
            toastr.success(tr('Memory Weaver: appointment added.'), 'Memory Weaver');
            requestRender();
        };
        stopEscape(text, () => { ui.sched.open = false; renderNow(); });
        text.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                submit();
            }
        });
        const row1 = el('div', 'mw-form-row');
        row1.append(el('span', 'mw-hint', tr('Due')), modeWrap, when, el('span', 'mw-hint', tr('· remind early')), lead);
        const row2 = el('div', 'mw-form-row');
        row2.append(label, entities, button({ label: tr('Save appointment'), iconName: 'check', cls: 'mw-btn-primary', onClick: submit }));
        card.append(text, row1, row2);
        return card;
    }

    /* ------------------------------------------------------------------ */
    /* Tab: Tình trạng                                                     */
    /* ------------------------------------------------------------------ */

    /* v0.9.0: what a run changed (added / updated before→after / deleted)
       with "Hoàn tác lượt này". Kept by the runner on the newest 3 runs. */
    function buildRunDiff(run, index, s, log = []) {
        /* v0.9.1: a burst = every record sharing its runId — show and undo
           them as ONE unit. */
        const group = run.runId ? log.filter(item => item.runId === run.runId) : [run];
        const truncated = group.some(item => item.changes?.truncated || item.changes?.undoable === false);
        const gather = key => group.flatMap(item => (Array.isArray(item.changes?.[key]) ? item.changes[key] : []));
        const changes = { truncated };
        const added = gather('added');
        const updated = gather('updated');
        const deleted = gather('deleted');
        if (truncated) {
            const note = el('div', 'mw-run-diff mw-hint', tr('This pass changed too much to keep full details — it cannot be undone.'));
            return note;
        }
        const box = el('details', 'mw-run-diff');
        const key = `${run.at}`;
        box.open = ui.openRuns.has(key);
        box.addEventListener('toggle', () => { if (box.open) ui.openRuns.add(key); else ui.openRuns.delete(key); });
        box.append(el('summary', '', group.length > 1
            ? tr('View changes ({chunks} chunks): +{added} · ~{updated} · −{deleted}', { chunks: group.length, added: added.length, updated: updated.length, deleted: deleted.length })
            : tr('View changes: +{added} · ~{updated} · −{deleted}', { added: added.length, updated: updated.length, deleted: deleted.length })));
        const byId = new Map(s.state.entries.map(entry => [String(entry.id), entry]));
        for (const id of added.slice(0, 30)) {
            const entry = byId.get(String(id));
            box.append(el('div', 'mw-diff-line mw-diff-add', `+ ${entry ? entry.text : tr('(no longer exists)')}`));
        }
        for (const change of updated.slice(0, 30)) {
            const line = el('div', 'mw-diff-line mw-diff-upd');
            line.append(el('div', 'mw-diff-before', `− ${change.before?.text ?? ''}`), el('div', 'mw-diff-after', `+ ${change.after?.text ?? ''}`));
            box.append(line);
        }
        for (const entry of deleted.slice(0, 30)) box.append(el('div', 'mw-diff-line mw-diff-del', `− ${entry?.text ?? ''}`));
        if (added.length + updated.length + deleted.length) {
            box.append(button({
                label: tr('Undo this pass'), iconName: 'rotate-left', cls: 'mw-btn-sm', fk: `undo-${run.runId ?? run.at}`,
                onClick: () => { void actions.undoRun(index, run.runId ?? null); },
            }));
        }
        return box;
    }

    /* v0.9.0: Cốt truyện — chapter summaries ("story so far"). */
    function buildStoryTab(s) {
        const wrap = el('div', 'mw-tabpanel mw-stack');
        const progress = deps.chapterProgress?.() ?? { enabled: false, every: 100, sinceLast: 0, due: false };
        const chapters = Array.isArray(s.state.chapters) ? s.state.chapters : [];
        wrap.append(el('p', 'mw-lead', tr('After every long stretch of story, the AI writes a summary chapter: who did what, how relationships changed, promises and open threads. The "story so far" goes into the prompt so the AI never loses the plot of a long story.')));
        if (!progress.enabled) {
            wrap.append(alertCard({ tone: 'info', title: tr('Chapter summaries are off'), body: tr('Turn them on in Settings → Memory Weaver → Features.'), actions: [] }));
        }
        const bar = el('div', 'mw-form-row');
        const remaining = Math.max(0, progress.every - progress.sinceLast);
        bar.append(el('span', 'mw-hint mw-grow', progress.due
            ? tr('Enough messages for a new chapter — it will be written after the next memory pass.')
            : tr('{n} chapters · next chapter after ~{remaining} more remembered messages (each chapter ≈ {every} messages)', { n: chapters.length, remaining, every: progress.every })));
        bar.append(button({
            label: ui.busy.has('chapter') ? tr('Writing…') : tr('Write next chapter'), iconName: 'feather', cls: 'mw-btn-soft mw-btn-sm',
            disabled: ui.busy.has('chapter') || s.running, onClick: () => runChapterNow(false),
        }));
        if (chapters.length) {
            bar.append(button({
                label: ui.busy.has('chapter-redo') ? tr('Rewriting…') : tr('Rewrite last chapter'), iconName: 'rotate', cls: 'mw-btn-sm',
                disabled: ui.busy.has('chapter-redo') || s.running || chapters.at(-1)?.locked === true, onClick: () => runChapterNow(true),
            }));
        }
        wrap.append(bar);
        if (!chapters.length) {
            wrap.append(el('div', 'mw-empty mw-empty-sm', tr('No chapters yet. The first chapter is written once about {n} messages have been remembered.', { n: progress.every })));
            return wrap;
        }
        const staleIds = new Set((deps.staleChapterIds?.() ?? []).map(String));
        chapters.forEach((chapter, index) => {
            const card = el('div', `mw-card mw-chapter${chapter.locked ? ' mw-chapter-locked' : ''}`);
            const head = el('div', 'mw-chapter-head');
            const start = ordinalOf(s, chapter.startRaw);
            const end = Math.max(start, (s.prefix[Math.min(Number(chapter.endRaw) || 0, s.prefix.length - 1)] ?? 0));
            head.append(el('span', 'mw-chapter-no', tr('Chapter {n}', { n: index + 1 })));
            const range = el('button', 'mw-link', tr('msg #{start}–{end}', { start, end }));
            range.type = 'button';
            range.title = tr('Open these messages');
            range.addEventListener('click', () => jumpTo(Number(chapter.startRaw)));
            head.append(range);
            if (chapter.source === 'manual') head.append(chip(tr('edited by hand')));
            const stale = staleIds.has(String(chapter.id));
            if (stale) head.append(chip(tr('history changed'), 'mw-tone-warn'));
            if (chapter.locked) head.append(chip(tr('locked'), 'mw-tone-accent'));
            card.append(head);
            if (ui.chapterEdit?.id === chapter.id) {
                const draft = ui.chapterEdit;
                const title = input('text', '', { value: draft.title, label: tr('Chapter title'), fk: 'chapter-title', onInput: (v) => { draft.title = v; } });
                const summary = el('textarea', 'text_pole mw-textarea');
                summary.rows = 6;
                summary.value = draft.summary;
                summary.dataset.fk = 'chapter-summary';
                summary.addEventListener('input', () => { draft.summary = summary.value; });
                const cancel = () => { ui.chapterEdit = null; renderNow(); };
                stopEscape(summary, cancel);
                stopEscape(title, cancel);
                const row = el('div', 'mw-form-row mw-form-actions');
                row.append(button({ label: tr('Cancel'), cls: 'mw-btn-ghost mw-btn-sm', onClick: cancel }), button({
                    label: tr('Save'), iconName: 'check', cls: 'mw-btn-primary mw-btn-sm', onClick: () => {
                        if (!summary.value.trim()) {
                            toastr.warning(tr('Memory Weaver: chapter text cannot be empty.'), 'Memory Weaver');
                            return;
                        }
                        if (actions.editChapter(chapter.id, { title: title.value.trim(), summary: summary.value.trim() })) {
                            ui.chapterEdit = null;
                            toastr.success(tr('Memory Weaver: chapter saved.'), 'Memory Weaver');
                            requestRender();
                        }
                    },
                }));
                card.append(title, summary, row);
            } else {
                card.append(el('div', 'mw-chapter-title', chapter.title || tr('Untitled')));
                card.append(el('div', 'mw-chapter-summary', chapter.summary));
                const row = el('div', 'mw-form-row mw-form-actions');
                if (staleIds.has(String(chapter.id)) && !chapter.locked) {
                    row.append(button({
                        fk: `chapter-${chapter.id}-redo`, label: ui.busy.has(`chapter-${chapter.id}`) ? tr('Rewriting…') : tr('Rewrite this chapter'), iconName: 'rotate', cls: 'mw-btn-soft mw-btn-sm',
                        disabled: ui.busy.has(`chapter-${chapter.id}`) || s.running,
                        onClick: () => busyRun(`chapter-${chapter.id}`, async () => {
                            const run = await actions.runChapters({ chapterId: chapter.id });
                            if (run?.created > 0) toastr.success(tr('Memory Weaver: rewrote the chapter from the new history.'), 'Memory Weaver');
                            else toastr.info(tr('Memory Weaver: could not rewrite ({reason}).', { reason: run?.stopped ?? run?.error ?? tr('unknown') }), 'Memory Weaver');
                        }),
                    }));
                }
                row.append(
                    button({ fk: `chapter-${chapter.id}-edit`, label: tr('Edit'), iconName: 'pen', cls: 'mw-btn-ghost mw-btn-sm', onClick: () => { ui.chapterEdit = { id: chapter.id, title: chapter.title ?? '', summary: chapter.summary ?? '' }; renderNow(); } }),
                    button({ fk: `chapter-${chapter.id}-lock`, label: chapter.locked ? tr('Unlock') : tr('Lock'), iconName: chapter.locked ? 'lock-open' : 'lock', cls: 'mw-btn-ghost mw-btn-sm', title: tr('A locked chapter is never rewritten by the AI'), onClick: () => actions.editChapter(chapter.id, { locked: !chapter.locked }) }),
                    button({
                        label: tr('Delete'), iconName: 'trash-can', cls: 'mw-btn-ghost mw-btn-sm mw-danger', onClick: async () => {
                            if (await confirmAction(tr('Delete chapter {n}? (Memories are not affected; the AI can write the chapter again.)', { n: index + 1 }))) actions.deleteChapter(chapter.id);
                        },
                    }),
                );
                card.append(row);
            }
            wrap.append(card);
        });
        const block = deps.chaptersText?.() ?? '';
        if (block) {
            wrap.append(el('div', 'mw-section-title', tr('The "story so far" block the AI sees')));
            const pre = el('pre', 'mw-block');
            pre.textContent = block;
            wrap.append(pre);
        }
        return wrap;
    }

    function formatK(value) {
        const n = Number(value) || 0;
        return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n));
    }

    /* "Dọn trùng lặp" (v0.8) — near-duplicate clusters found by the pure
       recall-core.findDuplicateClusters; never merged automatically. */
    function buildDuplicatesSection(s) {
        const wrap = el('div', 'mw-stack mw-dupes');
        const head = el('div', 'mw-form-row');
        head.append(el('div', 'mw-section-title mw-grow', tr('Clean up duplicate memories')));
        head.append(button({
            label: ui.dupes ? tr('Scan again') : tr('Find duplicates'), iconName: 'clone', cls: 'mw-btn-sm',
            onClick: () => {
                ui.dupes = actions.findDuplicates() ?? [];
                renderNow();
            },
        }));
        wrap.append(head);
        if (!ui.dupes) {
            wrap.append(el('div', 'mw-hint', tr('The AI sometimes records the same thing in different words. Find and merge them so the prompt fits more distinct facts.')));
            return wrap;
        }
        const byId = new Map(s.state.entries.map(entry => [String(entry.id), entry]));
        const clusters = ui.dupes
            .map(cluster => ({ ...cluster, ids: (cluster.ids ?? []).map(String).filter(id => byId.has(id)) }))
            .filter(cluster => cluster.ids.length > 1);
        if (!clusters.length) {
            wrap.append(el('div', 'mw-empty mw-empty-sm', tr('No duplicate memories found.')));
            return wrap;
        }
        wrap.append(el('div', 'mw-hint', tr('{n} possible duplicate groups. "Merge" keeps the ★ entry (combines related names, keeps the highest level and any lock/pin) and deletes the rest — undoable.', { n: clusters.length })));
        for (const cluster of clusters.slice(0, 20)) {
            const keepId = byId.has(String(cluster.keepId)) ? String(cluster.keepId) : cluster.ids[0];
            const card = el('div', `mw-card mw-dupe${cluster.negationRisk ? ' mw-dupe-risk' : ''}`);
            if (cluster.negationRisk) card.append(el('div', 'mw-text-warn mw-hint', tr('Careful: one sentence contains a negation (not/never…) — these may be two opposite facts.')));
            for (const id of cluster.ids) {
                const entry = byId.get(id);
                const row = el('div', 'mw-dupe-row');
                row.append(el('span', id === keepId ? 'mw-dupe-keep' : 'mw-dupe-drop', id === keepId ? tr('★ keep') : tr('delete')));
                row.append(el('span', 'mw-grow', entry.text));
                row.append(el('span', `mw-badge mw-badge-${Math.min(3, Math.max(1, Number(entry.importance) || 1))}`, importanceLabel(Math.min(3, Math.max(1, Number(entry.importance) || 1)))));
                card.append(row);
            }
            card.append(button({
                label: tr('Merge {n} into 1', { n: cluster.ids.length }), iconName: 'code-merge', cls: 'mw-btn-primary mw-btn-sm',
                onClick: () => {
                    if (actions.mergeCluster(keepId, cluster.ids.filter(id => id !== keepId))) {
                        ui.dupes = ui.dupes.filter(item => item !== cluster && String(item.keepId) !== String(cluster.keepId));
                        requestRender();
                    }
                },
            }));
            wrap.append(card);
        }
        return wrap;
    }

    function buildHealthTab(s) {
        const wrap = el('div', 'mw-tabpanel mw-stack');
        const urgent = s.alerts.filter(alert => alert.tone !== 'info');
        const info = s.alerts.filter(alert => alert.tone === 'info');
        wrap.append(el('div', 'mw-section-title', urgent.length ? tr('Needs your attention') : tr('All good')));
        if (!urgent.length) {
            const ok = el('div', 'mw-alert mw-tone-ok');
            ok.append(icon('circle-check', 'mw-alert-icon'), el('div', 'mw-alert-title', tr('No errors. Memory is working normally.')));
            wrap.append(ok);
        }
        for (const alert of urgent) wrap.append(alertCard(alert));
        for (const alert of info) wrap.append(alertCard(alert));

        wrap.append(el('div', 'mw-section-title', tr('Progress')));
        const grid = el('div', 'mw-grid-2');
        const progressCard = (title, value, pct, cls) => {
            const card = el('div', 'mw-card');
            const head = el('div', 'mw-card-head');
            head.append(el('span', 'mw-muted', title), el('b', '', value));
            card.append(head, progressBar([{ pct, cls }], title));
            return card;
        };
        const coveredPct = s.total ? Math.round((s.covered / s.total) * 100) : 0;
        grid.append(progressCard(tr('Remembered'), tr('{covered} / {total} messages · {pct}%', { covered: s.covered, total: s.total, pct: coveredPct }), coveredPct, 'mw-fill-accent'));
        grid.append(s.settings.mode === 'auto'
            ? progressCard(tr('Until the next auto pass'), tr('{n} / {max} messages', { n: Math.min(s.pending, s.threshold), max: s.threshold }), (Math.min(s.pending, s.threshold) / s.threshold) * 100, s.ready ? 'mw-fill-ok' : 'mw-fill-pending')
            : progressCard(tr('Automatic memory'), s.settings.mode === 'manual' ? tr('off — on demand') : tr('off'), 0, 'mw-fill-pending'));
        wrap.append(grid);

        const stats = el('div', 'mw-stats');
        const entities = new Set();
        let core = 0;
        let locked = 0;
        for (const entry of s.state.entries) {
            for (const name of entry.entities ?? []) entities.add(name);
            if (entry.importance >= 3) core++;
            if (entry.locked === true) locked++;
        }
        for (const [value, label] of [[s.state.entries.length, tr('memories')], [core, tr('core')], [locked, tr('locked')], [s.state.entries.filter(entry => entry.pinned === true).length, tr('pinned to prompt')], [entities.size, tr('character/object names')]]) {
            const card = el('div', 'mw-stat');
            card.append(el('div', 'mw-stat-value', String(value)), el('div', 'mw-stat-label', label));
            stats.append(card);
        }
        wrap.append(stats);

        wrap.append(el('div', 'mw-section-title', tr('Recent runs')));
        const log = Array.isArray(s.state.runLog) && s.state.runLog.length ? s.state.runLog : (s.state.lastResult ? [s.state.lastResult] : []);
        if (!log.length) {
            wrap.append(el('div', 'mw-empty mw-empty-sm', tr('No memory passes in this chat yet.')));
        } else {
            const table = el('div', 'mw-table');
            const head = el('div', 'mw-table-row mw-table-head');
            for (const label of [tr('When'), tr('Type'), tr('Result'), tr('Model · time · tokens')]) head.append(el('span', '', label));
            table.append(head);
            for (const run of log.slice(0, 10)) {
                const row = el('div', 'mw-table-row');
                const failed = run.outcome === 'failed' || run.outcome === 'conflict' || run.outcome === 'blocked';
                const range = run.sourceRange ? tr(' · msgs {start}–{end}', { start: ordinalOf(s, run.sourceRange.start), end: Math.max(ordinalOf(s, run.sourceRange.start), (s.prefix[Math.min(run.sourceRange.end, s.prefix.length - 1)] ?? 0)) }) : '';
                const result = el('span', failed ? 'mw-text-bad' : run.outcome === 'changed' ? 'mw-text-ok' : 'mw-muted', `${outcomeText(run)}${range}`);
                if (failed && run.error) result.title = String(run.error);
                const tokens = Number.isFinite(Number(run.estInputTokens)) && run.estInputTokens !== null
                    ? (Number.isFinite(Number(run.estOutputTokens)) && run.estOutputTokens !== null
                        ? tr('~{in} in · ~{out} out', { in: formatK(run.estInputTokens), out: formatK(run.estOutputTokens) })
                        : tr('~{in} in', { in: formatK(run.estInputTokens) }))
                    : '';
                const exec = [run.model ? String(run.model).split('/').pop() : '', Number.isFinite(run.durationMs) ? `${(run.durationMs / 1000).toFixed(1)}s` : '', tokens].filter(Boolean).join(' · ');
                const sourceLabel = { manual: tr('on demand'), auto: tr('auto'), consolidate: tr('AI cleanup') }[run.source] ?? '—';
                row.append(el('span', '', relativeTime(run.at)), el('span', '', sourceLabel), result, el('span', 'mw-muted', exec || '—'));
                table.append(row);
                const groupHead = !run.runId || log.find(item => item.runId === run.runId) === run;
                if (groupHead && run.changes && !run.reverted) table.append(buildRunDiff(run, log.indexOf(run), s, log));
                else if (run.reverted) table.append(el('div', 'mw-run-diff mw-hint', tr('This pass was undone.')));
            }
            wrap.append(table);
            const totalIn = log.reduce((sum, run) => sum + (Number(run.estInputTokens) || 0), 0);
            const totalOut = log.reduce((sum, run) => sum + (Number(run.estOutputTokens) || 0), 0);
            if (totalIn) wrap.append(el('div', 'mw-hint', tr('The last {n} passes used about ~{in} input tokens · ~{out} output tokens (estimate).', { n: log.length, in: formatK(totalIn), out: formatK(totalOut) })));
        }

        wrap.append(buildDuplicatesSection(s));

        if (deps.isRetrievalEnabled()) {
            const status = deps.getRetrieverStatus();
            wrap.append(el('div', 'mw-section-title', 'Vector recall'));
            const line = el('div', 'mw-form-row');
            const label = status.status === 'ready'
                ? tr('Ready · {documents}/{entries} indexed', { documents: status.documents, entries: status.entries })
                : status.status === 'error' ? tr('Error: {error}', { error: status.lastError }) : String(status.status ?? '—');
            line.append(chip(label, status.status === 'ready' ? 'mw-tone-ok' : status.status === 'error' ? 'mw-tone-bad' : ''), button({
                label: ui.busy.has('vsync') ? tr('Syncing…') : tr('Resync'), iconName: 'arrows-rotate', cls: 'mw-btn-sm', disabled: ui.busy.has('vsync'), onClick: runVectorSync,
            }));
            wrap.append(line);
        }

        wrap.append(el('div', 'mw-section-title', tr('Tools')));
        const tools = el('div', 'mw-form-row');
        tools.append(
            button({ label: ui.busy.has('rescan') ? tr('Scanning…') : tr('Rescan last 60 messages'), iconName: 'rotate-left', disabled: ui.busy.has('rescan') || s.running, onClick: runRescan }),
            button({ label: ui.busy.has('consolidate') ? tr('AI is cleaning up…') : tr('AI merge & clean up memories'), iconName: 'broom', disabled: ui.busy.has('consolidate') || s.running, onClick: () => runConsolidate() }),
            button({ label: tr('Export .md'), iconName: 'file-export', onClick: () => actions.exportMarkdown() }),
            button({ label: tr('Import file'), iconName: 'file-import', onClick: () => importInput.click() }),
        );
        wrap.append(tools);
        wrap.append(el('div', 'mw-hint', tr('Data lives inside the chat file itself (variable memoryWeaverState). Quick commands: /memories action=add|summarize|sched_add …')));
        return wrap;
    }

    /* ------------------------------------------------------------------ */
    /* Render loop                                                         */
    /* ------------------------------------------------------------------ */

    function scrollHost() {
        return ui.root?.closest('.popup-content') ?? null;
    }

    function captureFocus() {
        const active = document.activeElement;
        if (!active || !ui.root?.contains(active) || !active.dataset?.fk) return null;
        let start = null;
        let end = null;
        try {
            start = active.selectionStart ?? null;
            end = active.selectionEnd ?? null;
        } catch {
            /* number inputs throw on selectionStart */
        }
        return { fk: active.dataset.fk, start, end };
    }

    function restoreFocus(focus) {
        if (!focus || !ui.root) return;
        const node = [...ui.root.querySelectorAll('[data-fk]')].find(item => item.dataset.fk === focus.fk);
        if (!node) return;
        node.focus({ preventScroll: true });
        if (focus.start !== null && typeof node.setSelectionRange === 'function') {
            try {
                node.setSelectionRange(focus.start, focus.end ?? focus.start);
            } catch {
                /* unsupported input type */
            }
        }
    }

    function dropMenuCloser() {
        if (!ui.menuCloser) return;
        document.removeEventListener('pointerdown', ui.menuCloser, true);
        ui.menuCloser = null;
    }

    function renderNow({ resetScroll = false } = {}) {
        if (!ui.root) return;
        ui.renderQueued = false;
        ui.renderAfterCompose = false;
        dropMenuCloser();
        const host = scrollHost();
        const scroll = host ? host.scrollTop : 0;
        const focus = captureFocus();
        const s = computeSnapshot();
        ui.snapshot = s;

        const shell = el('div', 'mw-shell');
        const top = el('div', 'mw-top');
        top.append(buildHeader(s), buildCoverage(s));
        const banner = s.alerts.find(alert => alert.tone === 'bad' || alert.tone === 'warn');
        if (banner && ui.tab !== 'health') top.append(alertCard(banner, { compact: true }));
        shell.append(top);
        const tabs = buildTabs(s);
        tabs.classList.add('mw-sticky-1');
        shell.append(tabs);

        ui.listEl = null;
        ui.countEl = null;
        ui.bulkEl = null;
        if (ui.tab === 'prompt') shell.append(buildPromptTab(s));
        else if (ui.tab === 'schedule') shell.append(buildScheduleTab(s));
        else if (ui.tab === 'health') shell.append(buildHealthTab(s));
        else if (ui.tab === 'story') shell.append(buildStoryTab(s));
        else shell.append(buildMemoriesTab(s));
        const panel = shell.lastElementChild;
        if (panel) {
            panel.id = 'mw_tabpanel';
            panel.setAttribute('role', 'tabpanel');
        }

        ui.root.replaceChildren(shell, importInput);
        if (host) host.scrollTop = resetScroll ? 0 : scroll;
        /* Narrow screens: keep the active tab visible inside the scrollable
           tab bar (horizontal only — never moves the popup body). */
        const activeTab = tabs.querySelector('.mw-tab-active');
        if (activeTab && tabs.scrollWidth > tabs.clientWidth) {
            const left = activeTab.offsetLeft - tabs.offsetLeft;
            if (left < tabs.scrollLeft || left + activeTab.offsetWidth > tabs.scrollLeft + tabs.clientWidth) {
                tabs.scrollLeft = Math.max(0, left - 16);
            }
        }
        restoreFocus(focus);
    }

    function requestRender() {
        if (!ui.root?.isConnected || ui.renderQueued) return;
        ui.renderQueued = true;
        /* rAF is paused in a background tab — the timeout keeps the popup
           current anyway; whichever fires first renders, the other no-ops. */
        const flush = () => {
            if (!ui.renderQueued) return;
            /* Never rebuild the DOM under an active IME composition (Unikey /
               OS Vietnamese input): replacing the field would drop the word
               being composed. Re-run on compositionend instead. */
            if (ui.composing) {
                ui.renderQueued = false;
                ui.renderAfterCompose = true;
                return;
            }
            renderNow();
        };
        window.requestAnimationFrame(flush);
        window.setTimeout(flush, 80);
    }

    async function open(tab = null) {
        if (tab && TABS.some(([key]) => key === tab)) ui.tab = tab;
        if (ui.root?.isConnected) {
            renderNow({ resetScroll: Boolean(tab) });
            return;
        }
        ui.root = el('div', 'mw-popup');
        ui.root.id = 'mw_popup';
        ui.root.addEventListener('compositionstart', () => { ui.composing = true; });
        ui.root.addEventListener('compositionend', () => {
            ui.composing = false;
            if (ui.renderAfterCompose) requestRender();
        });
        renderNow();
        await deps.callGenericPopup(ui.root, deps.POPUP_TYPE.TEXT, '', {
            okButton: tr('Close'),
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            /* ST 1.18: a falsy onClosing return CANCELS the close — always
               return true explicitly. */
            onClosing: () => {
                dropMenuCloser();
                ui.menuOpen = false;
                ui.clockDraft = null;
                ui.unprocessedCache = null;
                ui.composing = false;
                ui.renderAfterCompose = false;
                ui.root = null;
                ui.listEl = null;
                ui.countEl = null;
                ui.bulkEl = null;
                ui.snapshot = null;
                ui.renderQueued = false;
                return true;
            },
        });
    }

    /* Everything here belongs to the previous chat (ids, drafts, filters). */
    function resetForChat() {
        ui.filter = { text: '', level: 'all', entity: '', prompt: 'all' };
        ui.selected.clear();
        ui.edit = null;
        ui.add = { open: false, text: '', entities: '', importance: '2' };
        ui.sched = { open: false, text: '', mode: 'after', when: '', lead: '', label: '', entities: '' };
        ui.schedEdit = null;
        ui.schedMenu = null;
        ui.schedPostpone = null;
        ui.dupes = null;
        ui.chapterEdit = null;
        ui.openRuns.clear();
        ui.diag = '';
        ui.clockDraft = null;
        ui.postponeDraft = '';
        ui.listLimit = LIST_PAGE;
        requestRender();
    }

    return {
        open,
        requestRender,
        renderNow,
        resetForChat,
        isOpen: () => Boolean(ui.root?.isConnected),
    };
}
