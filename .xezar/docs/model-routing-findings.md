# Model routing findings and history

### Expired at 0.16.0

0.16.0 was released on 2026-09-18 18:49 CEST (npm `latest` = 0.16.0, tag `v0.16.0`, bump merge
`a8b25a77`), so section 10 step 3 applies: these campaign-only rules are out of force and are kept
here only so their history is readable.

- 2026-09-18 ~17:00 (paraphrase; the 0.16.0 campaign `decisions.md` was deleted by the owner on 2026-09-18 20:26): the release go-ahead under the standing release-auth rule. Spent – the release ran and finished.
- 2026-09-18 14:39, GPT coding = "Ends with 0.16.0" (quoted from the 0.16.0 campaign `decisions.md`, which the owner deleted on 2026-09-18 20:26; not verifiable in the repository today). Expired: the table's GPT rows apply as written again.
- 2026-09-18 14:30, "fix all three real defects found by opus. Give it to DeepSeek V4.1 Flash" (quoted from the 0.16.0 campaign `decisions.md`, which the owner deleted on 2026-09-18 20:26; not verifiable in the repository today). Expired: the three defects were fixed by DeepSeek with a Claude review – defects A and B on PR #638 (`890577c7`, merged as `669a389e`) and the machine-wide skills-mirror lock on PR #639 (`b863ca9f`, merged as `b0d88ca7`).
- 2026-09-18 14:16, "stop testing models and focus on the release" (quoted from the 0.16.0 campaign `decisions.md`, which the owner deleted on 2026-09-18 20:26; not verifiable in the repository today). Expired with the release; benchmarks still need the owner's word.
- 2026-09-18 12:20, "Do not use OpenCode for now until the 0.16.0 will be ready" (quoted from the 0.16.0 campaign `decisions.md`, which the owner deleted on 2026-09-18 20:26; not verifiable in the repository today). Expired as a dated ban – the cockpit has run 0.16.0 since 2026-09-18 19:41. OpenCode nevertheless stays out of the rotation on its own record (§ 7: the kit's five read-only roles are never routed to it, and it stays out for writing rows until a repeated retrial reaches a draft PR); a re-trial is one small task on the owner's request that is not one of the kit's five read-only roles, cancelled after 15 silent minutes.
- 2026-09-17 22:58, "but do not use GPT for coding" (the coding half of that sentence; quoted from the 0.16.0 campaign `decisions.md`, which the owner deleted on 2026-09-18 20:26; not verifiable in the repository today). Expired: GPT may write code again when Codex quota returns on 2026-09-20 16:02. The images half stays in force, above.


## 12. Sources

Vendor pages fetched 2026-09-16; the dogfooding findings
`docs/features/mcp-server/leader-dogfooding-2026-09-13.md` (D); PR comments on qodeca/xezar
#500–#505, 2026-09-16 (R); and the leader's 2026-09-15/16 run-record observations (L; recorded in
§ 13). "Inferred" marks a judgement of the leader's, not a vendor claim.

- Claude: https://platform.claude.com/docs/en/models/overview · https://code.claude.com/docs/en/model-config · https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code · https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan · https://www.anthropic.com/claude-fable-and-mythos-5-1 · https://code.claude.com/docs/en/errors
- Codex: https://learn.chatgpt.com/docs/models · https://developers.openai.com/api/docs/models/gpt-6-astra · …/gpt-5.6-sol · …/gpt-5.6-terra · …/gpt-5.6-luna · https://developers.openai.com/api/docs/guides/latest-model
- Local: https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash · https://recipes.vllm.ai/deepseek-ai/DeepSeek-V4-Flash-Vision-Exp · https://github.com/vllm-project/vllm/issues/43648 · https://huggingface.co/Qwen/Qwen3.8-Flash-Next · https://huggingface.co/pipenetwork/Qwen3.8-Flash-Next-MLX-mixed-4_8bit · https://github.com/sgl-project/sglang/issues/36537 · https://pi.dev/docs/latest/models
- Leader log: run store `.local/xezar/runs.json` + campaign notes under `.local/xezar/campaigns/`; cited per run in § 13.
- Unconfirmed: exact Claude quota multipliers per model; whether `[1m]` variants are credit-gated on a subscription; `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5-codex`, `gpt-5.1` ids (not in the current Codex model list); coding-benchmark loss of the Qwen 4/8-bit quantisation.


