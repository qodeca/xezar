# Model routing for Xezar tasks

The one routing document. Owner: Marcin. Keeper: the project leader.
Version 3, 2026-09-18, after the 0.16.0 release; version 2 (three reviews: fidelity, clarity,
strategy) and the 2026-09-16 map are carried forward in the model inventory, the sources and the
findings log.
Last verified against quota and owner rules: 2026-09-18 21:11 CEST. Every dated line below has an
expiry; the leader re-checks them at session start.

## Read this first (for the owner)

A plain summary. The rules themselves live in the numbered sections.

- **Who does what, in normal times:** DeepSeek and the small local models do the procedural work (tracker chores, merges, mechanical docs, bounded fixes). GPT models do the routine and judgement work (docs, QA, reviews). Claude Opus builds cockpit screens and checks the hardest claims. The strongest GPT model (astra) does security reviews, the hardest work and all generated images.
- **Today (2026-09-18 evening):** GPT (Codex) is back Sun 2026-09-20 16:02. Claude: `westagilelabs-priv` works; `qodeca-priv` is out until Sun 21 Sep 19:00; `gmail-priv` reset Fri 18 Sep 21:00 (probe it before you count on it); `eqamana-priv` Sat 19 Sep 18:00. At most 4 Claude tasks at once.
- **DeepSeek:** DeepSeek V4.1 Flash through pi is a normal lane now, not a backup. It is the first choice for procedural work – tracker chores, merges, mechanical docs, scoped re-checks, bounded fixes, evidence passes, the release role – and it works in every state, because its quota is its own. It is never used for security reviews, judging screens or pictures, cockpit UI, checking a big claim, or reviewing anything it wrote itself. Anything it writes still gets a full Claude review before it merges.
- **Never allowed:**
  1. A model approving its own work.
  2. Merging anything a local or DeepSeek model wrote before Claude reviewed it.
  3. A "Major" or "Blocker" claim from a weaker model reaching you before a strong model proved it.
  4. OpenCode (out on its own record: it stalled every time; a re-trial only if you ask) and Ornith (dropped).
  5. The release without your word.

## 1. The idea

1. For mechanical and procedural work: the cheapest model that does it well.
2. For verdicts that gate a merge (reviews, QA, security, claim checks): the strongest available model, and never the author's model.
3. Quota is the real limit, not price. Check who has quota first.
4. Use the lowest reasoning effort that produces the result.
5. Write down every failure. A model that fails often leaves the rotation.

## 2. Owner rules in force (top row wins)

A named exception covers only the tasks it names and ends when they merge. The exact words live in
the campaign `decisions.md`; each row cites it.

