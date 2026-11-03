/* Memory Weaver — Copyright (C) 2026 kdturtle — GPL-3.0, see LICENSE. */
/* v0.9: the importance rubric (shared by the optimizer and the
 * consolidation pass). */
export const IMPORTANCE_RUBRIC = '- Rate importance on this rubric: 1 = minor or transient detail (mood, outfit, small talk, a passing scene snapshot); 2 = important (the default); 3 = CORE — the story would BREAK if it were forgotten: identities and true names, relationships and how they changed, secrets, promises and deals, irreversible events (deaths, injuries, betrayals, losses, decisions that cannot be undone). Keep core rare — at most about one entry in five. Never rate a transient state (current mood, stat numbers, "current scene") as 3. Entries rated 3 are tagged [core] and are ALWAYS inserted into the prompt.';

export const DEFAULT_OPTIMIZER_SYSTEM = [
    'You are the memory keeper for an interactive story chat.',
    'You compress recent conversation into concise durable memory entries, grouped per character/entity.',
    'Rules:',
    '- Only record facts, events and decisions that matter for future continuity (relationships, promises, discoveries, possessions, injuries, location changes, secrets, deals).',
    '- Never invent events that are not present in the provided messages.',
    '- Keep each entry under 200 characters, objective, written in the same language as the conversation.',
    '- Update existing entries (by id) when the new messages change, clarify or contradict them; delete entries that turned out to be false or fully superseded.',
    '- Tag each entry with the entity names it is about ("USER" is the player).',
    /* v0.6.0 (F3): the importance rubric — uncalibrated models rated
       everything 2, which the delivery gate (imp≥3 / persona) then filtered
       OUT, so important memories never reached the prompt ("AI quên"). */
    /* v0.9: stronger rubric — "core" = the story would break if forgotten. */
    IMPORTANCE_RUBRIC,
    'Reply with EXACTLY ONE <MEMORY_UPDATE> block and nothing else. The block contains valid JSON with this exact shape:',
    '<MEMORY_UPDATE>{"protocol":2,"batchId":"<copy the batch id given below>","outcome":"changed|no_change","add":[{"entities":["Alice"],"text":"Alice knows the hidden passage","importance":2}],"update":[{"id":"1a2b3c4d","text":"rewritten entry text"}],"delete":["deadbeef"]}</MEMORY_UPDATE>',
    '- "outcome" is "changed" when the patch records something, "no_change" when the messages truly contain nothing worth remembering (pure greetings, OOC chatter).',
    '- "batchId" MUST be the exact batch id given in the task — a wrong or missing batch id invalidates the whole patch.',
    '- An all-empty patch with outcome "no_change" is valid. If the messages carry any event, fact, promise, discovery or change, record it with outcome "changed".',
    'No markdown, no code fences, no explanation.',
].join('\n');

/* v0.6.0 (F2): the protocol block is the NON-NEGOTIABLE part of the system
 * prompt — output envelope, batchId echo and strict typing. A user
 * promptOverride replaces the memory-keeping guidance but MUST still carry
 * this block, or every pass fails to parse (the exact v0.5.2 failure mode).
 * The default prompt already embeds the same rules inline; this export
 * exists so an override can never strip them. */
export const OPTIMIZER_PROTOCOL_BLOCK = [
    'Output protocol (mandatory — overrides any conflicting instruction above):',
    'Reply with EXACTLY ONE <MEMORY_UPDATE> block and nothing else. The block contains valid JSON with this exact shape:',
    '<MEMORY_UPDATE>{"protocol":2,"batchId":"<copy the batch id given below>","outcome":"changed|no_change","add":[{"entities":["Alice"],"text":"Alice knows the hidden passage","importance":2}],"update":[{"id":"1a2b3c4d","text":"rewritten entry text"}],"delete":["deadbeef"]}</MEMORY_UPDATE>',
    '- "batchId" MUST be the exact batch id given in the task — a wrong or missing batch id invalidates the whole patch.',
    '- "outcome" is "changed" when the patch records something, "no_change" when the messages truly contain nothing worth remembering.',
    '- An all-empty patch with outcome "no_change" is valid; "no_change" requires all arrays empty.',
    '- "add"/"update"/"delete" must be arrays; absent or null arrays are treated as empty, wrong-typed values invalidate the whole patch.',
    '- Schedule ops are OPTIONAL and only apply when the host says scheduling is enabled: "schedule_add": [{"text":"Alice will return on the full moon","when":{"mode":"after","in":30},"label"?:"..." }], "schedule_resolve": ["id"], "clock": {"day":N}. Absent or null schedule fields are treated as empty; wrong-typed ones invalidate the whole patch.',
    '- Never invent events that are not present in the provided messages.',
    'No markdown, no code fences, no explanation.',
].join('\n');

/* Scale guard (v0.3.1): the whole store used to be serialized into every
   optimizer pass — at the 500-entry cap that meant a ~30k-token prompt every
   N messages. A pass can only meaningfully update facts about speakers
   PRESENT IN THIS CHUNK, so those entries go first; the rest ride along
   (importance/newest first) for global dedupe context, hard-capped. */
export const MAX_EXISTING_IN_PROMPT = 100;
/* v0.9: `settings.optimizerExistingMax` replaces the hard 100 cap when
 * provided (default 150 in index.js DEFAULT_SETTINGS, clamped 50–300).
 * Absent/invalid → MAX_EXISTING_IN_PROMPT (legacy parity). The planner and
 * the prompt use the same number. */
export const OPTIMIZER_EXISTING_MAX = { default: 150, min: 50, max: 300 };

export function existingLimitFor(settings = {}) {
    const raw = settings?.optimizerExistingMax;
    if (raw === undefined || raw === null || raw === '') return MAX_EXISTING_IN_PROMPT;
    const num = Math.round(Number(raw));
    if (!Number.isFinite(num)) return MAX_EXISTING_IN_PROMPT;
    return Math.min(OPTIMIZER_EXISTING_MAX.max, Math.max(OPTIMIZER_EXISTING_MAX.min, num));
}