## 13. Findings log

Campaign notes moved to `.local/xezar/campaigns/` on 2026-09-18, and the owner deleted every campaign
note older than 0.17.0 the same day (`model-benchmark` was kept). Entries below that cite a
`.local/xezar-campaigns/…` path therefore name a file that no longer exists; the run-store entries
they also cite are still there, and the text is kept as written rather than re-attributed.

### 2026-09-16

- **OpenCode pin and kit snapshots.** At about 12:40, setting `defaultModels.opencode = mac-m4/qwen38-flash-next-mlx-mixed-4-8bit` from the cockpit wrote the primary checkout's `.xezar/config.json`. Kit bootstrap then refused chains 29 and 30 at `kit` with `existing task asset differs: config.json` (run store, run `f0a3e70a`; campaign note § Wave at 12:42–12:52 CEST; run store, run `8bc1287b`; campaign note § Wave at 12:42–12:52 CEST). `quick-task` with a `xezar-*` skill worked because it has no kit step. The owner chose to commit the pin in PR #513; after CI found the repository's own fixture asserting that the key was absent, the choice was to keep the pin and fix the test (run store, run `9303ee84`; campaign note § Wave at 12:42–12:52 CEST).
- **Codex Terra.** `77df8015` opened PR #513 in about five minutes with both kit checks; `baa0a90b` reviewed it with real checks, APPROVE, and labels; `325bcea0` honestly stopped integration on a real `settings-agents.e2e.ts` failure rather than the #446 flake (run store, runs `77df8015`, `baa0a90b`, `325bcea0`; campaign note § Wave at 12:42–12:52 CEST).
- **Codex Sol.** The issue #515 audit was thorough, file:line-cited, and separated verified from unverified claims in about seven minutes (run store, run `bfa65dc8`; campaign note § Wave at 12:42–12:52 CEST). At log time, the token-heavy response, re-check, and bug investigation had no verdict yet (run store, runs `d2ec4451`, `47c7f4bf`, `deb5deb4`; campaign note § Wave at 12:42–12:52 CEST).
- **Existing local-model trials.** The OpenCode total is eight stalls: seven DeepSeek results – `f07d1839`, `5ae9de7e`, `43c73d0f`, `cd20e3a8`, `ae6280b2`, `3e608a1d`, plus the #373 docs run `cb9818e5` – plus one Qwen result, `52a11f58` (run store, runs `f07d1839`, `5ae9de7e`, `43c73d0f`, `cd20e3a8`, `ae6280b2`, `3e608a1d`, `cb9818e5`, `52a11f58`; campaign note § Wave at 23:33–23:40 CEST). pi Qwen's already-recorded loop occurred after posting (run store, run `e12a2004`; campaign note § Wave at 23:43–23:50 CEST). No new trial verdict is added here.

### 2026-09-17

- **Codex out for the rest of the campaign.** Usage limit hit at 10:00, reset 2026-09-20 16:02: every dispatch from then on went to Claude opus/sonnet or one of the two one-shot local pi models instead (`.local/xezar-campaigns/2026-09-17-release-0-16-0/timeline-2026-09-17.md:14`, `:102`).
- **pi DeepSeek, tracker filing.** Run `899dabce` filed issue #603 in one shot at 23:14 with the primary left clean, matching the one-shot pi brief rule in § 6 (`.local/xezar-campaigns/2026-09-17-release-0-16-0/timeline-2026-09-17.md:333`).

### 2026-09-18

