# The phase record

`SDLC.md` § Task phases says what each phase of a development task settles. This page says what that phase writes down and where, so the next phase — or the next agent, after a Continue, a backend switch or a replacement run — reads a fact instead of re-deriving it.

The record is operating guidance for this repository's own kit. It ships in nothing; the published package carries no part of `.xezar/`.

## Where it lives

One directory per run, in the **primary checkout**:

```
.local/xezar/tasks/<runId>/
```

Resolve it with the shared helper rather than by hand — `.xezar/checks/lib/common.sh`, `resolve_task_paths` then `task_evidence_dir`. A task worktree's own `.local` is reclaimable and the engine's tmp directory is not durable; neither is a record. `/.local/` is already ignored at the repository root, so no new ignore line is needed and nothing here is ever committed.

What must never enter it: secrets, credentials, `.env` contents, personal agent configuration, and source content unrelated to this task. A report that would need one of those says "not recorded" instead.

## Writing it

One command, so nobody has to remember eight file names or where they go:

```sh
bash .xezar/checks/phase-record.sh set DEPTH "small — one bounded surface, known behaviour"
bash .xezar/checks/phase-record.sh set CRITERIA < criteria.md   # or pipe it on stdin
bash .xezar/checks/phase-record.sh list                         # what is present, what is absent
bash .xezar/checks/phase-record.sh check                        # what readiness will refuse
```

`check` is the same code readiness runs, so it answers the question before the workflow asks it. Run it while you are still authoring; a missing record found there costs a second, and found at readiness costs the step.

## What each phase records

| Phase | Record | Holds |
|---|---|---|
| Triage and preflight | `CAPABILITY` | Which backends, tools, networks and scanners are actually available for this run, and which required one is absent |
| Triage and preflight | `DEPTH` | `small`, `standard` or `high-risk`, and the one sentence that chose it |
| Triage and preflight | `MATURITY` | Where the inputs sit on the ladder, and which required input is missing or stale |
| Analysis | `CRITERIA` | Each accepted acceptance criterion with its ID, and the authority that accepted it |
| Discovery and plan | `PLAN` | Files and contracts in scope, how each criterion will be proven, and the plan-review outcome |
| Author | `SELF_REVIEW` | Each self-review round: what triggered it, what changed, and the running count |
| Author | `DOCS` | The documentation applicability decision, and which documents changed |
| Readiness | `BLOCKED` | Present only when something blocks: the missing decision with its options, the unavailable check, or the exhausted counter |
| Canonical checks | gate logs + `SECURITY` | Complete hashed logs and real outcomes; the security stage's own structured result, separate from the quality verdict |
| Seal | the seal | The head SHA the evidence belongs to, hashed |
| Handoff | the handoff report, and `DELIVERED` when it applies | PR number, head SHA and labels with their stated reasons; `DELIVERED` when the fix went to another branch |
| Independent review / QA / design | the PR comments | The verdicts themselves live on the PR (`## QA`, `## Design review`, the review comment), each naming its head SHA |
| AC verification | `AC_VERIFICATION` | Each accepted criterion ID mapped to the evidence that satisfies it, at the current head |

A phase that does not apply still writes its record, saying **not applicable and why**. "Not applicable" is a finding; an absent file is not.

### What readiness refuses without

`worktree-preflight.sh --readiness` and `--record-gate-evidence` require the eight records whose phase has already run by the time they do: `CAPABILITY`, `DEPTH`, `MATURITY`, `CRITERIA`, `PLAN`, `SELF_REVIEW`, `DOCS` and `COUNTERS`. Each refusal names the record, the predicate (`phase.depth`, `phase.criteria`, …) and the command that writes it.

The read-only roles — code review, design review, QA, business analysis, research — never run either mode, so none of them is ever asked for an author's facts.

`CRITERIA` is validated rather than counted, because it is the **AC input** and an empty rung of the maturity ladder is the failure this closes. It needs at least one `<ID>: <what a reader can check>` line and an `accepted-by: <authority and when>` line. A file that exists, a shipped template and a mutable label are not acceptance.

`SECURITY` and `AC_VERIFICATION` are not on that list, for opposite reasons: the security result is produced by the gate run itself (below), and AC verification happens at the current head, after the candidate exists.

### The four records that carry their own rules

- `BLOCKED` stops readiness before anyone pays for a gate run, and it outranks every other record.
- `DELIVERED` is the review-response case only — a fix pushed to the PR's own branch, leaving this task's branch empty. Three lines: `branch`, `head`, `base`, checked live against the remote.
- `VERIFICATION` is the verify-only case only — this run verified an existing revision and was never asked to change source. It is `verified:` plus `findings:`, and it is why readiness accepts an empty branch. It is **not** the acceptance-criteria mapping; that is `AC_VERIFICATION`, above, and the two are different questions.
- `COUNTERS` is written by `phase-record.sh counters`, never by hand — see below.

## Counters

Three durable counters, defined in `SDLC.md` § "Self-review inside the author phase, and the repair counters", and none of them a substitute for another: **two** self-review fix rounds per candidate, **two** workflow gate-repair returns, **two** quality-gate repairs of the same failure.

Each is written to `COUNTERS` **before** the round it allows, not after — a round that is applied and then not recorded is the failure mode this record exists to close. Each entry names what triggered the repair and which counter it consumed.

