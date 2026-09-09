# Learn the recommended way of working through real Xezar development

Every future authorized feature/bug/docs task is also an opportunity to assess the workflow, skill and effective settings it actually uses. Do not launch an extra goal merely to fill this ledger. The leader preserves the feature's AC and records concise operational observations alongside its delivery evidence.

Four evidence levels, never conflated: **adapted** (installed and statically checked), **fixture-tested** (named isolated case passed on identified kit bytes), **real-task verified** (observed in an actual authorized task, with runtime/kit/result evidence), **recommended** (reviewed guidance justified by real-task results and known limits). Copying or a green fixture is insufficient for a recommendation.

Record: task/goal and criterion, workflow/skill/effective config, code head/base, runtime/build and kit digest, expected behavior, observed behavior, evidence link, problem/impact, hypothesis/change, regression or control, outcome, remaining limit, owner/next trigger. Keep private logs in primary .local/xezar-tasks; publish only safe conclusions in this maintained guidance. Missing tokens/cost/timing remain unknown.

Loop: observe during real work → classify problem versus environment/unknown → fix the narrow workflow/skill/check/config cause within authority → test the regression and unchanged quality → validate in a later relevant real task → record the bounded recommendation and limits. Do not schedule fixed reviews, weaken gates, fabricate performance benefits or overwrite active snapshots. Recommendations can be revised with rationale and evidence; not every one-off brief needs a permanent skill.

Installation validation is reported in installation.md. Real-task entries follow; each names its evidence level.

## Real-task entries

### 2026-09-09 — issue #18, single agent step (`quick-task`, no kit workflow) — real-task verified

- Observed: `worktree-preflight.sh` (strict and `--readiness`), `worktree-setup.sh` and `repo-gates.sh --fast` ran standalone from a plain agent step. Setup on npm 11 prints "install-scripts not yet covered by allowScripts" warnings (esbuild, fsevents); they do not block.
- Observed: the fast gate recorded `failed` because a parallel issue (#19) broke five project-registration test files unrelated to the change. The attempt stays unsealed. The kit has no "known-unrelated failure" notion, so a blockage by a peer task always shows as an unsealed attempt and the leader decides (here: CI in a plain checkout is the gate). That conservative behaviour is correct; do not add a waiver knob.
- Observed: the red-then-green proof works with the shared stash stack when the stash is tagged, applied by SHA and dropped by tag; a bare `git stash pop` is unsafe with peer worktrees.
- Remaining limit: this entry covers one bugfix task with unit tests only; no UI smoke, no kit workflow steps, no root-sync or integration role was exercised.

### 2026-09-09 — issue #27, single agent step (`quick-task`, no kit workflow) — real-task verified

- Observed: the full canonical gate (`repo-gates.sh --fast`: typecheck, `npm test`, `test:unit`, build, `test:package`, infra fixtures) passed inside a task worktree on macOS for the first time, on Node 24.20 / npm 11.19, after the two test fixes in #27. Before the fix `test:unit` was the only red command; the cause was in the tests, not in the scratch relocation from #23.
- Observed: `--record-gate-evidence` refuses to seal while the tree has uncommitted changes and asks for a commit plus a gate re-run. A single agent step therefore runs the gate twice: once as a development check, once after the commit for the seal. That is the correct conservative order; do not seal a pre-commit run.
- Observed: the `.xezar/checks/worktree-setup.sh` exit code is lost through a pipe in zsh when read via `PIPESTATUS`; zsh spells it `pipestatus`. Read the `SETUP OK` line, or capture the status without a pipe.
- Lesson (recommended): any test that spawns a child from inside the scratch dir must resolve loaders to an absolute URL and compare real paths in main-module guards, because scratch may sit under a symlinked OS temp dir. Recorded in `docs/testing/local-data.md`. A guard test using an explicit symlink now pins this on every platform, including Linux CI where scratch stays in-repo.
- Remaining limit: one macOS machine; Windows was not exercised, and no UI smoke or kit workflow step ran.