/* v0.6.5: the system prompt actually sent for these settings — the planner
 * budgets with its length (it is part of the request input). */
export function optimizerSystemPrompt(settings = {}) {
    const override = String(settings?.promptOverride ?? '').trim();
    return override ? `${override}\n\n${OPTIMIZER_PROTOCOL_BLOCK}` : DEFAULT_OPTIMIZER_SYSTEM;
}

/* v0.6.0 (T9.3): renders the optional schedule section for the optimizer
 * prompt. Null/disabled input ⇒ '' (byte-identical prompt). */
function buildSchedulePromptSection(scheduleAuto) {
    if (!scheduleAuto || typeof scheduleAuto !== 'object') return '';
    const active = Array.isArray(scheduleAuto.active) ? scheduleAuto.active.slice(0, 20) : [];
    /* v0.6.0 review-fix (B2): null/undefined storyDay (clock unset) must stay
       absent — Number(null) is 0 and printed a false "Current story day: 0". */
    const rawStoryDay = scheduleAuto.storyDay;
    const storyDay = (rawStoryDay === null || rawStoryDay === undefined || rawStoryDay === '') ? NaN : Number(rawStoryDay);
    if (!active.length && !Number.isFinite(storyDay)) return '';
    const lines = ['## Active appointments', 'The model may reference these ids in "schedule_resolve" when the messages show an appointment is fulfilled or abandoned.'];
    for (const item of active) {
        const label = item?.when?.label ? ` (${item.when.label})` : '';
        const remaining = Number(item?.remaining);
        const due = Number.isFinite(remaining)
            ? `due in ${Math.max(0, Math.round(remaining))} messages`
            : item?.when?.mode === 'story_day' ? `due on story day ${item.when.storyDay}` : '';
        lines.push(`- id:${item?.id ?? ''}${label} ${item?.text ?? ''}${due ? ` — ${due}` : ''}`);
    }
    if (Number.isFinite(storyDay)) lines.push(`Current story day: ${Math.round(storyDay)}`);
    return lines.join('\n');
}

/* v0.8: the existing-memories RANKING (which entries the prompt includes),
 * exported so the planner trims exactly the tail the prompt would drop:
 * chunk speakers first, then importance desc, then newest first; capped at
 * `limit` (default MAX_EXISTING_IN_PROMPT). */
export function rankExistingForPrompt(entries = [], chunk = [], limit = MAX_EXISTING_IN_PROMPT) {
    const chunkSpeakers = new Set();
    for (const item of Array.isArray(chunk) ? chunk : []) {
        const name = String(item?.name ?? '').trim().toLowerCase();
        if (name) chunkSpeakers.add(name);
    }
    const overlapsChunk = (entry) => (Array.isArray(entry?.entities) ? entry.entities : [])
        .some(entity => chunkSpeakers.has(String(entity).trim().toLowerCase()));
    const cap = Number.isFinite(Number(limit)) ? Math.max(0, Math.min(OPTIMIZER_EXISTING_MAX.max, Math.floor(Number(limit)))) : MAX_EXISTING_IN_PROMPT;
    return [...(Array.isArray(entries) ? entries : [])].sort((a, b) => {
        const aIn = overlapsChunk(a) ? 0 : 1;
        const bIn = overlapsChunk(b) ? 0 : 1;
        return aIn - bIn || (Number(b?.importance ?? 0) - Number(a?.importance ?? 0)) || String(b?.createdAt ?? '').localeCompare(String(a?.createdAt ?? ''));
    }).slice(0, cap);
}

/* `maxExisting` (v0.8, optional): the planner's trimmed existing-memories
 * count when the fixed prompt cost alone exceeds the input budget. */
/* v0.9: compact "Story so far" section for the optimizer (and consolidation)
 * — the last `limit` chapter summaries, oldest first. '' when none. */
export const STORY_SO_FAR_CHAPTERS = 3;
export function buildStorySoFarSection(chapters, limit = STORY_SO_FAR_CHAPTERS) {
    const list = (Array.isArray(chapters) ? chapters : [])
        .filter(item => item && typeof item === 'object' && String(item.summary ?? '').trim())
        .map((item, index) => ({ item, index }))
        .sort((a, b) => ((Number(a.item.startRaw) || 0) - (Number(b.item.startRaw) || 0)) || (a.index - b.index))
        .map(row => row.item);
    if (!list.length) return '';
    const total = list.length;
    const shown = list.slice(-Math.max(1, Math.floor(Number(limit) || STORY_SO_FAR_CHAPTERS)));
    const firstNumber = total - shown.length + 1;
    return [
        '## Story so far (chapter summaries, oldest first — context only, do not copy them into memories)',
        ...shown.map((item, i) => `- Ch.${firstNumber + i}${String(item.title ?? '').trim() ? ` (${String(item.title).trim()})` : ''}: ${String(item.summary).trim()}`),
    ].join('\n');
}

/* v0.9: `chapters` (optional array) — when non-empty, a compact "Story so
 * far" section (last 3 summaries) is PREPENDED to the user message so the
 * extraction stays coherent with the long arc. Empty/absent → byte-identical.
 * `maxExisting` null → existingLimitFor(settings). */
