# OpenCode qualification — 2026-09-19

**Owner ask** (2026-09-19 13:28, exact words): "I need a report when you finish testing OpenCode.
Save the report in project documentation."

**Verdict in one line:** every read-only workflow type tried completed on OpenCode, and the whole
writing chain now runs up to handoff — but a post-denial stall (#692) stopped the one writing retrial
before its PR, so **OpenCode stays out of the routing rotation until #692 merges** (judgement, § 8).

**Evidence base.** Every number in this report is read from the run store `.local/xezar/runs.json`
in the primary checkout, the `gh` records of PR #688 and issues #686/#690/#692, and the QA
reports under `.local/xezar/tasks/` (§ Sources). Facts are marked **fact**; the one routing
conclusion is marked **judgement**. Where a claim could not be re-verified it says so.

## 1. The 0.16.0 baseline (fact)

- Before this trial, OpenCode's record was "it stalled every time it was tried": § 7 of
  `model-routing.md` said so, and § 13 **enumerated eight stalls** to 2026-09-16 (seven DeepSeek
  results — `f07d1839`, `5ae9de7e`, `43c73d0f`, `cd20e3a8`, `ae6280b2`, `3e608a1d`, `cb9818e5` —
  plus one Qwen result `52a11f58`), while the leader's 2026-09-18 tally read **9 of 9**. Those eight
  run ids are a dated record in § 13 and are **not re-verifiable in today's run store** (they are no
  longer present).
- Issue **#578**, "OpenCode runs hang forever on an unanswered `external_directory` permission ask"
  (closed 2026-09-18), is the mechanism behind those hangs: OpenCode asks before a tool reaches
  outside the task, and nothing answered, so the run waited to its 30-minute step limit with no
  named cause. It shipped in **0.16.0**: the runner now answers each ask at once and fails closed
  (`CHANGELOG.md`, 0.16.0 section, entry `#578`).
- 0.16.0 therefore removed the *unanswered* ask. It did not yet grant the run its own task-evidence
  directory, and it did not bound the silence *after* a rejection. This trial tested both.

## 2. Method (fact)

- **Runner:** OpenCode 1.18.31 through xezar's `opencode-server-runner.ts` — no `XEZ_DRY_RUN`, a real
  `opencode serve` session. Models: `deepseek-api/deepseek-flash` (DeepSeek V4.1 Flash API),
  `dgx-spark/deepseek-v4-flash-vision` (LAN), `mac-m4/qwen38-flash-next-mlx-mixed-4-8bit` (LAN).
- **Read-only pass — 11 runs, 2026-09-19 11:01–12:30 UTC, all `done`:** the workflow types
  `business-analysis` (7), `qa` (1), `code-review` (1), `research` (1), `quick-task` (1). They ran
  on `main` at `e2e53c75`, i.e. **before** the #686 fix.
- **Writing pass — 1 run, 11:07 UTC, `failed`:** `0f4c4e08`, workflow `bug-fix`, on the same base.
  This is the run that produced #686.
- **Writing retrial — 1 run, driven by a `qa` task (`8feb0aaa`):** a headless
  `xezar run` of the kit `docs-maintenance` workflow on OpenCode + `deepseek-api/deepseek-flash`,
  against a fresh clone of `qodeca/xezar` at the fixed `main` **`9e97a149`** in a scratch checkout
  outside the real primary checkout. Inner run `851a6f9b`; the retrial report is
  `.local/xezar/tasks/8feb0aaa-815f-4052-b960-747c33ce2815/opencode-writing-retrial.md` (fact).
- **Why headless:** the cockpit running on this machine is the **installed 0.16.0**, which does not
  contain the #686 fix, so the retrial had to build the CLI from source at `9e97a149`
  (`npm ci && npm run build`) and drive it directly. Both paths construct the OpenCode session the
  same way, but the cockpit's HTTP/server path was **not** exercised (§ 6).

## 3. Results — every OpenCode run of 2026-09-19 (fact)

Deliverable paths are relative to the primary checkout's `.local/xezar/tasks/<runId>/`; a `—` means
the run posted to GitHub instead or wrote nothing. On the 11 read-only runs, whose base predates the
#686 fix, several briefs told the agent to write inside its own worktree because the evidence
directory was denied — #686 records that `7fd00b1f` did exactly that. Wall-clock is
`finishedAt − createdAt`.

