/* Memory Weaver — Copyright (C) 2026 kdturtle — GPL-3.0, see LICENSE. */
/* Vector recall core — PURE. No ST imports, no DOM, no network.
 *
 * Frozen P2 semantics (see AGENTS.md):
 * - The chat-local store stays the single source of truth. The vector index
 *   on ST's /api/vector/* server is a DERIVED, rebuildable artifact.
 * - Server hashes are NUMERIC (32-bit). Entry ids are strings, so each entry
 *   gets a stable numeric hash of its id; collisions are resolved by salting
 *   and detected before any server write.
 * - A document version is the digest of its canonical index text: changing
 *   text/entities creates a new document version (delete + re-insert);
 *   changing importance does NOT re-embed, it only re-ranks.
 * - Everything here is deterministic: same inputs, same outputs, same order.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a32(str, seed = FNV_OFFSET) {
    let hash = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
    return hash >>> 0;
}

/* Short stable hex hash for derived identifiers (collection names, stamps). */
export function shortHash(str) {
    return fnv1a32(String(str ?? '')).toString(16).padStart(8, '0');
}

/* Word-boundary mention test against a recent-text blob. Unicode-aware
   (\p{L}) so Vietnamese/diacritic names match exactly; names shorter than 2
   chars and the literal player token are never "mentioned". */
export function createMentionTest(recentText) {
    /* v0.6.5: NFC on both sides (Unikey "tổ hợp" = NFD) and combining marks
       (\p{M}) count as word characters — "Ha" must never match inside "Hà". */
    const blob = String(recentText ?? '').normalize('NFC');
    const cache = new Map();
    return entity => {
        const name = String(entity ?? '').normalize('NFC').trim();
        if (name.length < 2 || name.toLowerCase() === 'user') return false;
        const key = name.toLowerCase();
        if (cache.has(key)) return cache.get(key);
        let hit = false;
        try {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            hit = new RegExp(`(?<![\\p{L}\\p{M}])${escaped}(?![\\p{L}\\p{M}])`, 'iu').test(blob);
        } catch {
            hit = blob.toLowerCase().includes(key);
        }
        cache.set(key, hit);
        return hit;
    };
}

/* 64-bit-equivalent change detector: two fnv1a variants concatenated.
   Collisions that matter (edit undetected) drop to ~1e-14 for chat scale. */
export function payloadDigest(text) {
    const a = fnv1a32(String(text ?? ''), FNV_OFFSET).toString(16).padStart(8, '0');
    const b = fnv1a32(String(text ?? ''), 0xdeadbeef).toString(16).padStart(8, '0');
    return a + b;
}

/* Canonical text that gets embedded for an entry. The digest of THIS text is
   the document version — importance/createdAt are deliberately excluded so
   re-ranking never triggers a paid re-embed. */
export function canonicalIndexText(entry) {
    const entities = Array.isArray(entry?.entities) ? entry.entities.join(', ') : '';
    return `${entities}\n${String(entry?.text ?? '')}`.trim();
}

/* Stable numeric (uint32) hash per entry id. Collisions across the whole
   id set are resolved by salting (id#1, id#2 …) BEFORE anything is sent to
   the server — the server cannot dedupe (it upserts blind). */
export function assignNumericHashes(ids) {
    const assigned = {};
    const used = new Set();
    for (const id of ids) {
        const base = String(id ?? '');
        let hash = fnv1a32(base);
        let salt = 0;
        while (used.has(hash)) {
            salt += 1;
            hash = fnv1a32(`${base}#${salt}`);
        }
        used.add(hash);
        assigned[base] = hash;
    }
    return assigned;
}

/* Desired documents for a store snapshot: entryId → { hash, digest }. */
export function computeDesiredDocuments(entries) {
    const ids = (Array.isArray(entries) ? entries : []).map(entry => String(entry?.id ?? '')).filter(Boolean);
    const hashes = assignNumericHashes(ids);
    const documents = {};
    for (const entry of Array.isArray(entries) ? entries : []) {
        const id = String(entry?.id ?? '');
        if (!id) continue;
        const indexText = canonicalIndexText(entry);
        documents[id] = { hash: hashes[id], digest: payloadDigest(indexText) };
    }
    return documents;
}

