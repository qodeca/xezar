# How work moves through this repository

This page is the process: the stages a change passes through, what each stage settles, and who
decides. It is written for the project leader, the task agents it dispatches and the people who
review their work. How the code is organised, and the rules each area keeps, is in `AGENTS.md`.
The rules a reviewer applies are in `CODE_REVIEW.md`; the public surfaces nobody may break are in
`BACKWARD_COMPATIBILITY.md`.

**The base branch is `develop`; `main` holds released work only.** Every change is a short-lived
branch and a pull request into `develop`, the default branch. A release moves `develop` into `main`.
Nothing merges on its own.

| Pull request | Source branch | Target | Merge method |
|---|---|---|---|
| Feature, fix, docs, changelog | any task branch | `develop` | squash |
| Promotion | `promote/v<version>`, cut at the changelog merge commit | `main` | merge commit |
| Version bump | `release/v<version>`, opened by the Release workflow | `main` | merge commit |
| Hotfix (owner-authorized) | `hotfix/<name>`, from `main` | `main` | merge commit |
| Back-merge, after every merge into `main` | `backmerge/v<version>`, from `main` | `develop` | merge commit |

- `main` and `develop` are never a pull request's source branch, and never deleted on merge.
- The `PR source guard` CI check refuses any other source branch into `main`. Release-class pull
  requests pass `integration-preflight.sh --release`; feature work passes the ordinary preflight.
- A promotion carries exactly what the changelog lists: work merged into `develop` after the
  changelog commit waits for the next release.
- Closing keywords (`Fixes #n`) work only in pull requests into `develop`, the default branch. A
  hotfix's issue is closed by hand after its back-merge.
- The release steps, in order, are in `docs/publishing.md` § Cutting a release.

## The gate

One command runs every gate, in this order, and it is the same list everywhere:

```bash
bash .xezar/checks/repo-gates.sh
```

1. `npm ci` — the install, from the lockfile.
2. `.xezar/checks/security-scan.sh` — the security stage (see § Security before the quality verdict).
3. `npm run typecheck`
4. `npm test`
5. `npm run test:unit`
6. `npm run build` (its last leg, `check:pack`, scans the packed archive)
7. `npm run test:package`
8. `.xezar/checks/repository-checks.sh` — the kit's own consistency checks and `scripts/check-links.mjs`.

There is no lint command, and none is implied. Run the gate in the foreground: a gate left running
in the background when a turn ends is killed with it. On a pull request, the check that gates the
merge is the CI job `Typecheck, unit tests, build, and package`, which runs the same five
application commands. The other CI jobs (MCP per-file coverage, the hosted-server boundary, the
browser e2e suite, the two-project harness) report on every pull request and are not required.

## Task phases

A development task passes through these phases, and each one settles one thing:

| Phase | Settles | Label |
|---|---|---|
| Intake and triage | what the change is, how urgent, how risky, which systems | one category, one `priority-*`, one `risk-*`, at least one platform label; `needs-design` when UI is in scope |
| Design (flagged work only) | the flow and its states, before any code | `design` → `design-approved` or `design-failed` |
| Implementation | the change and its tests, in the task's own worktree | `in-progress` while an agent holds the claim |
| Gates | the full gate list above, green on the head | — |
| Review | a verdict on that head | `review`, `changes-requested` |
| QA | the change works for a user | `needs-qa` → `qa` → `qa-approved` / `qa-self-verified`, or `qa-failed` |
| Merge | the change lands on `develop` | `merge-queue` |

The label set and its descriptions live in `.xezar/pipeline/labels.json`; § Labels says how
they are applied.

`blocked` and `do-not-merge` stop any phase. `ci-monitoring` means a finished run still owes a
CI-result comment; it is not a claim. What each phase writes down, and where, is in
`.xezar/docs/phase-record.md`.

## Labels

Labels are defined in `.xezar/pipeline/labels.json`. A new label is added there in the same
pull request that starts using it. The only labels outside it are the release labels below and
the ones automation owns, such as `mutation-nightly`.

| Group | Rule | Labels |
|---|---|---|
| Category | exactly one | `bug`, `feature`, `refactor`, `security`, `dependencies`, `documentation` |
| Priority | exactly one, set at triage | `priority-low`, `priority-medium`, `priority-high`, `priority-extreme` |
| Risk | exactly one, set at triage | `risk-low`, `risk-medium`, `risk-high` |
| Platform | at least one | `windows`, `linux`, `macos` |
| Pipeline and meta | as § Task phases, § The QA gate and § The design gate say | the phase labels and the meta labels |

**Platform labels** name every operating system where the problem happens or where the change
must work and be verified.

- A problem seen on one system only gets that one label: a Windows-only CI flake gets `windows`.
- A change that touches more than one system gets every one it touches: a fix to the POSIX
  shutdown path gets `linux` and `macos`.
- Behaviour that is the same everywhere gets all three. This includes most engine, cockpit, MCP and
  docs work. Absence of a platform label is never "all"; it means triage is unfinished.
- WSL counts as `linux`. When the failure depends on the Windows host under it, add `windows`
  too.
- The operating system in a bug report's environment block is evidence, not the label. A bug
  reported on macOS whose cause is the same on every system gets all three.
- When work narrows or widens the platforms, for example a reproduction proves a flake is
  Windows-only, the person or agent who learns it updates the labels in the same step.