| Run | Workflow | Model | Issue/PR | Wall | Outcome | Deliverable |
|---|---|---|---|---|---|---|
| `7fd00b1f` | business-analysis | deepseek-api/deepseek-flash | #677 / #672 | 5m04s | done | `config-parity-inventory.md` |
| `0f4c4e08` | bug-fix | deepseek-api/deepseek-flash | #680 | 1m12s | **failed** | — (engine `manifest.json` only; the run's own write was denied) |
| `e5cbf578` | business-analysis | deepseek-api/deepseek-flash | #670 | 2m41s | done | `670-analysis.md` |
| `71358c98` | business-analysis | deepseek-api/deepseek-flash | #676 | 4m59s | done | `676-analysis.md`, `676-gate-attempts.mjs` |
| `0864d7db` | qa | deepseek-api/deepseek-flash | #683 (post-merge) | 1m53s | done | `qa-fragments-main.md` |
| `ec883b72` | code-review | deepseek-api/deepseek-flash | PR #665 (advisory) | 9m22s | done | `review-665.md` |
| `069f3dd5` | research | deepseek-api/deepseek-flash | #686 | 5m09s | done | `research-opencode-permissions.md` |
| `841770b3` | quick-task | deepseek-api/deepseek-flash | #677 (comment) | 2m42s | done | comment on #677, 11:26:04Z |
| `f4bec267` | business-analysis | dgx-spark/deepseek-v4-flash-vision | #678 | 5m59s | done | `678-analysis.md` |
| `4f40f4b7` | business-analysis | mac-m4/qwen38-flash-next-mlx-mixed-4-8bit | #686 (re-check) | 4m06s | done | `686-recheck.md` |
| `d2216383` | business-analysis | deepseek-api/deepseek-flash | #613 | 2m13s | done | `613-analysis.md` |
| `91fea85d` | business-analysis | deepseek-api/deepseek-flash | #647 + #649 | 3m04s | done | `647-649-analysis.md` |

Read-only wall-clock: 1m53s–9m22s. Total: 12 runs, 11 `done`, 1 `failed`, 0 cancelled, 0 still
running. The retrial (`851a6f9b`) is not in this run store — it ran in a scratch clone — and its
step timings come from the retrial report.

## 4. What works (fact)

- **Every read-only workflow type tried completed**, on all three models: business-analysis ×7, qa,
  code-review (cold advisory on an already-merged PR), research, and a one-shot tracker comment.
  Deliverables are real, e.g. `ec883b72`'s review of PR #665 found the record-rewrite that became
  issue #689, and `4f40f4b7` re-checked all five of #686's evidence claims PASS.
- **The whole writing chain works up to handoff on the fixed build.** Retrial `851a6f9b`
  (`docs-maintenance`, build `9e97a149`) ran: `kit` → `preflight` → `setup` → `docs` (author,
  ~2m26s) → `readiness` → `gates` (**8 of 8 passed**, ~4m16s) → `evidence` (sealed `ba494c8e`) →
  `handoff` (**stalled**, § 5). The author step wrote the full phase record into the run's own
  evidence directory and committed the fix; the gate step wrote its full attempt record there too.
  **Zero denials of `.local/xezar/tasks/<runId>/*` across the run** — the exact failure #686 fixed.
- **`0f4c4e08`'s own defect is gone.** On the fixed build a kit writing task can write its phase
  record, red proofs and gate evidence to its own evidence directory, which it could not do at
  `e2e53c75`.

## 5. What does not work (fact) — issue #692

