# Software delivery process

## Purpose

This file documents how work flows from ticket to merged PR in this repository. The agent skills configured in `.ai/agentic.config.json` enforce the process; humans read it here. PRs target `main`; issues and PRs live in GitHub, and every tracker operation runs through the `gh` CLI.

**Contributing as a person?** Start with [CONTRIBUTING.md](CONTRIBUTING.md). The `om-*` skills named below are this project's internal automation; you do not need them.

Work enters through two paths: a free-form task brief handed to an agent, or a filed ticket. Both converge on the same review loop, the same validation gate, and the same merge gates.

## Roles

- **Author** — the human or agent who writes the change. Owns the ticket from claim to a merge-ready PR.
- **Reviewer** — reads the diff and approves or requests changes. May be a human or the `om-auto-review-pr` skill; the `om-code-review` checklist applies either way.
- **QA reviewer** — manually exercises user-facing changes before they merge. Always referenced by role, never by name or handle: assignments change.
- **Maintainer** — owns branch protection, the label taxonomy, the config, and this document; arbitrates when gates conflict.

## Ticket lifecycle

| Stage | What happens | Driven by | Done when |
|---|---|---|---|
| Intake | A ticket or task brief is filed in GitHub with enough detail to act on. | Anyone | Ticket exists |
| Triage | Confirm the issue is real, still unfixed on `main`, and not already claimed or covered by an open PR. Read-only; stops the chain cleanly when there is nothing to do. | `om-verify-in-repo` or a human | Confirmed actionable, or closed as no-action |
| Claim | The author claims the ticket so concurrent agents back off. See the claim protocol below. | `om-fix` / `om-auto-create-pr`, or a human | Claim visible on the ticket |
| Implement | Locate the minimal change surface (`om-root-cause`, read-only), then implement the change with regression tests and run the validation gate. Task briefs without a ticket go through `om-auto-create-pr`, which plans, implements phase by phase in an isolated worktree, and runs the same gate. | `om-root-cause` + `om-fix`, `om-auto-create-pr`, or a human author | Change complete, validation gate green |
| PR | Commit, push, and open a PR against `main` with normalized labels. On a hand-worked branch, `om-check-and-commit` runs the gate, fixes obvious drift, and pushes when green. | `om-open-pr`, `om-auto-create-pr`, or `om-check-and-commit` | Open, labeled PR |
| Review loop | The reviewer reads the diff against the `om-code-review` checklist and approves or requests changes. Requested changes are addressed (`om-auto-continue-pr` resumes agent PRs from the tracking plan) and the PR is re-reviewed until approved. | `om-auto-review-pr` (single PR), `om-review-prs` (sweep), or a human | Approving review submitted |
| QA | A PR carrying `needs-qa` waits for manual QA. A QA reviewer tests it and records the outcome. See the QA gate below. | QA reviewer (manual) | `qa-approved` applied, or the failure is recorded in a PR comment and `merge-queue` removed, which routes it back |
| Merge | `om-merge-buddy` reports, read-only, which PRs can merge now and which are close but blocked. `om-approve-merge-pr` re-checks every gate, approves, and squash-merges. | `om-merge-buddy` + `om-approve-merge-pr`, or a human | PR squash-merged into `main` |
| Post-merge housekeeping | Close issues the merged PR fixes; comment on issues whose PRs were closed without merging; turn leftover asks or review comments into tracked follow-up issues. | `om-close-fixed-issues`, `om-followup-issue-from-pr` | Tracker reconciled, follow-ups filed |

## Label state machine

This section lists only labels that exist in `qodeca/xezar`. Verify with `gh label list --limit 200`, and create a label before this document tells anyone to apply it — a step that names a label the repository does not have stops the flow at its first `gh` call. The reproducible create list lives in `.ai/trackers/github.md` under **ensure-label-taxonomy**.

Pipeline labels are mutually exclusive: a PR carries at most one, and it names where the PR sits in the flow. This repository defines two.

- A ready, non-draft PR carries `review`.
- The reviewer approves and moves it to `merge-queue`. To request changes there is no label: the reviewer submits the review comments and removes `review`, and the author restores `review` when the fixes are pushed.
- `merge-queue` is routing, not proof of QA: a `needs-qa` PR legitimately sits there until QA signs off.
- A QA reviewer who picks up a queued `needs-qa` PR says so in a PR comment rather than in a label — there is no `qa` label. On a pass they apply `qa-approved`. On a failure they remove `merge-queue` and post what failed; there is no `qa-failed` label either.
- To stop a PR wherever it is — a dependency, an unresolved decision, a deliberate hold — remove `merge-queue` and convert the PR to draft, saying why in a comment. Draft is the hard block, and it is enforced in code: `.xezar/checks/integration-preflight.sh` refuses to merge a draft PR. There is no `blocked` or `do-not-merge` label here.