A pull request copies the platform labels of the issue it fixes, unless its diff changes the
set. Its verification evidence names the system it ran on. A platform that it labels but did
not verify is reported as unchecked, as § Acceptance requires.

**Release labels** (`release-x.y.z`) mark what a release must contain. They come off every open
issue once that release ships; an issue that slipped gets the next release's label or none.

`in-progress` belongs to an active claim only. When a claim is stale, and when another agent may take
the work over, is decided by the claim protocol of the skills that set the label, not here. A label
that outlived its claim (no agent working, no open run) is removed by whoever finds it, with a
comment that says so.

## Security before the quality verdict

The security stage runs second, right after the install and before anything that produces a
quality signal. Its result is resolved before anybody gives a quality verdict: a green test run
on a change that failed its security stage is not a pass. The stage scans the changed files for
secret-shaped content, credential-shaped paths, kill-by-pattern commands and dependency changes,
and records every named trust boundary the change touches, which makes a security reviewer
required. No supply-chain scanner is chosen (`security.provider` is unset in
`.xezar/pipeline/config.json`), so that part reports "not applicable"; choosing one is the owner's
decision.

## Review loop

Every pull request gets a review by a model other than the one that wrote it. The reviewer
approves or requests changes on a named head, as a pull request comment whose first line is
`## Code review`. The author owns the next move after `changes-requested`. At most **two** response
rounds; a third repair round is the owner's decision. Findings that do not break an acceptance
criterion are recorded, not fixed in the same loop.

**Name the break.** A new or changed behaviour test names a concrete regression — the file, the
line, and the change that would cause it — and the author records an actual failing run, quoting
the assertion that failed. A test written after the diagnosis passes against the bug more often
than anyone expects, and a green-either-way test is how the same regression ships twice. Guard
tests that pass both ways are fine and worth keeping; the record just says which kind each one is.

## Self-review inside the author phase, and the repair counters

The author reviews its own diff before it asks for a review: the gate is green, the pull request
body says what changed, why, how it was verified and whether it is risky, and nothing outside the
task's scope moved. Self-review is part of authoring and never replaces the independent review.
Each branch has a repair counter: two repair rounds, then the work stops and goes to the owner.
A fresh branch is not a way around the counter unless the content genuinely changed.

## The QA gate

QA is on for this project. A change carrying `needs-qa` does not merge until QA signs it off with
`qa-approved`. QA evidence is a pull request comment whose first line is `## QA`, naming the
reviewed commit and what was exercised. `qa-failed` is a hard block whatever else is green.
`skip-qa` is allowed only with the reason stated on the pull request. `qa-approved` is never
applied by automation.

## The design gate

**Awake in this project.** UI in scope means the cockpit (`packages/web`) and the CLI's visible
surface: command names, flags, help text, output shapes and exit codes. A change flagged
`needs-design` does not pass review until `design-approved` is present; the design lives in
`designs/<feature>/`, judged against `docs/design-system/`. Rendered output that does not change
takes `skip-design` with the reason. The design gate mirrors the QA gate; neither approval
satisfies the other. It is switched by `gates.designGate` in `.xezar/pipeline/config.json`.

## The QA and design self-verification exceptions

An agent may verify its own work only where this section allows it, and the label says so:
`qa-self-verified` for a change whose only user-visible effect the agent can prove with posted
evidence (screenshots or command output on the reviewed head). The design gate has no
self-approval: `design-approved` needs a named authority other than the author. Both exceptions
are labelled so they stay auditable.

## Security review

A change to a trust boundary is routed to the security-review row of `.xezar/routing.json`
before it merges: the local HTTP API and its loopback and origin guards, the WebSocket and MCP
session binding, the agent environment and secret redaction, the packed npm archive, and every
file `CODE_REVIEW.md` § Security names. The reviewer reads `SECURITY.md` first, so it knows what
this project has promised.

## Architecture review

A change that adds a package, a new runner backend, a new persisted format or a new public route
family gets an architecture review against `AGENTS.md` and `BACKWARD_COMPATIBILITY.md` before
implementation starts, and its decision is recorded under `docs/architecture/`.

## Acceptance

A change is accepted when its acceptance criteria are each shown on the merged head, not when a
tool call finished. Evidence is named: the command and its output, the screenshot, the pull
request comment. A criterion that could not be checked is reported as unchecked, never as met.

## Deploy authority

**Asleep in this project.** xezar ships as an npm package through the manually dispatched
`Release` workflow (`docs/publishing.md`), and a release go is always the owner's decision. The
`deploy` and `rollback` workflows are installed and refuse to run while `deploy.environments` and
`deploy.rollback` in `.xezar/pipeline/config.json` are `[]`; listing a workflow there is the one
line that wakes them.

## Performance budgets

**Asleep.** `performance.budgets` is `[]`; the `performance` workflow is installed and refuses
until the owner writes a budget there. This setup never proposes a number.

## Localisation

**Asleep.** `localisation.locales` is `[]`: the cockpit ships in one language. The
`localisation` workflow is installed and wakes when a locale is listed there.

## Campaign notes

The leader keeps its record in `.xezar/campaigns/<yyyymmdd>-<code-name>/`, committed: the owner's
decisions in their own words, the live state, a daily timeline and the merges. The folder
`future-campaign/` is reserved and never live. Opening a campaign is the owner's decision. The
file kinds and their rules are in `.xezar/docs/campaign-notes.md`.
