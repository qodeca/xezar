# Leader-context loading: the committed guide a leader session reloads itself from

This is the standard for giving the AI session that **leads** a project its own durable context: a
committed **leader guide**, loaded automatically by a committed client hook, together with the live
campaign notes the guide points at. It exists because a leader's rules and current state must
survive a new session and a context-window compaction, and because the same mechanism has to be
installable in any project xezar leads — this repository is the dogfooding case, not the target.

Owner decision, 2026-09-18 20:57 (verbatim): "comprehensively document this entire mechanism as we
will be using it probably in many different project. Remember that dogfooding Xezar on xezar
project is to prepare standards for other projects and improve new project onboarding to Xezar
later." Refs #600.

Related: [campaign-notes.md](campaign-notes.md) for the campaign note's own contract,
[worktrees.md](worktrees.md) for the worktree rules the guard depends on, [dogfooding.md](dogfooding.md)
for how observations are classified, and [../../AGENTS.md](../../AGENTS.md) § Generic instructions
for the product-neutrality rule the user-guide half follows.

## Purpose

A leader session is long-lived but not continuous. It starts, it is resumed, its context is cleared
or compacted, and each time the client may hand the model an empty conversation. Three things must
be re-established without a person retyping them:

- **Standing rules** — how tasks are routed, which gates are mandatory, the merge order and the
  attribution rules. These change rarely and must not be re-derived from scratch.
- **Live state** — the current release, open pull requests with their heads and verdicts, running
  tasks per account, and the single next action per item. These change hourly.
- **Owner decisions** — the exact words that authorize a deviation, kept so a later session can
  quote the authority instead of paraphrasing it.

The guide holds the first and third as durable text; the campaign notes hold the second. The hook
is what makes the client reload both without a prompt.

## The moving parts

| Path | What it is | Committed? |
| --- | --- | --- |
| `.xezar/docs/leader-guide.md` | The leader guide: rules, patterns, recovery steps, owner-only decisions, brief rules and a checklist. Capped at about 450 lines. | yes |
| `.claude/settings.json` | The Claude Code `SessionStart` hook that runs the loader. The only `.claude/` file that is un-ignored. | yes |
| `.xezar/checks/leader-context.sh` | The loader. Prints one JSON object when it should; prints nothing when it should not. | yes |
| `.xezar/checks/leader-context.test.mjs` | The fixture case: loud in the primary, silent in each agent shape. | yes |
| `.local/xezar/campaigns/<release>/README.md` | Live campaign state, rewritten at every milestone. | no — runtime |
| `.local/xezar/campaigns/<release>/decisions.md` | Owner decisions in the owner's exact words, append-only. | no — runtime |

The loader is deliberately tiny and dependency-free: a shell script that reads the guide and the
newest campaign folder, checks the guard, and prints one JSON object. It reads no configuration, so
a project that has the three committed files needs nothing else.

## The guard, and why each rule exists

Claude Code reads a project's `.claude/settings.json` for **every** session started under that
project folder, and it finds project instructions by walking parent folders. A task worktree lives at
`.local/xezar/worktrees/<runId>`, inside the primary checkout, so a hook committed in the primary is
discovered by a task session too. That is the failure the guard closes: a task agent must never
receive leader rules. (Observed 2026-09-18: a local `.claude/CLAUDE.md` at the repository root was
loaded by every worktree session through the parent-folder walk, and there was no per-worktree way
to mute it.)

`leader-context.sh` prints nothing when any of these is true, and prints the block only when none is:

1. **Linked worktree** — `git rev-parse --git-dir` differs from `git rev-parse --git-common-dir`.
   In the primary checkout the two are equal; in a linked worktree they differ, because a task's
   worktree shares the primary's common git directory.
2. **A path under `.local/xezar/worktrees/`** — a belt-and-braces check that does not depend on git
   being installed or on either git command succeeding.
3. **`XEZ_HANDOFF_FILE` or `XEZ_TODOS_FILE` is set** — the engine sets these for a task, including a
   **Worktree-OFF** task running in the primary checkout, which neither of the first two rules
   catches. A silent rule that only understood worktrees would leave that task loud.
4. **The guide is missing** — a project without a guide gets silence, not an error and not a
   half-loaded block.

Everything else is loud. The silent cases matter as much as the loud one: they are what makes it safe
to commit the hook at all, and the test pins each of them.