export function buildOptimizerPrompt({ entries = [], chunk = [], settings = {}, batchId = '', scheduleAuto = null, maxExisting = null, chapters = null } = {}) {
    /* v0.6.0 (F2): an override replaces the GUIDANCE but the protocol block
       is always appended — without it the model loses the output envelope
       and every pass fails to parse. Legacy (no override) is byte-identical
       to before: DEFAULT_OPTIMIZER_SYSTEM already embeds the same rules. */
    const system = optimizerSystemPrompt(settings);
    const hasOverride = String(settings?.promptOverride ?? '').trim() !== '';

    const ranked = rankExistingForPrompt(entries, chunk, maxExisting === null || maxExisting === undefined ? existingLimitFor(settings) : maxExisting);
    const storySoFar = buildStorySoFarSection(chapters);
    /* R1: the runner validates update/delete ids against EXACTLY the ids the
       model saw — the ranking lives in one place and is exported alongside. */
    const includedIds = ranked.map(entry => String(entry.id));

    /* v0.8: the SAME included set is rendered oldest-first (createdAt ASC,
       rank as tiebreak) — a stable, append-mostly prefix lets providers
       cache the prompt across passes; validation still uses includedIds. */
    const rendered = ranked
        .map((entry, rank) => ({ entry, rank }))
        .sort((a, b) => String(a.entry?.createdAt ?? '').localeCompare(String(b.entry?.createdAt ?? '')) || a.rank - b.rank)
        .map(item => item.entry);
    const existing = rendered.length
        ? rendered.map(entry => `- id:${entry.id} [${(entry.entities ?? []).join(', ')}] (importance ${entry.importance}) ${entry.text}`).join('\n')
        : '(no memories recorded yet)';
    const hiddenCount = entries.length - ranked.length;

    const messages = chunk.length
        ? chunk.map(item => `${item.name}: ${item.text}`).join('\n')
        : '(no new messages)';

    const batchLine = batchId
        ? `Batch id (echo it back EXACTLY in "batchId"): ${batchId}`
        : 'Batch id: (not provided — reply with the legacy shape)';

    /* v0.6.0 (T9.3): the schedule section is appended ONLY when the host
       enables schedule auto ops — OFF stays byte-identical to before. */
    const scheduleSection = buildSchedulePromptSection(scheduleAuto);

    const user = [
        ...(storySoFar ? [storySoFar, ''] : []),
        '## Existing memories',
        existing,
        /* v0.6.0 (F6): over-cap stores show only the top 100 — tell the model
           the rest exist so it does not re-add facts it cannot see. */
        ...(hiddenCount > 0
            ? [`(…and ${hiddenCount} older memories are not listed — do not re-add facts similar to the ones above.)`]
            : []),
        '',
        '## New chat messages',
        messages,
        ...(scheduleSection ? ['', scheduleSection] : []),
        '',
        '## Task',
        batchLine,
        'Produce an updated memory patch:',
        '- "add": only durable facts/events that NO existing memory already states. If an existing memory states the same fact (even reworded, shortened or with an extra detail), UPDATE that id instead — never add it again.',
        '- "update": rewrite existing entries (by id) when the new messages change, clarify or expand them. Never raise "importance" merely because a fact was restated.',
        '- Skip transient state lines (current mood/stat numbers, "Cảnh hiện tại…"/"current scene…" snapshots) unless they matter later in the story.',
        /* v0.8: the default system prompt already carries the delete/tagging/
           language/no-invention rules — repeated only when a promptOverride
           replaced that guidance (the protocol block does not carry them). */
        ...(hasOverride ? [
            '- "delete": ids of entries that turned out to be false or fully superseded.',
            '- Tag each entry with the entity names it is about ("USER" is the player).',
        ] : []),
        '- List "add" entries in story order: the EARLIEST event described in the messages first, the LATEST event last. Never shuffle them.',
        ...(hasOverride ? ['- Never invent events that are not in the messages. Keep each text under 200 characters, objective, in the same language as the conversation.'] : []),
        'Output format (strict, single block, no markdown fences, no other text). Fill it with REAL data from the messages — never copy the example verbatim:',
        '<MEMORY_UPDATE>{"protocol":2,"batchId":"<the batch id above>","outcome":"changed","add":[{"entities":["Name"],"text":"a fact stated in the messages","importance":2}],"update":[],"delete":[]}</MEMORY_UPDATE>',
        /* v0.8: the "no_change ⇒ all arrays empty" rule lives in BOTH system
           variants (default prompt + protocol block) — not repeated here. */
    ].join('\n');

    return { system, user, includedIds };
}

/* Models quote dialogue inside a string without escaping it
   ("text":"Claire says "no gun""), and some write raw line breaks inside
   strings; either breaks JSON.parse. Escape a quote that sits inside a
   string and is not followed by JSON structure, and escape raw control
   characters. The result still goes through JSON.parse only. */
/* A quote closes the string only when what follows is real JSON structure:
   end of text, `}` / `]`, `:` before a value, or `,` before the next key or
   element. `"đi", rồi chạy` is a comma inside dialogue, not structure. */
function closesString(text, from) {
    const rest = text.slice(from, from + 64);
    const match = /^\s*([\s\S]?)/.exec(rest);
    const next = match[1];
    if (next === '' || next === '}' || next === ']') return true;
    const after = rest.slice(match[0].length).trimStart();
    if (next === ':') return after === '' || /^["{[\-\d]|^(true|false|null)\b/.test(after);
    if (next === ',') return after === '' || /^["{[\]}\-\d]|^(true|false|null)\b/.test(after);
    return false;
}

export function repairJsonStrings(text) {
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (!inString) {
            if (ch === '"') inString = true;
            out += ch;
            continue;
        }
        if (ch === '\\') {
            out += ch + (text[i + 1] ?? '');
            i++;
        } else if (ch === '"') {
            if (closesString(text, i + 1)) {
                inString = false;
                out += ch;
            } else {
                out += '\\"';
            }
        } else if (ch === '\n') {
            out += '\\n';
        } else if (ch === '\r') {
            out += '\\r';
        } else if (ch === '\t') {
            out += '\\t';
        } else {
            out += ch;
        }
    }
    return out;
}

/* `errorSink` (optional) receives the last JSON.parse error message. */
function tryParseJsonObject(candidate, errorSink = null) {
    if (candidate === null || candidate === undefined) return null;
    let text = String(candidate).trim();
    if (!text) {
        if (errorSink) errorSink.message = 'empty block';
        return null;
    }

    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    const attempts = [text];
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace && (firstBrace > 0 || lastBrace < text.length - 1)) {
        attempts.push(text.slice(firstBrace, lastBrace + 1));
    }
    /* Repaired copies go last: a valid block is always parsed as written. */
    for (const attempt of [...attempts]) {
        const repaired = repairJsonStrings(attempt);
        if (repaired !== attempt) attempts.push(repaired);
    }

    let firstError = '';
    for (const attempt of attempts) {
        let payload;
        try {
            payload = JSON.parse(attempt);
        } catch (error) {
            /* Report the error of the text as written, not of a repair try. */
            if (!firstError) firstError = String(error?.message ?? error).slice(0, 160);
            if (errorSink) errorSink.message = firstError;
            continue;
        }
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
        if (Array.isArray(payload)) {
            const object = payload.find(item => item && typeof item === 'object' && !Array.isArray(item));
            if (object) return object;
        }
    }

    return null;
}

