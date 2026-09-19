# Software delivery process

## Purpose

This file documents how work flows from ticket to merged PR in this repository. The kit workflows in `.xezar/workflows/` and their `xezar-*` roles enforce the process, reading the shared pipeline config in `.xezar/pipeline/config.json`; humans read it here. PRs target `main`; issues and PRs live in GitHub, and every tracker operation runs through the `gh` CLI.

**Contributing as a person?** Start with [CONTRIBUTING.md](CONTRIBUTING.md). The `xezar-*` kit roles and `.xezar/workflows/*` named below are this project's internal automation; you do not need them.

Work enters through two paths: a free-form task brief handed to an agent, or a filed ticket. Both converge on the same review loop, the same validation gate, and the same merge gates.

## Roles

- **Author** — the human or agent who writes the change. Owns the ticket from claim to a merge-ready PR.
- **Reviewer** — reads the diff and approves or requests changes. May be a human or the `code-review` workflow (`xezar-code-review`); the CODE_REVIEW.md checklist applies either way.
- **QA reviewer** — manually exercises user-facing changes before they merge. May be a human or the read-only `qa` workflow (`xezar-qa`), which posts a `## QA` comment. Always referenced by role, never by name or handle: assignments change.
- **Design reviewer** — reviews UI-in-scope work against `docs/design-system/` and the design's handoff before it merges. Never the author of the change. May be a human or the `design-review` workflow (`.xezar/skills/xezar-ux-design.md` in review mode); referenced by role, never by name.
- **Maintainer** — owns branch protection, the label taxonomy, the config, and this document; arbitrates when gates conflict.

## Campaign notes

A campaign is a set of related issues and PRs the project leader drives over several sessions. Keep one Markdown note per campaign in the **primary checkout** at `.local/xezar/campaigns/<yyyy-mm-dd>-<slug>.md`, so reclaiming a task worktree cannot remove it. The root `.gitignore` rule `/.local/` already ignores this runtime state; no new ignore line is needed. Xezar must still start and work without these notes – they are written during coordination, never required configuration.

Claude Code memory or Codex memory may hold a pointer to the campaign file, never its only copy: leader-tool memory is per machine and per tool. The in-session task list is the short view; the file is the full view that survives a new session or context-window compaction.

Keep these records in the note:

- **Done** – completed items and their outcomes.
- **Open items** – for every item, the issue, PR and current head SHA, Xezar run id(s), last verdict and the single next step. Say `none` or `unknown` where a reference or verdict does not yet exist; do not omit the field.
- **Owner decisions** – the date and the owner's exact words, with a link to the issue or decision record where applicable.
- **Standing rules** – runner routing, gate cap, merge order and attribution rules for this campaign.
- **Restart and re-attach** – the checkout, verified cockpit start command and connection details, and the steps to re-attach the leader and reconcile active runs. Record no credentials; label unverified instructions as such.

Update the note at every milestone – a merge, a review, QA or design verdict, an owner decision, a new item or a blocker. Updating it is the last act of handling that event, **before reporting to the owner**.

Reading the note is the first act of a new session and the first act after compaction, **before dispatching any task**. In its first message, the leader states which campaign file it read. Reconcile recorded heads, verdicts and running tasks with current state before acting; mark missing information as unknown rather than reconstructing it from memory.

The note is a coordination aid, not evidence. Task evidence stays in the primary checkout's `.local/xezar-tasks/<runId>/`; decisions that change the product go to [the decision log](docs/design-system/decisions.md) or the issue. A checkpoint still names the run id under the [parallel-work guidance](.xezar/docs/parallel-tasks.md). Link to those records from the note; maintained documentation must not depend on a private campaign file.

Use this short template, filling in the campaign's actual references and instructions:

```md
# <Campaign name>
Updated: <date and time>

## Done
- <Issue / PR – outcome>

## Open items
- Issue: <#>; PR: <#>; head SHA: <sha>; Xezar run id(s): <ids>
  Last verdict: <kind, result, source>; next step: <one action>
  Blocker: <none or dependency / missing decision>

## Owner decisions
- <yyyy-mm-dd> – "<exact words>" – <record link>

## Standing rules
- Runner routing: <rule>; gate cap: <rule>
- Merge order: <rule>; attribution: <rule>

## Restart and re-attach
- Checkout / cockpit start command / connection: <verified details>
- Leader re-attachment and active-run reconciliation: <steps>
```

## Ticket lifecycle

| Stage | What happens | Driven by | Done when |
|---|---|---|---|
| Intake | A ticket or task brief is filed in GitHub with enough detail to act on. | Anyone | Ticket exists |
| Triage | Confirm the issue is real, still unfixed on `main`, and not already claimed or covered by an open PR. Read-only; stops the chain cleanly when there is nothing to do. | `issue-triage` workflow (`xezar-issue-triage`), or a human | Confirmed actionable, or closed as no-action |
| Design | For feature-sized UI (a new screen, surface, component or pattern) the author produces `designs/<feature>/` — static mockups showing every state per `docs/design-system/new-designs.md` §4 plus the README handoff — and a design reviewer reviews it. Fix-sized UI (a bug, a visual discrepancy, a documented `G-nn` rule applied) skips the mockup and is design-reviewed on its PR. Non-UI work skips this row. | `design` workflow + `design-review` workflow, or a human | `designs/<feature>/README.md` status is Approved, or the ticket says the change is fix-sized |
| Claim | The author claims the ticket so concurrent agents back off. See the claim protocol below. | A human or the leader (the kit workflows do not claim; the optional `xez-*` collection does, per `.xezar/pipeline/trackers/github.md`) | Claim visible on the ticket |
| Implement | Locate the minimal change surface (`xezar-bug-investigation`, diagnosis before repair), then implement the change with regression tests and run the validation gate. Task briefs without a ticket go through the `feature-implementation` workflow, which plans, implements in an isolated worktree, and runs the same gate. | `bug-fix` workflow (`xezar-bug-investigation`), `feature-implementation` workflow (`xezar-implementation`), or a human author | Change complete, validation gate green |
| PR | Commit, push, and open a PR against `main` with normalized labels. On a hand-worked branch, `bash .xezar/checks/repo-gates.sh` runs the gate and the handoff opens the PR when green. | `handoff` step (`xezar-handoff-draft-pr`) of the implementing workflow, or a human | Open, labeled PR |
| Review loop | The reviewer reads the diff against the CODE_REVIEW.md checklist and approves or requests changes. Requested changes are addressed (the `address-review-findings` workflow, `xezar-review-response`, resumes agent PRs) and the PR is re-reviewed until approved. A PR carrying `needs-design` also gets a design review; see the design gate below. | `code-review` workflow (`xezar-code-review`) per PR, or a human | Approving review submitted |
| QA | A PR carrying `needs-qa` waits for manual QA. A QA reviewer tests it and records the outcome. See the QA gate below. | QA reviewer — a human or the read-only `qa` workflow (`xezar-qa`) | `qa-approved` applied, or the failure is recorded in a PR comment and `merge-queue` removed, which routes it back |
| Merge | `.xezar/checks/integration-preflight.sh` reports, read-only, whether a PR can merge now and what blocks it otherwise. The `integration` workflow (`xezar-integration`) re-checks every gate and squash-merges. | `integration` workflow (`xezar-integration`), or a human | PR squash-merged into `main` |
| Post-merge housekeeping | Close issues the merged PR fixes; comment on issues whose PRs were closed without merging; turn leftover asks or review comments into tracked follow-up issues. | The integrating human or leader; `xezar-integration` verifies issue scope after merge, and `.xezar/docs/close-out.md` sets how each scope item is disposed | Tracker reconciled, follow-ups filed |

## Task phases