| Group | Labels | Exclusivity | Meaning |
|---|---|---|---|
| Pipeline | `review`, `merge-queue` | one at a time | Workflow state |
| Category | `bug`, `enhancement`, `refactor`, `testing`, `documentation` | additive | Kind of change |
| Meta | `needs-qa`, `skip-qa`, `qa-approved`, `qa-self-verified`, `in-progress` | additive | Process signals |
| Priority | `priority-high` | opt-in; unset = ordinary urgency | Urgency of the work |
| Risk | `risk-high` | opt-in; unset = ordinary blast radius | Blast radius of the change |

Two more labels sit outside the change taxonomy and mark issues only: `epic` for a tracking issue with sub-issues, and `release-<version>` for work planned into a named release. A kind of change with no matching category label simply carries none; say what it is in the PR title and body instead of inventing a label.

Priority is how urgent the work is; risk is how dangerous the change is to ship, and the two are independent: a one-line fix for a broken cockpit can be `priority-high` without being `risk-high`, and a large runner-seam refactor that can wait is `risk-high` without being `priority-high`. Both are single opt-in flags rather than scales — there is no low or medium label, and an unlabelled PR is ordinary on both axes. A PR inherits both from its source issue unless the scope clearly changed. When an automated skill adds or changes a pipeline or meta label, it leaves a short comment explaining why.

Apply `priority-high` when the work is a security fix, a release-blocking regression, or a break in the published CLI (`npm install -g @qodeca/xezar` or `npx @qodeca/xezar` fails) or in `.local/xezar/` state. Leave it off otherwise.

Apply `risk-high` when the change touches the runner seam (`packages/xezar/src/core/agent-runner.ts`), worktree or branch handling, the `.local/xezar/` state file formats, the per-user workspace file `~/.xezar/config.json` (its schema, its defaults, or what an absent key resolves to — it is shared by every xezar this user runs across every repo, and it carries the project registry), or the HTTP API surface, or when it edits broadly across the tree. Leave it off for an ordinary single-area change and for docs-only work.

When signals conflict, apply the flag and say why in the label comment. A `risk-high` PR strengthens the case for `needs-qa` and deeper review even when it would otherwise look routine.

There is no `do-not-close` label. Housekeeping closes an issue only when a merged PR explicitly says it fixes it, so an issue that must survive a related merge is kept open by leaving `Fixes #<n>` out of the PR body and linking the issue in prose instead. A maintainer reopens anything closed in error.

## The QA gate

The one hard rule of this process: **a PR carrying `needs-qa` must not merge until it also carries `qa-approved`, even when every other check is green.** `om-merge-buddy` classifies such a PR as blocked; `om-approve-merge-pr` refuses to merge it.

- Apply `needs-qa` to cockpit UI changes, new features, and other user-facing behavior that needs manual exercise (a `XEZ_DRY_RUN=1` session covers most cockpit flows without a real `claude` login).
- `skip-qa` is the explicit opt-out for docs-only, dependency-only, CI-only, and similarly low-risk non-user-facing changes. Never combine it with `needs-qa`.
- A failed QA run is a hard block regardless of every other signal: the QA reviewer removes `merge-queue`, posts what failed, and removes `qa-approved` if it was applied in error. Never merge under an active tester — a tester who has picked the PR up says so in a comment, and that comment blocks the merge until they post the outcome.
- The merge guard `.xezar/checks/lib/project-policy.mjs` additionally refuses any PR carrying `blocked`, `do-not-merge`, `qa` or `qa-failed`. This repository does not define those labels and this document never tells anyone to apply one; the check is a fail-safe for a fork that does define them, not a step in this flow.
- The gate is satisfied when a QA reviewer tests the PR and applies `qa-approved`.
- **Self-QA exception**: when no QA reviewer has capacity in time, any engineer may sign off instead — but only by (1) checking the PR out and running it locally, (2) exercising the affected flow, and (3) attaching evidence to the PR: a screenshot of it working, or a written account of what was exercised and the observed result. Then apply both `qa-approved` (so the gate passes) and `qa-self-verified` (so the exception is auditable). No evidence, no `qa-approved`.

## The claim protocol

Before mutating an issue or PR, an agent claims it with all three signals: it assigns itself, adds the `in-progress` label, and posts a claim comment saying what it is doing. Any agent that finds an existing claim backs off instead of colliding. A PR carrying `in-progress` is also skipped by the merge tooling.

The claim is released when the work finishes — on success and on failure alike. A stale `in-progress` with no recent activity may be cleared by the maintainer.

## Validation gate

Every PR passes the full validation gate before review sign-off, in this canonical reporting order:

- `npm run typecheck`
- `npm test`
- `npm run test:unit`
- `npm run build`
- `npm run test:package`