/**
 * Collects JSON object candidates from arbitrary model output: fenced code
 * blocks first, then every top-level balanced `{...}` object (string-aware).
 */
function collectJsonCandidates(text) {
    const candidates = [];

    for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
        candidates.push(match[1]);
    }

    const openStack = [];
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length && candidates.length < 12; i++) {
        const char = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        /* v0.6.5: strings only exist INSIDE an object — a stray quote in the
           prose before the JSON must not swallow the whole payload. */
        if (char === '"' && openStack.length) {
            inString = true;
            continue;
        }
        if (char === '{') {
            openStack.push(i);
        } else if (char === '}' && openStack.length) {
            const start = openStack.pop();
            if (!openStack.length) candidates.push(text.slice(start, i + 1));
        }
    }

    return candidates;
}

function patchFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (!('add' in payload || 'update' in payload || 'delete' in payload)) return null;
    return {
        ok: true,
        add: Array.isArray(payload.add) ? payload.add : [],
        update: Array.isArray(payload.update) ? payload.update : [],
        delete: Array.isArray(payload.delete) ? payload.delete.map(String) : [],
    };
}

/* v0.5.2: absent or null patch arrays are common model behavior (empty
 * fields omitted from the envelope) — they coerce to []. Genuinely
 * wrong-typed values (object/string/number) still reject. */
function typedPatchArray(payload, field) {
    const value = payload[field];
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null) return [];
    return null;
}

/* Protocol 2 structural check — STRICT: a wrong-typed field is an error,
 * never a coercion (plan §B2.1). Returns { ok, batchId, outcome, patch,
 * error } — on failure `reason` explains the first violation. */
function protocol2FromPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { ok: false, reason: 'protocol 2: payload is not an object' };
    }
    if (Number(payload.protocol) !== 2) {
        return { ok: false, reason: 'protocol 2: "protocol" must be 2' };
    }
    const batchId = String(payload.batchId ?? '');
    if (!batchId.trim()) {
        return { ok: false, reason: 'protocol 2: "batchId" is required' };
    }
    const outcome = payload.outcome;
    if (outcome !== 'changed' && outcome !== 'no_change') {
        return { ok: false, reason: 'protocol 2: "outcome" must be "changed" or "no_change"' };
    }
    const addList = typedPatchArray(payload, 'add');
    const updateList = typedPatchArray(payload, 'update');
    const deleteList = typedPatchArray(payload, 'delete');
    if (addList === null || updateList === null || deleteList === null) {
        return { ok: false, reason: 'protocol 2: "add"/"update"/"delete" must be arrays' };
    }
    if (outcome === 'no_change' && (addList.length || updateList.length || deleteList.length)) {
        return { ok: false, reason: 'protocol 2: outcome "no_change" requires all arrays empty' };
    }
    for (let i = 0; i < addList.length; i++) {
        const add = addList[i];
        if (!add || typeof add !== 'object' || Array.isArray(add)) return { ok: false, reason: `protocol 2: add[${i}] is not an object` };
        if (typeof add.text !== 'string' || !add.text.trim()) return { ok: false, reason: `protocol 2: add[${i}].text must be a non-empty string` };
        if (add.entities !== undefined && !Array.isArray(add.entities)) return { ok: false, reason: `protocol 2: add[${i}].entities must be an array` };
        if (add.importance !== undefined && !Number.isFinite(Number(add.importance))) return { ok: false, reason: `protocol 2: add[${i}].importance must be a number` };
    }
    for (let i = 0; i < updateList.length; i++) {
        const upd = updateList[i];
        if (!upd || typeof upd !== 'object' || Array.isArray(upd)) return { ok: false, reason: `protocol 2: update[${i}] is not an object` };
        if (typeof upd.id !== 'string' || !upd.id.trim()) return { ok: false, reason: `protocol 2: update[${i}].id must be a non-empty string` };
        if (upd.text !== undefined && typeof upd.text !== 'string') return { ok: false, reason: `protocol 2: update[${i}].text must be a string` };
    }
    for (let i = 0; i < deleteList.length; i++) {
        if (typeof deleteList[i] !== 'string') return { ok: false, reason: `protocol 2: delete[${i}] must be a string id` };
    }
    /* v0.6.0 (S8b/F10): OPTIONAL schedule ops — absent/null ⇒ [] (same
       leniency as the patch arrays), wrong-typed ⇒ reject (same lesson). The
       runner decides whether to EXECUTE them (scheduleAuto.enabled). */
    const scheduleAddList = typedPatchArray(payload, 'schedule_add');
    const scheduleResolveList = typedPatchArray(payload, 'schedule_resolve');
    if (scheduleAddList === null || scheduleResolveList === null) {
        return { ok: false, reason: 'protocol 2: "schedule_add"/"schedule_resolve" must be arrays when present' };
    }
    const clockPayload = payload.clock;
    if (clockPayload !== undefined && clockPayload !== null && (typeof clockPayload !== 'object' || Array.isArray(clockPayload))) {
        return { ok: false, reason: 'protocol 2: "clock" must be an object when present' };
    }
    if (clockPayload && clockPayload.day !== undefined && !Number.isFinite(Number(clockPayload.day))) {
        return { ok: false, reason: 'protocol 2: "clock.day" must be a number' };
    }
    for (let i = 0; i < scheduleAddList.length; i++) {
        const item = scheduleAddList[i];
        if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, reason: `protocol 2: schedule_add[${i}] is not an object` };
        if (typeof item.text !== 'string' || !item.text.trim()) return { ok: false, reason: `protocol 2: schedule_add[${i}].text must be a non-empty string` };
        const when = item.when;
        if (!when || typeof when !== 'object' || Array.isArray(when)) return { ok: false, reason: `protocol 2: schedule_add[${i}].when must be an object` };
        if (when.mode !== 'after' && when.mode !== 'story_day') return { ok: false, reason: `protocol 2: schedule_add[${i}].when.mode must be "after" or "story_day"` };
        if (when.mode === 'after' && !Number.isFinite(Number(when.in))) return { ok: false, reason: `protocol 2: schedule_add[${i}].when.in must be a number` };
        if (when.mode === 'story_day' && !Number.isFinite(Number(when.storyDay))) return { ok: false, reason: `protocol 2: schedule_add[${i}].when.storyDay must be a number` };
        if (item.label !== undefined && item.label !== null && typeof item.label !== 'string') return { ok: false, reason: `protocol 2: schedule_add[${i}].label must be a string` };
        if (item.entities !== undefined && !Array.isArray(item.entities)) return { ok: false, reason: `protocol 2: schedule_add[${i}].entities must be an array` };
        if (item.lead !== undefined && item.lead !== null && !Number.isFinite(Number(item.lead))) return { ok: false, reason: `protocol 2: schedule_add[${i}].lead must be a number` };
    }
    for (let i = 0; i < scheduleResolveList.length; i++) {
        if (typeof scheduleResolveList[i] !== 'string') return { ok: false, reason: `protocol 2: schedule_resolve[${i}] must be a string id` };
    }
        /* v0.6.0 (S8b): schedule ops ride the parse result; execution is
           gated by scheduleAuto.enabled in the runner. review-fix (B): a
           null/absent clock day normalizes to null (never {day:0}). */
        const rawClockDay = clockPayload ? clockPayload.day : undefined;
        const clockDay = (rawClockDay === null || rawClockDay === undefined) ? null : Number(rawClockDay);
        return {
            ok: true,
            protocol: 2,
            batchId,
            outcome,
            patch: { add: addList, update: updateList, delete: deleteList.map(String) },
            scheduleAdd: scheduleAddList,
            scheduleResolve: scheduleResolveList.map(String),
            clock: clockDay !== null && Number.isFinite(clockDay) ? { day: clockDay } : null,
        };
    }