The table above says what happens to a **ticket**. This section says what happens inside one **task** — one agent run, or one person's sitting — and what that task writes down. The two describe the same work: a lifecycle stage is delivered by one or more of the phases below.

This section adds no label, changes no gate exception, and adds no command to the validation gate. It names the order the existing pieces run in, and the facts each phase leaves behind so the next one does not have to guess. Where those facts are written — the primary checkout's `.local/xezar-tasks/<runId>/`, never a worktree that can be reclaimed — and the field names are in [.xezar/docs/phase-record.md](.xezar/docs/phase-record.md).

| Phase | What it settles | What it records |
|---|---|---|
| Triage and preflight | The work is real, unclaimed and runnable here; the task is on its own branch in its own checkout. | Capability inventory (which tools, backends and networks are actually available), the chosen **depth**, and the inputs' **maturity** |
| Analysis | What the change must do, in criteria a reader can check. | Accepted acceptance criteria, each with an ID, and the authority that accepted them |
| Discovery and plan | Which files change, which contracts are affected, and how it will be proven. | The plan, plus its plan review — and a UI design review when the change is UI in scope |
| Author | The change itself: code, tests, docs, and a focused self-review. | Commits, the self-review rounds used, and the documentation applicability decision |
| Readiness | Nothing unresolved blocks a gate run. | `BLOCKED` when a required decision, an unavailable check or an exhausted counter stands in the way |
| Canonical checks | The validation gate, with the security assessment resolved **before** any quality verdict. | Complete logs, real outcomes, and the security result as its own record |
| Seal | The evidence belongs to this exact candidate. | The head SHA the evidence was taken at, hashed |
| Handoff | A reviewable PR exists. It changes no content and makes no late commit. | PR number, head SHA, labels and their stated reasons |
| Independent review | Whether the solution is sound, read-only, by someone other than the author. Architecture is a **named section of this review**, not a task of its own: the reviewer checks the boundary changes against the plan, and scales that section by risk. | The review verdict at a named head, with each finding's disposition ([CODE_REVIEW.md](CODE_REVIEW.md)) |
| AC verification | Whether each accepted criterion is actually met. | Each AC ID mapped to the evidence that satisfies it, at the current head |
| QA and design gate | Whether it works, and whether it is the right surface — two different questions. | The `## QA` and `## Design review` comments the gates below already define |
| Integration | Whether every applicable verdict, label and CI check is green at the reviewed head. | The merge commit, and the tracker reconciliation after it |

A required decision that is not yours, a required check that is unavailable, or an exhausted repair counter ends the phase as **blocked**: write the `BLOCKED` record, keep the evidence, let independent work continue, and never proceed by lowering a severity or a threshold. Silence from the owner grants nothing.

### Depth

Three levels. Pick the highest that applies; a small line count or an `enhancement` label alone cannot pull a change down a level.

- **small** — one bounded surface with known behaviour. Short assessments may be combined, and the plan can be a paragraph.
- **standard** — a feature, or several components. Full plan and full independent review.
- **high-risk** — a trust boundary, a state migration, concurrency, API or state-file compatibility, or broad impact across the tree. Adds explicit recovery, compatibility and adversarial evidence, and normally a second reader on the risky part.

Depth scales the weight of each phase, never whether a phase happened: every phase above is accounted for at every depth, including as an explicit "not applicable, because …". A programme larger than one task is split into bounded tasks, not given a fourth level.

Depth and the `risk-high` label answer nearly the same question from two sides — depth sizes the work, `risk-high` warns the reviewer — and they normally agree. A high-risk depth without `risk-high` on the PR says why in the PR body.

### Maturity of the inputs

Maturity is what the task was handed, and it is separate from depth. The ladder is: **issue only** → **accepted analysis** → **complete spec** → **spec plus approved design**.

**A file's existence is not maturity.** A spec that exists but has no readable criteria, no accepted authority, stale dependency assumptions or a missing design is not a complete spec, and a `designs/<feature>/` directory whose README is not Approved is not an approved design. Validate the inputs before discovering the same ground again: exact readable criteria, the authority that accepted them, the contracts the change touches, current dependency assumptions, and applicable design evidence. A missing or stale part returns to targeted discovery. It never quietly becomes permission to start coding.