| When | Rule (owner's words) | What it means | Expires |
|---|---|---|---|
| 2026-09-18 21:3x | "add deep seek v4.1 flash to the leader model / agent routing table and come back to using the routing table as the guideline" | pi + `deepseek-api/deepseek-flash` is a NORMAL lane in section 4, not only a backup; this document is the guideline for every dispatch again. SUPERSEDES the 17:19 all-DeepSeek rule and the 14:18 backup-only rule | until changed |
| 2026-09-18 17:23 | "I fully agree with: The rule: a model never reviews its own work. You approved this rule in the routing document today. So one Claude task reviews that pull request." | the independence rule of section 3 step 4 is confirmed by the owner: no model reviews its own work, and what the DeepSeek lane writes is reviewed by a Claude task | until changed |
| 2026-09-18 17:19 | "All next task run with DeepSeek V4.1 Flash to speed it up. It will also allow us to verify it in this type of tasks" | SUPERSEDED by the 21:3x rule; kept for history. It is the reason 46 DeepSeek runs exist on 2026-09-18 (§ 13), which is the evidence behind the section 4 placement | superseded 2026-09-18 21:3x |
| 2026-09-18 14:39 | DeepSeek role = "Yes: second opinion on risky PRs" | STANDING ROLE beside its ordinary rows in section 4: a cold, read-only second-opinion review by pi + `deepseek-api/deepseek-flash` on every `risk-high` PR, in parallel with the main review; it writes nothing; at most one Opus check per PR for its Major claims | until changed |
| 2026-09-18 14:39 | Cloud limit = "No: it may read everything" | the DeepSeek API may read any code in the repository; no never-list | until changed |
| 2026-09-18 14:18 | "Keep DeepSeek V4.1 and Pi as a backup for situation that there will be no limits available on GPT and Claude accounts" | SUPERSEDED by the 21:3x rule: the lane is no longer backup-only. What survives is state 3 of section 4 – when Claude and Codex are both out, DeepSeek carries the work it is first or second choice for | superseded 2026-09-18 21:3x |
| 2026-09-18 13:53 | "Drop Ornith usage completely" | `mac-m4/ornith-1.5-35b-a3b-mlx` gets no task | until changed |
| 2026-09-17 22:58 | "When you will have to generate images for the documentation update, use Astra" | generated images → `gpt-6-astra` only. A deterministic screenshot capture is tooling, not image generation (owner 2026-09-18 10:14). The second half of the same sentence, "but do not use GPT for coding", was campaign-only and expired at 0.16.0 (see below) | until changed |
| 2026-09-17 (paraphrase, memory `xezar-codex-limit-2026-09-17`) | Codex limit: move the work to Claude | state 2 of section 4 | Codex reset 2026-09-20 16:02 |
| 2026-09-16 | astra only for very demanding work; sol / terra / luna otherwise | section 4 | until changed |
| 2026-09-13 | drop unreliable models | section 7 | until changed |
| standing | release auth: "I ask you each time" | the leader asks; the release role starts only on the owner's word, quoting the commit | always |

### Expired at 0.16.0

0.16.0 was released on 2026-09-18 18:49 CEST (npm `latest` = 0.16.0, tag `v0.16.0`, bump merge
`a8b25a77`), so section 10 step 3 applies: these campaign-only rules are out of force and are kept
here only so their history is readable.

- 2026-09-18 ~17:00 (paraphrase; the 0.16.0 campaign `decisions.md` was deleted by the owner on 2026-09-18 20:26): the release go-ahead under the standing release-auth rule. Spent – the release ran and finished.
- 2026-09-18 14:39, GPT coding = "Ends with 0.16.0". Expired: the table's GPT rows apply as written again.
- 2026-09-18 14:30, "fix all three real defects found by opus. Give it to DeepSeek V4.1 Flash". Expired: the single-project defects A, B and C were fixed by DeepSeek on PR #638 with a Claude review and merged as `669a389e`.
- 2026-09-18 14:16, "stop testing models and focus on the release". Expired with the release; benchmarks still need the owner's word.
- 2026-09-18 12:20, "Do not use OpenCode for now until the 0.16.0 will be ready". Expired as a dated ban – the cockpit has run 0.16.0 since 2026-09-18 19:41. OpenCode nevertheless stays out of the rotation on its own record (§ 7: it stalled every time it was tried); a re-trial is one small read-only task on the owner's request, cancelled after 15 silent minutes.
- 2026-09-17 22:58, "but do not use GPT for coding" (the coding half of that sentence). Expired: GPT may write code again when Codex quota returns on 2026-09-20 16:02. The images half stays in force, above.

## 3. How the leader picks a model for one task

1. **Pick the state:** (1) normal, (2) Codex out, (3) Claude and Codex both out. Read the account table in the campaign README. The DeepSeek lane is available in every state: it has its own quota (the DeepSeek API, paid per token, no session window observed), so a Claude or Codex limit does not move it.
2. **Find the task row** in section 4 and read the column for that state.
3. **Apply section 2.** An owner rule beats the table. Since the owner's 21:3x rule of 2026-09-18 the table is the guideline again, so a dispatch that departs from it needs a rule to cite.
4. **Independence check:** the reviewer, QA or verifier model is never the author's model – confirmed by the owner on 2026-09-18 17:23. For `risk-high` work it runs on a different account, and on a different vendor when one has quota. What the DeepSeek lane writes is reviewed by a Claude task. The verifier of a claim differs from both the author and the claimant. The verdict names the author model and the reviewer model.
5. **Pick the account.** For Claude and Codex always pass `agentProfile` (the login name). One lane of work per account, so one limit stops only part of the work. Never `default` (the leader's own login). A pi task takes no `agentProfile`.
6. **Write the brief** from the brief template (section 6).
7. **After the task:** read the result; after any pi task check the primary checkout is clean; log failures in the timeline; if a failure changes a row, change this file.

## 4. The routing table

Columns: state 1 = normal; state 2 = Codex out (today); state 3 = Claude and Codex both out, so
DeepSeek only. "wait" = the task waits for a strong model.

In this table **DeepSeek** always means the cloud lane, pi + `deepseek-api/deepseek-flash` (DeepSeek
V4.1 Flash through the DeepSeek API). **local DeepSeek** means pi + `dgx-spark/deepseek-v4-flash-vision`
on this machine. They are different lanes with different rules; do not read one for the other.

| Kind of task | State 1 first → fallback | State 2 | State 3 – DeepSeek only | Never |
|---|---|---|---|---|
| Tracker only: labels, comments from a file, issue filing | DeepSeek → local DeepSeek → luna | DeepSeek → local DeepSeek → sonnet | DeepSeek | opus, astra |
| Re-check of one record against one comment | DeepSeek → local DeepSeek → luna | DeepSeek → local DeepSeek → sonnet | DeepSeek | opus, astra |
| Evidence pass: gate evidence, phase record, close-out audit of a release | DeepSeek → luna | DeepSeek → sonnet | DeepSeek | opus, astra |
| Mechanical docs edits | DeepSeek → luna → terra | DeepSeek → sonnet | DeepSeek | astra |
| Docs PR with real writing | terra → sol; DeepSeek second, draft PR + a full Claude review | opus (sonnet slipped twice on docs writing); DeepSeek second, same condition | DeepSeek, draft PR; the review waits | – |
| Merge chain (integration) | DeepSeek → terra with explicit allowed actions → sol → sonnet | DeepSeek → sonnet | DeepSeek | astra, opus, local models |
| Root-sync (Worktree off, fast-forward) | the leader's own `git pull --ff-only` | the same | the same | – |
| Conflict repair | DeepSeek for non-UI → terra → sol; opus for cockpit UI | DeepSeek for non-UI → sonnet; opus for UI | DeepSeek for non-UI; UI waits | astra |
| Scoped code re-check | DeepSeek → sol → sonnet | DeepSeek → sonnet (opus when sonnet authored) | DeepSeek | luna, haiku, whichever model authored the change |
| Full cold code review | sol → astra for very large diffs → opus; PLUS DeepSeek as a parallel read-only second opinion when the PR is `risk-high` | opus (sonnet when opus authored and risk is low); PLUS the same second opinion | DeepSeek, advisory only | haiku, local models, and the model that wrote the change |
| Security-sensitive review | astra → opus | opus | wait | local models, DeepSeek, terra, luna |
| Browser / manual QA | terra → astra for a live multi-step harness → sonnet | sonnet | wait | local models |
| Design review (judging screens and pictures) | sol → opus | opus | wait | luna, local models, DeepSeek |
| UX mockups | opus → sol | opus | wait | local models, DeepSeek |
| Bounded bug fix, one file, tests named | DeepSeek → terra → sol; luna for a test-only fix | DeepSeek → sonnet | DeepSeek, draft PR; the review waits | `gpt-5.3-codex-spark` |
| Multi-file implementation, not UI | sol → astra → opus; DeepSeek second, draft PR + a full Claude review + a red proof | opus; DeepSeek second, same condition | DeepSeek, draft PR; the review waits | terra alone, local models |
| Cockpit UI implementation | opus → astra; fable only if opus at high effort fell short twice | opus | wait | local models, luna, DeepSeek |
| Review response, one verdict | DeepSeek → sol; terra for a docs-only response | DeepSeek → sonnet | DeepSeek | – |
| Review response folding several verdicts | astra → opus | opus | wait | terra, local models |
| Kit / checks refactor | astra → sol | opus | wait | local models |
| Generated images | astra | probe the astra login; if out, ask the owner | ask the owner | every other model |
| Analysis, specs, research | sol → astra; fable for work larger than one sitting; DeepSeek second, advisory | opus; DeepSeek second, advisory | DeepSeek, advisory | luna |
| Verifying a Major claim from a weaker model | opus → astra or sol | opus | wait | the author, the claimant, DeepSeek |
| Release role | only on the owner's word; then DeepSeek first – it ran 0.16.0 end to end (§ 13) | the same | DeepSeek, on the owner's word | – |

Rules for state 3: DeepSeek does every row where this table makes it a first or second choice. A row
where it is in the "never" column waits for Claude or Codex, and so does a row that names it neither
way – browser QA, a review response folding several verdicts and a kit refactor are those three.
(Root-sync is the leader's own `git pull --ff-only` in every state, and generated images already read
"every other model" in the never column.) Its cold reviews stay advisory: they inform a verdict, they
are not one.

Two conditions ride with the DeepSeek lane everywhere in this table. It is a cloud API, so the
repository text it reads leaves the machine (owner 2026-09-18 14:39: it may read everything; there is
no never-list). And what it WRITES is merged only after a full Claude review, because a model never
reviews its own work (owner 2026-09-18 17:23) – which also means it never reviews, re-checks or QAs a
change it authored itself, whatever the row says.

Local models – pi + local DeepSeek (`dgx-spark`) and pi + Qwen (`mac-m4`) – keep every restriction
they had: they never touch a branch, so no implementation, no live QA and no security reading, and at
most a bounded single-file test fix. "Local models" never includes `deepseek-api/deepseek-flash`; that
one is the DeepSeek lane and is a normal lane of this table.

## 5. Accounts and quota

- Claude logins: `qodeca-priv`, `westagilelabs-priv`, `gmail-priv`, `eqamana-priv`. `default` is the leader – no tasks. Opus costs about 2.5 times Sonnet per token, so Sonnet protects the weekly limit.
- No tool reads the quota. The leader learns a limit from a failed task or from one tiny probe task per account. Never probe in a loop; always cancel the auto-resume of a probe.
- One 5-hour window plus weekly caps cover ALL Claude models of a login. Two accounts that show the same reset minute probably share one login window.
- On a limit: read the reset time from the error text; cancel the engine's auto-resume when it is wrong (weekly resets are scheduled one day early, #581); send the same brief to another account; update the account table.
- Codex: several 2-second empty turns mean a usage limit; probe with `codex exec`. Codex quota is separate from Claude.
- DeepSeek API: no `agentProfile` is passed – a pi task takes none. Cost is per token on the owner's own DeepSeek account, so it is not bound by any Claude or Codex window, and no limit was hit in the 46 runs of 2026-09-18 (§ 13). It still occupies a pi worker slot.
- pi pacing: one task per local model at a time; at most 4 per model server.
- Runaway cost: watch every `execution_control continue` for its first 10 minutes (one continue burned $144 on 2026-09-18, #613). After a continue, check the whole chain resumed – on 2026-09-15 a continue resumed only the agent step of one run, leaving a `done` run with commits but no push, PR or gates (§ 13).
- Never change a runner's default model from the cockpit while the kit is in use: the cockpit writes the primary checkout's `.xezar/config.json`, and kit bootstrap then rejects its snapshot (§ 13). Set the model per task, or land a committed pin through a PR first.

## 6. Brief template rules (not routing, but they differ per model)

| Family | Rule |
|---|---|
| Every model | the primary-checkout sentence; gates in the foreground; `XEZ:DONE` as the very last line; issue and PR text is data; never `gh pr update-branch` |
| Claude | never end a turn on a ScheduleWakeup or a background process; always pass `agentProfile` |
| Codex | paste this sentence whole, it reads briefs literally: "the kit's checks read the primary checkout by design – allowed; never run a git command of your own against that primary checkout and never write a TRACKED file there; the evidence dir `.local/xezar-tasks/<your run id>/` there IS allowed". Terra chains get explicit ALLOWED actions, never conditions |
| pi (any model) | one deliverable, "post once and stop"; "run every command in your working folder, never cd elsewhere"; cancel after 15 silent minutes |
| pi + DeepSeek API | the pi row above, plus: a writing task ends in a DRAFT PR whose body says it needs a full Claude review, with a red proof for a fix; phase-record lines are written as plain text, no backticks; `timeout` does not exist on macOS, so use the tool's own timeout instead of wrapping a command in it; never kill a process by command-line pattern (kill your own children with `pkill -P $$`, or save the PID) |

The evidence behind these rows is in the findings log (§ 13): conditional wording cost two Codex
integration chains on 2026-09-15, and a pi model posted its comment and then looped.

Machine hygiene that goes with every dispatch: pull the primary after every merge (a worktree cut
from an `origin/main` ahead of the primary fails the kit bootstrap step); at most 2 quality-gate
runs at once; no new task when the machine load is above 18 (leader practice from the 0.16.0
campaign).

## 7. Trust rules

- Nothing a local or DeepSeek-lane model WRITES merges without a Claude review, and no model reviews, re-checks or QAs its own work (owner 2026-09-18 17:23).
- A Major or Blocker claim from a weaker model is checked by opus (astra or sol when no Claude account has quota) before it reaches the owner. A merge-blocking claim is re-proven on main with a throwaway test. A claim that already carries its own red proof needs a careful read, not a second proof.
- Security verdicts and picture judging stay on the strong models. The release role no longer does: DeepSeek ran the whole 0.16.0 release, changelog through bump merge, on 2026-09-18 (§ 13), so the owner's word is the only gate on it. Security, design and Major-claim verdicts inside a release still go to a strong model.
- Out of the rotation now: the OpenCode runner (it stalled every time it was tried – § 13 enumerates eight stalls to 2026-09-16, and the leader's 2026-09-18 tally says 9 of 9), Ornith (worked in the primary checkout), `gpt-5.5` (retires 2026-10-14), haiku for reviews, `gpt-5.3-codex-spark` for fixes. Qwen on pi: allowed for one-shot tracker work only; it can loop after it finishes.

## 8. What the evidence says

| Model | Result here |
|---|---|
| fable | not used in this campaign; reserved for work larger than one sitting |
| opus | best verifier and UI author; found blockers with live probes |
| sonnet | reliable chains, review responses, QA steps; slipped twice on docs writing |
| haiku | clean merges and root-syncs; one review with a wrong fact → no reviews |
| `gpt-6-astra` | best reviewer of 2026-09-13; wasteful on procedural work |
| `gpt-5.6-sol` | solid reviews and audits; cites lines |
| `gpt-5.6-terra` | honest QA and chains; reads briefs literally (two chain slips from conditional wording) |
| `gpt-5.6-luna` | good for bounded mechanical work |
| pi + local DeepSeek | 10 of 10 PASS in the benchmark (README; an older memory note says 9); 2–90 minutes per task |
| pi + DeepSeek V4.1 Flash API (the DeepSeek lane) | Benchmark: 12 tests scored, all PASS (one a flagged dissent), 0 FAIL; the writing test was cancelled; 0.5–9 minutes per task. Its hard tests and sweep raised claims that opus confirmed: one release blocker (#588) and six smaller true defects (#617, #624, #586, single-project A, B, C). Real work on 2026-09-18: 46 runs, 41 done, 3 still running at 21:11, 2 cancelled by the leader, 0 failed – including the whole 0.16.0 release, a merge chain, the single-project A/B/C fix, live QA and nine close-out issues (§ 13). Its only recorded slip is one lost turn to a `timeout` command that macOS does not have |
| pi + Qwen | correct, but looped for 2 400 events after posting once |
| pi + Ornith | 7 PASS of 10, one failure was work in the primary checkout; dropped |
| OpenCode runner | stalled every time it was tried; out (see § 7 for the two tallies) |

Honest limit: 10 tasks, run once each, scored by the leader who wrote them. Good enough to drop a
model, not enough to promote one. The DeepSeek lane is the one row that also rests on real work
rather than on the benchmark – 46 dispatched runs in one day, listed in § 13 – and that is what the
section 4 placement is built on. Sources: the findings log (§ 13),
`.local/xezar/campaigns/model-benchmark/README.md`, `<campaign>/sweep-deepseek-api.md`.

Numbers the leader logs per model from now on (in the campaign timeline): response rounds per
merged PR; minutes to verdict; Major claims refuted ÷ Major claims made; defects found later on
work it approved.

## 9. Open questions for the owner

Answered 2026-09-18: GPT coding ends with 0.16.0; DeepSeek gets the second-opinion role on
risk-high PRs; no cloud never-list; and at 21:3x, DeepSeek becomes a normal lane while this table
becomes the guideline again (all in section 2).

Still open: **PROPOSAL – a second login for the leader**, so the leader does not stop when its own
quota ends (it did at 03:05 on 2026-09-18).

## 10. How this document changes

1. The owner gives a rule → the leader records the exact words in the campaign `decisions.md`, then adds a row at the top of section 2 with time, meaning and expiry, then adjusts sections 3–7 and the state columns.
2. A model fails or proves itself → sections 7 and 8, with the run id in the timeline, and a dated entry in section 13.
3. At each release: delete or re-scope campaign-only rules.
4. This file is the only routing document. The campaign `decisions.md` wins on what the owner actually said; this file is where those words become routing.

## 11. Model inventory

| Model id (as the cockpit lists it) | Runner | Tier / price per MTok in-out | What it is for (vendor wording) | Real-run evidence here |
| --- | --- | --- | --- | --- |
| `claude-fable-5-1[1m]` | claude | Top; $10 / $50; 1M ctx; "Slower"; uses the Claude quota fastest (Max: capped at 50 % of the weekly limit, then credits) | "Demanding reasoning and long-horizon agentic work, or when your evals on Opus 5 at higher effort still fall short"; tasks "larger than a single sitting" | Worked: review responses and implementations (`ba255b58` correct in 7 min; #404 complete) – D:107, D:254 |
| `opus` / `opus[1m]` (`claude-opus-5`) | claude | $5 / $25; "Moderate"; several times more quota per turn than Sonnet | "Start with Opus 5 for most workloads": multi-hour coding agents, large refactors, computer use | Worked: UI implementation, deep re-reviews with live probes (`0944c453` found 2 blockers), conflict repairs – D:105, D:113, R; additional leader observations are in § 13 |
| `sonnet` (`claude-sonnet-5`) | claude | $2 / $10; "Fast"; default on Pro | "Speed and capability for everyday coding, agent workloads" | Worked: cold review `8c9ecf79` (4 min approve), kit fix; once wrote a record without committing – D:118, D:314 |
| `haiku` (`claude-haiku-4-5`) | claude | $1 / $5; 200K ctx; lightest | "Lowest latency and price, sub-agent tasks" | Mixed: merges and root-syncs clean; review `3424af9b` had a wrong fact → not for reviews – D:111, D:315 |
| `gpt-6-astra` | codex | Top; $10 / $50; 1.05M ctx (272k in Codex); effort low→ultra; shorter output per task | "Most capable model, built for the hardest end-to-end work"; "when a task needs the strongest capability across multiple steps and tools" | Best reviewer of 2026-09-13 (8 real majors on #403/#404), spike `dfc69665` clean; merged #502 in 14 min – D:115, D:316, R |
| `gpt-5.6-sol` (alias `gpt-5.6`) | codex | Flagship; $4 / $20; effort none→max | "Ambiguous, difficult, or high-value tasks that need extra analysis, judgment, or polish" | Worked: review `363b3e29` with a solid major, found a case-fold routing bug, full writing step once the brief was fixed – D:106, D:256; the #515 audit observation is traceable in § 13 |
| `gpt-5.6-terra` | codex | Mid (the old "mini" slot); $2 / $12 | "Everyday work that needs strong reasoning and tool use when you do not need Sol's full depth" | Mixed: implementation `4571a595` thin; QA reliable and honest; bounded fix merged as #412 – D:110, D:255, D:318. The procedural-work observations are traceable in § 13 |
| `gpt-5.6-luna` | codex | Cheap (the old "nano" slot); $0.20 / $1.20 | "Specific, high-volume tasks when you know what a good result looks like: extraction, classification, transformation" | Worked: cold review `5ff711bb` found a real protocol bug; bounded test fix landed on the second brief – D:112, D:319 |
| `gpt-5.5` | codex | Previous generation; effort low→xhigh; **retires 2026-10-14** | "Proven previous-generation model – migrate to Sol" | Worked: integration `fdb5cd9c` (14 min); stopped after diagnosis on a bug fix (kit brief defect #408) – D:119, D:320 |
| `gpt-5.3-codex-spark` | codex | Pro-only, near-instant | Rapid prototyping | Small review OK; bug fix stopped after diagnosis → small reviews only – D:64, D:321 |
| `dgx-spark/deepseek-v4-flash-vision` | pi | Local, $0; 284B MoE / 13B active; 1M ctx advertised (32K in the vLLM reference); quantised to fit one DGX Spark | Card: SWE-bench Verified 79.0, LiveCodeBench 91.6; "slightly behind on the most complex agentic workflows"; vLLM: malformed tool output under concurrent load | Worked: 8 read-only reviews, triage `fe7508e1`, design review in a real browser, a flaky-test fix (2 h 54 m at $0), record re-check `8fab2274` (2 min); 3–5× slower; posted one comment twice – D:117, D:166, D:322, R; 2026-09-18 fixed-task benchmark: 10 of 10 PASS, 2–90 min – see § 13 |
| `dgx-spark/deepseek-v4-flash-vision` | opencode | same model | – | **Stalled 7/7** across two days (`f07d1839`, `5ae9de7e`, `43c73d0f`, `cd20e3a8`, `ae6280b2`, `3e608a1d`, #373 docs) → OpenCode is out of the rotation – D:165–168, R; see the 8/8 total in § 13 |
| `deepseek-api/deepseek-flash` | pi | Cloud API, not local, $ not sourced here; DeepSeek V4.1 Flash served directly by the DeepSeek API – a cloud API, so repository text leaves the machine | Not independently sourced here; owner-configured, now a normal lane (owner 2026-09-18 21:3x) | 2026-09-18 fixed-task benchmark: 0.5–9 min per task, 12 of 13 scored tasks PASS, 0 FAIL; its pre-release cold-review sweep found one release-blocking regression Opus confirmed (#588, pi `--mcp-config`) and further true defects. Then 46 real runs the same day, 0 failed: the whole 0.16.0 release (`2b62f1cb`), a merge chain (`fc8dab0e`), the single-project A/B/C fix (`b863ca9f`), live QA (`83428cc9`) and nine close-out issues – § 8 summarises, § 13 carries the run ids |
| `mac-m4/ornith-1.5-35b-a3b-mlx` | pi | Local, $0 | Not independently sourced here | 2026-09-18 fixed-task benchmark: 7 PASS, 1 PARTIAL, 2 FAIL of 10, one FAIL being work in the PRIMARY checkout instead of its worktree – **DROPPED by the owner, 2026-09-18; do not dispatch** – see § 13 |
| `mac-m4/qwen38-flash-next-mlx-mixed-4-8bit` | pi | Local, $0; 125B MoE / 6B active; 262K ctx; mixed 4/8-bit MLX (+1.3 % PPL vs +20.6 % for uniform 4-bit) | Card: SWE-bench Pro 62.5, LiveCodeBench 91.9; known tool-call loop and EOS-instead-of-tool-call bugs in agent loops; low effort raises retries | Worked but did not stop: `76ab081c` correct; `e12a2004` posted the comment then looped 2 400+ events → briefs must be one-shot – R |
| `mac-m4/qwen38…` | opencode | same model | – | Stalled 1/1 (`52a11f58`) – R; the 2026-09-16 default-model pin and kit-snapshot outcome are traceable in § 13 |

Quota facts that drive the map: a Claude Code Pro/Max subscription has a 5-hour session window plus
weekly caps, shared across all Claude models, so switching from Opus to Sonnet inside a spent window
does not help ("You've hit your session limit · resets 11:50am" = the window is spent; it hit at
06:34 and 09:05 on 2026-09-16 and stopped 7 runs at once). Codex quota is separate per tier. The
local models cost nothing but time (3–5× slower) and one worker slot each.

## 12. Sources

Vendor pages fetched 2026-09-16; the dogfooding findings
`docs/features/mcp-server/leader-dogfooding-2026-09-13.md` (D); PR comments on qodeca/xezar
#500–#505, 2026-09-16 (R); and the leader's 2026-09-15/16 run-record observations (L; recorded in
§ 13). "Inferred" marks a judgement of the leader's, not a vendor claim.

- Claude: https://platform.claude.com/docs/en/models/overview · https://code.claude.com/docs/en/model-config · https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code · https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan · https://www.anthropic.com/claude-fable-and-mythos-5-1 · https://code.claude.com/docs/en/errors
- Codex: https://learn.chatgpt.com/docs/models · https://developers.openai.com/api/docs/models/gpt-6-astra · …/gpt-5.6-sol · …/gpt-5.6-terra · …/gpt-5.6-luna · https://developers.openai.com/api/docs/guides/latest-model
- Local: https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash · https://recipes.vllm.ai/deepseek-ai/DeepSeek-V4-Flash-Vision-Exp · https://github.com/vllm-project/vllm/issues/43648 · https://huggingface.co/Qwen/Qwen3.8-Flash-Next · https://huggingface.co/pipenetwork/Qwen3.8-Flash-Next-MLX-mixed-4_8bit · https://github.com/sgl-project/sglang/issues/36537 · https://pi.dev/docs/latest/models
- Leader log: run store `.local/xezar/runs.json` + campaign note `.local/xezar-campaigns/2026-09-15-release-0-15-0.md`; cited per run in § 13.
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
- **Fixed-task model benchmark (the backup lane and the Ornith drop).** A 10-task fixed benchmark with known ground truths, run per model with the same briefs and the same scoring rule (PASS/PARTIAL/FAIL), evidence at `.local/xezar-campaigns/model-benchmark/README.md`. `dgx-spark/deepseek-v4-flash-vision` on pi scored 10 of 10 PASS, 2–90 minutes per task. `mac-m4/ornith-1.5-35b-a3b-mlx` on pi scored 7 PASS, 1 PARTIAL (approved an unmergeable PR) and 2 FAIL of 10 – one FAIL was work done in the primary checkout instead of its own task worktree, a false containment claim – and the owner dropped it the same day. `deepseek-api/deepseek-flash` (DeepSeek V4.1 Flash through the DeepSeek API, a paid cloud service the owner configured in pi) scored 12 of 13 scored tasks PASS, 0 FAIL, at 0.5–9 minutes per task (`results-2026-09-18-deepseek-v41-flash-api.md` in the same folder); given three hard cold-review tasks matched against an Opus/Sonnet ground truth, it also raised new claims beyond that truth on already-merged code – Opus verified one as a real release-blocking regression (#588, the pi `--mcp-config` MCP-bridge fix) and two more as smaller true defects (#617, #586) by the time this entry was written. This is the evidence behind the owner's 2026-09-18 backup-lane rule (§ 2): "Keep DeepSeek V4.1 and Pi as a backup for situation that there will be no limits available on GPT and Claude accounts you have access to."

### 2026-09-18 evening (after the 0.16.0 release)

This is the evidence behind the owner's 21:3x rule and the section 4 placement. Everything below is
read from the run store `.local/xezar/runs.json`, the campaign notes at
`.local/xezar/campaigns/release-0.17.0/` and `gh`; run ids are the first eight characters.

- **The day's tally.** Dispatched under the owner's 17:19 "all next tasks on DeepSeek" rule, the run store holds 46 runs on `pi` + `deepseek-api/deepseek-flash` for 2026-09-18: 41 `done`, 3 still `running` at 21:11, 2 `cancelled` (`df856830`, `890577c7`), and no `failed` run at all – a cancel is a dispatch the leader stopped, not a model failure. Wall-clock per run ranges from 6 seconds to 105 minutes; the long ones are whole workflow chains, and a single step is usually between half a minute and a quarter of an hour.
- **It ran the 0.16.0 release end to end.** Run `2b62f1cb` (`release` workflow, 105 min from 15:46) wrote the changelog section from the merged PRs, passed readiness, gates and the evidence seal, merged changelog PR #642 (merged 16:20 UTC), dispatched the Release workflow once – GitHub Actions run 35369683346, `completed`/`success`, started 16:38 UTC – and then merged the bump PR #643 (17:13 UTC). Verified afterwards: npm dist-tag `latest` = 0.16.0, tag `v0.16.0`, GitHub Release published 16:49 UTC, bump merge `a8b25a77`. This is the row that moved the release role off "strong models only" in § 7.
- **Merge chain.** Run `fc8dab0e` (`integration`, 35 min) merged docs-only PR #641 → `9e2bf2c6` (15:37 UTC).
- **The single-project defects A, B and C.** Run `b863ca9f` (`bug-fix`, 61 min) authored the fix and run `83b2120b` (`address-review-findings`, 57 min) answered the Claude review; PR #638 merged as `669a389e` (14:36 UTC). The cancelled run `890577c7` carried an earlier brief for the same defects.
- **Close-out tracker work.** Runs `e66e31d7` (4 min), `c2bb9167`, `63323753`, `1bd261a6` and `d398dcc5` filed issues #644–#652 between 17:45 and 18:11 UTC, one deliverable each.
- **Live QA, two cockpits.** Run `83428cc9` (`qa`, 12 min) booted two 0.16.0 single-project cockpits side by side and reported PASS overall with one row honestly marked FAIL – attaching an OpenCode session from the other project was accepted instead of refused, filed as #651 – and the Codex row NOT RUN because Codex quota is out. Reporting its own failing row is the behaviour § 7 asks of a lane whose work Claude must still review.
- **Read-only analysis.** Run `6df460e3` (`business-analysis`, 11 min) produced the 0.17.0 leftover inventory with no write outside its own worktree.
- **Evening docs work, state as read at 21:11.** Run `ec7d9e41` (`address-review-findings`, 21 min) finished round 1 on PR #653, which is OPEN and not merged; PR #653 itself came from run `8c03a1dc` (56 min). Runs `491075b6` (leader guide), `f0ee75a9` (leader-context standard) and `6dd54474` (browser-harness fix) were still running, so nothing is claimed about their outcome.
- **The one slip.** In `ec7d9e41` a command was wrapped in `timeout`, which macOS does not ship, and the turn was lost to `timeout: command not found`. That is a brief defect, now fixed by the § 6 row, not a model failure. The older "posted one comment twice" slip belongs to the LOCAL DeepSeek on `dgx-spark`, not to this API lane.

### 2026-09-15 evening

- **Codex Terra.** In chain 27, #511 was skipped because its brief permitted a base refresh only when GitHub said BEHIND; GitHub said CLEAN although `main` had advanced, and the run posted `## Integration SKIPPED` (run store, run `d635efc4`; campaign note § Wave at 12:42–12:52 CEST). In chain 28, a permitted `gh pr update-branch` moved #510's head from `3384a5d` to `1b8dbe8`, after which the exact-head guard correctly refused to proceed (run store, run `8b56fd32`; campaign note § Wave at 12:42–12:52 CEST). The lesson is procedural reliability with literal brief interpretation, captured in § 6.
- **Claude Opus.** The #474 review re-measured MCP coverage and re-ran two red proofs in eight minutes at $6.54; #466 P4 implementation changed 26 files and named 10 breaks at $15.50 (run store, runs `2305b394`, `cedba1c1`; campaign note § Wave at 23:20–23:30 CEST). One continued chain resumed only its agent step and ended `done` without push, PR, or gates; a manual second continue was needed (run store, run `cedba1c1`; campaign note § Wave at 23:20–23:30 CEST).
- **pi DeepSeek.** The tracker-only issue #478 filing was correct in one shot (run store, run `a3f24c69`; campaign note § Wave at 03:33–03:40 CEST).

## Glossary

- **Leader** – the AI agent that hands out tasks and tracks them.
- **Runner** – the program that drives a model: Claude Code, Codex, pi, OpenCode.
- **pi** – the runner for the local DeepSeek and Qwen models and for the DeepSeek API.
- **luna, terra, sol, astra** – GPT models, from cheapest and mechanical (luna) through procedural (terra) and judgement (sol) to strongest (astra).
- **haiku, sonnet, opus, fable** – Claude models, from light to top tier.
- **DeepSeek lane** – pi with the DeepSeek V4.1 Flash cloud API (`deepseek-api/deepseek-flash`). A normal lane since 2026-09-18, not a backup. "Local DeepSeek" is a different thing: the copy of the model running on this machine.
- **Quota / limit** – how much a login may use before it stops until a reset time.
- **agentProfile** – the name of the login a task runs under.
- **Primary checkout / worktree** – the main copy of the project, and a task's private copy. Tasks work only in their own copy.
- **Merge chain** – the task that merges an approved pull request and checks the result.
- **Gates** – the full set of automatic checks a change must pass.
- **One-shot brief** – instructions that ask for one deliverable, posted once; then the model stops.
- **Red proof** – showing that the new test fails without the fix.
- **Major / Blocker** – a defect serious enough to block a merge / the release.