/**
 * Parses the optimizer output.
 * - Protocol 2 (payload has `"protocol":2`): strict envelope — batchId echo,
 *   outcome, typed arrays; any violation rejects the WHOLE patch.
 * - Legacy (schema valid but no envelope): tolerant v0.4.1 coercion kept;
 *   empty arrays are a valid no_change (runner decides the outcome).
 * - Parse failure stays a failure — never mapped onto a patch.
 * Returns { ok, protocol: 2|'legacy'|null, batchId, outcome, patch,
 *           diagnostics: [], error? }.
 */
export function parseOptimizerResponse(text, { batchId: expectedBatchId = null } = {}) {
    const raw = String(text ?? '');
    const candidates = [];
    const blockCandidates = new Set();

    /* v0.6.5: EVERY closed block (models often echo the prompt's template
       block before the real one). */
    for (const block of raw.matchAll(/<\s*MEMORY[_-]?UPDATE\s*>([\s\S]*?)<\s*\/\s*MEMORY[_-]?UPDATE\s*>/gi)) {
        candidates.push(block[1]);
        blockCandidates.add(candidates.length - 1);
    }

    /* Truncated output: opening tag present, closing tag lost to max tokens.
       A complete JSON payload is still usable. The LAST open tag is the
       truncated one (earlier ones are closed blocks above). */
    const openTags = [...raw.matchAll(/<\s*MEMORY[_-]?UPDATE\s*>/gi)];
    if (openTags.length) {
        const lastOpen = openTags[openTags.length - 1];
        const tail = raw.slice(lastOpen.index + lastOpen[0].length);
        if (!/<\s*\/\s*MEMORY[_-]?UPDATE\s*>/i.test(tail)) {
            candidates.push(tail);
            blockCandidates.add(candidates.length - 1);
        }
    }

    candidates.push(...collectJsonCandidates(raw));

    /* v0.6.5: with an expected batch id, a protocol-2 candidate that ECHOES it
       is preferred over earlier candidates (template echo first, real block
       second). Stable otherwise. */
    const parsedCandidates = candidates.map((candidate, index) => {
        const errorSink = { message: '' };
        const payload = tryParseJsonObject(candidate, errorSink);
        return { index, payload, parseError: errorSink.message, isBlock: blockCandidates.has(index) };
    });
    const expected = expectedBatchId ? String(expectedBatchId) : '';
    const ordered = expected
        ? [
            ...parsedCandidates.filter(item => item.payload && Number(item.payload.protocol) === 2 && String(item.payload.batchId ?? '') === expected),
            ...parsedCandidates.filter(item => !(item.payload && Number(item.payload.protocol) === 2 && String(item.payload.batchId ?? '') === expected)),
        ]
        : parsedCandidates;

    const diagnostics = [];
    let lastReason = null;
    let blockParseError = null;
    for (const { payload, parseError, isBlock } of ordered) {
        if (!payload) {
            diagnostics.push('candidate was not parseable JSON');
            if (isBlock && blockParseError === null) blockParseError = parseError || 'not a JSON object';
            continue;
        }
        /* Protocol 2 responses are recognized even inside a legacy-shaped
           wrapper: the envelope field decides. */
        if (Number(payload.protocol) === 2) {
            const strict = protocol2FromPayload(payload);
            if (!strict.ok) {
                diagnostics.push(strict.reason);
                lastReason = strict.reason;
                continue;
            }
            return {
                ok: true,
                protocol: 2,
                batchId: strict.batchId,
                outcome: strict.outcome,
                patch: strict.patch,
                scheduleAdd: strict.scheduleAdd,
                scheduleResolve: strict.scheduleResolve,
                clock: strict.clock,
                diagnostics,
            };
        }
        const patch = patchFromPayload(payload);
        if (patch) {
            diagnostics.push('protocol: legacy (no protocol-2 envelope)');
            return {
                ok: true,
                protocol: 'legacy',
                batchId: typeof payload.batchId === 'string' ? payload.batchId : null,
                outcome: null,
                patch: { add: patch.add, update: patch.update, delete: patch.delete },
                scheduleAdd: [],
                scheduleResolve: [],
                clock: null,
                diagnostics,
            };
        }
        diagnostics.push('candidate had no add/update/delete keys');
    }

    /* A protocol-2 rejection is more specific than "no block found"; a block
       that exists but holds broken JSON reports the JSON error (v0.6.5). */
    const error = lastReason
        ?? (blockParseError !== null ? `invalid JSON in <MEMORY_UPDATE> block: ${blockParseError}` : 'missing <MEMORY_UPDATE> block');
    return { ok: false, protocol: null, batchId: null, outcome: null, patch: null, scheduleAdd: [], scheduleResolve: [], clock: null, diagnostics, error };
}