**A rejected `external_directory` ask can leave the session silent** — no event, no error, no turn
end, for more than ten minutes, until a human kills it. The rejection itself is correct and intended
(it is the #686/#688 boundary); the defect is the silence afterwards. There is no per-ask watchdog,
so only the 30-minute step timeout (or nothing, on the uncapped last step) bounds it.

Four reproductions, on both the base and the fixed build, so it is independent of #686:

1. `755e878d` — PR #688 QA, combined probes 1–3 on the fix build `825990a8`; stalled after the
   probe-2 denial, >10 minutes with zero new events.
2. The base build `e2e53c75` — the same stall "reproduced on the base run" in that QA comment (no run
   id named there).
3. `626d8b35` — the same QA's isolated probe-3 re-run on the fix build; stalled after the denial.
4. `851a6f9b` — this trial's retrial on `9e97a149`; at `handoff` a **correct** denial of a read of
   the primary's `.xezar/skills/*` was followed by **11m58s of silence**, then killed by PID.

**The one different shape — `0f4c4e08` (fact).** There the agent did **not** stall: the denial at
seq 223/224 was followed within ~0.1s by `turn.completed` (seq 228, `end_turn`), `session.ended`
(seq 231) and a `step-end` `failed` with "ended its turn without the XEZ:DONE completion marker"
(seq 232). So the behaviour after a rejection is not uniform: sometimes an immediate end-of-turn
(which the workflow reports as a missing marker), sometimes a silent stall.

## 6. Honest limits (fact)

- **One writing retrial, not a repeated sample.** No second run was attempted to measure how often
  the handoff-step stall recurs.
- **Headless CLI, not the cockpit path.** The retrial drove `xezar run` directly; the cockpit's
  HTTP/server path was not exercised. Both construct the OpenCode session the same way, but that is
  reasoning, not a measurement.
- **Config-pin friction with kit bootstrap.** Pinning `defaultRunner: opencode` in the scratch clone
  had to be **committed** there (not pushed): an uncommitted-only change made kit bootstrap refuse
  the new task worktree with `existing task asset differs: config.json` on the first two attempts —
  the pitfall `model-routing.md` § 5 already documents.
- **DeepSeek-only for writing.** Only `deepseek-api/deepseek-flash` was tried on a writing chain; the
  LAN DeepSeek and Qwen models were exercised read-only only.
- **The 0.16.0 baseline tally** (§ 1) rests on the § 13 record; those eight run ids are not in
  today's run store.
- **Security and quality verdicts are not this report's.** The `## QA` on PR #688 and the retrial
  report are the verdicts; this report is a qualification summary, not a new approval.

## 7. Defects found, and their state (fact)

| Defect | State | Detail |
|---|---|---|
| **#686** — the runner denied `external_directory` for the run's own evidence dir, so a kit writing task could not finish | **fixed** | PR **#688** merged as `9e97a149` (2026-09-19 12:10Z). Opus security review **APPROVE** (3 Minors); sonnet live QA **PASS** on a real `opencode serve` session — and that QA found #692. |
| **#692** — after a rejected `external_directory` ask the session goes silent | **open**, `bug` + `release-0.17.0` | Four reproductions (§ 5). The fix is in flight as a separate task. |
| **#690** — `safeRunId` is looser than its comment, and the frozen `.local/xezar-tasks/<runId>` root is granted even when absent | **open**, `enhancement` + `release-0.17.0` | The two non-blocking Minors of the #688 review, filed rather than fixed there. |

## 8. Routing verdict (judgement)

**OpenCode stays OUT of the model-routing rotation until #692 merges.** The 2026-09-19 evidence
justifies that on its own: read-only work is now solid across five workflow types and three models,
but the one writing chain that got as far as a sealed evidence set still could not reach a PR,
because a correct rejection can hang a session. A backend whose failure mode is "silent until a
human notices" is not ready for the rows a PR depends on.

**After #692 merges**, re-enter OpenCode for **read-only rows first** (business-analysis, research,
advisory code review, post-merge QA, tracker chores), and promote it to writing rows only after a
second, repeated writing retrial reaches a merged draft PR. This is the leader's judgement, not a
measured result: nothing in the 2026-09-19 data shows a writing chain completing end to end.

## 9. How to retest

1. Build the CLI from the candidate `main`: `npm ci && npm run build`.
2. Make a fresh clone of the repository outside the real primary checkout and set
   `.xezar/config.json` to `{"defaultRunner":"opencode"}`; **commit** that change in the clone (kit
   bootstrap refuses a new task worktree otherwise).
3. Drive it headless: `node packages/xezar/dist/index.js run "<task>" --repo <scratch-clone>
   --workflow docs-maintenance --model deepseek-api/deepseek-flash`, with `XEZ_HOME` pinned to
   scratch and **no** `XEZ_DRY_RUN`.
4. Watch `.local/xezar/runs/<runId>.ndjson`: assert **no** `denied permission
   'external_directory'` line naming `.local/xezar/tasks/<runId>/*` (the #686 check), and after any
   *legitimate* denial assert that the session either continues or ends within a bounded time
   (the #692 check). Kill only by saved PID.
5. Pass condition: the chain reaches `handoff` and opens a draft PR; a silent stall is a FAIL.

## Sources

- Run store `.local/xezar/runs.json` (primary checkout, read-only) — the 12 runs of § 3 and their
  timings, models and statuses.
- `gh pr view 688` / `gh issue view 686` — the `## QA` PASS (probes and the stall), the Opus
  security review, and the integration record.
- `.local/xezar/tasks/8feb0aaa-815f-4052-b960-747c33ce2815/opencode-writing-retrial.md` — the
  writing retrial's step table, seal `ba494c8e` and the 11m58s stall.
- Issues #686, #688 (PR), #690, #692; `CHANGELOG.md` 0.16.0 entry `#578`.
- `.xezar/docs/model-routing.md` § 7 and § 13 — the 0.16.0 baseline tally (dated record).
