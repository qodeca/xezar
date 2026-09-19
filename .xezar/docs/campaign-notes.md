# Campaign notes: a folder, not a file

SDLC.md § Campaign notes defines what a campaign note is and what it must record (Done, Open
items, Owner decisions, Standing rules, Restart and re-attach) and the short single-file template
for a small campaign. This page adds the default *layout* for a campaign that outgrows that one
file: a folder under `.local/xezar/campaigns/<yyyy-mm-dd>-<slug>/`, still primary-checkout runtime
state, still covered by the root `/.local/` ignore rule, never committed.

## Why split

A single-file note for the 0.16.0 campaign grew past 360 lines and 150 KB in one day. Claude Code
and Codex memory hold only a pointer to the note (SDLC.md), but the note itself was still loaded
whole at every session start and at every context-window compaction — so the file's own growth
made every restart slower and every compaction more expensive. Splitting the live state from the
append-only history cuts what loads at start-up to about a third of the old file, and lets the
leader read the timeline's tail on demand instead of the whole day. Splitting a note in place also
leaves a short pointer stub at the old single-file path — see "The files and their contract" below
— so a stale reference or a date-slug search still finds where the note went instead of dead-ending.

## The files and their contract

- **`README.md`** – live state. **Rewritten**, not appended, at every milestone (SDLC.md's "last
  act of handling that event, before reporting to the owner" still applies). Stamp `Updated:` with
  the output of `date`. Keep: a table of the folder's own files and whether each loads at session
  start; a State block (main sha, merges so far, checkpoints met); open pull requests with head
  sha, verdict state and the single next action; the serial merge line; running tasks per account;
  the account table (state, reset times — see `.xezar/docs/account-limits.md`); held/queued work;
  owner items; a "rules that bit" list for briefs; restart and re-attach steps. Target ≤ 120 lines
  — when it grows past that, move a stale block to an `archive-*.md` file rather than trim history
  silently.
- **`decisions.md`** – owner decisions in the owner's exact words, with the date and the channel
  (chat or `AskUserQuestion`), plus the campaign's standing rules. Append-only; never edit or
  reorder a past entry.
- **`merges.md`** – one line per day, listing every merge that day as `#PR → sha`. Each merge's own
  verification (parent count, file count, issues left open, main CI result) lives in that day's
  timeline entry, not here — this file is the index, not the evidence.
- **`plan.md`** – the owner-approved plan, copied in once. Never edited afterward; a plan change
  goes through the owner and is recorded as a dated entry in `decisions.md`, not as a silent edit
  here.
- **`timeline-YYYY-MM-DD.md`** – one file per day, append-only. Every line starts
  `- YYYY-MM-DD HH:MM – …` stamped from `date`, names run ids by their first 8 characters, and ends
  by naming the leader-events sequence acked so far. Never read this file whole; read its tail.
- **`archive-*.md`** – stale blocks kept for history (a past day's morning state, an old single-file
  note before a split). Never loaded at session start or compaction.
- **The old single-file path** – kept in place as a short pointer stub, written once at split time
  and never edited again. It holds a `# Moved` heading, the split date and time, the new folder's
  name, and a line noting that `README.md` is the live state and
  `archive-single-file-note-until-<hhmm>.md` holds the full old copy. A stale reference or a
  date-slug search that still lands on the old path finds the stub and where the note actually
  went, instead of finding nothing.

## Loading

The leader's own bootstrap file (for example `.claude/CLAUDE.md`, itself git-ignored) imports only
`README.md`, `decisions.md` and `merges.md` with `@`-paths — the three files a new session or a
post-compaction reload needs to reconstruct state. `plan.md` is named as a plain path instead, read
on demand rather than `@`-imported: the plan is large, and auto-loading it at every session start
and every compaction would defeat the split this page exists for (see "Why split" above). The
timeline is likewise never `@`-imported; the leader reads a day's tail on demand instead. Claude
Code or Codex memory holds one pointer to the folder, never a copy of its content (SDLC.md's "never
its only copy" rule applies to the folder exactly as it did to the single file).

## Writing rules

- Stamp every line from `date`; never hand-write a time.
- A run-id placeholder in a brief is filled with `sed` right after the matching `task_create`
  call returns its real id — never left as a placeholder in a note.
- Never put backticks inside a double-quoted shell string when appending to a note file — the
  shell executes them. Use single quotes, or a Python heredoc, for any append that contains a
  command example or code fragment.
- The erfana bash-safety hook blocks note text that contains a destructive git phrase (for example
  a literal `git reset --hard` or `git push --force`) even inside a quoted description of what NOT
  to do. Describe such a rule in words instead of pasting the command.

## When a day ends

Start a new `timeline-YYYY-MM-DD.md` for the next day; do not keep appending to the old one. The
README's State block names the running merge count and which plan checkpoints the campaign has
met so far, so a new day starts from a written number rather than a recount.

## Scope

This page is a default layout, not a new requirement: SDLC.md's single-file template still covers
a campaign small enough to stay under it, and this folder shape is what to reach for once that
file would otherwise grow past a comfortable single load. Everything SDLC.md says about a campaign
note — what it is, what it must record, when to update it, that it is a coordination aid and not
evidence — applies to the folder unchanged; this page only describes how those records are split
across files.