/* =========================================================================
 * v0.9 — Story chapters ("Tóm tắt truyện"): one AI call summarizes ONE
 * processed raw range into a faithful narrative chapter.
 * ========================================================================= */

export const CHAPTER_SUMMARY_LIMIT = 1200;
export const CHAPTER_TITLE_LIMIT = 80;
const CHAPTER_INPUT_BUDGET = { default: 12000, min: 2000, max: 32000 };
/* Share of the message budget used for the head / the tail when a chapter
   range does not fit verbatim (the middle is covered by the memories). */
const CHAPTER_HEAD_SHARE = 0.45;
const CHAPTER_TAIL_SHARE = 0.45;

export const DEFAULT_CHAPTER_SYSTEM = [
    'You are the chronicler of an interactive story chat. You write the summary of ONE chapter (a fixed range of messages) for the long-term "story so far" record.',
    'Rules:',
    '- Write a faithful narrative of what actually happened in THIS range: who did what, where it happened, how relationships changed, promises and deals that were made, secrets that came out, conflicts, and the threads still open at the end of the chapter.',
    '- Never invent, guess or embellish. Only state what the messages (or the memories extracted from them) say. If something is unclear, leave it out.',
    '- Write in the same language as the conversation (Vietnamese if the chat is in Vietnamese). Third person, past tense, plain prose — no lists, no markdown, no commentary about the writing.',
    `- "summary" must be at most ${CHAPTER_SUMMARY_LIMIT} characters; "title" is a short chapter name of at most ${CHAPTER_TITLE_LIMIT} characters.`,
    '- Use the canonical character names exactly as they appear in the messages. "USER" in the memories is the player character.',
    '- Continue coherently from the previous chapters when they are given, but do not repeat them.',
    'Reply with EXACTLY ONE <CHAPTER> block and nothing else. The block contains valid JSON with this exact shape:',
    '<CHAPTER>{"batchId":"<copy the batch id given below>","title":"short chapter name","summary":"the narrative summary"}</CHAPTER>',
    '- "batchId" MUST be the exact batch id given in the task — a wrong or missing batch id invalidates the chapter.',
    'No code fences, no explanation.',
].join('\n');

function chapterMessageLine(item) {
    if (typeof item === 'string') return item.trim();
    const name = String(item?.name ?? '').trim();
    const text = String(item?.text ?? '').trim();
    return name ? `${name}: ${text}` : text;
}

/* ×2 the optimizer input budget (token cost is not a concern for chapters),
   same chars/4 + 15% margin convention as the planner estimate. */
export function chapterBudgetChars(settings = {}) {
    const raw = Math.round(Number(settings?.optimizerInputBudgetTokens));
    const tokens = Number.isFinite(raw)
        ? Math.min(CHAPTER_INPUT_BUDGET.max, Math.max(CHAPTER_INPUT_BUDGET.min, raw))
        : CHAPTER_INPUT_BUDGET.default;
    return Math.floor((tokens * 2 * 4) / 1.15);
}

/* Fits the range's message lines into the char budget: everything verbatim
 * when it fits, else the first and the last parts (45% / 45%) around an
 * omission marker. Returns { lines, omitted, total }. */
export function fitChapterMessages(messages, maxChars) {
    const lines = (Array.isArray(messages) ? messages : []).map(chapterMessageLine).filter(Boolean);
    const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
    if (total <= maxChars) return { lines, omitted: 0, total: lines.length };
    const headBudget = Math.floor(maxChars * CHAPTER_HEAD_SHARE);
    const tailBudget = Math.floor(maxChars * CHAPTER_TAIL_SHARE);
    const head = [];
    let used = 0;
    for (const line of lines) {
        if (used + line.length + 1 > headBudget) break;
        head.push(line);
        used += line.length + 1;
    }
    const tail = [];
    used = 0;
    for (let i = lines.length - 1; i >= head.length; i--) {
        if (used + lines[i].length + 1 > tailBudget) break;
        tail.unshift(lines[i]);
        used += lines[i].length + 1;
    }
    const omitted = lines.length - head.length - tail.length;
    return {
        lines: [...head, `[… ${omitted} messages in the middle are omitted here — the memories above cover them …]`, ...tail],
        omitted,
        total: lines.length,
    };
}

