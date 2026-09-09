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

### 2026-09-09 — issue #31, single agent step (`quick-task`, no kit workflow) — adapted / fixture-tested

- Goal: add the `release` workflow, `xezar-release-changelog` and `xezar-release-publish` skills and `checks/changelog-check.sh` so one task releases a patch/minor/major with no hand-written changelog brief. Kit-only; engine, `.github/` and `scripts/release.mjs` untouched.
- Observed: `catalog-check.mjs`'s writing-workflow phase contract (#116) requires the step after `evidence` to carry the id `handoff`. The brief asked for `publish`; the step keeps that id (`handoff`) with the publish skill and name, and the YAML says why. A kit brief that names step ids should be checked against that contract before it is issued.
- Observed: a fresh task worktree carries no tags (`git describe --match 'v*'` on `origin/main` answered `v0.11.0` while `origin` holds `v0.11.1`), so the changelog skill fetches `--tags` first. Also observed the version-arithmetic trap the publish skill guards in step c: `main` still held `0.11.0` in `packages/xezar/package.json` while npm served `0.11.1`, because the bot's `release/v0.11.1` bump PR (#32) had not merged; `bump: patch` from that state would rebuild a published version.
- Fixture-tested: 13 synthetic changelog cases in `infra-tests.sh` (two `# Unreleased`, one below a dated heading, fenced and second-level headings ignored, `--require-version` shapes, missing file); a stub check that always exits 0 turned the 7 refusal cases red and left the 6 acceptance cases green, so the acceptance cases are guards, not proofs. The contract test's pinned counts moved to 14 workflows / 16 skills.
- Not verified: no real `release` run. `gh pr merge --match-head-commit`, `gh run watch --exit-status`, the `actions/runs/<id>/approve` call and the `production` environment wait are transcribed from `gh` documentation and docs/publishing.md, not observed from a task. The first real run, ideally `dry-run: true`, is the next trigger; record its evidence here.
- Remaining limit: the last step must fit every wait inside the agent's own session budget (issue #22 removes only the 30-minute kill for the final step); a Release run held at a required reviewer for hours is an untested duration.

### 2026-09-09 — issue #28, single agent step (`quick-task`, no kit workflow) — real-task verified

- Goal: kill the intermittent CI failure of `github.test.tsx › the follow-up prompt template menu (#413) › inserting a second template stacks it below the first`. Code head `5e8b30c` (v0.11.2), branch `xez/ba65de24`, Node 24 / npm 11, macOS.
- Observed: the flake was a **test** defect, not a product one, and not the obvious "asserted too early". The helper used *"the option node unmounted"* as proof that the insert had landed. That proxy is false: `insertPromptTemplate` restores focus to the textarea inside a `requestAnimationFrame`, Radix dismisses an open popover when focus lands outside it, and a frame deferred by a loaded runner therefore closes the **next** menu with nothing selected. The helper read the empty menu as success and returned without ever clicking.
- Evidence: an in-suite probe (menu open, `textarea.focus()`) printed `option present: true` → `false`, so the dismissal is real in jsdom rather than inferred. Reverting the helper body alone, with the new regression test kept, reproduced the CI diff byte for byte.
- Lesson (recommended): in this cockpit's suite, **never wait on a popover/menu disappearing as proof that its action ran.** Closing is a side effect a dismiss layer can produce on its own. Wait on the state the action was supposed to change — here the textarea value — and re-drive the interaction (reopen, re-click) until it does. The same shape applies to every Radix `Popover`/`Command` picker in `packages/web`.
- Observed: the "prove the regression test fails without the fix" rule needs an adaptation when the fix and the test live in the same file — `git stash push -- <file>` removes both. Reverting only the fixed helper body while keeping the new test is the honest equivalent, and it is worth saying so in the PR body rather than claiming a stash proof that was not run.
- Regression/control: the new deterministic case queues `requestAnimationFrame` callbacks, releases them with the menu open, asserts the menu really was dismissed, then requires the pick to land. The whole file passed 30/30 consecutive runs (120 tests each) after the fix; the full canonical gate passed on the committed tree.
- Remaining limit: one macOS machine and jsdom only. The fix removes the test's dependence on the timing, but it was never reproduced on the actual ubuntu-latest runner, so "the CI flake is gone" stays an inference from the mechanism plus 30 local runs, not an observation of CI under load.