- **pi DeepSeek, second one-shot filing.** Run `03b43fe0` filed issue #613 (the `continue` re-prompt loop below) at 05:12, primary left clean (`.local/xezar-campaigns/2026-09-17-release-0-16-0/timeline-2026-09-18.md:57`).
- **A $144 `execution_control continue` loop, Claude sonnet, `westagilelabs-priv`.** Run `04af6692` (the #607 review-response step, sonnet, `westagilelabs-priv` account) burned 41 turns / 3.2M tokens / $144 inside one `continue` call before failing on a missing `XEZ:DONE` – the continued turn re-prompted itself instead of stopping (`.local/xezar-campaigns/2026-09-17-release-0-16-0/README.md:61`). Filed as issue #613 (above). This is an engine-behaviour cost, not a model-choice lesson, but it means a `continue` call needs watching for a runaway re-prompt rather than an assumption that it self-terminates.
- **All coding on Claude opus/sonnet.** With Codex still out (reset 2026-09-20 16:02) and OpenCode already excluded (§ 2, the 2026-09-18 12:20 rule), every implementation, review and chain dispatch on 2026-09-17/18 ran on Claude opus or sonnet, split across the `qodeca-priv` and `westagilelabs-priv` accounts (`.local/xezar-campaigns/2026-09-17-release-0-16-0/README.md`, accounts table, updated 05:27). `westagilelabs-priv` itself had been out on its own session-window limit and came back at 23:50 on 2026-09-17, with the engine auto-resuming its 5 limited runs itself (`.local/xezar-campaigns/2026-09-17-release-0-16-0/README.md:39`).
- **Fixed-task model benchmark (the backup lane and the Ornith drop).** A 10-task fixed benchmark with known ground truths, run per model with the same briefs and the same scoring rule (PASS/PARTIAL/FAIL), evidence at `.local/xezar-campaigns/model-benchmark/README.md`. `dgx-spark/deepseek-v4-flash-vision` on pi scored 10 of 10 PASS, 2–90 minutes per task. `mac-m4/ornith-1.5-35b-a3b-mlx` on pi scored 7 PASS, 1 PARTIAL (approved an unmergeable PR) and 2 FAIL of 10 – one FAIL was work done in the primary checkout instead of its own task worktree, a false containment claim – and the owner dropped it the same day. `deepseek-api/deepseek-flash` (DeepSeek V4.1 Flash through the DeepSeek API, a paid cloud service the owner configured in pi) scored 12 of 13 scored tasks PASS, 0 FAIL, at 0.5–9 minutes per task (`results-2026-09-18-deepseek-v41-flash-api.md` in the same folder); given three hard cold-review tasks matched against an Opus/Sonnet ground truth, it also raised new claims beyond that truth on already-merged code – Opus verified one as a real release-blocking regression (#588, the pi `--mcp-config` MCP-bridge fix) and two more as smaller true defects (#617, #586) by the time this entry was written. This is the evidence behind the owner's 2026-09-18 backup-lane rule (§ 2; the quote's source, the 0.16.0 campaign `decisions.md`, was deleted by the owner on 2026-09-18 20:26): "Keep DeepSeek V4.1 and Pi as a backup for situation that there will be no limits available on GPT and Claude accounts you have access to."

### 2026-09-18 evening (after the 0.16.0 release)

This is the evidence behind the owner's 21:3x rule and the section 4 placement. Everything below is
read from the run store `.local/xezar/runs.json`, the campaign notes at
`.local/xezar/campaigns/release-0.17.0/` and `gh`; run ids are the first eight characters.

- **The day's tally.** Dispatched under the owner's 17:19 "all next tasks on DeepSeek" rule (source deleted; § 2), the run store holds 46 runs on `pi` + `deepseek-api/deepseek-flash` for 2026-09-18: 41 `done`, 3 still `running` at 21:11, 2 `cancelled` (`df856830`, `890577c7`), and no `failed` run at all – a cancel is a dispatch the leader stopped, not a model failure. Wall-clock per run ranges from 6 seconds to 105 minutes; the long ones are whole workflow chains, and a single step is usually between half a minute and a quarter of an hour.
- **It ran the 0.16.0 release end to end.** Run `2b62f1cb` (`release` workflow, 105 min from 15:46, state 2 – Codex out, Claude available) wrote the changelog section from the merged PRs, passed readiness, gates and the evidence seal, merged changelog PR #642 (merged 16:20 UTC), dispatched the Release workflow once – GitHub Actions run 35369683346, `completed`/`success`, started 16:38 UTC – and then merged the bump PR #643 (17:13 UTC). Verified afterwards: npm dist-tag `latest` = 0.16.0, tag `v0.16.0`, GitHub Release published 16:49 UTC, bump merge `a8b25a77`. This is the row that moved the release role off "strong models only" in § 7.
- **Merge chain, state 2.** Run `fc8dab0e` (`integration`, 35 min, state 2 – Codex out, Claude available) merged docs-only PR #641 → `9e2bf2c6` (15:37 UTC). This is the only merge-chain run cited, and state 3 did not occur that day: the table's state-3 cell for this row is the leader's placement judgement, not this evidence.
- **The single-project defects A and B, and the skills-mirror lock.** Run `890577c7` (`bug-fix`, 12:30–13:27 UTC) authored the A and B fix on branch `xez/890577c7`, and run `83b2120b` (`address-review-findings`, 57 min) answered the Claude review; PR #638 merged as `669a389e` (14:36 UTC). `890577c7` is one of the two runs the tally above records as `cancelled` – the leader stopped it at its gate step after its branch and PR were already up, so the status is not a model failure and did not lose the fix (`gh pr view 638 --json headRefName` → `xez/890577c7`). The third defect, the machine-wide skills-mirror lock, ran separately as `b863ca9f` (`bug-fix`, 61 min, `done`) and merged as PR #639 (`b0d88ca7`).
- **Close-out tracker work.** Runs `e66e31d7` (4 min), `c2bb9167`, `63323753`, `1bd261a6` and `d398dcc5` filed issues #644–#652 between 17:45 and 18:11 UTC, one deliverable each.
- **Live QA, two cockpits.** Run `83428cc9` (`qa`, 12 min) booted two 0.16.0 single-project cockpits side by side and reported PASS overall with one row honestly marked FAIL – attaching an OpenCode session from the other project was accepted instead of refused, filed as #651 – and the Codex row NOT RUN because Codex quota is out. Reporting its own failing row is the behaviour § 7 asks of a lane whose work Claude must still review.
- **Read-only analysis.** Run `6df460e3` (`business-analysis`, 11 min) produced the 0.17.0 leftover inventory with no write outside its own worktree.
- **Evening docs work, state as read at 21:11.** Run `ec7d9e41` (`address-review-findings`, 21 min) finished round 1 on PR #653, which is OPEN and not merged; PR #653 itself came from run `8c03a1dc` (56 min). Runs `491075b6` (leader guide), `f0ee75a9` (leader-context standard) and `6dd54474` (browser-harness fix) were still running, so nothing is claimed about their outcome.
- **The one slip.** In `ec7d9e41` a command was wrapped in `timeout`, which macOS does not ship, and the turn was lost to `timeout: command not found`. That is a brief defect, now fixed by the § 6 row, not a model failure. The older "posted one comment twice" slip belongs to the LOCAL DeepSeek on `dgx-spark`, not to this API lane.

### 2026-09-15 evening

- **Codex Terra.** In chain 27, #511 was skipped because its brief permitted a base refresh only when GitHub said BEHIND; GitHub said CLEAN although `main` had advanced, and the run posted `## Integration SKIPPED` (run store, run `d635efc4`; campaign note § Wave at 12:42–12:52 CEST). In chain 28, a permitted `gh pr update-branch` moved #510's head from `3384a5d` to `1b8dbe8`, after which the exact-head guard correctly refused to proceed (run store, run `8b56fd32`; campaign note § Wave at 12:42–12:52 CEST). The lesson is procedural reliability with literal brief interpretation, captured in § 6.
- **Claude Opus.** The #474 review re-measured MCP coverage and re-ran two red proofs in eight minutes at $6.54; #466 P4 implementation changed 26 files and named 10 breaks at $15.50 (run store, runs `2305b394`, `cedba1c1`; campaign note § Wave at 23:20–23:30 CEST). One continued chain resumed only its agent step and ended `done` without push, PR, or gates; a manual second continue was needed (run store, run `cedba1c1`; campaign note § Wave at 23:20–23:30 CEST).
- **pi DeepSeek.** The tracker-only issue #478 filing was correct in one shot (run store, run `a3f24c69`; campaign note § Wave at 03:33–03:40 CEST).

### 2026-09-19

- **OpenCode qualification.** 12 runs with `runner: opencode` in one day (run store, all times UTC). **11 read-only runs completed**: `business-analysis` ×7 (`7fd00b1f` #677/#672, 5m04s; `e5cbf578` #670, 2m41s; `71358c98` #676, 4m59s; `f4bec267` #678, 5m59s on local DeepSeek; `4f40f4b7` #686 re-check, 4m06s on Qwen; `d2216383` #613, 2m13s; `91fea85d` #647+#649, 3m04s), `qa` (`0864d7db` #683 post-merge, 1m53s), advisory `code-review` (`ec883b72` PR #665, 9m22s – its record-rewrite finding became #689), `research` (`069f3dd5` #686, 5m09s) and a one-shot tracker comment (`841770b3` #677, 2m42s). Wall-clock 1m53s–9m22s, 0 cancelled, 0 failed.
- **The one failure, and the defect it found.** `0f4c4e08` (`bug-fix` #680) failed after 1m12s: the runner denied `external_directory` for the run's own task-evidence directory, so a kit writing task could not finish. Filed as **#686**; fixed by PR **#688** (merged `9e97a149`; opus security review APPROVE, sonnet live QA PASS, which found the next defect). The same trial produced **#690** (two Minors of that review, open).
- **Writing retrial, and the second defect.** A `qa` run (`8feb0aaa`) drove a headless `xezar run` of the kit `docs-maintenance` workflow on OpenCode + `deepseek-api/deepseek-flash` against a fresh clone of `main` `9e97a149` in a scratch checkout (inner run `851a6f9b`): author → readiness → **8/8 gates** → evidence sealed `ba494c8e`, **zero denials of `.local/xezar/tasks/<runId>/*`** – #686 confirmed fixed on a real end-to-end chain. It then stalled at `handoff`: after a *correct* denial of a read of the primary's `.xezar/skills/*` the session emitted nothing for **11m58s**. Filed as **#692** (`bug`, `release-0.17.0`) – the fourth reproduction of a post-denial stall, after three in the #688 QA (combined run `755e878d`, the base build, isolated re-run `626d8b35`); the fix is in flight. The one different shape is `0f4c4e08`, where the turn ended at once (a missing-`XEZ:DONE` failure) instead of stalling.
- **Placement.** OpenCode stays **out of the rotation** until #692 merges; after that it re-enters for read-only rows first, and for writing only after a repeated retrial reaches a draft PR. Full report: [opencode-qualification-2026-09-19.md](opencode-qualification-2026-09-19.md).

### 2026-09-21

Read from the 0.17.0 campaign notes (`.local/xezar/campaigns/release-0.17.0/decisions.md`,
`timeline-2026-09-20.md`, `timeline-2026-09-21.md`) and the run store; the brief rules these
incidents produced are in § 6 and the leader rules in
[leader-guide.md](leader-guide.md).

- **A synthetic "load" harness is not a load test.** The #731 review (`b74e59fe`, sonnet) spawned 24
  `bash -c while :; do :; done` busy loops because its brief said "or throttle CPU"; the machine load
  went to 55 against a cap of 18. The leader killed the 24 PIDs and the load fell to 29 within three
  minutes (timeline-2026-09-20.md 09:47). The rule it produced is the § 6 load-claim row (leader,
  2026-09-20; decisions.md dates it 10:3x, the timeline times the incident at 09:47, and the two
  notes disagree on the order). Separately, four concurrent gate runs on 2026-09-21 put the load at
  39 (timeline-2026-09-21.md 01:11), inside the 90 % failure band of § 6: a ceiling to stay under,
  not a condition to reproduce.
- **The owner strengthened "fix or rebuild every flake" into "redesign the flake".** At 2026-09-20
  06:55 the owner said "All flake tests MUST be fixed / rebuilt to ensure no flake(iness)"; at 21:02
  the owner strengthened it: "flaky tests must be redesign to a different approach to ensure the are
  not flaky" (decisions.md). #671 became one redesign pull request per flake; that each states the
  old mechanism, the new mechanism and why the new one cannot depend on timing is the leader's
  reading, marked as such in decisions.md (the § 6 row). The
  `todos.test.ts` FSEvents case below is one of them, redesigned by run `3730744e` as PR #786.
- **An exhausted gate-return counter does not carry into a superseding run.** Run `98cc751d`, the
  first supersede of #784, was content-green (7 of 8 gates, the fragment fixed in `f510de9c`) and
  still FAILED readiness, because it had declared `counters init --predecessor` and inherited the
  spent 2-of-2 gate-return counter of `700f23bf`. The rule it produced is the § 6 supersede row
  (leader, 2026-09-21 02:38; timeline-2026-09-21.md). The counter itself was spent on
  `src/todos.test.ts` "scopes events to the written dataDir", a macOS FSEvents timing flake that
  reddened four of five gate runs (timeline-2026-09-21.md 01:23).
- **A closing keyword closes an issue the work did not finish.** #670 was closed at 09:05 on a
  `ci-watch` "passed" event before main CI was read, and reopened at 09:06 once the run was read as
  red (2026-09-20). #677 was closed by a merge's closing keyword with B3–B6 still open and was
  reopened by the leader; the timeline entry is labelled 15:4x and the notes correct that label to
  14:4x–14:5x (timeline-2026-09-20.md, the 15:01 correction). The rule it produced is in
  [leader-guide.md](leader-guide.md).
- **An unrelated flaky test is reported, never repaired in the pull request that hit it.** Four pull
  requests on 2026-09-20 (#769, #775, #774 and the DeepSeek #671 attempt) each carried a private
  `todos.test.ts` rider, and every one conflicted with the next merge (leader, 2026-09-20 22:3x;
  decisions.md).
- **A non-final step cannot host a long wait.** Two attempts of #734's round 1 (`5495f83d`, opus)
  failed on `XEZ:MONITORING` after starting their own background gate run: the first at `address`
  (timeline-2026-09-20.md 12:51), the second in the gate-return `address` step (13:12). The lesson
  recorded then was that the brief must forbid a self-run gate outright, not only "in the
  background". The Codex and shared-`TMPDIR` halves of the leader-guide rule are the leader's
  dated rule from the dispatch brief, not evidenced in the campaign notes (leader, 2026-09-21;
  [leader-guide.md](leader-guide.md)).
- **Codex out of credits is not a stuck session.** The #791 review on `gpt-6-astra` replayed one
  identical turn eight times with no tool call; a `codex exec` probe answered "Your workspace is out
  of credits. Add credits to continue.", a credits problem and not a window limit, and routing moved
  to state 2 (timeline-2026-09-21.md 02:26–02:27).
- **A weaker model's Blocker claim holds the pull request.** A DeepSeek advisory on PR #791 claimed a
  Blocker (an unref timer letting a headless run exit 0 mid-step) that the sonnet APPROVE had not
  tested; `merge-queue` was removed and the verification went to Fable (run `866c92bd`), a strong
  model that was neither the author (opus) nor the claimant (DeepSeek) (timeline-2026-09-21.md
  02:44). The hold was never lifted: the sonnet live QA reproduced the defect 4 of 4 and filed it as
  #793 (02:48), Fable confirmed it live 3 of 3, wider than claimed (02:56), and fix round `16ae6f6e`
  followed. The weaker model's claim was true.
- **A `REFRESH` record refused for its shape.** #772's readiness refused the record shape until the
  brief carried `refresh:`, `base: <40-character sha>` and `evidence:`, and the same note went to
  #771 (timeline-2026-09-21.md 02:00). The three lines are in § 6.
- **Several parked runs resumed at once.** Continuing three parked runs plus two fresh fixes put four
  gates in flight and the load at 39; #777 (01:11) and #771 (01:18) were cancelled at their gates
  step to keep the ceiling at two, and #783/#784 exhausted their gate-return counters on the same
  `todos.test.ts` flake (timeline-2026-09-21.md 01:04–01:23). The leader rule is in
  [leader-guide.md](leader-guide.md); the ceiling itself is § 6.

### 2026-09-21 (continued)

Leader lessons 12–16 of the same day, recorded after the entry above. Every rule below is the
leader's own, not the owner's; the brief rules are the § 6 rows dated 2026-09-21 and the leader
rules are in [leader-guide.md](leader-guide.md).

- **A superseding run declares its counter history as none.** Lesson 12 repeats the finding already
  recorded in the entry above (run `98cc751d`): a supersede on a fresh branch that declares
  `counters init --predecessor` inherits the exhausted gate-return counter and fails at readiness.
  The rule was already a § 6 row before this entry was written, so nothing was added for it (leader,
  2026-09-21).
- **A conflict refresh that keeps the old head in the record is refused.** The refresh merges `main`
  through `.xezar/checks/merge-recovery.sh` and must then REWRITE the `DELIVERED` record for the new
  head; readiness compares the record against the current head and refuses a stale one. The rule it
  produced is the § 6 conflict-refresh row (leader, 2026-09-21).
- **A `continue` note written from an older message re-answered a settled question.** On run
  `770d8428`, the #791 conflict refresh (2026-09-21 04:43), the leader's note said the merge commit
  had never been made because `MERGE_HEAD` was left behind; `merge-recovery.sh` had in fact made it,
  so the note sent the run back to a step it had already finished and the leader withdrew it a
  minute later (timeline-2026-09-21.md 04:43, 04:44). The rule it produced is in
  [leader-guide.md](leader-guide.md) (leader, 2026-09-21).
- **A fresh push showed no checks at all.** Run `9395bcfb` finished #672 at 06:24 and opened PR #805
  with no CI checks on the new head `3e49a44b`; the leader dispatched
  `gh workflow run ci.yml --ref xez/9395bcfb` (Actions run 35560772898) rather than closing and
  reopening the pull request (timeline-2026-09-21.md 06:24). The rule it produced is both the § 6
  handoff-step row and a leader rule in [leader-guide.md](leader-guide.md) (leader, 2026-09-21).
- **A flake fix was dispatched for a wait another pull request had already rebuilt.** Run
  `e842b53c` (2026-09-21 05:09) was briefed on `progressive-history.e2e.ts:459`, which PR #782
  (`2f195b78`) had already rebuilt; the run correctly stopped at readiness with `BLOCKED` rather than
  re-fixing it. The rule it produced – grep the campaign `merges.md` and run
  `gh pr list --search "<spec file>"` before dispatching a flake fix – is in
  [leader-guide.md](leader-guide.md) (leader, 2026-09-21).
- **A rebuilt wait failed again once.** The `serve-port-memory.test.ts` "busy remembered port" case
  failed on run `c03361ad` (2026-09-21 05:52, two gates in flight, load 12) on a branch that already
  contained the #782 rebuild `2f195b78`; the cause was not established then, and PR #807 later found
  the random busy sentinel could be port 65535, decided by the port number and not by timing
  (timeline-2026-09-21.md 05:52, 06:12). Filed as #804. The rule it produced is in
  [leader-guide.md](leader-guide.md) (leader, 2026-09-21).
- **A `continue` that only supplied a missing `XEZ:DONE` cost nothing.** One
  `execution_control continue` on run `9395bcfb` (2026-09-21 06:04) resumed a run that had merely
  omitted `XEZ:DONE`, at no extra cost – the $144 re-prompting loop of #613 (2026-09-18, above) did
  not recur. The ten-minute watch on every continue is unchanged.

### 2026-09-21 (after the 0.17.0 release)

Leader lessons 17–20 of the same day, recorded after the entries above, together with the release
record itself. Every rule below is the leader's own, not the owner's; the brief rules are the § 6
rows dated 2026-09-21 and the leader rules are in [leader-guide.md](leader-guide.md).

- **0.17.0 shipped.** 0.17.0 was released on 2026-09-21 13:55 CEST (npm `latest` = 0.17.0, tag
  `v0.17.0` → `114aa348`, bump merge `ccff8a2f`) by release run `b477bc90` on the DeepSeek lane in
  state 2, with all 18 issues of the fixed scope the owner set on 2026-09-20 06:55 closed. That scope
  is not the label's total: 19 `release-0.17.0` issues were open on the morning of 2026-09-21, and
  #669 was closed the same day as won't-do on the owner's "No, keep it strict". The label as a whole
  holds 59 issues, all closed (`gh issue list --label release-0.17.0 --state all`, read 2026-09-21).
- **Every agent turn in every step ends with the marker.** `XEZ:DONE` is the very last line of every
  turn of every step, not only of the last step of a run. The base "Every model" row already carried
  the marker, so what is new is that it applies to every turn of every step. The rule it produced is
  the § 6 row (leader, 2026-09-21).
- **A bug-fix brief forbids background proofs outright.** Run `16d05de6` (the #812 fix, opus,
  2026-09-21 10:50) failed at `investigate` on `XEZ:MONITORING` because it started its proofs in the
  background, with the fix already committed; one `continue` saying "re-run the proofs in the
  foreground" finished it. This is the #734 lesson again (run `5495f83d`, 2026-09-20). The rule it
  produced is the § 6 row (leader, 2026-09-21).
- **The release brief dispatches the changelog review at once.** On release run `b477bc90`
  (2026-09-21 13:36) the run's last step polled about 15 minutes for a review of PR #814 because the
  leader had not dispatched one. The rule it produced is in [leader-guide.md](leader-guide.md)
  (leader, 2026-09-21).
- **A CI re-run of an unfixed flaky case is never the remedy.** On PR #653 (2026-09-21 12:25–12:41)
  the leader cancelled CI re-run 35588702096, then refresh run `def330f3` merged `main` `22334449`
  (the #813 fixture fix) and CI went green. The rule it produced is in
  [leader-guide.md](leader-guide.md) (leader, 2026-09-21).

### 2026-09-22

- **The four read-only kit workflows carry a `bashAllowlist` (#849, kit slice D), proven against a
  live Claude CLI.** The first version (PR #857 head `6fb4edc9`, sonnet, run `8a1dad0e`) was proven
  only by the argv the engine BUILDS; the binding review (opus, run `876c6e1f`) ran that argv through
  a real `claude` 2.1.278 and found the directory entry `bash .xezar/checks/` matched no command and
  `sed`/`cp` rewrote tracked files. Claude Code reads `Bash(<entry>:*)` as the entry followed by a
  space and anything, or by nothing, so each command is now its own entry (response run `c13d5e74`,
  opus, head `124cf32e`). The proof: a `git archive` of `124cf32e` into a fresh remote-free
  `git init`, a headless `XEZ_DRY_RUN=1` `xezar run --workflow code-review` whose mock recorded the
  built `--allowedTools` (`Read,Grep,Glob` plus 43 `Bash(<entry>:*)` rules, no plain `Bash`), then
  one fresh `claude -p` session per command under that exact list, `--permission-mode dontAsk`,
  `--setting-sources project` over a project settings file with empty `permissions`. RAN:
  `bash .xezar/checks/worktree-setup.sh --readonly-init`, `node .xezar/checks/catalog-check.mjs`,
  bare `bash .xezar/checks/worktree-preflight.sh` and bare `gh pr view` (an entry matches with nothing
  after it), `jq -n '…' | bash .xezar/checks/verdict-packet.sh` (the packet was written), and
  `git diff --output=<file>` (a write a prefix cannot see). DENIED: `sed -i` and `sed -n 'w …'` on a
  tracked file, `cp source AGENTS.md`, `mv a b`, `gh pr merge 1`, `gh api …`, `git commit`,
  `git diff; rm -rf x`, `rg --pre`, `XEZ_DRY_RUN=1 npm test`, and `echo x > <file>` even inside an
  `--add-dir` directory, which is why the verdict packet now goes through `verdict-packet.sh`. No
  tracked file changed. Kit checks at `124cf32e`, in the task worktree after `npm ci` (with
  `node_modules`): `node .xezar/checks/catalog-check.mjs` CATALOG OK (18 workflows, 20 skills),
  `node .xezar/checks/xezar-contract.test.mjs` 35 of 35, `bash .xezar/checks/infra-tests.sh` 757
  passed, 0 failed (751 plus six new `verdict-packet.sh` cases). The reviewer measured 735 passed,
  1 failed for the same suite in a checkout without `node_modules`, at this PR and at `main` alike:
  the gate-lease case needs a xezar CLI in the checkout. Not run: pi, Codex or OpenCode sessions;
  on pi the `bashAllowlist` removes the shell (read from `pi-runner.ts` `piTools`), tracked as #856.
  A reviewer's own run is not the QA for a workflow change unless its checkout carries the change —
  the first version's claim to the contrary was wrong.