/* Prompt for one chapter. `messages` = canonical source texts of the range
 * ({name, text} or plain strings, oldest first); `memories` = entries whose
 * provenance falls in the range; `previousChapters` = the chapters before
 * this one (the last 2 are shown for continuity). Returns { system, user }. */
export function buildChapterPrompt({ messages = [], memories = [], previousChapters = [], settings = {}, batchId = '', chapterNumber = 1 } = {}) {
    const fitted = fitChapterMessages(messages, chapterBudgetChars(settings));
    const memoryLines = [...(Array.isArray(memories) ? memories : [])]
        .filter(entry => entry && String(entry.text ?? '').trim())
        .sort((a, b) => String(a?.createdAt ?? '').localeCompare(String(b?.createdAt ?? '')))
        .map(entry => `- [${(Array.isArray(entry.entities) ? entry.entities : []).join(', ')}] (importance ${entry.importance ?? 2}) ${String(entry.text).trim()}`);
    const previous = (Array.isArray(previousChapters) ? previousChapters : [])
        .filter(item => item && String(item.summary ?? '').trim())
        .slice(-2);
    const number = Math.max(1, Math.floor(Number(chapterNumber) || 1));
    const previousLines = previous.map((item, i) => {
        const n = Math.max(1, number - previous.length + i);
        const title = String(item.title ?? '').trim();
        return `- Ch.${n}${title ? ` (${title})` : ''}: ${String(item.summary).trim()}`;
    });

    const user = [
        ...(previousLines.length ? ['## Previous chapters (context only — do not repeat them)', ...previousLines, ''] : []),
        '## Memories extracted from this chapter\'s messages',
        memoryLines.length ? memoryLines.join('\n') : '(none)',
        '',
        `## Messages of chapter ${number} (oldest first)`,
        fitted.lines.length ? fitted.lines.join('\n') : '(no messages)',
        '',
        '## Task',
        `Batch id (echo it back EXACTLY in "batchId"): ${batchId}`,
        `Write chapter ${number}: a faithful narrative summary of the messages above (at most ${CHAPTER_SUMMARY_LIMIT} characters) and a short title (at most ${CHAPTER_TITLE_LIMIT} characters).`,
        ...(fitted.omitted > 0
            ? [`Note: this chapter has ${fitted.total} messages — too long to show in full. The first and the last messages are shown verbatim; ${fitted.omitted} messages in the middle are omitted and are represented ONLY by the memories list. Do not guess about the omitted part beyond what the memories state.`]
            : []),
        'Cover: who/what/where, relationship changes, promises and deals, secrets revealed, and the open threads at the end. Never invent anything.',
        'Output format (strict, single block, no markdown fences, no other text):',
        '<CHAPTER>{"batchId":"<the batch id above>","title":"…","summary":"…"}</CHAPTER>',
    ].join('\n');

    return { system: DEFAULT_CHAPTER_SYSTEM, user };
}

function truncateSummary(text, limit = CHAPTER_SUMMARY_LIMIT) {
    const clean = String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
    if (clean.length <= limit) return clean;
    const slice = clean.slice(0, limit - 1);
    const sentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
    if (sentence > limit * 0.6) return slice.slice(0, sentence + 1).trim();
    const space = slice.lastIndexOf(' ');
    return `${(space > limit * 0.6 ? slice.slice(0, space) : slice).trim()}…`;
}

/* Strict chapter parser (JSON.parse only). Candidates: every closed
 * <CHAPTER> block, an unterminated last block, then fenced/balanced JSON
 * objects; a candidate echoing the expected batchId is preferred, and with
 * an expected batchId a non-echoing candidate is rejected. Returns
 * `{ ok, title, summary, error }` — summary ≤1200 chars (cut at a sentence
 * or word boundary), title ≤80. */
export function parseChapterResponse(text, { batchId: expectedBatchId = null } = {}) {
    const raw = String(text ?? '');
    const candidates = [];
    for (const block of raw.matchAll(/<\s*CHAPTER\s*>([\s\S]*?)<\s*\/\s*CHAPTER\s*>/gi)) candidates.push(block[1]);
    const openTags = [...raw.matchAll(/<\s*CHAPTER\s*>/gi)];
    if (openTags.length) {
        const lastOpen = openTags[openTags.length - 1];
        const tail = raw.slice(lastOpen.index + lastOpen[0].length);
        if (!/<\s*\/\s*CHAPTER\s*>/i.test(tail)) candidates.push(tail);
    }
    candidates.push(...collectJsonCandidates(raw));

    const expected = expectedBatchId ? String(expectedBatchId) : '';
    const parsed = candidates.map(candidate => {
        const sink = { message: '' };
        return { payload: tryParseJsonObject(candidate, sink), parseError: sink.message };
    });
    const echoes = item => item.payload && String(item.payload.batchId ?? '') === expected;
    const ordered = expected ? [...parsed.filter(echoes), ...parsed.filter(item => !echoes(item))] : parsed;

    let lastReason = null;
    for (const { payload, parseError } of ordered) {
        if (!payload) {
            if (lastReason === null && parseError) lastReason = `invalid JSON in <CHAPTER> block: ${parseError}`;
            continue;
        }
        if (!('summary' in payload)) { lastReason = lastReason ?? 'chapter: "summary" is required'; continue; }
        if (expected && String(payload.batchId ?? '') !== expected) { lastReason = 'chapter: batch id mismatch'; continue; }
        if (typeof payload.summary !== 'string' || !payload.summary.trim()) { lastReason = 'chapter: "summary" must be a non-empty string'; continue; }
        if (payload.title !== undefined && payload.title !== null && typeof payload.title !== 'string') { lastReason = 'chapter: "title" must be a string'; continue; }
        return {
            ok: true,
            title: String(payload.title ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, CHAPTER_TITLE_LIMIT),
            summary: truncateSummary(payload.summary),
            error: null,
        };
    }
    return { ok: false, title: '', summary: '', error: lastReason ?? 'missing <CHAPTER> block' };
}

