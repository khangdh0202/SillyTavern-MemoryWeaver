# Memory Weaver — Living Story Memory for SillyTavern

> **English** · [Tiếng Việt](README.vi.md) — Full guide: [USER_GUIDE.md](USER_GUIDE.md) · [USER_GUIDE.vi.md](USER_GUIDE.vi.md)

Memory Weaver gives your AI a **living memory of the current chat**. Every N messages, a silent AI pass compresses the recent conversation into concise memory entries; the most relevant ones are injected back into the prompt, so the AI keeps names, promises, injuries, relationships and consequences consistent — even in very long chats. Fully standalone: no other extension required.

> **Interface language:** the UI is in **English** by default and can be switched to **Tiếng Việt** (or **Auto**, which follows SillyTavern's language) with the **Language** selector at the top of Extensions → Memory Weaver. Only the UI is translated — the prompts sent to the AI are unchanged.

## What's new

**v0.9.2 — bilingual UI**
- Bilingual UI: English (default) or Tiếng Việt, plus Auto (follow SillyTavern). New **Language** setting at the top of the settings drawer; switching applies immediately. Prompts sent to the AI are not translated.

**v0.9.1 — audit fixes**
- Run undo is all-or-nothing: a whole burst (all chunks of one run) is undone together, diffs are kept for the newest 3 bursts, too-large runs are marked not undoable, and undo is refused across a memory wipe.
- The "Super Smart" preset restore asks before shrinking *max memories* below the current store size.
- Auto consolidation keeps a persisted counter and rotates through memory groups.
- Chapters: limited automatic retries per range, same-chat guard, chapters made stale by edits/deletions are flagged with **Rewrite this chapter**; at the 60-chapter cap the two oldest are merged instead of stopping.
- Retention: keeps the longer of two duplicates, never evicts both copies, stricter transient rule, ~5× faster near-duplicate scan; the scene tier is no longer starved by pins/foundation.
- UI: correct unprocessed-message snippets for NFD/Hangul text, a diagnostic hint when injection is off, word-based name-merge suggestions, IME Enter guard, mobile menu, light-theme colors.
- The generate interceptor skips the recall wait when injection is off.

**v0.9.0 — smarter memory**
- **Story chapters**: roughly every 100 memorized messages the AI writes a chapter summary; the "story so far" rides the main prompt and the optimizer prompt. New **Story** tab to edit / lock / delete / regenerate.
- **AI consolidation** (**AI merge & clean up memories**): merges paraphrases, supersedes stale facts, drops trivia, normalizes names — never adds, never touches locked/pinned entries; optional automatic cadence.
- **Per-run diffs + undo**: the Health tab shows what each recent run added/changed/deleted, with **Undo this pass**.
- **Same-turn vector recall**: before the AI replies, a bounded generate interceptor waits (default up to 1.5 s) for recall on the newest message.
- Retention v2 (duplicates and transient lines go first, foundation facts protected, importance-inflation dampening); the optimizer sees more existing memories (default 150, configurable up to 300).
- One-click **Turn on Super Smart mode** preset with **Restore previous settings**.

**v0.8.0 — "why did the AI forget?"**
- A diagnostic search in the **In prompt** tab explains, per matching memory, whether it is injected, cut by budget, filtered out or not relevant this turn (with one-click fixes), and finds facts still sitting in unprocessed messages.
- **Pin to prompt** (always injected, own quota) is now separate from **Lock** (only protects against AI edits/eviction).
- Recall packing fix (no more ~30% wasted budget); near-duplicate cleanup with one-click merge; entity rename/merge; jump to the source message; **Remember everything** drains a long backlog; per-run token estimates; default input budget 6000 → 12000.
- The send-form button shows amber **review** after history edits instead of red **error**.
- Fixes: the max-memories field evicting on a keystroke, review losing earlier dirty ranges, acknowledge marking unread messages as covered, lossy export/import, schedule undo clobbering newer changes, stale vector results for a new message.

**v0.7.0 — dashboard overhaul**
- Tabbed dashboard where the list comes first, a single scroll container and sticky tabs; the **In prompt** tab shows the exact `[Chat Memories]` block the AI sees next turn, plus an **AI sees this** mark on each row.
- Actionable alerts (retry, review edited history, skip an oversized message), 10-run history, accent-insensitive search, filter chips, bulk lock/importance/delete, a stateful send-form button, a slimmer settings drawer (memory list / export / import moved into the dashboard).
- Fixes: fresh chats stuck on "legacy unverified", long messages truncated at 1500 chars while counted as covered (removed in v0.6.5 — messages are never truncated now), one-message batches once the store passed ~100 entries, the rescan moving the cursor backwards or running concurrently, NFC/NFD Vietnamese text breaking dedupe, locked entries that could not be deleted, schedule rows lost on postpone or a lowered cap, the greeting being re-counted on every reopen.

**v0.6.0 — control & polish**
- Lock entries against AI edits and eviction; one-level undo for destructive actions; skip oversized messages; an execution line (model + duration + token estimates); markdown export/import; recall inspector + `/memories action=recall`; opt-in schedule auto-ops (OFF by default); vector indexes purged when their chat is deleted; importance rubric + recent floor.

**v0.5.0 — hardened core**
- A single mutation boundary guards every write against chat switches, mid-flight edits and clears; the optimizer reads the backlog in order (≤ 60 counted messages per chunk, ≤ 2 chunks per run by default, bounded by an estimated input budget); every patch is structurally validated and rejected atomically on conflicts; source edits below the coverage cursor mark coverage *needs review*; a corrupted chat state is never overwritten (a bounded copy is kept in `memoryWeaverState_recovery`).

---

## How it works

1. You chat normally. Every **N counted messages** (default 20 — system messages, tool calls and empty narration don't count), a silent AI pass reads the new chunk plus the existing memories and outputs a patch: **new facts are added, changed facts are rewritten, superseded ones are removed**.
2. Memories live in the **chat-local variable** `memoryWeaverState` — **per chat** by design (one character, many chats = many independent memories; not per-character, not global). It travels inside the chat file.
3. At generation time a **[Chat Memories]** block is injected under a strict token budget, together with the optional **story so far** (chapters) and **[Schedule]** blocks.
4. **Vector recall (opt-in, off by default)**: Memory Weaver keeps a per-chat embedding index on SillyTavern's built-in vector server (free local model) and pulls in older memories relevant to the current topic — a day-3 fact surfaces again on day 40.
5. In **Storyline** chats, Storyline's `memory_keeper` function projects the memories into the narrator prompt. Without Storyline everything works standalone.

## Highlights

- Silent optimizer pass every N messages — backlog processed **in order**, never truncated; a manual **Remember now** button and **Remember everything** for long backlogs
- **Tabbed dashboard** (5 tabs): Memories · In prompt · Story · Schedule · Health
- **"Does the AI remember this?"** diagnostic with one-click fixes
- **Pin vs lock**, bulk actions, entity rename/merge, near-duplicate cleanup, jump to source message
- **Story chapters**, **AI consolidation**, **undo a whole run**
- **Hybrid vector recall** per chat — same-turn injection (waits up to *recall wait*, default 1500 ms)
- **Schedule** with story-clock and message-count triggers, postpone, missed tracking, done → memory graduation
- `/memories` slash command and `MemoryWeaverAPI` v3 for other extensions

## Design principles

1. **The store is the single source of truth** — the chat-local variable. The vector index is a derived, rebuildable artifact.
2. **Deterministic before probabilistic** — the canon block is always present and bounded; embeddings only *widen coverage*.
3. **Counted messages** — N means N real conversation messages.
4. **Retrieval-off parity** — with vector recall disabled, injection behaves exactly like the classic importance-ranked block.
5. **Independent** — no imports from other extensions; Storyline integration is Storyline-side via `MemoryWeaverAPI`.
6. **Every write is guarded** — scope, lifecycle, revision and source fingerprints are verified before any commit; conflicts reject the whole batch.
7. **Coverage is honest** — the cursor only advances inside a committed patch; source changes mark coverage *needs review*; an oversized message blocks the pass explicitly instead of being truncated.

## How it compares

- **CharMemory**: per-character, cross-chat (card + Data Bank + Vector Storage). Memory Weaver is **per-chat**; its optional vector recall indexes only the current chat's memories, and it never touches CharMemory data.
- **Character State**: runtime numbers (stats/effects). Memory Weaver stores **narrative facts** (who knows what, promises, injuries…). Different layers — they can run together.
- **World Info / lorebook-based memory extensions**: a different mechanism (keyword-triggered lore entries).

## UI overview

**Send-form button** — **🧠 Memory** next to the chat input (after the Character Sheet button when character-state is installed). The badge shows `pending/threshold` in **Automatic** mode or `N waiting` in the other modes, and switches to a state word: **ready**, **saving…**, **error**, **review**, **N due** (appointments due), **off**. Clicking opens the dashboard on the relevant tab.

**Dashboard** (button or `/memories`) — header with status, **Remember now** and a **⋯** menu (rescan the last 60 messages, AI consolidation, export / import a `.md` file, re-sync the vector index, clear the schedule, clear all memories); a slim progress bar; an alert strip with fix buttons; and 5 tabs:

| Tab | Contents |
|---|---|
| **Memories** | The list: accent-insensitive search, importance/name chips, sort, In-prompt filter, inline edit, pin / lock, multi-select bulk actions, **Add memory** |
| **In prompt** | The exact `[Chat Memories]` block the AI sees next turn + the "Does the AI remember this?" diagnostic |
| **Story** | Chapter summaries: write next / rewrite last, edit, lock, delete |
| **Schedule** | Appointments, story clock, add/postpone/done/missed |
| **Health** | Alerts, stats, 10-run history with diffs + undo, duplicate cleanup, vector status, tools (rescan, consolidate, export, import) |

**Settings** (Extensions → Memory Weaver) — the **Language** selector (English / Tiếng Việt / Auto), the Super Smart preset, **Basics**, **Features** and a collapsed **Advanced** section. See the [settings reference](USER_GUIDE.md#14-settings-reference).

## Slash commands

The action is always given with the named argument `action=` (default `view`); named arguments come **before** the free text.

```
/memories                                              — open the dashboard (= action=view)
/memories action=add entity=Alice entity=Bob importance=3 Alice knows the secret passage
/memories action=summarize                             — run the optimizer now
/memories action=recall [query]                        — show what vector recall selects (needs vector recall on)
/memories action=delete id=<id>
/memories action=clear                                 — delete all memories (keeps the schedule; asks first)
/memories action=sched_add when=after:40 lead=5 Breakfast with Alice
/memories action=sched_add when=day:13 entity=Bob Sword duel with Bob
/memories action=sched_done id=<id>                    — done (+ saved as a memory)
/memories action=sched_cancel id=<id>                  — cancel
/memories action=sched_miss id=<id>                    — mark as missed
/memories action=sched_postpone id=<id> amount=10      — postpone
/memories action=sched_clear                           — clear the whole schedule (asks first)
/memories action=clock day=13                          — set the current story day
/memories action=vindex [rebuild=true]                 — vector index status / rebuild for this chat
```

Without `entity=`, `add` tags the active character (or `USER`); default importance is 2.

## Troubleshooting

- **No memories after N messages** — check the toast and the **Health** tab run history; the Console (F12) shows `[Memory Weaver]` lines.
  - API failure (e.g. `Not Found` / HTTP 404): the ST server forwards only the upstream `statusText`; open the **ST server console** — the `Chat completion request error: ...` line shows the real status and body (for OpenRouter often "No endpoints found matching your data policy/provider preferences"). Check the model, your OpenRouter privacy/data policy, provider/quantization + "Allow fallbacks", web-search plugins and Middle-out. The cursor is kept; the next attempt runs after another N messages, or press **Remember now**.
  - `No message generated` / *The API returned an EMPTY completion*: usually a reasoning model that spent its whole 4096-token completion budget thinking. Memory Weaver does **not** change your Reasoning Effort (since v0.5.0) — lower it yourself or switch model/provider.
  - `Optimizer output rejected: ... Raw (first 800 chars): ...`: the model used the wrong format. Try another model or add guidance in the custom optimizer system prompt.
  - An empty-but-valid patch ("Nothing new to save") is not an error: the cursor advances.
- **Auto doesn't run** — mode must be **Automatic** and the extension enabled; the Console shows `Auto optimization queued: ...`. After a failure the next try waits for N new messages.
- **Blocked by one oversized message** — click the toast or **Skip this message** on the alert; it never blocks again and rejoins if it gets shorter.
- **The AI still forgets** — open the **In prompt** tab and use **Does the AI remember this?**; pin the fact, raise it to Core, raise the budget, or enable vector recall. In Storyline chats, check that **Memory Keeper** is enabled.
- **🔒 locked entries** — the AI cannot edit/delete them and retention never evicts them; the status line reports skipped operations on locked entries.

## Storage & privacy

- Data lives in the chat's own local variable `memoryWeaverState` (`/getvar key=memoryWeaverState`). Exporting/importing the chat carries the memories.
- The vector index (when enabled) is derived data on the ST machine (`data/<user>/vectors/`); with the default local model, memory text never leaves your machine.
- Nothing is sent anywhere except to your configured LLM API when a memory / chapter / consolidation pass runs (and to a cloud embedding provider only if you select one).

## Compatibility

- SillyTavern **1.18.0** or newer
- Chat Completion and Text Completion APIs
- Standalone; inside **Storyline** chats via the `memory_keeper` function (Storyline ≥ 0.1.20 for the vector-recall path, which waits up to 400 ms — `retrieval.waitBudgetMs`)
- Vector recall needs nothing external — ST's server-side local embedding model (downloaded once).

## Installation

1. SillyTavern top bar → **Extensions** (puzzle icon)
2. **Install extension** → paste `https://github.com/khangdh0202/SillyTavern-MemoryWeaver` → **Install just for me**
3. Open any chat — the **🧠 Memory** button appears next to the send form.

Installing from the Git URL creates the folder `data/<user>/extensions/SillyTavern-MemoryWeaver/`; a manual copy can use any folder name. No API keys beyond your usual chat LLM. Vector recall is optional and off by default.

## Documentation

| Document | Language | Contents |
|---|---|---|
| [USER_GUIDE.md](USER_GUIDE.md) | English | Full walkthrough: dashboard, schedule, chapters, vector recall, slash commands, settings, troubleshooting |
| [USER_GUIDE.vi.md](USER_GUIDE.vi.md) | Tiếng Việt | Hướng dẫn sử dụng đầy đủ |
| [README.vi.md](README.vi.md) | Tiếng Việt | Tổng quan |

## 🐞 Bug reports & help

Found a bug or have a question? Open an issue on **[GitHub Issues](https://github.com/khangdh0202/SillyTavern-MemoryWeaver/issues/new/choose)** and pick *Bug report* or *Question / idea* — the form asks for everything needed.

A good bug report includes:

- your SillyTavern version and Memory Weaver version (Extensions panel → Manage extensions)
- the API / model you use
- steps to reproduce: what you did, what you expected, what happened instead
- errors from the browser console (F12 → Console), if any — copy the red lines
- a screenshot when something looks wrong

Remove private story content and API keys before posting — issues are public.

## ❤️ Support

If Memory Weaver improves your sessions, consider supporting the project:

[![Ko-fi](https://img.shields.io/badge/Support%20on-Ko--fi-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/kdturtle)

or click the **💜 Sponsor** button at the top of this repository. Starring the repo, reporting bugs with logs and sharing ideas help too — see [DONATE.md](DONATE.md).

## License

Released under the [GNU General Public License v3.0 (GPL-3.0)](LICENSE) — free to use, modify and redistribute; any fork or redistribution must stay open-source under the same license. © 2026 kdturtle.