```sh
bash .xezar/checks/phase-record.sh counters init --none        # a fresh candidate, no predecessor
bash .xezar/checks/phase-record.sh counters init --predecessor <runId>   # a replacement run
bash .xezar/checks/phase-record.sh counter self-review --trigger "review found X"
bash .xezar/checks/phase-record.sh counters                    # what is used and what is left
```

**The history is declared before the first repair, not inferred from an empty file.** `counter` refuses outright when `COUNTERS` has no `history:` line, because a replacement run gets a fresh evidence directory and an absent file there means "nobody has reconciled this", not "nothing has happened". `--predecessor` carries the predecessor's totals forward; `--none` is the explicit claim that there is no predecessor.

Gate re-entry, a Continue, a new backend and a replacement run all continue an existing count. Missing history reads as **unknown**, not as zero, and blocks another repair until it is reconciled. An exhausted counter blocks another repair outright — stop and report, and never lower a severity, a threshold or a mandatory check to get past it, and never pay for one counter's round out of another.

Two checks enforce it beyond the writer: readiness refuses a `COUNTERS` record whose count is **over** its limit (a hand-edited or forged total), and `resume-complete.sh` refuses to re-run the gates when the `gate-return` counter is spent or unknown — a resumed run is a continuation of the count, never a fresh allowance.

## The security result

**It is produced by a command, not typed.** `.xezar/checks/security-scan.sh` is gate 2 of the canonical list — straight after the install and ahead of every gate that produces a quality signal — and it writes its structured result to `security.json` inside that gate attempt, next to the logs. `worktree-preflight.sh --record-gate-evidence` refuses to seal an attempt that carries no such result, and the seal records its status, so a reviewer reads a fact rather than the author's summary of one.

The result records the decision before it records an outcome: does a code or security capability apply to this change at all?

- **Yes** — the applicable project-approved secret, credential-path, executable-pattern and dependency-input checks, each with a real outcome. An unavailable scanner, a parse error, a change set the stage could not read, or an interrupted scan is written as **unknown**. Unknown is not a pass, and the reviewer reads it before giving a quality verdict.
- **No** — the change set that supports saying so, plus the checks that do fit the work: source verification, confidential-data handling, claim checking against the supplied criteria. Software fixtures inside otherwise non-code work still get software checks. Mixed work takes the union of both.

Four statuses, and only the first is a pass: `pass`, `findings` (the gate fails), `unknown`, `not-applicable`. A candidate whose base was resolved and whose diff was readable but whose inventory is nonetheless **empty** is `not-applicable`, not refused: the gate can run before the agent has committed anything, so there is nothing to scan and nothing to refuse. **Empty is decided from the full enumeration over the base, deletions included** — never from the content-scan enumeration alone, which excludes them, or a candidate that only deletes files would misread as one that changed nothing. A change set that is non-empty but has nothing the content scan reads (deletion-only, or similar) says so in its own words instead, and the deleted paths still reach the trust-boundary check. The shapes that DO mean the stage could not look — an unresolved base, an unreadable repository, an enumeration command that errored — are recorded as `unknown` and refused, and the two must never be confused with each other.

Two run shapes legitimately carry no commits of their own — `DELIVERED` (the fix went to the PR's own branch) and `VERIFICATION` (this run only verified an existing revision) — and readiness accepts an empty branch for exactly those two. For them the empty change set is expected. `security-scan.sh` records the declaration with its reason so a reviewer reads why the branch is empty; an empty change set resolves as `not-applicable` whether or not it is declared, and the declaration is never a pass.

`reviewerRequired` is recorded separately. A change to a named trust boundary — the HTTP surface, agent config, the MCP tools, the workspace registry, CI's own workflows, the env contract — does not fail the gate, because automation cannot prove that an authorization decision is correct. It records that a human or a security reviewer is required, and the handoff says so.

One suppression exists and it is per LINE: a source line carrying `security-scan:allow` is not reported, and the count of allowed lines is recorded in the result. It is there because a scanner has to be able to name the thing it bans and a fixture has to be able to contain one. Never use it on a real finding, and never exempt a file or a rule.

Anything the command cannot answer still belongs in a written `SECURITY` record beside it — a specialist's reading of a changed trust boundary, or a check that this project has not automated.

## What does not go in the pipeline config

Depth, maturity, capability inventory and the counters are facts about **one task**. `.xezar/pipeline/config.json` describes the pipeline — the base branch, the validation commands, the label taxonomy, the QA gate — and travels to every checkout, so a per-task value there would be a false promise, the same reason `maxParallel` and `memoryLimitMb` are refused in the committed project config. Keep them in the run's own record.

## Reading it back

Distinguish **observed**, **fixture-tested**, **live-verified** and **unknown** in anything you report from these files. Historical validity, reuse in this run and current eligibility are three different questions: a green attempt from an earlier head does not cover new candidate bytes, and a newer failure is never hidden behind an older pass. Cross-task reading is read-only, inside a trusted path.

Related: `.xezar/docs/recovery.md` for reconciling a snapshot against current policy, `.xezar/docs/ui-operations.md` for delivery, takeover and readiness records, and `.xezar/docs/dogfooding.md` for what a real task taught.
