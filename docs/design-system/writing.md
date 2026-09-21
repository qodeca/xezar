# UX writing

The conventions below were derived from the cockpit's real copy in `packages/web/src/routes/**` and
`packages/web/src/components/**` on 2026-09-13. Every example is a quotation from the code, with its
source. Where usage is split, the rule is the majority form and the minority is in
[known-gaps.md](known-gaps.md).

## 1. Case and punctuation

| Rule | Evidence |
| --- | --- |
| Sentence case everywhere: headings, labels, buttons, menu items, tabs. Proper nouns keep their case (`GitHub`, `MCP`, `CPU`). | 58 of 60 headings; 130 of 130 button labels. "Global settings", "Agent accounts", "Defaults for new projects" (`settings/registry.tsx`, `accounts-section.tsx`). |
| `xezar` is always lower case, even at the start of a sentence. | 212 occurrences, 0 of "Xezar". "xezar MCP server" (`mcp-api-section.tsx`). The app calls itself "the cockpit" in prose. |
| No trailing period on headings, labels, buttons, tooltips, empty-state titles. Descriptions, hints, subtitles and bodies are full sentences with a period. | 20 of 20 empty titles without a period; 18 of 18 subtitles with one. |
| The ellipsis is one character, `…`, never `...`. | 134 to 1. "Loading task…", "Search tasks…". |
| Clauses are joined with a spaced em dash ` — `. | 334 lines. "Disconnected — reconnecting", "Copy failed — drag the button instead." (`bookmarklets-section.tsx`). Note: the repository's docs use en dashes; the UI uses em dashes. Follow the surface you are writing for. |
| User-supplied names are wrapped in curly quotes `“ ”`; apostrophes are curly `’`. | `Remove “{label}”?` (`accounts-section.tsx`), `No tasks match “{needle}”.` (`tasks-overview.tsx`), "This xezar doesn’t serve a project by that id." |
| No Oxford comma. | 25 to 2. "Theme, accent and density." (`settings/registry.tsx`), "Claude Code, Codex, OpenCode or pi" (`mcp-capabilities.tsx`). |
| Contractions are avoided; write `cannot`, `does not`, `will not`. | 21 lines to 7. "This browser does not support notifications" (`notifications-section.tsx`). |

## 2. Voice

- Second person to the operator: "Notify when an agent needs you", "Finished tasks you archive land here.",
  "System follows your OS preference." (`notifications-section.tsx`, `tasks-overview.tsx`, `appearance.tsx`).
- Third person for capability text an MCP leader reads about itself: "A person can run the cockpit
  locally on this machine.", "A person can install Claude Code, Codex, OpenCode or pi." (`mcp-capabilities.tsx`).
- Plain, concrete, present tense. Say what happens, then why or what next.

## 3. Headings and page titles

One to six words, a noun phrase: "Tasks", "All tasks", "Inbox", "Skills", "Workflows", "Git", "GitHub",
"Settings", "Global settings", "Manage skills", "Open pull requests". Settings section titles are nouns:
"Agents", "Agent config", "Worktrees", "Bookmarklets", "Prompt templates", "MCP connection", "MCP API",
"Appearance", "Notifications", "Resources", "Projects".

The one question heading is the `/new` hero: "What should the agent work on?"

## 4. Buttons and menu items

- Verb first, one to three words: "Run", "Start", "Save", "Commit", "Push", "Create PR", "View PR",
  "Open in terminal", "Add account", "Add template", "Reclaim now", "Resolve conflicts", "Attach leader",
  "Refresh" (`mcp-leader-control.tsx`, pending "Attaching…" and "Refreshing…").
- Noun phrases only for "create or open a thing": "New task", "Draft PR", "Notes", "Terminal", "All commits".
- Pending state replaces the label with the present participle and `…`: "Starting…", "Saving…",
  "Adding…", "Sending…", "Planning…", "Committing…", "Cloning…", "Updating…".
