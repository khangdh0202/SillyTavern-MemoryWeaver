# Memory Weaver — User Guide

> Doc version: v0.9.2. **English** · [Tiếng Việt](USER_GUIDE.vi.md) — Quick overview: [README.md](README.md).
> The extension folder depends on how you installed it: installing from the Git URL creates `data/<user>/extensions/SillyTavern-MemoryWeaver/`; a manual copy uses whatever folder name you chose.
> The UI is in **English** by default and can be switched to **Tiếng Việt** (or **Auto**, which follows SillyTavern's language) with the **Language** selector at the top of Extensions → Memory Weaver. Only the UI is translated — the prompts sent to the AI are unchanged. This guide uses the English labels.

## Table of contents

1. [Core concepts](#1-core-concepts)
2. [Getting started](#2-getting-started)
3. [The send-form button](#3-the-send-form-button)
4. [The dashboard](#4-the-dashboard)
5. [Managing memories](#5-managing-memories)
6. ["Does the AI remember this?"](#6-does-the-ai-remember-this)
7. [Story chapters](#7-story-chapters)
8. [AI consolidation & undoing a run](#8-ai-consolidation--undoing-a-run)
9. [The schedule](#9-the-schedule)
10. [Vector recall — topic-based memory retrieval](#10-vector-recall--topic-based-memory-retrieval)
11. [How the AI updates memories](#11-how-the-ai-updates-memories)
12. [Storyline chats](#12-storyline-chats)
13. [Slash commands](#13-slash-commands)
14. [Settings reference](#14-settings-reference)
15. [Data safety & privacy](#15-data-safety--privacy)
16. [FAQ & troubleshooting](#16-faq--troubleshooting)

---

## 1. Core concepts

- **Memory** = a short established fact from the story: *"Alice knows the secret passage under the library"*, *"USER has an injured left shoulder"*, *"Day 13: breakfast date with Mai"*. Each memory has content, **entity tags** (characters/objects/places), an **importance level** (1 Normal, 2 Important, 3 Core), a creation time and its source message range.
- **Counted messages** = real conversation messages. System messages, tool calls and empty narration are **never counted** — every threshold and progress bar counts real dialogue only.
- **Cursor** = "memorized up to message X". It is an internal index; the dashboard shows it as the number of memorized messages.
- **Importance** drives prompt priority: Core (3) always comes first. When the store is full (default 150 memories, adjustable up to 500), duplicates / transient lines / low-importance old entries are evicted first; 🔒 locked and 📌 pinned memories are never evicted.
- **The store** = the chat-local variable `memoryWeaverState`, **separate for every chat**. Disabling the extension or deleting memories is a legitimate user action — the extension never "repairs" deliberate deletions.

## 2. Getting started

1. Install the extension (Extensions → Install extension → paste the repo URL → *Install just for me*).
2. Open any chat → a **🧠 Memory** button appears next to the send form.
3. The default mode is **Automatic**. Just chat — after every 20 conversation messages (default) a silent AI pass runs and writes the first memories.
4. Click 🧠 to open the **dashboard** — progress, memories, edit/delete, manual add.

The only requirement is the LLM connection you already chat with (the memory pass uses that same connection).

## 3. The send-form button

The **🧠 Memory** button next to the chat input:

- **Badge `13/20`** — new messages / threshold in **Automatic** mode: how many more messages until the next automatic pass. In the other modes the badge shows **`N waiting`** (unmemorized messages).
- **`ready`** (green outline) — threshold reached; the next AI reply triggers a memory pass.
- **`saving…`** (`saving… (N)` during **Remember everything**) — a pass is running.
- **`error`** (red) — the last run failed, the state is invalid, or an oversized message is blocking. Click → opens the **Health** tab.
- **`review`** (amber) — chat history was edited/deleted after being memorized (or old-version coverage is unverified). Not an error. Click → **Health** tab to **Review again** or **Ignore**.
- **`N due`** — N schedule items are due. Click → **Schedule** tab.
- **`off`** (dimmed) — the extension is disabled.

On phones only the icon + badge remain. The button sits after the Character Sheet button when character-state is installed. Missing? Reload the page (F5).

## 4. The dashboard

Open with the 🧠 button or `/memories`. Layout:

- **Header** — status (e.g. "Auto · next pass in N messages", "Remembering…", "Off"), the **Remember now** button and a **⋯** menu: *Rescan last 60 messages*, *AI merge & clean up memories*, *Export memories to .md*, *Import memories from .txt/.md*, *Resync vector index* (when vector recall is on), *Clear the whole schedule…*, *Clear all memories…*.
- **Slim progress bar** — X / Y messages memorized, messages waiting + the result of the last run. Long unmemorized chats get a **Remember everything** button (**Stop** to stop).
- **Alert strip** — only when something needs attention, with fix buttons (*Retry*, *Review again*, *Skip this message*, *Turn back on*, *Set N tokens*…).
- **5 tabs**:
  - **Memories** — the main list ([section 5](#5-managing-memories)).
  - **In prompt** — the exact `[Chat Memories]` block the AI will see next turn: how many memories are injected, how many tokens, grouped by tier (Pinned, Foundation, Current scene, Core, Recent), the accompanying schedule block, a **Copy block** button, and the diagnostic ([section 6](#6-does-the-ai-remember-this)). **When the AI "forgets", look here first.**
  - **Story** — chapter summaries ([section 7](#7-story-chapters)).
  - **Schedule** — appointments & story day ([section 9](#9-the-schedule)).
  - **Health** — every alert + fix button, stats, **10-run history** (result, message range, model, duration, token estimates, *View changes* + *Undo this pass*), **Clean up duplicate memories**, vector recall, **Tools** (rescan the last 60 messages, AI consolidation, export .md, import file).

There is **a single scroll container**; the tab bar (and the filter bar on wide screens) is sticky. The dashboard **never jumps position** when data changes; the focused field, caret and drafts survive.

## 5. Managing memories

- **Accent-insensitive search**: typing "sieu thi" finds "siêu thị".
- **Filters**: importance chips (All, Core, Important, Normal) + name chips (the most frequent names; the rest under *Filter by another name*) + an **In prompt / Not in prompt** filter. **Sort**: newest first / important first / story order / oldest first.
- **AI sees this** (green dot) on a row = that memory is inside the block injected into the prompt.
- **Edit** (pencil): inline → **Save** (Ctrl+Enter), **Esc** cancels. Content identical to another memory is blocked.
- **Delete** (trash can): **one-level undo** — click the toast right after (~8 s).
- **🔒 Lock**: the AI cannot edit/delete it and it is never evicted. You can still edit/delete it. Locking does **not** force the AI to see it.
- **📌 Pin to prompt** (separate from lock since v0.8): the memory is **always** injected, every turn (and is locked as well). Max 10 pins, using at most ~35% of the block — for facts that must never be forgotten (relationships, secrets, promises).
- **Jump to source**: click "tin #A–B" (messages #A–B, or "≈ tin #N" for older memories) to scroll to the chat passage that produced the memory.
- **Entity card + name merge**: click a name chip → stats card; if similar names exist ("Yamada Rika", "Rika-chan") → **Merge N names into "Rika"**; or **Rename…** (type an existing name to merge). Undoable. The card also offers **AI clean up this name's memories**.
- **Multi-select**: tick the box at the start of a row (or **Select all shown**) → bottom bar: **Pin to prompt** / **Lock** / **Unlock** / **Change level…** / **Delete** / **Deselect**.
- **Manual add**: **Add memory** (Ctrl+Enter to add), or `/memories action=add entity=Alice importance=3 <text>`.
- **Export / import**: the ⋯ menu or Health tab → Tools (export `.md`, import `.txt/.md`). Unsafe lines are refused on import and counted.
- **Rescan last 60 messages**: the AI re-reads the tail — the covered cursor is **not** reset; existing memories are kept, duplicates are filtered. Use it when the store is empty although the chat is marked as memorized.
- **Review again / Ignore**: when you edit, delete or swipe an already-memorized message, the button turns **review** and the Health tab reports "History from message #N was edited/deleted after being remembered". **Review again** makes the AI re-read exactly that range and fix the memories; **Ignore** if the change doesn't matter. If the chat is now shorter than the memorized part, use **Accept current history**; old-version coverage has **Mark as checked**.
- **Skip an oversized message**: if one huge message blocks the pass, click **Skip this message** on the alert (or the toast). It never blocks again and rejoins the queue if it gets shorter.
- **Remember everything**: drains a long unmemorized chat pass after pass (click again to stop).

## 6. "Does the AI remember this?"

**In prompt** tab → the **Does the AI remember this?** box — type what the AI just forgot (accents optional). Every matching memory gets a verdict:

- **In the prompt** (green) — the AI sees it; if it still forgets, that's the model: try **Pin to prompt** or **Make Core**.
- **Eligible, but did not fit the budget** — out of room: **Pin to prompt** or **Set N tokens**.
- **Filtered out** (non-vector mode) — not Core, not tagged USER/the character, not among the newest: **Make Core** or **Pin to prompt**.
- **Not relevant this turn** — not mentioned in the latest messages and no vector hit; it will surface when the scene touches it.
- **"This is in message #N — NOT remembered yet"** — the fact is still in the unprocessed part of the chat: **Remember now** / **Open message**.
- Nothing found → **Add this memory** (pre-filled).

## 7. Story chapters

- After a memory pass, once ~100 more **memorized** messages have accumulated since the previous chapter (Settings → Features → *Messages per chapter (approx.)*), the AI writes a chapter: messages #A–B, a title, a summary.
- The **"story so far"** block rides the main prompt and the memory pass (default budget 600 tokens); when it overflows, older chapters shrink to their titles.
- **Story** tab: **Write next chapter** / **Rewrite last chapter**; per chapter **Edit** / **Lock** (the AI won't rewrite it) / **Delete**. Chapters made stale by edits/deletions inside their range are flagged with **Rewrite this chapter**.
- 60-chapter cap: when full, the two oldest chapters are merged.

## 8. AI consolidation & undoing a run

- **AI merge & clean up memories** (AI consolidation): ⋯ menu, Health tab → Tools, or the entity card (**AI clean up this name's memories**). The AI only **updates/deletes** (never adds): merges paraphrases, supersedes stale facts, drops trivia, normalizes names, rebalances Core. Locked/pinned memories are untouched. Runs automatically after every N automatic passes when *Let the AI merge & clean up memories every N automatic passes* is > 0 (default 0 = manual only).
- **Undo a run**: Health tab → **View changes** under a run (added / updated before → after / deleted) → **Undo this pass**. Kept for the newest 3 bursts; a whole burst (all chunks of one run) is undone together. Memories you edited after that run are kept (skipped). Not possible when the run was too large or memories were wiped afterwards. The messages read by that run are **not** re-memorized automatically — use **Review again** or the rescan if needed.
- **Clean up duplicate memories** (Health tab): **Find duplicates** → each cluster offers **Merge N into 1** (undoable). Never merged automatically.

## 9. The schedule

For **appointments, promises and future events** — the things plain memories "forget exactly on time".

### Adding
**Schedule** tab → **Add appointment**:
- **after … messages** (recommended, self-counting, no AI cooperation needed), or
- **on story day …** (requires the **Story day** control at the top of the tab, −/+ buttons, or `/memories action=clock day=13`).
- Fill in **Appointment text**, **Related names**, **Remind early** (default 5 messages / 1 day), **Label** (empty = automatic) → **Save appointment**.
- With *Let the AI add appointments while remembering* (off by default), the memory pass may also create appointments and set story-day marks.

### Behavior
- Normally a compact `[Schedule]` block appears in the prompt.
- **Nearing the deadline** → escalates to `[Schedule — DUE NOW]`, pushed near the end of the context (the model cannot miss it) + a one-time toast.
- **Overdue** → the row turns "overdue" and keeps nagging until you resolve it. Never silently dropped (unless *Mark long-overdue appointments as "missed" automatically* is on: items long overdue — 10 messages / 10 days past due + lead — are marked missed by the AI).

### Lifecycle
- ✓ **It happened** — marks it done and **graduates it into a regular memory** with source "from schedule".
- **Postpone +10** (message-based) / **Postpone +1 day** (story-day); any amount via ⋯ → **Postpone by…**.
- ⋯ menu — **Edit** (content/label/lead), **Mark as missed** (lets the AI know it slipped), **Cancel appointment**.
- Finished items live in the collapsed **Done / cancelled / missed (N)** section.

### Deleting
"Clear all memories" **never touches the schedule**. Clear the schedule separately via ⋯ → **Clear the whole schedule…** or `/memories action=sched_clear`. Max 20 active appointments per chat (adjustable).

## 10. Vector recall — topic-based memory retrieval

> Experimental, **off by default**. Enable in Settings → Features → *Vector recall*.

Once a chat has hundreds of memories, the canon block only fits the most important lines. Vector recall adds coverage: it indexes all of the chat's memories with **SillyTavern's Vector Storage** (free local embedding model, runs on the ST server) and at every reply retrieves memories **relevant to the current topic** — including day-one facts.

- The index is **per chat** — other chats never share it.
- Status lives in settings (the "Vector recall: …" line and the **Resync** button) and in the Health tab.
- **Same-turn recall**: before the AI replies, the extension waits up to *Wait for vector recall before the AI replies* (default 1500 ms, 0 = never wait) so results for the newest message make it into the prompt. No wait when injection is off.
- Disabling returns behavior to the exact non-vector state. Network/index errors fall back to the regular selection and never block the chat.
- First enable: the server downloads the embedding model once. Track it with `/memories action=vindex`; see what recall selects with `/memories action=recall [query]`.

## 11. How the AI updates memories

The memory pass (every N messages or on demand) receives: the **new message chunk** (at most 60 counted messages per chunk, by default at most 2 chunks per run, within the *per-pass input budget* — default 12000 tokens; messages are passed whole and **never truncated**; a single message larger than the whole budget blocks the pass and asks whether to skip it) + the **story so far** + the **existing memories** (default up to 150), and returns a patch:

- `add` — new facts (deduplicated: *Exact* mode blocks identical content, *Near* mode also blocks paraphrases).
- `update` — rewrites an entry when information changed (by id).
- `delete` — removes entries that turned out false or were superseded.

The model cannot invent memories outside this pass; a failed pass **keeps the cursor** (no messages lost) and retries after enough new messages; a valid empty patch still advances the cursor to the end of the chunk. Every change is normalized + deduplicated + retention-trimmed (over *max memories* → duplicates / transient / low-importance old entries go first; locked/pinned never). The AI cannot touch locked memories — the result toast counts the skipped operations.

## 12. Storyline chats

In Storyline chats the standalone block is replaced by Storyline's full-prompt override (structural, not a bug) — memories reach the model through Storyline's **memory_keeper** function:

1. Storyline Editor → Advanced → Story Functions → add **Memory Keeper** (Default On).
2. With Storyline ≥ 0.1.20 + Memory Weaver ≥ 0.4.0 the bridge calls Memory Weaver's **recall API** — including vector recall, waiting up to 400 ms (`retrieval.waitBudgetMs`) before the prompt is captured.
3. The schedule is **not** projected into Storyline prompts yet.

## 13. Slash commands

The action is always passed with the named argument `action=` (default `view`); named arguments come **before** the text, and the text is the remaining unnamed argument.

```
/memories                                              — open the dashboard (= action=view)
/memories action=add entity=Alice entity=Bob importance=3 <text>
/memories action=summarize                             — run the memory pass now
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
/memories action=vindex [rebuild=true]                 — vector index status / rebuild
```

Without `entity=`, `add` tags the active character (or `USER`); default importance is 2. `lead` = remind this many messages (`after`) or story days (`day`) early.

## 14. Settings reference

Extensions → Memory Weaver. The **Language** selector sits at the very top; below it, the **⚡ Turn on Super Smart mode** button (see the second table); **Restore previous settings** puts every value back as it was (asking first if that would make *max memories* smaller than the current store).

| Section | Setting (UI label) | Default | Meaning |
|---|---|---|---|
| (top) | Language | English | **English** / **Tiếng Việt** / **Auto (follow SillyTavern)** — UI language only (prompts sent to the AI are never translated). Switching re-renders the settings, the send-form badge and an open dashboard immediately |
| Basics | Enable Memory Weaver | on | Master switch |
| Basics | How memories are made | Automatic | **Automatic** (the AI records memories every N messages) / **On demand** (runs only when you press "Remember now") / **Manual only** (the AI never writes memories) |
| Basics | Remember every | 20 messages | Conversation messages between passes (5–100) |
| Basics | Add memories to the prompt | on | Emit the [Chat Memories] block |
| Basics | Memory budget in the prompt | 600 tokens | Memory block budget (100–4000) |
| Features | Story chapters | on | Write and inject the "story so far" |
| Features | Messages per chapter (approx.) | 100 | 20–400 |
| Features | Tokens for the summary block | 600 | 100–4000 |
| Features | Schedule | on | Schedule tab + [Schedule] injection |
| Features | Let the AI add appointments while remembering | off | Experimental |
| Features | Mark long-overdue appointments as "missed" automatically | off | Requires the line above |
| Features | Vector recall | off | Topic-based retrieval of old memories (experimental) |
| Advanced | Token budget per memory pass | 12000 | 2000–32000 (estimate) |
| Advanced | Max chunks processed per pass | 2 | 1–10 (≤ 60 messages each) |
| Advanced | Max memories per chat | 150 | 20–500; full → trim |
| Advanced | Max tokens for the schedule block | 120 | 40–400 |
| Advanced | Max pending appointments per chat | 20 | 5–100 |
| Advanced | Existing memories the AI reviews per pass | 150 | 50–300 |
| Advanced | Let the AI merge & clean up memories every N automatic passes | 0 | 0 = manual only (0–50) |
| Advanced | Wait for vector recall before the AI replies | 1500 ms | 0 = never wait (0–5000) |
| Advanced | Duplicate blocking when adding memories | Exact | **Exact** (identical text only) / **Near** (rephrased sentences too, experimental) |
| Advanced | Custom system prompt for memory passes | empty | Empty = default; the output protocol is always kept |

**Super Smart** mode sets:

| Setting | Value |
|---|---|
| Prompt memory budget | 2000 tokens |
| Optimizer input budget | 24000 |
| Chunks per run | 4 |
| Existing memories reviewed | 250 |
| Max memories | 300 |
| Dedupe mode | Near |
| Recall wait | 2000 ms |
| Vector recall · AI schedule auto · Chapters | on |
| Messages per chapter / chapter block budget | 80 / 1000 |
| Auto consolidation | every 5 passes |

## 15. Data safety & privacy

- Memories, chapters, the schedule and the story clock live in the **chat's own local variable** — deleting the chat deletes them; there is no separate server-side store.
- The **vector index** is derived data on the machine running ST (`data/<user>/vectors/`) — deleting it only removes the search index; memories remain and re-index; deleting a chat purges its index.
- With the local embedding model, memory text is processed **on your machine**. A cloud embedding source sends content to that provider.
- No data is shared across chats; nothing is sent anywhere except your configured LLM API (when a memory / chapter / consolidation pass runs).

## 16. FAQ & troubleshooting

**Q: The AI still forgets despite memories?**
**In prompt** tab → **Does the AI remember this?** tells you why and offers a fix. For long chats enable **Vector recall** or raise the prompt memory budget. In Storyline chats, check that the **Memory Keeper** function is enabled.

**Q: `No message generated` / "The API returned an EMPTY completion"?**
A reasoning model burned its whole completion budget (4096 tokens). Since v0.5.0 the extension does **not** lower Reasoning Effort for you (mutating global settings mid-run is unsafe). Usually transient; if it repeats, lower Reasoning Effort yourself or switch models.

**Q: Progress numbers jumped / don't match the message count?**
Since v0.2.1 the counters measure **real conversation messages** — tool calls and system messages don't count. The new number is the correct one.

**Q: I deleted/edited messages — did memories shift?**
Memories are not lost. The button turns **review** (amber) and the Health tab offers **Review again** or **Ignore**; the cursor is **never** clamped automatically. Only "message #X" labels can drift slightly.

**Q: Can the AI remember across different chats?**
Memory Weaver is per-chat by design. Use CharMemory for per-character cross-chat recall (both can coexist, but you pay for two LLM passes).

**Q: Vector recall reports an error?**
Check the status line in settings or the alert in the Health tab. Network/model errors fall back to the regular selection and never affect the chat. Click **Resync** or run `/memories action=vindex rebuild=true`.