Dependency installation runs alone. The canonical kit runner may then overlap three lanes: `typecheck → build → test:package`, `npm test`, and `npm run test:unit`. Join all lanes before `.xezar/checks/repository-checks.sh` (actual catalog, changelog and contract checks). Run `bash .xezar/checks/infra-tests.sh` locally as well for kit-check/workflow changes; its unconditional `Xezar infrastructure fixtures` CI job is required on every PR. Serial execution remains valid. Preserve the Vitest worker cap, execute every required command even after an ordinary gate failure, and leave cancelled command phases or unrecordable attempts incomplete. Atomic result publication is the completion commit point: if it finishes before a deferred cancellation is handled, retain and report the completed verdict. Only one reducer writes aggregate gate evidence. This schedule changes no command or acceptance requirement.

Any non-zero exit fails the gate and blocks the PR. `npm test` is the fast server + cockpit unit/component suite (vitest) and `npm run test:unit` the node:test core-module suite; the build includes the `check:pack` tarball gate, and `npm run test:package` builds a release tarball, installs it into an isolated consumer, and exercises the offline CLI workflow. User-facing changes also need the separate real-browser QA (`npm run test:e2e`) described by the QA gate. The implementing skills run the configured gate before opening a PR, and `om-check-and-commit` runs it before pushing a hand-worked branch. The command list lives in `.ai/agentic.config.json`; when it changes, update it there and in this section together.

### The MCP test floor

Everything the MCP server does – `packages/xezar/src/mcp/**`, `packages/contract/src/mcp-*.ts` and the MCP routes in `packages/xezar/src/server/server.ts` – carries two requirements, and a PR that touches it meets **both**. Meeting one and missing the other is a fail. (#333)

1. **The coverage floor.** Every source file under `packages/xezar/src/mcp/` has at least 80 % line coverage **and** at least 80 % branch coverage, per file, from the MCP suites alone. `npm run test:coverage:mcp` measures it – the MCP test files under `packages/xezar/src/mcp/`, `server/mcp-*` and `server/stale-write-routes`, with the v8 provider – and exits non-zero naming each file below the floor. Per file, because an average hides a file at 40 % behind one at 100 %. Branches as well as lines, because a line that ran says nothing about the decision on it. From the MCP suites alone, because coverage a module picks up from an unrelated test was never aimed at it. The contract's `mcp-*.ts` schemas and the MCP routes in `server.ts` are held by behaviour instead of by a percentage – v8 counts every line of a zod declaration as covered the moment it is imported – so each refinement, transform and route has a test that makes it refuse, named in `docs/testing/coverage-gaps.md` § 10. 80 % is a floor, never a target.
2. **Tests that would fail.** Every test a PR adds or changes on this scope is shown failing without the behaviour it covers. The PR names the break – the file, the line and the change: a flipped condition, a swapped operator, a deleted call – and quotes the assertion that failed. A reviewer re-applies the break and runs the test. A test that stays green with its behaviour broken is not coverage, whatever the percentage says; one that pins a behaviour nobody should change and passes either way is allowed, and the PR says which it is.

A PR on this scope leaves every file it changes at or above the floor, lowers no file's numbers, and quotes the command's result in its body. A file below the floor that the PR does not change is still a debt, not a pass: it is either exempt or listed as sequenced work in `coverage-gaps.md` § 10, with the issue or PR that ends it.

The floor refuses: a file below it with no written exemption or sequencing record; a new or changed test with no named break in its PR; a test that asserts nothing its code could get wrong – it checks that a call returned, or a value the code cannot produce any other way; a vitest test that duplicates a behaviour already held by a suite v8 cannot see (`npm run test:unit`, `npm run test:package`, `npm run test:e2e`, the real-client harness) – record that suite in `coverage-gaps.md` instead; and a `v8 ignore` comment, an `exclude` entry or a lowered threshold used to reach the floor. A comment, an `exclude` entry or a lowered threshold is an exemption like any other and needs the record below.

**Exemptions are written down or they do not exist.** A file below the floor carries an entry in `docs/testing/coverage-gaps.md` § 10 naming the uncovered branches, why no real test reaches them, what does hold the behaviour if anything does, and the event that ends the exemption. "Hard to test" is not a reason. An exemption answers the floor only; it never excuses a test that cannot fail.

`npm run test:coverage:mcp` is a required check for a PR on this scope, not a sixth command of the gate above: it stays out of `.ai/agentic.config.json` and CI until it passes on `main`. This subsection adds requirements and removes none. It changes no command in the gate above, and no exemption, label or request for permission waives a mandatory check (F-22).

## Amending this process

This document and `.ai/agentic.config.json` describe the same process: change them together, and re-run the `om-setup-agent-pipeline` skill when the toolchain or label taxonomy changes. Per-skill deviations — extra review rules, a different PR body template, an added gate step — belong in a repo-local skill of the same name at `.ai/skills/<skill-name>/SKILL.md`, which takes precedence over the installed skill (and can `@`-import or reference it to extend rather than replace it); local rules win, but a repo-local skill cannot grant what the installed skill's safety rules forbid.