/* =========================================================================
 * v0.9 — Consolidation pass ("AI gộp & dọn memory"): the model reviews
 * EXISTING memories and returns a protocol-2 envelope with update/delete
 * only (any add invalidates the patch — enforced by the runner).
 * ========================================================================= */

export const CONSOLIDATION_BATCH_MAX = 80;

export const DEFAULT_CONSOLIDATION_SYSTEM = [
    'You are the memory curator for an interactive story chat. You review an EXISTING list of memory entries and clean it up. You do not see the chat — work only from the listed memories.',
    'Do these, in order:',
    '1. Merge duplicates and paraphrases: keep ONE entry (update its text to the best complete wording that combines what the duplicates say, under 200 characters) and delete the others.',
    '2. Resolve superseded facts: when a newer memory replaces an older state (location, status, possession, plan, relationship), update or delete the stale one so only the current truth remains — keep the history only when it matters (e.g. "former enemies, now allies").',
    '3. Drop transient trivia (mood or stat numbers like "Mood 70→78", "Cảnh hiện tại…"/"current scene…" snapshots, one-off small talk) unless it still matters for the story.',
    '4. Normalize entity names to ONE canonical spelling (the fullest / most frequent form) — both in "entities" and in the text.',
    '5. Recalibrate importance with the rubric below; at most about 20% of the entries may be core (3).',
    IMPORTANCE_RUBRIC,
    'Hard rules:',
    '- NEVER invent facts. A merged or rewritten text may only contain what the listed memories already state.',
    '- NEVER "add": this pass only updates and deletes existing ids. Any "add" item invalidates the whole patch.',
    '- Entries under "Read-only context" are user-locked: never update or delete them (you MAY delete other entries that merely duplicate them).',
    '- When in doubt, leave an entry unchanged. If the list is already clean, reply with outcome "no_change" and empty arrays.',
    '- Write in the same language as the memories.',
    'Reply with EXACTLY ONE <MEMORY_UPDATE> block and nothing else. The block contains valid JSON with this exact shape:',
    '<MEMORY_UPDATE>{"protocol":2,"batchId":"<copy the batch id given below>","outcome":"changed|no_change","add":[],"update":[{"id":"1a2b3c4d","text":"merged canonical text","entities":["Alice"],"importance":2}],"delete":["deadbeef"]}</MEMORY_UPDATE>',
    '- "update" items need "id" plus any of "text", "entities" (the full new tag list) and "importance".',
    '- "batchId" MUST be the exact batch id given in the task — a wrong or missing batch id invalidates the whole patch.',
    'No markdown, no code fences, no explanation.',
].join('\n');

/* Builds the consolidation prompt for one batch. `entries` = the batch:
 * editable entries plus (optionally) locked/pinned ones, which are rendered
 * as READ-ONLY context WITHOUT ids and never appear in includedIds.
 * Optional `chapters` adds the "Story so far" section (superseded-fact
 * context). `settings` is accepted for signature symmetry. Returns
 * { system, user, includedIds }. */
export function buildConsolidationPrompt({ entries = [], settings = {}, batchId = '', focusEntity = null, chapters = null } = {}) { // eslint-disable-line no-unused-vars
    const list = (Array.isArray(entries) ? entries : []).filter(entry => entry && String(entry.text ?? '').trim() && String(entry.id ?? '') !== '');
    const byAge = (a, b) => String(a?.createdAt ?? '').localeCompare(String(b?.createdAt ?? ''));
    const editable = list.filter(entry => entry.locked !== true && entry.pinned !== true).sort(byAge);
    const readOnly = list.filter(entry => entry.locked === true || entry.pinned === true).sort(byAge);
    const includedIds = editable.map(entry => String(entry.id));
    const tags = entry => (Array.isArray(entry.entities) ? entry.entities : []).join(', ');
    const core = editable.filter(entry => Number(entry.importance) >= 3).length;
    const storySoFar = buildStorySoFarSection(chapters);
    const focus = String(focusEntity ?? '').trim();

    const user = [
        ...(storySoFar ? [storySoFar, ''] : []),
        '## Memories to review (oldest first)',
        editable.length
            ? editable.map(entry => `- id:${entry.id} [${tags(entry)}] (importance ${entry.importance ?? 2}) ${String(entry.text).trim()}`).join('\n')
            : '(none)',
        ...(readOnly.length
            ? ['', '## Read-only context (user-locked — never update or delete these)', ...readOnly.map(entry => `- [${tags(entry)}] (importance ${entry.importance ?? 2}) ${String(entry.text).trim()}`)]
            : []),
        '',
        '## Task',
        `Batch id (echo it back EXACTLY in "batchId"): ${batchId}`,
        ...(focus ? [`Focus: these memories are about "${focus}" — normalize that name and merge its duplicates first.`] : []),
        `This batch: ${editable.length} editable entries, ${core} rated core (${editable.length ? Math.round((core / editable.length) * 100) : 0}%).`,
        'Merge duplicates (update the keeper + delete the rest), resolve superseded facts, drop transient trivia, normalize names, recalibrate importance. Only ids listed under "Memories to review" may be updated or deleted. Never add.',
        'Output format (strict, single block, no markdown fences, no other text). Fill it with REAL ids from the list — never copy the example verbatim:',
        '<MEMORY_UPDATE>{"protocol":2,"batchId":"<the batch id above>","outcome":"changed","add":[],"update":[{"id":"<id>","text":"…"}],"delete":["<id>"]}</MEMORY_UPDATE>',
    ].join('\n');

    return { system: DEFAULT_CONSOLIDATION_SYSTEM, user, includedIds };
}