## The hook output shape

A `SessionStart` hook prints nothing on stdout in the silent cases, and one line of JSON otherwise:

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"=== .xezar/docs/leader-guide.md (project leader guide) ===\n\n# Leader guide\n…\n\n=== .local/xezar/campaigns/v0.16.0/README.md (campaign live state) ===\n…"}}
```

`additionalContext` is one string holding three labelled blocks in a fixed order: the guide, the
newest campaign `README.md`, then its `decisions.md`. Order matters — a rule that a decision
overrides is read after the rule, and the live state is read last, nearest to the work. The hook is
registered in `.claude/settings.json` with the four matchers a leader has to survive:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "bash .xezar/checks/leader-context.sh",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

The explicit `bash` means the copied script does not depend on its executable bit surviving the
copy, and `"timeout": 15` bounds a hook that runs on every session start and compaction.

## The test

`leader-context.test.mjs` builds a primary-shaped checkout with a guide and both campaign files, then
runs the loader in the primary, in each of the three agent shapes, and once more with the guide
removed, and asserts the outcome:

- the **primary** prints one parseable object whose `additionalContext` contains the guide and both
  campaign files;
- a **linked worktree**, a **path under `.local/xezar/worktrees/`** and a **primary with
  `XEZ_HANDOFF_FILE` set** each print **nothing at all**;
- a **missing guide** prints nothing.

"Nothing at all" is the assertion, not "an empty object": a loader that prints `{}` still wakes the
client and still risks a future field. Run the case directly or through the kit's isolated suite:

```sh
node --test .xezar/checks/leader-context.test.mjs
bash .xezar/checks/infra-tests.sh
```

## The cost model

The hook runs on `startup`, `resume`, `clear` **and** `compact`. Compaction is triggered by a full
context window, so a large block loaded at compaction makes the next compaction come sooner and the
guide's size compounds. Two caps follow, and both are requirements rather than style:

- The guide stays at about **450 lines**. Everything durable and leader-only belongs there; anything
  that is really project documentation belongs in a linked file the guide names.
- The campaign `README.md` stays at about **120 lines** (see [campaign-notes.md](campaign-notes.md)),
  and the loader loads only the newest folder's `README.md` and `decisions.md`. A plan, a timeline or
  an archive is never loaded; the leader reads its tail on demand.

A silent case costs one process spawn and no tokens. A loud case costs the guide plus two files.

## The Codex and pi fallback

Codex and pi have no Claude Code `SessionStart` hook, so nothing reloads the guide for them. Their
leaders load it because the guide's **first section** tells them to: read the guide and the newest
campaign `README.md` and `decisions.md` immediately after every start and every compaction, before
dispatching any task. That section is written for a session that has just lost its context —
imperative, short, and first in the file. A Codex or pi leader that skips it is not covered by the
hook, which is why the first section is a requirement of the guide, not a nicety.

## Standing loops the leader runs

Two recurring checks keep a campaign moving when no push arrives. They are **session state**: a hook
runs once per event and cannot schedule, and a machine cron cannot talk to the session, so a loop dies
when the session ends or its context is cleared. The guide therefore orders the leader to re-create
them on every start, resume and compaction: run `CronList`, compare what is scheduled against the
guide's list, and re-create whatever is missing.

**Loop A — bottleneck check.** A recurring cron job at `*/10 * * * *` (every ten minutes). Prompt,
verbatim: "check every 10 minutes if you are not a bottlenect and if Xezar tasks are not waiting for
you". Tasks stop at questions, review verdicts and merge steps that only the leader can move; the
loop makes the leader read `leader_events` `status` / `read` and `task_read` `list` even when no push
arrived, which is exactly the case after a compaction. A tick that finds nothing to move is a noop.

**Loop B — usage-limit watch.** A self-paced `/loop` (a ScheduleWakeup of 3600 s, with noop ticks
when nothing changed). Prompt, verbatim: "check every hour if the new limit is available and resume
the work when it is available". When an account hits its usage limit, the leader re-probes at the
reset time with one tiny task per account, updates the account table in the campaign `README.md`,
cancels a wrong auto-resume (a weekly reset can be scheduled one day early, #581), and re-dispatches
the held work.

Rules that make the loops safe:

- **The owner asks for a loop; the guide only re-creates it.** A loop exists because the owner
  requested that recurring check, and the guide's job is to restore what the owner asked for — never
  to invent new recurring work.
- **A tick that changes nothing is a noop.** Neither loop dispatches new scope; they only unblock
  work that is already waiting.
- **A cron job expires after seven days** and must be re-created, which is one more reason the guide
  carries the cadence and the prompt rather than relying on the job's own memory.

Why not a hook: Claude Code hooks fire once per event and cannot schedule, and an operating-system
cron cannot reach into the session. The guide's re-create order is the only durable mechanism.

## How to install it in a NEW project

1. **Copy the loader.** Put `leader-context.sh` at the project's own kit path (`.xezar/checks/` in a
   xezar kit) and keep its guard logic unchanged. Change only the paths it reads if the project uses
   different ones; the four guard rules are the mechanism and travel as they are.
2. **Add the hook.** Create `.claude/settings.json` with the `SessionStart` block above: the four
   matchers `startup|resume|clear|compact`, and a command that runs the loader.
3. **Un-ignore exactly that one file.** The project's `.gitignore` ignores `.claude/*`; add
   `!.claude/settings.json` and nothing else, so per-machine `.claude/` state (locks, worktrees,
   `settings.local.json`) stays uncommitted while the hook travels with a clone.
4. **Write the guide from the template outline.** Start with the Codex/pi first section, then:
   standing rules and patterns; recovery steps for a restart or a compaction; owner-only decisions;
   how to write a task brief; and a short pre-dispatch checklist. Cite the source of every rule
   (issue number, dated decision) instead of asserting it, and keep the whole file under the cap.
5. **Put campaign notes under `.local/xezar/campaigns/<release>/`.** `README.md` is live state,
   rewritten at every milestone; `decisions.md` is append-only owner words with date and channel.
   Both are runtime and stay uncommitted.
6. **Write the standing loops into the guide's checklist.** Record each recurring check the owner
   asked for with its prompt and its cadence, plus the re-create order (list, compare, re-create),
   so a new session restores them instead of relying on the loop's own memory.
7. **Verify with the test.** Run the loader's fixture case and confirm the primary is loud and all
   three agent shapes are silent. If the project's docs changed, run its link checker as well.

## How to keep it honest

- **The guide cites its sources.** A rule without a source is an assertion; the next session cannot
  tell whether it is current. Link the issue, the decision record or the dated owner words.
- **Owner words stay verbatim in `decisions.md`.** Quote, date and name the channel; never paraphrase
  an authority and never edit or reorder a past entry. The guide may summarize a decision, but the
  authority lives in the decision file.
- **Update the guide when a rule changes.** The guide is part of the change, not a follow-up task: a
  session that reads a stale rule will act on it. A decision that changes the product also belongs in
  the project's own decision log or issue — the campaign file is a coordination aid, never the only
  copy.
- **Reconcile the older campaign path.** [campaign-notes.md](campaign-notes.md) still describes a
  `.local/xezar-campaigns/<date-slug>/` folder; the owner rule of 2026-09-18 puts everything
  uncommitted and xezar-related under `.local/xezar/`, and the loader reads the newest folder under
  `.local/xezar/campaigns/<release>/`. The two paths are a recorded reconciliation, not a silent
  override.

## What this dogfooding proved

- **2026-09-18 — a root `CLAUDE.md` leaked into task worktrees.** A local `.claude/CLAUDE.md` at the
  repository root was picked up by every worktree session through Claude Code's parent-folder walk,
  so a task agent received leader instructions it must not have, and there was no per-worktree way to
  mute it. This is why the guide is loaded by a hook with an explicit guard rather than by an
  imported instruction file.
- **2026-09-18 — the MCP bridge needed `/mcp` after the mode switch.** Switching the project into
  single-project mode invalidated the running Claude Code session's MCP connection; the leader could
  not attach again until the bridge was reconnected with `/mcp` and a new session was started. The
  guide's recovery section records the step, because a mode switch is exactly the kind of change that
  otherwise costs a session.
- **2026-09-18 — a committed hook is what travels.** A local-only hook (in the uncommitted
  `settings.local.json`) works on the machine that wrote it and does not travel with a clone; a
  memory file lives on one machine and on one tool. Only a committed `.claude/settings.json` plus a
  committed script gives a new clone the same leader context, which is what makes this a standard for
  onboarding a project rather than a personal convenience.