- Toggles state the next state: "Hide details" / "Show details", "Hide folders" / "Browse…".
- Dismiss buttons name the kept outcome: "Keep it" (6 sites), "Keep comparing",
  "Keep the existing chain" over a plain "Cancel" (1 site, a non-destructive dialog). "Keep the
  file" was listed here until #453 B7 replaced it with "Keep it"; `design-debt-b7.test.tsx`
  asserts the old string is gone, so do not reintroduce it. Counts read 2026-09-17.
- Destructive verbs are explicit: "Delete", "Remove from list", "Cancel the run", "Discard".
- No "OK", no visible "Close" (the close button's `sr-only` text is "Close").
- Retry: "Retry" (5 sites) over "Try again" (3 sites).

## 5. Empty states

Title: a fragment naming the absence. Subtitle: one or two sentences that name the next action or explain
when the thing will appear.

| Title | Subtitle | Source |
| --- | --- | --- |
| "No tasks yet" | "Describe a task to get started." | `tasks-overview.tsx` |
| "Nothing archived yet" | "Finished tasks you archive land here." | `tasks-overview.tsx` |
| "No matching tasks" | "No tasks match “fix”." | `tasks-overview.tsx` |
| "Inbox empty" | "Agents drop follow-up suggestions here when they finish a task." | `inbox.tsx` |
| "No commits yet" | "This task hasn’t committed anything on its branch. Autosave commits and any the agent makes appear here." | `task-commits.tsx` |
| "Working tree clean" | "No uncommitted changes in the main working tree. Edits show up here as they happen." | `repo-changes.tsx` |
| "Page not found" | "Nothing lives at this address. The link may be mistyped, or it points at something that is gone." | `not-found.tsx` |
| "The follow-up inbox is off" | "Agents are not asked to leave follow-ups. Set XEZ_FOLLOWUPS=1 and restart xezar to turn the inbox on." | `inbox.tsx` |

Inside a list or picker: "Nothing matches." (5 sites), "Nothing to filter by", "No skills yet — drop
Markdown files into .xezar/skills/, …".

## 6. Loading

"Loading {thing}…" with a "Fetching …" subtitle on a page; "{Verb}ing…" inline.
"Loading task…" / "Fetching the run and its session transcript." (`thread-loading.tsx`);
"Checking agent providers…"; "Checking GitHub…"; "Working…" (shimmered); "Starting the clone…".

## 7. Errors and refusals

- The cockpit writes the title; the server's message is shown verbatim as the body or the toast. This is
  the repo-wide error doctrine ("400/409/500 alike: the server's own words, verbatim",
  `agents-section.tsx:109`).
- Load-error titles: "Could not load X" (14 sites: "Could not load skills", "Could not load the inbox",
  "Could not load this task", "Could not load tasks across projects"). No "X did not load" title
  remains (#453 B3 fixed settings, B4 the global Tasks page).
- Disabled-action reasons: "{Thing} unavailable — {why}": "Commit unavailable — no changes to commit",
  "Push unavailable — no remote configured" (`lib/git-actions.ts`).
- Refusals name the consequence and who can act, never the phrase "not available in hosted mode":
  "Agent accounts are managed from the machine that owns the checkout — this cockpit runs in hosted mode."
  (`accounts-section.tsx`); "This xezar is not running in local mode, so actions on the host machine are
  refused." + "A person can run the cockpit locally on this machine." (`mcp-capabilities.tsx`).
- Inline validation states the rule: "Enter a whole number from 1 to 60 minutes.",
  "{n} characters — the limit is {max}."
- Attachment rejections: "{name} is too large (max 5 MB)", "{name} skipped — max 4 attachments per message".
- A server blocker with a remedy: its message verbatim, then a second line led by a medium-weight
  "Fix:" and the server's fix, in a `bg-muted` card-body block; a refusal the status does not already
  explain is shown once in the server's words as a `role="alert"` line. Names the server writes as plain
  text (`leader_events`, `app-server`) still render as code. (`routes/settings/mcp-leader-control.tsx`)

## 8. Confirmations

Title is a question naming the object; body states what happens; irreversible actions add
"There is no undo."; the confirm repeats the verb; the cancel names the kept outcome.

| Title | Body (excerpt) | Cancel | Confirm | Source |
| --- | --- | --- | --- | --- |
| "Delete this task?" | "This removes the run, its transcript, its worktree and its branch. There is no undo." | "Keep it" | "Delete" | `run-header.tsx` |
| "Cancel this task?" | "The agent is stopped and the run completes as cancelled. The worktree stays." | "Keep it" | "Cancel the run" | `run-header.tsx` |
| "Remove {name} from the workspace?" | "This only unregisters the project — nothing on disk is deleted. …" | "Keep it" | "Remove from list" | `remove-project.tsx` |
| "Open this link?" | – | "Cancel" | "Open link" | `link-safety-dialog.tsx` |

Form dialogs use a plain phrase, no question mark: "Commit changes", "Add agent account",
"Open local folder", "Clone from GitHub", "Save as chain".

## 9. Status words

- Run status (`lib/attention.ts`) is lower case because the dot carries the emphasis: "needs you",
  "needs review", "running", "monitoring", "queued", "done", "failed", "scheduled", "cancelled".
- Every other status label is sentence case: the Tasks pages' "Active" and "Archived" tabs (the sidebar's
  "Pinned", "Needs you", "Working" and "Recent" bucket headings went with its task list in #546); reference labels "Draft", "Waiting for review", "Changes requested", "Checks running",
  "Checks failing", "Ready to merge", "Merged", "Closed", "Merge conflicts" with lower-case hints
  ("CI is red on the latest commit"); connection states "Ready to connect", "Connected",
  "Disconnected — reconnecting"; the skill catalog's "Up to date", "Update available", "Check is
  stale", "Not checked yet", "Comparison unknown" and "Version unknown"
  (`routes/settings/skills-section.tsx`, `catalogStateLabel`). Those are deliberately different
  words for different facts: a badge never says "Version unknown" over two printed versions, so
  "Version unknown" belongs to the no-local-copy case alone, while "Check is stale" and "Not
  checked yet" name the CHECK, not the version, and "Comparison unknown" is kept for two versions
  that really cannot be lined up (#752).
- The same block's sentences, quoted with their source (`routes/settings/skills-section.tsx`,
  `catalogExplanation`) — each states the fact, then names the next step in the same form:
  - "Tracking <repo> <ref> — last checked 2h ago. Use Refresh on the Skills page to start serving
    the newer version." (`Update available`)
  - "Tracking <repo> <ref> — the last upstream check is older than six hours (13h ago), so the
    versions above are as of then. Use Refresh on the Skills page to re-check upstream."
    (`Check is stale`)
  - "Tracking <repo> <ref> — this machine has not checked upstream yet, so it cannot say whether
    these versions are current. Use Refresh on the Skills page to check." (`Not checked yet`)
  - "Tracking <repo> <ref> — last checked 4m ago, and these two versions share no history, so they
    cannot be compared." (`Comparison unknown`) — never said of two IDENTICAL commits, which is
    the defect #752 fixed: different facts get different words, and "share no history" is a fact
    about two different commits.
- Another cockpit's state (`components/other-projects.tsx`, `--instance project`, #467) is lower
  case for the same reason run status is — the row is the emphasis: "running",
  "running — address not known", "not running", "checking…", "current". Each is a fact this server
  CHECKED; when it did not look (hosted mode) the row carries no state word at all, because "not
  running" would be a claim nobody made. The hint under an unaddressable row is a full sentence,
  "Find the terminal that runs it.", and the action beside a stopped one is "Copy command"
  (`xez --repo <folder>`), with "Command copied" or the command itself in the toast when the
  clipboard refused. The global Tasks page names the narrowing in one line: "This list is {project}
  only — your other projects run in their own cockpits." (`routes/global-tasks.tsx`).
- Product names come from `lib/runner-label.ts`: "Claude Code", "Codex", "OpenCode", "pi" (lower case).
  Multi-backend runs read "Claude Code +1".

## 10. Settings copy

- Label: a sentence-case noun phrase, no colon: "Theme", "Reading width", "Max parallel tasks",
  "Auto-resume after a usage limit", "Notify when an agent needs you".
- Hint: full sentences ending in a period, second person, sentinels spelled out: "Roomy adds space between things and the Compact options take it away — text stays the same size.", "How many tasks run at once across every
  project. The rest wait in the queue.", "0 = unlimited", "Leave empty for no limit."
- Placeholder: either an example value ("~/xezar/projects", "sonnet", "owner/repo or
  https://github.com/owner/repo") or an instruction ending in `…` ("Search tasks…",
  "Describe a task for the agent — / for skills…"). Sentence case; four lower-case "search …" placeholders
  remain, in `routes/new-task.tsx` and `routes/github/hand-to-agent.tsx` (G-15).
- "Filter" for narrowing a local list ("Filter skills…", "Filter labels…"); "Search" for a search box
  ("Search tasks…", "Search every project…").
- A switch whose setting is off while another source still holds it says so in its state text and
  names where each source is lifted: "Off — still locked elsewhere", with the hint "If xezar was
  started with XEZ_AGENT_MODELS_LOCKED=1, restart it without that variable to unlock. If the
  workspace config file — ~/.xezar/config.json, or .xezar/workspace.json in single-project mode —
  sets modelsLocked, remove that key from it." (`routes/settings/agents-section.tsx`, #809).

## 11. Tooltips and accessible names

- `title` on a labelled control adds information; it never repeats the label: "Unread — not opened since
  it finished", "Drag to resize the sidebar — double-click to reset", "Attach an image, PDF, TXT or MD
  file (or paste a screenshot)".
- An icon-only control gets an imperative `aria-label`: "Copy the command", "Refresh from GitHub",
  "Insert a prompt template", "Open menu", "Close menu", "Pin task" / "Unpin task".
- Shortcut hints: `⌘K` / `Ctrl+K`, `⌘↵` / `Ctrl+↵`, joined with `+`, no spaces, inside an `aria-hidden`
  `<kbd>`; never the word "Enter".

## 12. Numbers, times and units

- Ages: one unit, floored, no space, no "ago": `12s`, `4m`, `3h`, `2d` (`lib/format.ts`). Callers add
  " ago" when there is room ("synced 4m ago").
- Tokens: `812`, `96.2k`, `1.4M`, truncated not rounded, lower-case `k`, upper-case `M`.
- Memory: `1.2 GB`, `612 MB`, `48 kB` with a space (`lib/tasks-table.ts`). Cost: `$0.31` under $10, `$12`
  above; nothing when not measured. CPU: `42%`.
- Missing values print `—`. Diff counts use the minus sign U+2212: `+128 −14`.
- Dates go through `Intl` with the reader's locale (`{ month: 'short', day: 'numeric' }` plus time).
- Durations in the composer read `m:ss`.

## 13. Toasts and notifications

- One short line. Success: "Worktree path copied", "Team skills refreshed", "Account added — use
  Connect to sign in", "{project} removed from the workspace — its files are untouched".
- Errors: the server message, `tone: 'danger'`. Hand-written only when there is no server:
  "Could not copy the command".
- A success toast reports what the server actually managed, never the action that was asked for
  (#771). When part of it failed, the toast is the partial: "Refreshed 1 of 2 team skills sources
  — {repo}: {the server's reason}", `tone: 'danger'` — rounding a partial to either side is what
  made Skills → Refresh report success for a fetch that never ran.
- Turning a setting off reports what still holds: "Project lock removed — models stay locked by the
  environment or the workspace config" when another lock remains, "Models unlocked for this
  project" when none does (`routes/settings/agents-section.tsx`, #809).
- Copying: "Command copied", "Worktree path copied", "No terminal found — command copied". When the
  clipboard refuses, the toast is the payload itself: "Run manually: {command}", "Path: {path}".
- Browser notification body: "Task needs you", "Task needs review", "Task failed"; title is the run title.
