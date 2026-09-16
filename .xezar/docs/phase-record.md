# The phase record

`SDLC.md` § Task phases says what each phase of a development task settles. This page says what that phase writes down and where, so the next phase — or the next agent, after a Continue, a backend switch or a replacement run — reads a fact instead of re-deriving it.

The record is operating guidance for this repository's own kit. It ships in nothing; the published package carries no part of `.xezar/`.

## Where it lives

One directory per run, in the **primary checkout**:

```
.local/xezar-tasks/<runId>/
```

Resolve it with the shared helper rather than by hand — `.xezar/checks/lib/common.sh`, `resolve_task_paths` then `task_evidence_dir`. A task worktree's own `.local` is reclaimable and the engine's tmp directory is not durable; neither is a record. `/.local/` is already ignored at the repository root, so no new ignore line is needed and nothing here is ever committed.

What must never enter it: secrets, credentials, `.env` contents, personal agent configuration, and source content unrelated to this task. A report that would need one of those says "not recorded" instead.

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

**Three of these records already exist and already have teeth; the rest are named by this contract and enforced by sequenced follow-up work (#469).** Do not overload the three:

- `BLOCKED` stops readiness before anyone pays for a gate run, and it outranks every other record.
- `DELIVERED` is the review-response case only — a fix pushed to the PR's own branch, leaving this task's branch empty. Three lines: `branch`, `head`, `base`, checked live against the remote.
- `VERIFICATION` is the verify-only case only — this run verified an existing revision and was never asked to change source. It is `verified:` plus `findings:`, and it is why readiness accepts an empty branch. It is **not** the acceptance-criteria mapping; that is `AC_VERIFICATION`, above, and the two are different questions.

## Counters

Three durable counters, defined in `SDLC.md` § Self-review inside the author phase and none of them a substitute for another: **two** self-review fix rounds per candidate, **two** workflow gate-repair returns, **two** quality-gate repairs of the same failure.

Each is written to `COUNTERS` **before** the round it allows, not after — a round that is applied and then not recorded is the failure mode this record exists to close. Each entry names what triggered the repair and which counter it consumed.

Gate re-entry, a Continue, a new backend and a replacement run all continue an existing count. A replacement therefore recovers its predecessor's attempt IDs and consumed budgets first: missing history reads as **unknown**, not as zero, and blocks another repair until it is reconciled. An exhausted counter blocks another repair outright — stop and report, and never lower a severity, a threshold or a mandatory check to get past it.

## The security applicability decision

`SECURITY` records the decision before it records a result: does a code or security capability apply to this change at all?

- **Yes** — the applicable project-approved dependency, secret and static checks, with real outcomes. An unavailable required scanner, a parse error, an empty inventory where one was expected, or an interrupted scan is written as **unknown**. Unknown is not a pass, and a reviewer reads this file before giving a quality verdict.
- **No** — the artefact or change set that supports saying so, plus the checks that do fit the work: source verification, confidential-data handling, claim checking against the supplied criteria. Software fixtures inside otherwise non-code work still get software checks. Mixed work takes the union of both.

The executable check that emits this result is sequenced follow-up work (#469). Until it lands the stage is a written record here, and an absent result reads as unknown rather than as a pass.

## What does not go in the pipeline config

Depth, maturity, capability inventory and the counters are facts about **one task**. `.xezar/pipeline/config.json` describes the pipeline — the base branch, the validation commands, the label taxonomy, the QA gate — and travels to every checkout, so a per-task value there would be a false promise, the same reason `maxParallel` and `memoryLimitMb` are refused in the committed project config. Keep them in the run's own record.

## Reading it back

Distinguish **observed**, **fixture-tested**, **live-verified** and **unknown** in anything you report from these files. Historical validity, reuse in this run and current eligibility are three different questions: a green attempt from an earlier head does not cover new candidate bytes, and a newer failure is never hidden behind an older pass. Cross-task reading is read-only, inside a trusted path.

Related: `.xezar/docs/recovery.md` for reconciling a snapshot against current policy, `.xezar/docs/ui-operations.md` for delivery, takeover and readiness records, and `.xezar/docs/dogfooding.md` for what a real task taught.