### Ownership

- **Review roles never edit the author's checkout.** Code review, design review, QA and AC verification are read-only and get their own task on immutable inputs. Findings go back to the original author's repair task, on the original branch and PR.
- **An implementation agent never marks its own work independently approved.** A self-review is the author's own evidence and says so. `qa-approved`, `design-approved` and an approving code review come from someone else — except through the two written self-verification exceptions the QA and design gates below already define, which exist precisely so that the exception is auditable.
- Role is not a backend. Author, reviewer and QA are jobs, not model pins; any available backend may hold any of them, subject to the separation above.

### Self-review inside the author phase, and the repair counters

The author phase carries a focused self-review: assess the plan before editing, assess the completed change, and check it is actually ready for an independent reader. It is an author's own quality step, not a substitute for the independent review, the design review or QA.

**At most two self-review fix rounds per candidate.** Count each round durably before you apply it. An initial assessment and a final verification are not fix rounds.

That budget is a third one, next to the two that already exist, and none of them substitutes for another:

| Counter | Limit | Scope |
|---|---|---|
| Self-review fix rounds | 2 | Inside one candidate's authoring work |
| Workflow gate-repair returns | 2 | A gated workflow returning to development |
| Quality-gate repairs of the same failure | 2 | The same failing check, repeated |

Gate-driven re-entry, a Continue, a switch to a different backend and a replacement run all **continue** an existing count. None of them starts a fresh allowance. Every repair records what triggered it and which counters it consumed. An exhausted counter blocks another repair: stop, report the remaining failure with its evidence, and never lower a severity, a threshold or a mandatory check to get past it (F-22, in [docs/features/mcp-server/mcp-project-leader-requirements.md](docs/features/mcp-server/mcp-project-leader-requirements.md), already says no exemption, label or request for permission waives a mandatory check). Missing or unknown counter history reads as unknown, not as zero, and blocks another repair until it is reconciled. Genuinely new scope needs a new accepted plan — not the same finding under a new name.

### Security before the quality verdict

The security assessment belongs inside the canonical check run, as a named stage of it — not a separate approval, and not an extra workflow step. It produces its own structured result, and that result is read **before** anyone gives a quality verdict. It is required whenever code or security capabilities apply, and it waives no existing policy requirement.

**It is a command.** `.xezar/checks/security-scan.sh` is gate 2 of the canonical list — straight after the install, ahead of every gate that produces a quality signal — and it writes its structured result into the gate attempt. Sealing refuses an attempt that carries no such result, and the seal records its status, so "security was resolved first" is the order the runner executes rather than a claim the author makes. Details and the four statuses are in [.xezar/docs/phase-record.md](.xezar/docs/phase-record.md) § The security result; anything the command cannot answer still goes in a written `SECURITY` record beside it.

- For a code change: use the project-approved dependency, secret and static checks; validate the expected inputs and scope first; run what is available with a bounded execution; classify findings under the rules in [CODE_REVIEW.md](CODE_REVIEW.md) § Security. An unavailable required scanner, a parse error, a change set the stage could not read, or an interrupted scan is recorded as **unknown** — never as a pass.
- A changed trust boundary also gets a human or a security reviewer. Automation cannot prove that an authorization decision is correct.
- For non-code work: record the code-security applicability decision and the artefact that supports it, and run the checks that do fit — source verification, confidential-data handling, claim checking against the supplied criteria. Software fixtures inside otherwise non-code work still get software checks. Mixed work takes the union.
- Discovery must not require new network access or a tool install. An unavailable required capability blocks that stage of the work; it never blocks xezar from starting.

### AC verification is not the quality review

They answer different questions, and one never stands in for the other:

- **AC verification** maps each accepted acceptance-criterion ID to the evidence that satisfies it, at the current candidate head. It is a semantic check of *did we build what was accepted*.
- **The quality review** answers *is this solution sound* against [CODE_REVIEW.md](CODE_REVIEW.md).

A change that is sound and misses an accepted criterion is not done. A change that meets every criterion with a design the review refuses is not done either.

**Who does it today.** The author records the AC mapping in the phase record (`AC_VERIFICATION`), and it is the author's own evidence — a self-verification, which certifies nothing on its own. The independent half is performed by the **reviewer inside the code-review task**, which reads that record as an input and says so when it is absent ([CODE_REVIEW.md](CODE_REVIEW.md) § What a review consumes). There is no separate AC-verification role, and adding one is not planned: a reviewer already holds the immutable candidate and the accepted criteria, and a second read-only task for the same head would duplicate the work without adding an independent reader.

The criteria themselves are an **input**, not something the author invents at this point: readiness refuses a task whose `CRITERIA` record names no criterion ID and no accepting authority.

### Naming the break

[§ The MCP test floor](#the-mcp-test-floor) requires every test on that scope to be shown failing without the behaviour it covers. **The technique is general; the 80 % per-file coverage floor is not.** Every meaningful new behaviour test, anywhere in this repository, names a concrete regression — the file, the line and the change (a flipped condition, a swapped operator, a deleted call) — and records an actual failing run: either before the fix, or after re-applying the break in an isolated fixture. Quote the assertion that failed.

A guard test that pins a behaviour nobody should change may pass both ways and is worth keeping — but the record says which kind each test is, and a test that passes both ways is never the only proof of a regression. AGENTS.md § Changing a mechanism that already works describes how to take the red run; this section generalizes **when it is expected**, not how it is done.

## Label state machine

This section lists only labels that exist in `qodeca/xezar`. Verify with `gh label list --limit 200`, and create a label before this document tells anyone to apply it — a step that names a label the repository does not have stops the flow at its first `gh` call. The reproducible create list lives in `.xezar/pipeline/trackers/github.md` under **ensure-label-taxonomy**.

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
| Meta | `needs-qa`, `skip-qa`, `qa-approved`, `qa-self-verified`, `needs-design`, `skip-design`, `design-approved`, `design-self-verified`, `in-progress` | additive | Process signals |
| Priority | `priority-high` | opt-in; unset = ordinary urgency | Urgency of the work |
| Risk | `risk-high` | opt-in; unset = ordinary blast radius | Blast radius of the change |

Three more labels sit outside the change taxonomy and mark issues only: `epic` for a tracking issue with sub-issues, `design-debt` for an issue that fixes a `docs/design-system/known-gaps.md` entry or a design-review finding deferred at merge, and `release-<version>` for work planned into a named release. A kind of change with no matching category label simply carries none; say what it is in the PR title and body instead of inventing a label.

Priority is how urgent the work is; risk is how dangerous the change is to ship, and the two are independent: a one-line fix for a broken cockpit can be `priority-high` without being `risk-high`, and a large runner-seam refactor that can wait is `risk-high` without being `priority-high`. Both are single opt-in flags rather than scales — there is no low or medium label, and an unlabelled PR is ordinary on both axes. A PR inherits both from its source issue unless the scope clearly changed. When an automated skill adds or changes a pipeline or meta label, it leaves a short comment explaining why.

Apply `priority-high` when the work is a security fix, a release-blocking regression, or a break in the published CLI (`npm install -g @qodeca/xezar` or `npx @qodeca/xezar` fails) or in `.local/xezar/` state. Leave it off otherwise.

Apply `risk-high` when the change touches the runner seam (`packages/xezar/src/core/agent-runner.ts`), worktree or branch handling, the `.local/xezar/` state file formats, the per-user workspace file `~/.xezar/config.json` (its schema, its defaults, or what an absent key resolves to — it is shared by every xezar this user runs across every repo, and it carries the project registry), or the HTTP API surface, or when it edits broadly across the tree. Leave it off for an ordinary single-area change and for docs-only work.

When signals conflict, apply the flag and say why in the label comment. A `risk-high` PR strengthens the case for `needs-qa` and deeper review even when it would otherwise look routine.

There is no `do-not-close` label. Housekeeping closes an issue only when a merged PR explicitly says it fixes it, so an issue that must survive a related merge is kept open by leaving `Fixes #<n>` out of the PR body and linking the issue in prose instead. A maintainer reopens anything closed in error.

## The QA gate

The one hard rule of this process: **a PR carrying `needs-qa` must not merge until it also carries `qa-approved`, even when every other check is green.** `.xezar/checks/integration-preflight.sh` classifies such a PR as blocked; `xezar-integration` refuses to merge it.

- Apply `needs-qa` to cockpit UI changes, new features, and other user-facing behavior that needs manual exercise (a `XEZ_DRY_RUN=1` session covers most cockpit flows without a real `claude` login). A cockpit UI change also carries `needs-design` (the design gate below); the two are different questions.
- `skip-qa` is the explicit opt-out for docs-only, dependency-only, CI-only, and similarly low-risk non-user-facing changes. Never combine it with `needs-qa`.
- A failed QA run is a hard block regardless of every other signal: the QA reviewer removes `merge-queue`, posts what failed, and removes `qa-approved` if it was applied in error. Never merge under an active tester — a tester who has picked the PR up says so in a comment, and that comment blocks the merge until they post the outcome.
- The merge guard `.xezar/checks/lib/project-policy.mjs` additionally refuses any PR carrying `blocked`, `do-not-merge`, `qa`, `qa-failed`, `design` or `design-failed`. This repository does not define those labels and this document never tells anyone to apply one; the check is a fail-safe for a fork that does define them, not a step in this flow.
- The gate is satisfied when a QA reviewer tests the PR and applies `qa-approved`.
- **Self-QA exception**: when no QA reviewer has capacity in time, any engineer may sign off instead — but only by (1) checking the PR out and running it locally, (2) exercising the affected flow, and (3) attaching evidence to the PR: a screenshot of it working, or a written account of what was exercised and the observed result. Then apply both `qa-approved` (so the gate passes) and `qa-self-verified` (so the exception is auditable). No evidence, no `qa-approved`.

## The design gate

The second hard rule: **a PR that is UI in scope carries `needs-design` and must not merge until it also carries `design-approved`, even when every other check is green.** `.xezar/checks/integration-preflight.sh` classifies such a PR as blocked; `xezar-integration` and `.xezar/checks/lib/project-policy.mjs` refuse to merge it. QA and design are different questions — QA shows the change works, a design review shows it is the right surface for the job — so neither label satisfies the other.

**UI in scope** means the diff touches (a) a non-test `.tsx` file under `packages/web/src/routes/` or `packages/web/src/components/`, (b) `packages/web/src/styles/index.css` or `docs/design-system/cockpit.css`, or (c) any file under `designs/`. `packages/web/src/lib/`, `packages/web/src/api/`, test files and `packages/xezar/**` alone are not UI in scope. Every document that names the rule uses this definition.

- The author (or `xezar-handoff-draft-pr`) applies `needs-design` to every PR that is UI in scope. It is required, not optional; `risk-high` or `needs-qa` do not replace it.
- `skip-design` is the explicit opt-out for a UI-in-scope diff whose rendered output is unchanged: a pure refactor, a test-only or type-only change, a copy fix that follows `docs/design-system/writing.md`, or a `G-nn` fix that applies the rule `known-gaps.md` already names. The PR body says which. Never combine it with `needs-design`.
- The design reviewer reviews the PR's head commit against `docs/design-system/` (`known-gaps.md` first, so a known inconsistency is not repeated) and, for feature-sized work, against the design's handoff — in both themes and at 375 px. On a pass they apply `design-approved`. On a failure they remove `merge-queue`, post the findings, and remove `design-approved` if it was applied in error. There is no `design` or `design-failed` label; the policy refuses them as a fail-safe, like `qa` and `qa-failed`.
- **Evidence.** A PR comment whose first line is the heading `## Design review`, carrying: the reviewed commit SHA; the reviewer's role; the themes and widths checked; the verdict — PASS, PASS WITH FOLLOW-UPS or FAIL; and each finding with exactly one disposition: *fixed in `<sha>`*, *filed as #n (`design-debt`)*, or *accepted, because …*. A design that went through the Design stage may instead link `designs/<feature>/README.md` § Design review, which holds the same fields. This is the rule the release definition of done already applies (`docs/releases/0.14.0-definition-of-done.md`, R-8).
- **Self-verification exception.** When no design reviewer has capacity in time, the author may sign off instead — but only by attaching that same comment with screenshots of every state in both themes and at 375 px, then applying both `design-approved` (so the gate passes) and `design-self-verified` (so the exception is auditable), and filing a `design-debt` issue for the post-merge review in the same comment. A release definition of done does not count `design-self-verified` as a review. No evidence, no `design-approved`.
- **The debt loop.** `docs/design-system/known-gaps.md` is the design backlog, not a to-do list: a review records what it finds and does not fix it in passing. A `G-nn` entry becomes a `design-debt` issue when a PR touches the files it names (fix it there or file the issue and link `G-nn`), when two design reviews cite it, or when release prep selects it. Release prep triages the list once per release: each entry is fixed, filed, or kept with a date (name this step in the release brief; `xezar-release-prep` does not carry it yet).

## The claim protocol

Before mutating an issue or PR, an agent claims it with all three signals: it assigns itself, adds the `in-progress` label, and posts a claim comment saying what it is doing. Any agent that finds an existing claim backs off instead of colliding. The kit merge tooling does not read `in-progress`; to hold a PR from merging, convert it to draft (see the label state machine).

The claim is released when the work finishes — on success and on failure alike. A stale `in-progress` with no recent activity may be cleared by the maintainer.

## Validation gate

Every PR passes the full validation gate before review sign-off, in this canonical reporting order:

- `npm run typecheck`
- `npm test`
- `npm run test:unit`
- `npm run build`
- `npm run test:package`

Dependency installation runs alone. The canonical kit runner may then overlap three lanes: `typecheck → build → test:package`, `npm test`, and `npm run test:unit`. Join all lanes before `.xezar/checks/repository-checks.sh` (actual catalog, changelog and contract checks). Run `bash .xezar/checks/infra-tests.sh` locally as well for kit-check/workflow changes; its unconditional `Xezar infrastructure fixtures` CI job is required on every PR. Serial execution remains valid. Preserve the Vitest worker cap, execute every required command even after an ordinary gate failure, and leave cancelled command phases or unrecordable attempts incomplete. Atomic result publication is the completion commit point: if it finishes before a deferred cancellation is handled, retain and report the completed verdict. Only one reducer writes aggregate gate evidence. This schedule changes no command or acceptance requirement.

Any non-zero exit fails the gate and blocks the PR. `npm test` is the fast server + cockpit unit/component suite (vitest) and `npm run test:unit` the node:test core-module suite; the build includes the `check:pack` tarball gate, and `npm run test:package` builds a release tarball, installs it into an isolated consumer, and exercises the offline CLI workflow. User-facing changes also need the separate real-browser QA (`npm run test:e2e`) described by the QA gate. The implementing workflows run the configured gate before opening a PR, and `bash .xezar/checks/repo-gates.sh` runs it before a hand-worked branch is handed off. The command list lives in `.xezar/pipeline/config.json`; when it changes, update it there and in this section together.

### The MCP test floor

Everything the MCP server does – `packages/xezar/src/mcp/**`, `packages/xezar/scripts/pi-leader-extension.ts`, `packages/contract/src/mcp-*.ts` and the MCP routes in `packages/xezar/src/server/server.ts` – carries two requirements, and a PR that touches it meets **both**. Meeting one and missing the other is a fail. (#333)

1. **The coverage floor.** Every source file under `packages/xezar/src/mcp/`, plus `packages/xezar/scripts/pi-leader-extension.ts`, has at least 80 % line coverage **and** at least 80 % branch coverage, per file, from the MCP suites alone. `npm run test:coverage:mcp` measures it – the MCP test files under `packages/xezar/src/mcp/`, `server/mcp-*` and `server/stale-write-routes`, with the v8 provider – and exits non-zero naming each file below the floor. Per file, because an average hides a file at 40 % behind one at 100 %. Branches as well as lines, because a line that ran says nothing about the decision on it. From the MCP suites alone, because coverage a module picks up from an unrelated test was never aimed at it. The contract's `mcp-*.ts` schemas and the MCP routes in `server.ts` are held by behaviour instead of by a percentage – v8 counts every line of a zod declaration as covered the moment it is imported – so each refinement, transform and route has a test that makes it refuse, named in `docs/testing/coverage-gaps.md` § 10. 80 % is a floor, never a target.
2. **Tests that would fail.** Every test a PR adds or changes on this scope is shown failing without the behaviour it covers. The PR names the break – the file, the line and the change: a flipped condition, a swapped operator, a deleted call – and quotes the assertion that failed. A reviewer re-applies the break and runs the test. A test that stays green with its behaviour broken is not coverage, whatever the percentage says; one that pins a behaviour nobody should change and passes either way is allowed, and the PR says which it is.

A PR on this scope leaves every file it changes at or above the floor, lowers no file's numbers, and quotes the command's result in its body. A file below the floor that the PR does not change is still a debt, not a pass: it is either exempt or listed as sequenced work in `coverage-gaps.md` § 10, with the issue or PR that ends it.

The floor refuses: a file below it with no written exemption or sequencing record; a new or changed test with no named break in its PR; a test that asserts nothing its code could get wrong – it checks that a call returned, or a value the code cannot produce any other way; a vitest test that duplicates a behaviour already held by a suite v8 cannot see (`npm run test:unit`, `npm run test:package`, `npm run test:e2e`, the real-client harness) – record that suite in `coverage-gaps.md` instead; and a `v8 ignore` comment, an `exclude` entry or a lowered threshold used to reach the floor. A comment, an `exclude` entry or a lowered threshold is an exemption like any other and needs the record below.

**Exemptions are written down or they do not exist.** A file below the floor carries an entry in `docs/testing/coverage-gaps.md` § 10 naming the uncovered branches, why no real test reaches them, what does hold the behaviour if anything does, and the event that ends the exemption. "Hard to test" is not a reason. An exemption answers the floor only; it never excuses a test that cannot fail.

`npm run test:coverage:mcp` is an unconditional, separate required CI job on every pull request,
with a 10-minute timeout. It is not a sixth command of the local gate above: it stays out of
`.xezar/pipeline/config.json`, so the main validation lane stays fast while CI enforces the floor
without a path-filtered required check that could be skipped. This subsection adds requirements and
removes none. It changes no command in the gate above, and no exemption, label or request for
permission waives a mandatory check (F-22).

## Amending this process

This document and `.xezar/pipeline/config.json` describe the same process: change them together (a checkout that also installs the optional `xez-*` team collection re-runs `xez-setup-agent-pipeline` when the toolchain or label taxonomy changes). `docs/design-system/CONTRIBUTING.md` restates the design gate's triggers; when the gate changes, change it too. Per-role deviations — extra review rules, a different PR body template, an added gate step — belong in the role's own file under `.xezar/skills/`. For the optional `xez-*` team collection they belong in a repo-local override at `.xezar/pipeline/overrides/<name>.md`, which takes precedence over the installed skill (and can reference it to extend rather than replace it); local rules win, but an override cannot grant what the installed skill's safety rules forbid.