/* Diff desired vs server reality (+ last-verified manifest for content
   versions the server cannot know — it only stores hashes).
   Returns ids to insert, numeric hashes to delete, and the NEXT verified
   manifest (only successfully synced documents may be committed by caller). */
export function diffDocuments({ serverHashes = [], desired = {}, previous = {} } = {}) {
    const serverSet = new Set((Array.isArray(serverHashes) ? serverHashes : []).map(Number));
    const claimed = new Set(Object.values(desired).map(doc => doc.hash));
    const toInsert = [];
    const toDelete = [];
    const next = {};
    for (const [id, doc] of Object.entries(desired)) {
        const onServer = serverSet.has(doc.hash);
        const previousDoc = previous?.[id];
        /* v0.6.5: verified ONLY when the manifest recorded THIS hash for this
           id. After a collision-salt reshuffle (base holder deleted, salted
           entry moves to the unsalted hash) the server copy under doc.hash
           belongs to a different entry — delete + re-insert. */
        if (onServer && Number(previousDoc?.hash) === doc.hash && previousDoc?.digest === doc.digest) {
            next[id] = { hash: doc.hash, digest: doc.digest };
            continue;
        }
        toInsert.push(id);
        if (onServer) toDelete.push(doc.hash);
        /* Not marked verified here: the caller commits only after the server
           acknowledged the insert. */
    }
    for (const hash of serverSet) {
        if (!claimed.has(hash)) toDelete.push(hash);
    }
    return { toInsert, toDelete, next };
}

/* Query text for the recall search: the newest USER message leads (it is the
   topic), earlier counted messages pad the context, newest first.
   v0.8: ASSISTANT messages drop their leading "Key: value" header lines
   (status blocks such as "Location: …", "Time: …", "Trang phục …:") and are
   sliced from the END — the scene's latest beat sits at the bottom of a long
   RP reply, the boilerplate at the top. User messages keep the head slice. */
