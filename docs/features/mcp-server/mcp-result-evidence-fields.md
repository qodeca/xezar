# Result and evidence fields a leader needs to assess a revision

Status: **field record; nothing here is implemented**. Date: 2026-09-10.
Audience: engineering. Baseline revision: `9fdcf0e878999783db6c2a69dec93a7d00ccea44`.

Delivers [#78](https://github.com/qodeca/xezar/issues/78), Phase 1 of [epic #67](https://github.com/qodeca/xezar/issues/67),
against § 13's closing subsection ("Process-evidence implications from the 2026-09-09 source audit") of the
[MCP requirements](mcp-project-leader-requirements.md). Siblings: the UI action inventory
(`mcp-ui-action-inventory.md`) and the settings classification (`mcp-settings-classification.md`), both written
separately and cited here by name only.

This is an agreed field list plus the reconciliation that produced it. It is **not** a schema change, a route
change or a protocol design: Phase 3 turns the "to be added" rows below into zod. Every symbol below was read in
the source at the baseline revision and is cited `path:line`. Where a requirements document and the source
disagreed, the source won and the disagreement is recorded under [Corrections](#corrections).

## 1. The one rule

> **Missing or unavailable evidence must never become `passed` through API normalization.**

Every field in this record therefore has a **defined ABSENT value**, and that value reads as *unknown* or
*unavailable*. Never as *passed*, never as *unchanged*, never as *no problems found*.

Three supporting rules follow from the requirements and are testable:

- **`done` alone is not proof of passing tests** (A-10). `RunStatus.done`
  (`packages/contract/src/runs.ts:29-38`) says the chain reached its end. It does not say a check ran, and a
  workflow whose only check step is `skipped` (`stepStatusSchema`, `packages/contract/src/runs.ts:48-57`)
  still ends `done`.
- **A SHA change invalidates the assumption that previous evidence covers the current result** (S-02, F-10).
  Evidence is only ever evidence *for a revision*.
- **A check needs an explicit outcome, not a boolean.** The vocabulary is
  `passed | failed | interrupted | not-run`, and the key's own absence is the fifth state, *unknown*.
  `scripts/e2e.sh:32` exits **0** while printing `TEST_E2E_STATUS=skipped`, so an exit code alone reads a
  suite that never ran as a pass.

### 1.1 The absent-value vocabulary

This repository already has three correct precedents, and they are the shapes to copy rather than invent:

| Precedent | Where | What it does right |
| --- | --- | --- |
| `mergeabilityOf` | `packages/xezar/src/server/forge/github.ts:1652-1663` | GitHub's `UNKNOWN` "means *we were not told*, never *it is clean*". Anything not explicitly `MERGEABLE`/`CONFLICTING`, **including an omitted field**, answers `'unknown'`. |
| `forgeInfoSchema.available` | `packages/contract/src/health.ts:24-33` | Optional on purpose: absent means "not determined yet", which is not the same as `false`, and the cockpit renders the two differently. |
| `/api/v1/github/ref-status` | `BACKWARD_COMPATIBILITY.md` § 2 | A number the forge does not know is **absent from the map** rather than present with a fallback; "collapsing that into a status would let 'we could not ask' render as 'nothing is wrong'". |

Everything below is measured against those three.

## 2. How to read the tables

- **Carrier** — the field that holds the distinction today, or `⟵ to be added` where none exists.
- **Route** — the HTTP route that returns it. Project-scoped routes answer under both `/api/v1/<path>` and
  `/api/v1/p/:projectId/<path>`.
- **ABSENT reads as** — the mandatory reading when the key is missing. This column is the deliverable.

A `⟵ to be added` row always names the schema file the field must be added to. A field that also **persists**
into `.local/xezar/runs.json` names its second home, `packages/xezar/src/runs/store.ts`, and is marked
**optional**: `runs.json` is `safeParse`d as one array, so a required addition silently drops every
pre-existing run (`BACKWARD_COMPATIBILITY.md` § 3; `packages/xezar/src/runs/store.ts:116-130` says the same in
the code, about `diffStat`). That is N-08.

## 3. Distinction 1 — historical validity

*Was this evidence true when it was recorded, and when was that?*

| Carrier | Where | Route | ABSENT reads as |
| --- | --- | --- | --- |
| `RunRecord.startedAt`, `RunRecord.finishedAt` | `packages/contract/src/runs.ts:198-199` (optional) | `GET /api/v1/runs`, `GET /api/v1/runs/:id` | not started / not finished — never "finished now" |
| `StepState.startedAt`, `StepState.finishedAt` | `packages/contract/src/runs.ts:77-78` (optional) | same | this attempt has no recorded window |
| `RunHistoryEvent.ts` + `seq` | `packages/contract/src/events.ts:62-68` | `GET /api/v1/runs/:id/history` | n/a — both are required on every journal record |
| `runHistoryPageSchema.asOfSeq` | `packages/contract/src/events.ts:70-79` | `GET /api/v1/runs/:id/history` | n/a — required; this is the existing "as of" precedent |
| `runHistoryContextSchema.asOfSeq` | `packages/contract/src/events.ts:81-85` | `GET /api/v1/runs/:id/history-context` | n/a — required |
| `RunCommit.committedAt` ⟵ to be added, `packages/contract/src/runs.ts` | — | `GET /api/v1/runs/:id/commits` | unknown commit instant |

`asOfSeq` is the model this record generalizes: a page of evidence states the sequence it was read at, so a
later reader can tell whether it is looking at the same thing.

**Why `committedAt` is needed.** `RunCommit.when` is git's relative `%cr` text — "3 hours ago"
(`packages/contract/src/runs.ts:576-583`, and `packages/xezar/src/server/git-changes.ts:388` supplies it). Two
reads of the *same* commit a day apart return different strings, and no read returns an instant a leader can
compare. `when` is a protected response field and stays; `committedAt` is an additive ISO-8601 sibling.

## 4. Distinction 2 — current reuse and eligibility

*May I still rely on an earlier read, and is the artifact even there to re-read?*

**This distinction needs no new field.** Every carrier exists, and the whole risk is on the reading side.

| Carrier | Where | Route | ABSENT reads as |
| --- | --- | --- | --- |
| `RunRecord.worktreePath` | `packages/contract/src/runs.ts:228-229` (optional) | `GET /api/v1/runs/:id` | no isolated worktree — the diff/files/commits evidence cannot be re-read |
| `RunRecord.worktreeReclaimedAt` | `packages/contract/src/runs.ts:233-235` (optional) | same | retention has not reclaimed the directory |
| `409 {error: NO_WORKTREE}` | `packages/xezar/src/server/server.ts:4113`, `:4131`; the message at `:4475` | `GET /api/v1/runs/:id/changes`, `…/commits` | n/a — this **is** the unavailable answer |
| `githubPrMergeStateResponseSchema` `available: false` + `reason` | `packages/contract/src/github.ts:326-330` | `GET /api/v1/github/prs/:number/merge-state` | n/a — a discriminated union; the unavailable branch carries no `checks` or `blockers` at all |
| `githubPrMergeState.eligibility` (`ready\|blocked\|pending\|unauthorized\|terminal\|unknown`) | `packages/contract/src/github.ts:318` | same | n/a — required, and `unknown` is a real member |
| `githubPrMergeState.blockers[]` | `packages/contract/src/github.ts:319` | same | n/a — only reachable on the `available: true` branch |

**The rule the MCP result tools must not break.** An M-08 tool that answers a run whose worktree is gone must
surface the 409, not normalize it into a successful empty payload. `{files: [], stat: {adds: 0, dels: 0,
files: 0}}` is what "this task changed nothing" looks like; returning it for "the evidence is no longer on
disk" is the exact failure this record exists to prevent. The same holds on the forge side: an empty
`blockers[]` is only meaningful inside the `available: true` branch, and the union is what keeps a reader from
misreading it. Do not flatten either union in an MCP tool result.

## 5. Distinction 3 — candidate identity

*Which revision am I assessing?*

This is the largest gap. **No run-scoped read returns a head SHA today.**

| Carrier | Where | Route | ABSENT reads as |
| --- | --- | --- | --- |
| `RunRecord.branch`, `RunRecord.baseBranch` | `packages/contract/src/runs.ts:230-232` (optional) | `GET /api/v1/runs/:id` | names only, never a revision; absent = in-place run or pre-field record |
| `changesPayloadSchema.repointedHead` | `packages/contract/src/repo.ts:98-99` (optional) | `GET /api/v1/runs/:id/changes` | HEAD sat on the task's own branch |
| `RunRecord.diffStat.repointed` | `packages/contract/src/runs.ts:98-104` (optional, only ever `true`) | `GET /api/v1/runs`, `…/:id` | the stat was not narrowed |
| `changesPayloadSchema.headSha`, `.baseSha` ⟵ to be added, `packages/contract/src/repo.ts` | — | `GET /api/v1/runs/:id/changes` | the unreadable case is the existing **409**, never an omitted key on a 200 |
| `runCommitsResponseSchema.headSha`, `.baseSha` ⟵ to be added, `packages/contract/src/runs.ts` | — | `GET /api/v1/runs/:id/commits` | same — the existing 409 |
| `RunRecord.diffStat.sha` ⟵ to be added, **optional**, `packages/contract/src/runs.ts` **and** `packages/xezar/src/runs/store.ts` | — | `GET /api/v1/runs`, `…/:id` | **the revision these numbers were measured at is unknown** — never "the current head" |

`baseSha` is the *resolved* anchor `resolveTaskDiffBase` returned, not the configured base branch name. The
name (`main`) is what a reader already has; the sha is what makes the diff reproducible.

`diffStat.sha` is the field this record hangs the worked example on (§ 8). It is optional and additive for the
same reason `repointed` is: `runs.json` records that predate it must keep parsing, and
`BACKWARD_COMPATIBILITY.md` § 3 records that a finished run's stat is **never backfilled** — so an absent
`sha` is exactly the honest answer for every historical record.

### 5.1 The diff-anchor rule this record inherits

A new task-diff surface resolves through `resolveTaskDiffBase`
(`packages/xezar/src/git-diff-base.ts:173-209`) and passes the run's **`branch` and its `startedAt`**. The
existing correct callers are `worktreeShortstat` (`packages/xezar/src/git-worktree.ts:548-563`) and
`collectChanges` (`packages/xezar/src/server/git-changes.ts:288-295`, fed by `server.ts:4114-4120`).

`AGENTS.md` records why: anchoring a review or QA run at the whole-branch base produced five-figure diffs
(open-mercato/cezar#591, #751), and anchoring at `HEAD` instead reported `+0 −0` for work that was really
committed. **`worktreeDiff` and `worktreeDiffStat` keep the whole-branch anchor deliberately**
(`packages/xezar/src/git-worktree.ts:449-465` and `:481-489` each carry a comment saying why — a protected
text surface, and a variant comparison that would be meaningless narrowed). This record proposes no change to
either, and Phase 3 must not "fix" them.

## 6. Distinction 4 — attempt outcomes

*What actually happened, per attempt and per check?*

| Carrier | Where | Route | ABSENT reads as |
| --- | --- | --- | --- |
| `RunStatus` (`queued\|running\|waiting\|review\|done\|failed\|cancelled`) | `packages/contract/src/runs.ts:29-38` | `GET /api/v1/runs/:id` | n/a — required. **`done` is not "tests passed"** |
| `StepStatus` (`pending\|running\|waiting\|review\|done\|failed\|cancelled\|skipped`) | `packages/contract/src/runs.ts:48-57` | same | n/a — required |
| `StepState.iterations` | `packages/contract/src/runs.ts:68` | same | n/a — required; the attempt count for a retried step |
| `StepState.error` | `packages/contract/src/runs.ts:79` (optional) | same | no error text was captured — **not** "no error occurred" |
| `check-output` event `exitCode` | emitted at `packages/xezar/src/workflows/run.ts:3855` and `:3861`; a standalone history item, `packages/xezar/src/runs/event-history.ts:104-114` | `GET /api/v1/runs/:id/history` | reachable only as an untyped `any` (see below) |
| `StepState.checkOutcome` (`passed\|failed\|interrupted\|not-run`) ⟵ to be added, **optional**, `packages/contract/src/runs.ts` **and** `packages/xezar/src/runs/store.ts` | — | `GET /api/v1/runs/:id` | **unknown** — a leader must not default it to `passed`, and specifically must not infer it from `status: 'done'` |
| `StepState.exitCode` (number) ⟵ to be added, **optional**, same two files | — | same | not recorded |
| `StepState.signal` (string) ⟵ to be added, **optional**, same two files | — | same | the process was not observed to die on a signal |

**Three source facts drive those additions.**

1. **The exit code exists but is not typed.** A check step's exit code rides only in the NDJSON journal
   (`run.ts:3855`, `:3861`). It reaches a reader through `runHistoryPageSchema.events`, whose element schema
   is `runHistoryEventSchema` — required envelope plus `.catchall(z.any())`
   (`packages/contract/src/events.ts:62-68`). So a leader must reverse-page the journal and read an untyped
   value to learn whether a gate passed. Nothing in `RunRecord`, `StepState` or any run response carries it.
2. **Interrupted and failed are the same record today.** Cancelling a run SIGTERMs the check child
   (`run.ts:3841`); `close` then reports no exit code, the event records `exitCode: -1` (`run.ts:3861`), the
   step settles `failed`, and the signal is never recorded. `interrupted` is therefore a genuinely new value,
   not a relabel.
3. **Exit 0 is not "passed".** `scripts/e2e.sh:32` prints `TEST_E2E_STATUS=skipped` and exits **0**. A check
   step running that command finishes `done` with a zero exit while no spec ran. `checkOutcome` must be
   derived from the command's own reported contract where one exists; where none exists, **the key stays
   absent (unknown) rather than being filled in with `passed`**.

## 7. Distinction 5 — CI-tested head/merge identity

*Which commit did CI actually test, and is it the one I am assessing?*

| Carrier | Where | Route | ABSENT reads as |
| --- | --- | --- | --- |
| `githubPrMergeState.headSha` | `packages/contract/src/github.ts:312` | `GET /api/v1/github/prs/:number/merge-state` | n/a — required on the `available: true` branch |
| `githubPrMergeState.mergeable` (`mergeable\|conflicting\|unknown`) | `packages/contract/src/github.ts:313` | same | n/a — `unknown` is a real member (§ 1.1) |
| `githubPrMergeState.reviewDecision` (`approved\|changes-requested\|review-required\|unknown`) | `packages/contract/src/github.ts:314` | same | n/a — `unknown` is a real member |
| `githubPrMergeState.checks[]` → `githubPrCheckSchema.state` (`passing\|failing\|pending\|unknown`) | `packages/contract/src/github.ts:295-301` | same | n/a — see correction C-3 for what currently reaches `passing` |
| `githubPrCheckSchema.required` (`boolean \| null`) | `packages/contract/src/github.ts:298` | same | `null` = we do not know whether this check is required |
| `githubPrChangesData.headSha` | `packages/contract/src/github.ts:363` | `GET /api/v1/github/prs/:number/changes` | n/a — required on the `available: true` branch |
| `githubChecksData.checks[n]` glyph (`passing\|failing\|pending\|null`) | `packages/contract/src/github.ts:16`, `:65-74` | `GET /api/v1/github/checks?prs=…` | see correction C-5 — absence currently means two different things |
| `githubPrCheckSchema.headSha` ⟵ to be added, **optional**, `packages/contract/src/github.ts` | — | `GET /api/v1/github/prs/:number/merge-state` | **unknown** — never "this check tested the current head" |
| `githubPrCheckSchema.completedAt` ⟵ to be added, **optional**, `packages/contract/src/github.ts` | — | same | unknown finish instant |

`githubPrMergeState.headSha` is the PR's head, and every check row is served beside it — but no row says which
commit it ran on. A check that ran on an earlier push and was never re-run is currently indistinguishable from
one that tested the head. `headSha` per check row closes that; both new keys are optional because `gh` does not
always report them, and absent must read as *unknown*.

**The identity a leader must reconcile** is three-way: the run's head (§ 5, to be added), the PR's `headSha`,
and the check's own `headSha`. All three equal → the green checks describe the revision under assessment. Any
disagreement, or any unknown, is *not* an assessment.

## 8. Worked example — one completed task, read at two SHAs

Task `xez/a1b2c3d4`, workflow finished, `status: 'done'`, PR #4242 open and green.

**Read A — 2026-09-10T09:00:00Z.** Worktree head `4f2c9ab`. The leader records its assessment.

| Field | Value |
| --- | --- |
| `RunRecord.status` | `done` |
| `RunRecord.finishedAt` | `2026-09-10T08:58:11Z` |
| `RunRecord.diffStat` | `{adds: 812, dels: 96, files: 14}` |
| `RunRecord.diffStat.sha` *(proposed)* | `4f2c9ab` |
| `changesPayloadSchema.headSha` *(proposed)* | `4f2c9ab` |
| `githubPrMergeState.headSha` | `4f2c9ab` |
| `githubPrMergeState.checks[]` | all `passing` |

A human then commits one fixup directly in the task's worktree and does not push it yet. The run is already
finished, so no turn-end fires and `RunRecord.diffStat` is never recomputed — `BACKWARD_COMPATIBILITY.md` § 3
records that a finished run's stat is deliberately never backfilled.

**Read B — 2026-09-10T11:20:00Z.** Worktree head `9d13e07`. The PR still reports `4f2c9ab`, because the fixup
has not reached the forge.

**What a leader sees today, at the baseline revision:**

| Field | Read A | Read B |
| --- | --- | --- |
| `RunRecord.status` | `done` | `done` |
| `RunRecord.finishedAt` | `2026-09-10T08:58:11Z` | `2026-09-10T08:58:11Z` |
| `RunRecord.diffStat` | `{812, 96, 14}` | whatever the last turn-end measured — with nothing saying which revision that was |
| head revision | **not returned by any run route** | **not returned by any run route** |

Nothing in either payload names a revision, so the two reads are indistinguishable and the leader's stored
assessment silently continues to look current. That is F-10 and S-02 failing at the same time.

**What a leader sees with the proposed fields:**

| Field | Read A | Read B | Meaning |
| --- | --- | --- | --- |
| `changesPayloadSchema.headSha` | `4f2c9ab` | `9d13e07` | the tree moved |
| `RunRecord.diffStat.sha` | `4f2c9ab` | `4f2c9ab` | **the stored numbers describe a revision that is no longer the head** |
| `githubPrMergeState.headSha` | `4f2c9ab` | `4f2c9ab` | CI's green answer is about the old revision |
| `githubPrCheckSchema.headSha` | `4f2c9ab` | `4f2c9ab` | per check row, same conclusion |
| `StepState.checkOutcome` | `passed` | `passed` | the run is finished, so the gate result cannot move — it belongs to `4f2c9ab` |

**The field that makes the older evidence recognisably stale rather than passed is
`RunRecord.diffStat.sha`, read against the response's `changesPayloadSchema.headSha`.** They agree at read A
and disagree at read B, and the disagreement is what a leader is required to notice. Every other row above
tells the same story from a different surface, and every one of them keeps saying *stale*, never *failed* and
never *passed*. Note that `status: 'done'` is identical in both columns — A-10, exactly.

If either sha is **absent**, the correct reading is *unknown*: the leader must re-read, not assume.

## 9. What this hands to A-13 and A-14

A-13 (stale write) and A-14 (lost response) both need one thing from this record: the **identity of the read a
decision was based on**. That is `headSha` from § 5 — the value a leader echoes back on a mutation as an
expected revision, so a write submitted after the tree moved is rejected rather than silently applied.

The mutation-side shape (`expectedHeadSha`, the operation key, the conflict response) is **operation-identity
design and is out of scope here**; this record only fixes the value it carries and where that value is read
from. No work is created for it in Phase 1.

## 10. Corrections

The source won in each of these. Every one was verified by reading the cited lines at the baseline revision.

**C-1 — `runHistoryPageSchema` and `runHistoryContextSchema` are not in `runs.ts`.** Issue #78 and § 13 place
them in `packages/contract/src/runs.ts`. They are declared in **`packages/contract/src/events.ts:70-79` and
`:81-85`**, together with `runHistoryEventSchema` (`:62-68`). `packages/contract/src/runs.ts` declares neither.
Phase 3 edits `events.ts` for anything touching history paging.

**C-2 — `rollupToChecks` normalizes unknown CI conclusions to `'passing'`.**
`packages/xezar/src/server/forge/github.ts:262-268` collapses the rollup with an explicit `failing` list
(`FAILURE, ERROR, TIMED_OUT, ACTION_REQUIRED`), an explicit `pending` list, and then
`return 'passing'` for **everything else** — which includes GitHub's `SKIPPED`, `NEUTRAL`, `CANCELLED` and
`STALE`. This is the hard rule of § 1 being broken in the current code: a cancelled CI run glyphs as
*passing*. Naming it is Phase 1's job; changing it is not, and it needs its own issue because the glyph is a
protected shape (`BACKWARD_COMPATIBILITY.md` § 2).

**C-3 — `mergeCheckState` maps `SKIPPED` and `NEUTRAL` to `'passing'`.**
`packages/xezar/src/server/forge/github.ts:2621-2627`. A check that never ran is reported to the merge panel
as passing. Its fallthrough is correct (`return 'unknown'`); its `SUCCESS, NEUTRAL, SKIPPED` list is not.

**C-4 — the two check mappers disagree about `CANCELLED`.** `rollupToChecks` (C-2) has no `CANCELLED` entry, so
a cancelled check falls through to `'passing'`; `mergeCheckState` (C-3) lists it under `'failing'`
(`github.ts:2624`). The same CI conclusion therefore reads as passing on a PR row and failing in the merge
panel. Neither is `interrupted`, which is what it actually is.

**C-5 — `githubChecksDataSchema`'s absence carries two meanings.** Its comment
(`packages/contract/src/github.ts:60-64`) says "An absent number means 'no checks / not found'", while the
glyph's own `null` already means "no CI configured" (`github.ts:14-16`). "We did not get an answer" and "there
is no CI" are different facts and a leader must be able to tell them apart. The timeline shape next door
already does this correctly and says so (`github.ts:262-264`: absent and `null` "stay distinct values").

**C-6 — `GET /runs/:id/commits` does not resolve through `resolveTaskDiffBase`.**
`packages/xezar/src/server/git-changes.ts:384-398` runs a raw `git merge-base <baseBranch> HEAD`: no
`freshestBaseRef`, no `taskBranch`, no `runStartedAt`, and `server.ts:4132` passes none. So on a repointed
worktree, or against a stale local base ref, the Commits list and the Changes list of the *same run* are
anchored differently and can disagree. This record does not assume a shared anchor, and it does not ask for
the change: whether to route that surface through the helper is a Phase-3 decision with its own
backward-compatibility question.

**C-7 — `RunCommit.when` is not a timestamp.** `packages/contract/src/runs.ts:576-583` documents it as git's
relative `%cr`. § 3 adds `committedAt` rather than reinterpreting it.

## 11. Coordination point

These fields are the same ones the separately specified built-in project leader consumes under L-A37–L-A43
([its requirements](../builtin-project-leader/builtin-project-leader-requirements.md)); it is a downstream
reader of this list and **this record creates no work for it**.

## 12. Traceability

| Requirement | Where it is answered |
| --- | --- |
| F-10 — assessment identifies its revision; missing or stale evidence is recognizable | § 5, § 8 |
| A-05 — every action mapped; start/status success alone is insufficient | § 4 (the 409 and `available: false` must not be flattened), § 6 |
| A-10 — `done` alone is not proof of passing tests; repeat after a SHA change | § 1, § 6, § 8 |
| A-13 — stale write rejected after a human change | § 9 |
| A-14 — retry with the same operation key | § 9 |
| S-02 — a revision change invalidates prior evidence | § 5, § 8 |
| M-08 — results identified by revision | § 3, § 5, § 6 |
| M-11 — GitHub issues/PRs/CI | § 7, C-2, C-3, C-4, C-5 |
| M-12 — existing merge-state inspection and merge | § 4, § 7 |
| N-08 — new persisted fields follow the compatibility rules | § 2, and the **optional** marker on every persisted row |