const HEADER_LINE = /^[\p{L}\p{M}\p{N} ()/'’.,&+-]{1,40}:(?:\s.{0,160})?$/u;

function isHeaderLine(line) {
    const bare = String(line ?? '').trim()
        .replace(/^[>#\-•\s]+/, '')
        .replace(/[*_`]+/g, '')
        .replace(/^\[(.*)\]$/, '$1')
        .trim();
    if (!bare || bare.length > 200) return false;
    return HEADER_LINE.test(bare);
}

export function stripLeadingHeaderLines(text) {
    const source = String(text ?? '');
    const lines = source.split(/\r?\n/);
    let i = 0;
    while (i < lines.length && (lines[i].trim() === '' || isHeaderLine(lines[i]))) i++;
    if (i === 0) return source.trim();
    /* Nothing but headers: keep the original (better than an empty query). */
    if (i >= lines.length) return source.trim();
    return lines.slice(i).join('\n').trim();
}

export function buildQueryText(orderedTexts, { maxChars = 1200, userReserve = 0.4 } = {}) {
    const source = Array.isArray(orderedTexts) ? orderedTexts : [];
    const items = source
        .map(item => {
            const fromEnd = item?.role === 'assistant';
            const raw = String(item?.text ?? '').trim();
            return { role: item?.role, fromEnd, text: fromEnd ? stripLeadingHeaderLines(raw) : raw };
        })
        .filter(item => item.text);
    if (!items.length) return '';

    const budget = Math.max(1, Math.floor(Number(maxChars) || 1200));
    const parts = [];
    let used = 0;

    /* Newest user message gets a reserved slice, however long the rest is.
       Separator newlines count toward the budget. */
    let userIndex = -1;
    for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].role === 'user') { userIndex = i; break; }
    }
    const addSlice = (item, room) => {
        const sep = parts.length ? 1 : 0;
        const size = Math.max(1, room - sep);
        const slice = item.fromEnd ? item.text.slice(-size).trimStart() : item.text.slice(0, size);
        if (!slice) return false;
        used += slice.length + sep;
        parts.push(slice);
        return used <= budget;
    };
    if (userIndex !== -1) {
        addSlice(items[userIndex], Math.max(1, Math.floor(budget * userReserve)));
    }
    for (let i = items.length - 1; i >= 0 && used < budget; i--) {
        if (i === userIndex) continue;
        if (!addSlice(items[i], budget - used)) break;
    }
    return parts.join('\n');
}

/* Hybrid tier packing (frozen P2): SCENE (union of vector + mention, ranked)
   → CORE (foundation) → RECENT (anchor). CORE owns a reserved quota slice so
   a large SCENE tier cannot starve the foundation; unused quota flows back.
   lineFormatter(entry) → string lets each profile keep its exact legacy
   formatting — this module only decides WHICH entries and in WHAT order.

   v0.6.2 (F8): optional FOUNDATION tier — the OLDEST relationship facts
   (how the characters met, who lives where). Recency-first SCENE/CORE/RECENT
   packing starved them: once the store outgrows the budget, the block only
   carries the newest plotline and the model re-derives "first meeting" beats
   (repeated "new here?" questions late in a long chat). Foundation ids come
   from the caller (oldest-first); they are packed FIRST and own a reserved
   quota slice (foundationQuotaRatio, default 0 = byte-identical legacy
   behavior for callers that do not opt in). Unused foundation quota flows to
   the later tiers as before. */
export function mergeRecall({
    entriesById = new Map(),
    budgetTokens = 1000,
    coreQuotaRatio = 0.3,
    lineFormatter = entry => String(entry?.text ?? ''),
    vectorRankedIds = [],
    mentionIds = [],
    coreCandidateIds = [],
    recentIds = [],
    foundationIds = [],
    foundationQuotaRatio = 0,
    pinnedIds = [],
    pinnedQuotaRatio = 0.35,
} = {}) {
    const pins = Array.isArray(pinnedIds) ? pinnedIds : [];
    const tierOrder = ['pinned', 'foundation', 'scene', 'core', 'recent'];
    /* Candidate lists per tier (deduped WITHIN the tier only). v0.8: an id is
       claimed when it is PACKED, not when it is listed — a line that does not
       fit its tier's quota stays available to the later tiers that also list
       it (the old "seen on assignment" rule wasted ~30% of the budget). */
    const candidates = { pinned: [], foundation: [], scene: [], core: [], recent: [] };
    const listTier = (tier, ids) => {
        const local = new Set();
        for (const id of ids) {
            if (local.has(id) || !entriesById.has(id)) continue;
            local.add(id);
            candidates[tier].push(id);
        }
    };
    listTier('pinned', pins);
    listTier('foundation', Array.isArray(foundationIds) ? foundationIds : []);
    listTier('scene', [...vectorRankedIds, ...mentionIds]);
    listTier('core', coreCandidateIds);
    listTier('recent', recentIds);

    /* estimate() returns TOKENS (chars / 4, the platform-wide approximation);
       budgetTokens is therefore a token budget, not a char budget. */
    const estimate = entry => Math.ceil(String(lineFormatter(entry) ?? '').length / 4);
    const budget = Math.max(0, Math.floor(Number(budgetTokens) || 0));
    const ratioOf = value => Math.min(1, Math.max(0, Number(value) || 0));
    const coreQuota = Math.floor(budget * ratioOf(coreQuotaRatio));
    const foundationQuota = Math.floor(budget * ratioOf(foundationQuotaRatio));
    const pinnedQuota = Math.floor(budget * ratioOf(pinnedQuotaRatio));
    /* SCENE is capped at (budget − coreQuota) so it can never starve the
       CORE tier; CORE's own quota plus whatever SCENE left unused flows to
       CORE then RECENT until the budget is spent. PINNED (v0.8, user "Ghim
       vào prompt") packs first under its own quota; FOUNDATION then gets its
       own quota slice on top of what the pins used (no pins → identical to
       the v0.6.2 absolute limit).
       v0.9.1 (audit3 #6): the SCENE limit is computed from the budget that
       REMAINS after pinned + foundation packed: usedAfterFoundation +
       (remaining − floor(remaining × coreRatio)) — 10 pins used to eat the
       scene tier's absolute slice while CORE kept its full quota. With zero
       pins/foundation usedAfterFoundation = 0 and the limit is exactly the
       legacy budget − floor(budget × coreRatio) (byte-identical). */
    const ratioCore = ratioOf(coreQuotaRatio);
    const sceneLimitFor = usedAfterFoundation => {
        const remaining = Math.max(0, budget - usedAfterFoundation);
        return Math.max(0, usedAfterFoundation + remaining - Math.floor(remaining * ratioCore));
    };

    const lines = [];
    const selected = [];
    const tierOf = {};
    const packed = new Set();
    let used = 0;
    let usedAfterPinned = 0;
    for (const tier of tierOrder) {
        if (tier === 'foundation') usedAfterPinned = used;
        let limit = budget;
        if (tier === 'pinned') limit = Math.min(budget, pinnedQuota);
        else if (tier === 'foundation') limit = Math.min(budget, usedAfterPinned + foundationQuota);
        else if (tier === 'scene') limit = sceneLimitFor(used);
        for (const id of candidates[tier]) {
            if (packed.has(id)) continue;
            const entry = entriesById.get(id);
            const tokens = estimate(entry);
            if (used + tokens > limit) continue;
            lines.push(lineFormatter(entry));
            selected.push(id);
            tierOf[id] = tier;
            packed.add(id);
            used += tokens;
        }
    }

    /* v0.8: candidates listed in some tier but never packed (quota/budget). */
    const skippedIds = [];
    const skippedSeen = new Set();
    for (const tier of tierOrder) {
        for (const id of candidates[tier]) {
            if (packed.has(id) || skippedSeen.has(id)) continue;
            skippedSeen.add(id);
            skippedIds.push(id);
        }
    }

    return {
        lines,
        ids: selected,
        tiers: {
            ...(pins.length ? { pinned: selected.filter(id => tierOf[id] === 'pinned') } : {}),
            ...(foundationIds.length ? { foundation: selected.filter(id => tierOf[id] === 'foundation') } : {}),
            scene: selected.filter(id => tierOf[id] === 'scene'),
            core: selected.filter(id => tierOf[id] === 'core'),
            recent: selected.filter(id => tierOf[id] === 'recent'),
        },
        estimatedTokens: used,
        skippedIds,
    };
}

/* v0.6.2 (F8): foundation candidate ids — the OLDEST entries tagged with the
   user persona or the character, oldest first, capped. These carry the "how it
   started" facts (first meeting, living situation, relationship frame) that
   recency-first packing starves in long chats. PURE: callers decide quotas.
   Review-round hardening: malformed rows (null/non-object, missing id) are
   skipped, and `limit: 0` means zero — only a non-finite limit falls back. */
export function foundationIdsFor(entries, { charName = '', limit = 10 } = {}) {
    const tokens = ['USER', String(charName ?? '').trim()]
        .map(name => name.toLowerCase())
        .filter(Boolean);
    if (!tokens.length) return [];
    const cap = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : 10;
    return [...(Array.isArray(entries) ? entries : [])]
        .filter(entry => entry && typeof entry === 'object' && String(entry?.id ?? '').trim() !== '')
        .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
        .filter(entry => (Array.isArray(entry.entities) ? entry.entities : []).some(name => tokens.includes(String(name).toLowerCase())))
        .slice(0, cap)
        .map(entry => String(entry.id));
}

/* v0.6.0 (F3): the "recent floor" — models that rate everything importance 2
 * used to starve the standalone/hybrid block (the gate keeps only imp≥3 /
 * persona hits). The newest `n` entries always survive the gate so the block
 * is never empty. Pure: ids in, filtered ids out (newest first by createdAt
 * DESC, id as tiebreaker). */
export function applyRecentFloor(ids, entriesById, n = 8) {
    const list = Array.isArray(ids) ? [...ids] : [];
    const floor = Math.max(0, Math.floor(Number(n)) || 0);
    if (!floor || list.length >= floor) return list;
    const map = entriesById instanceof Map ? entriesById : new Map(Object.entries(entriesById ?? {}));
    const missing = [];
    for (const entry of map.values()) {
        const id = String(entry?.id ?? '');
        if (!id || list.includes(id)) continue;
        missing.push(entry);
    }
    missing.sort((a, b) => String(b?.createdAt ?? '').localeCompare(String(a?.createdAt ?? '')) || String(b?.id ?? '').localeCompare(String(a?.id ?? '')));
    return [...list, ...missing.slice(0, floor - list.length).map(entry => String(entry.id))];
}

/* v0.6.0 (F4): near-duplicate detection for the opt-in 'near' dedupe mode.
 * Normalization: lowercase, strip punctuation, digits → '#', token set.
 * Similarity: Jaccard over the token sets (|∩| / |∪|). Pure + deterministic.
 * v0.8: + CONTAINMENT rule — |A∩B| / min(|A|,|B|) ≥ 0.9 with the shorter
 * side ≥ 6 tokens ("same fact + an aside in parentheses" is a duplicate the
 * Jaccard floor missed), entity sets must overlap when both are given, and
 * a NEGATION GUARD applies to both rules: when exactly one side carries a
 * negation token ("Rika thích mèo" / "Rika không thích mèo") it is never a
 * duplicate. */
function normalizedTokens(text) {
    return new Set(
        String(text ?? '')
            .normalize('NFC')
            .toLowerCase()
            /* v0.6.5: keep combining marks — stripping them split NFD
               diacritics into separate tokens and made "bàn"/"bán" equal. */
            .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
            .replace(/\d/g, '#')
            .split(/\s+/)
            .filter(Boolean),
    );
}

export const NEGATION_TOKENS = Object.freeze(['không', 'chưa', 'chẳng', 'chả', 'đừng', 'never', 'not', 'no']);
const NEGATION_SET = new Set(NEGATION_TOKENS);
export const CONTAINMENT_THRESHOLD = 0.9;
export const CONTAINMENT_MIN_TOKENS = 6;

function hasNegation(tokens) {
    for (const token of tokens) if (NEGATION_SET.has(token)) return true;
    return false;
}

function entityKeySet(entities) {
    if (!Array.isArray(entities) || !entities.length) return null;
    const set = new Set(entities.map(name => String(name ?? '').normalize('NFC').trim().toLowerCase()).filter(Boolean));
    return set.size ? set : null;
}

/* Prepared side: { tokens, negated, entities } — tokenized once so the O(n²)
   cluster scan does not re-tokenize every pair. */
function prepareSide(text, entities) {
    const tokens = normalizedTokens(text);
    return { tokens, negated: hasNegation(tokens), entities: entityKeySet(entities) };
}

function preparedNearDuplicate(a, b, threshold) {
    const ta = a.tokens;
    const tb = b.tokens;
    if (!ta.size || !tb.size) return false;
    if (ta.size === 1 && tb.size === 1) {
        return ta.values().next().value === tb.values().next().value; // single tokens: identical (or not)
    }
    if (a.negated !== b.negated) return false;
    let intersection = 0;
    for (const token of ta) {
        if (tb.has(token)) intersection += 1;
    }
    const union = ta.size + tb.size - intersection;
    if (!union) return false;
    if (intersection / union >= Math.min(1, Math.max(0, Number(threshold) || 0.82))) return true;
    const shorter = Math.min(ta.size, tb.size);
    if (shorter < CONTAINMENT_MIN_TOKENS) return false;
    if (intersection / shorter < CONTAINMENT_THRESHOLD) return false;
    if (a.entities && b.entities) {
        let overlap = false;
        for (const name of a.entities) if (b.entities.has(name)) { overlap = true; break; }
        if (!overlap) return false;
    }
    return true;
}

/* `options.entitiesA` / `options.entitiesB` (arrays) gate the containment
   rule: when both are non-empty they must share a tag. */
/* v0.9: prepared-side API for O(n²) scans outside this module (retention v2)
 * — same predicate as nearDuplicate, tokenized once per entry. */
export function prepareNearDuplicateSide(text, entities = null) {
    return prepareSide(text, entities);
}
export function preparedSidesNearDuplicate(a, b, threshold = 0.82) {
    return preparedNearDuplicate(a, b, threshold);
}

export function nearDuplicate(textA, textB, threshold = 0.82, { entitiesA = null, entitiesB = null } = {}) {
    return preparedNearDuplicate(prepareSide(textA, entitiesA), prepareSide(textB, entitiesB), threshold);
}

/* First entry whose text is a near-duplicate of `text` (exact mode stays the
 * caller's cheap path — this only runs when dedupeMode === 'near').
 * v0.8: `options.entities` = the candidate's tags (entity-overlap gate). */
export function findNearDuplicate(text, entries, threshold = 0.82, { entities = null } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const probe = prepareSide(text, entities);
    for (const entry of list) {
        if (!entry || typeof entry.text !== 'string') continue;
        if (preparedNearDuplicate(probe, prepareSide(entry.text, entry.entities), threshold)) return entry;
    }
    return null;
}

/* v0.8: duplicate clusters for the dashboard "gộp trùng" tool. Union-find
 * over every pair the near-duplicate predicate accepts (same rules as
 * findNearDuplicate). Returns clusters of ≥2 members:
 * `[{ ids, keepId, negationRisk }]` — ids in input order; keepId preference:
 * locked/pinned → higher importance → longer text → older createdAt → id.
 * negationRisk is true when members differ in negation presence (the guard
 * makes that impossible for direct pairs; it is reported for honesty).
 * Work is capped: only the first `maxEntries` (default 1000) valid rows are
 * scanned (O(n²) pairs — fine for the 500-entry cap). */
export function findDuplicateClusters(entries, { threshold = 0.82, maxEntries = 1000 } = {}) {
    const cap = Number.isFinite(Number(maxEntries)) ? Math.max(0, Math.floor(Number(maxEntries))) : 1000;
    const rows = (Array.isArray(entries) ? entries : [])
        .filter(entry => entry && typeof entry === 'object' && typeof entry.text === 'string' && String(entry.id ?? '') !== '')
        .slice(0, cap);
    const prepared = rows.map(entry => prepareSide(entry.text, entry.entities));
    const parent = rows.map((_, i) => i);
    const find = i => {
        while (parent[i] !== i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        return i;
    };
    for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
            if (find(i) === find(j)) continue;
            if (preparedNearDuplicate(prepared[i], prepared[j], threshold)) parent[find(j)] = find(i);
        }
    }
    const groups = new Map();
    rows.forEach((_, i) => {
        const root = find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(i);
    });
    const better = (a, b) => {
        const protectedA = a.locked === true || a.pinned === true ? 1 : 0;
        const protectedB = b.locked === true || b.pinned === true ? 1 : 0;
        if (protectedA !== protectedB) return protectedA > protectedB;
        const impA = Number(a.importance) || 0;
        const impB = Number(b.importance) || 0;
        if (impA !== impB) return impA > impB;
        if (a.text.length !== b.text.length) return a.text.length > b.text.length;
        const created = String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
        if (created !== 0) return created < 0;
        return String(a.id) < String(b.id);
    };
    const clusters = [];
    for (const members of groups.values()) {
        if (members.length < 2) continue;
        let keep = members[0];
        for (const index of members.slice(1)) if (better(rows[index], rows[keep])) keep = index;
        const negations = new Set(members.map(index => prepared[index].negated));
        clusters.push({ ids: members.map(index => String(rows[index].id)), keepId: String(rows[keep].id), negationRisk: negations.size > 1 });
    }
    return clusters;
}
