# Model routing map for Xezar tasks

Written 2026-09-16 on the owner's request; sources and evidence below

Sources: vendor pages fetched 2026-09-16 (listed at the end), the dogfooding findings `docs/features/mcp-server/leader-dogfooding-2026-09-13.md` (D), and the campaign note `2026-09-15-release-0-15-0.md` (C). "Inferred" marks a judgement of mine, not a vendor claim.

## 1. Inventory

| Model id (as the cockpit lists it) | Runner | Tier / price per MTok in-out | What it is for (vendor wording) | Real-run evidence here |
| --- | --- | --- | --- | --- |
| `claude-fable-5-1[1m]` | claude | Top; $10 / $50; 1M ctx; "Slower"; uses the Claude quota fastest (Max: capped at 50 % of the weekly limit, then credits) | "Demanding reasoning and long-horizon agentic work, or when your evals on Opus 5 at higher effort still fall short"; tasks "larger than a single sitting" | Worked: review responses and implementations (`ba255b58` correct in 7 min; #404 complete) – D:107, D:254 |
| `opus` / `opus[1m]` (`claude-opus-5`) | claude | $5 / $25; "Moderate"; several times more quota per turn than Sonnet | "Start with Opus 5 for most workloads": multi-hour coding agents, large refactors, computer use | Worked: UI implementation, deep re-reviews with live probes (`0944c453` found 2 blockers), conflict repairs – D:105, D:113, C:277 |
| `sonnet` (`claude-sonnet-5`) | claude | $2 / $10; "Fast"; default on Pro | "Speed and capability for everyday coding, agent workloads" | Worked: cold review `8c9ecf79` (4 min approve), kit fix; once wrote a record without committing – D:118, D:314 |
| `haiku` (`claude-haiku-4-5`) | claude | $1 / $5; 200K ctx; lightest | "Lowest latency and price, sub-agent tasks" | Mixed: merges and root-syncs clean; review `3424af9b` had a wrong fact → not for reviews – D:111, D:315 |
| `gpt-6-astra` | codex | Top; $10 / $50; 1.05M ctx (272k in Codex); effort low→ultra; fewer output tokens per task | "Most capable model, built for the hardest end-to-end work"; "when a task needs the strongest capability across multiple steps and tools" | Best reviewer of 2026-09-13 (8 real majors on #403/#404), spike `dfc69665` clean; merged #502 in 14 min – D:115, D:316, C |
| `gpt-5.6-sol` (alias `gpt-5.6`) | codex | Flagship; $4 / $20; effort none→max | "Ambiguous, difficult, or high-value tasks that need extra analysis, judgment, or polish" | Worked: review `363b3e29` with a solid major, found a case-fold routing bug, full writing step once the brief was fixed – D:106, D:256 |
| `gpt-5.6-terra` | codex | Mid (the old "mini" slot); $2 / $12 | "Everyday work that needs strong reasoning and tool use when you do not need Sol's full depth" | Mixed: implementation `4571a595` thin; QA reliable and honest; bounded fix merged as #412 – D:110, D:255, D:318 |
| `gpt-5.6-luna` | codex | Cheap (the old "nano" slot); $0.20 / $1.20 | "Specific, high-volume tasks when you know what a good result looks like: extraction, classification, transformation" | Worked: cold review `5ff711bb` found a real protocol bug; bounded test fix landed on the second brief – D:112, D:319 |
| `gpt-5.5` | codex | Previous generation; effort low→xhigh; **retires 2026-10-14** | "Proven previous-generation model – migrate to Sol" | Worked: integration `fdb5cd9c` (14 min); stopped after diagnosis on a bug fix (kit brief defect #408) – D:119, D:320 |
| `gpt-5.3-codex-spark` | codex | Pro-only, near-instant | Rapid prototyping | Small review OK; bug fix stopped after diagnosis → small reviews only – D:64, D:321 |
| `dgx-spark/deepseek-v4-flash-vision` | pi | Local, $0; 284B MoE / 13B active; 1M ctx advertised (32K in the vLLM reference); quantised to fit one DGX Spark | Card: SWE-bench Verified 79.0, LiveCodeBench 91.6; "slightly behind on the most complex agentic workflows"; vLLM: malformed tool output under concurrent load | Worked: 8 read-only reviews, triage `fe7508e1`, design review in a real browser, a flaky-test fix (2 h 54 m at $0), record re-check `8fab2274` (2 min); 3–5× slower; posted one comment twice – D:117, D:166, D:322, C |
| `dgx-spark/deepseek-v4-flash-vision` | opencode | same model | – | **Stalled 7/7** across two days (`f07d1839`, `5ae9de7e`, `43c73d0f`, `cd20e3a8`, `ae6280b2`, `3e608a1d`, #373 docs) → OpenCode is out of the rotation – D:165–168, C:143 |
| `mac-m4/qwen38-flash-next-mlx-mixed-4-8bit` | pi | Local, $0; 125B MoE / 6B active; 262K ctx; mixed 4/8-bit MLX (+1.3 % PPL vs +20.6 % for uniform 4-bit) | Card: SWE-bench Pro 62.5, LiveCodeBench 91.9; known tool-call loop and EOS-instead-of-tool-call bugs in agent loops; low effort raises retries | Worked but did not stop: `76ab081c` correct; `e12a2004` posted the comment then looped 2 400+ events → briefs must be one-shot – C:135, C:143 |
| `mac-m4/qwen38…` | opencode | same model | – | Stalled 1/1 (`52a11f58`) – C:143 |

Quota facts that drive the map: a Claude Code Pro/Max subscription has a 5-hour session window plus weekly caps, shared across all Claude models, so switching from Opus to Sonnet inside a spent window does not help ("You've hit your session limit · resets 11:50am" = the window is spent; it hit at 06:34 and 09:05 on 2026-09-16 and stopped 7 runs at once). Codex quota is separate per tier. The local models cost nothing but time (3–5× slower) and one worker slot each.

## 2. Routing by task kind (cheapest adequate first)

| Task kind (Xezar workflow) | First choice | Fallback | Never |
| --- | --- | --- | --- |
| Tracker-only: labels, verdict comments from a file, CI status comments, issue filing (`quick-task`) | pi + DeepSeek | pi + Qwen (one-shot brief only) or `gpt-5.6-luna` | Claude |
| Record re-check (read one evidence file, compare with a PR comment, approve + label) | pi + DeepSeek (proven `8fab2274`) | `gpt-5.6-luna` | Claude |
| Docs re-check, mechanical docs edits (`docs-maintenance`, scoped docs re-check) | `gpt-5.6-luna` | `gpt-5.6-terra` when prose judgement is needed | astra, Claude |
| Docs PR with real writing | `gpt-5.6-terra` | `gpt-5.6-sol` | Claude |
| Integration / merge chain (`integration`, `gh`-driven, procedural) | `gpt-5.6-terra` | `gpt-5.6-sol`; `haiku` only if Codex is down | astra (proven but wasteful), opus |
| Root-sync (Worktree OFF, fast-forward) | leader's own `git pull --ff-only` | `gpt-5.6-luna` | – |
| Conflict repair (merge main, keep both sides, gates) | `gpt-5.6-terra` | `gpt-5.6-sol`; opus if the conflict is in cockpit UI | astra |
| Scoped code re-check (one commit against one review) | `gpt-5.6-sol` (high effort) | pi + DeepSeek for an advisory light pass | luna, haiku |
| Full cold code review of a PR | `gpt-5.6-sol` | astra for security-sensitive or very large diffs; opus when Codex quota is gone | haiku, local models |
| Security-sensitive review (trust boundary, auth, secrets) | astra | opus | local models, terra, luna |
| Manual / browser QA (`qa`, agent-browser) | `gpt-5.6-terra` (proven "reliable and honest") | astra for a multi-step live harness (MCP leader proofs); `sonnet` | local models (tool-call loops) |
| Design review (`design-review`, read-only verdict) | `gpt-5.6-sol` | pi + DeepSeek did one correctly in a real browser (D:166) | luna |
| UX design mockups (`design`, HTML + README) | opus | `gpt-5.6-sol` | local models |
| Bounded bug fix, one file, tests named | `gpt-5.6-terra` | `gpt-5.6-sol`; `gpt-5.6-luna` for a test-only fix | spark (stops after diagnosis) |
| Implementation, multi-file, red-proof tests, non-UI (`feature-implementation`) | `gpt-5.6-sol` (xhigh) | astra when sol's output is thin or the change spans kit + engine + docs | terra alone, local models |
| Implementation touching the cockpit UI (React, Tailwind, design system) | opus | astra; fable only if opus at high effort fell short twice | local models, luna |
| Review response with one verdict | `gpt-5.6-sol` | terra for a docs-only response | – |
| Review response folding several verdicts (code + QA + design) | astra | opus | terra, local |
| Kit / checks refactor (`.xezar/checks`, bash + node) | astra | sol | local models |
| Any task that must generate an image (mockup renders, diagrams, screenshots for docs or designs, graphics for the README) | astra (owner rule 2026-09-16 09:53) | – | every other model |
| Business analysis, spec writing, research (`business-analysis`, `research`, `plan-and-spec`) | `gpt-5.6-sol` | astra for a spec that spans many systems; fable for "larger than a sitting" | luna |
| Release (`release` role) | never dispatched by the leader (owner decision) | – | – |

## 3. Rules that go with the map

1. **Claude is the scarce quota.** Do not dispatch Claude by default; use it for cockpit UI work and as the fallback when Codex is unavailable. After a "session limit" failure: `cancel_auto_resume` on every failed run, re-dispatch on Codex or pi, and do not let the 5-hour reset re-run the same work twice.
2. **Astra for every task that must generate an image** (mockup renders, diagrams, graphics), whatever its size – owner rule 2026-09-16 09:53. Otherwise **astra only when the task is genuinely hard**: several verdicts at once, large multi-surface implementations, kit refactors, security-sensitive reviews. Everything procedural goes to terra, everything judgement-heavy to sol, everything mechanical to luna. Use the lowest reasoning effort that produces the result.
3. **`gpt-5.5` retires 2026-10-14** – stop using it now; sol replaces it.
4. **OpenCode is out** (8/8 stalls with both local models). Only re-trial on the owner's request, one small read-only task, cancel at 15 min without events.
5. **pi briefs are one-shot**: one deliverable, one comment, "post once and stop". DeepSeek posted a comment twice once; Qwen looped for 2 400 events after its comment.
6. **Local models never touch a branch**: no implementation, no QA on the live harness, no security reading. Read-only verdicts, triage, tracker updates, bounded single-file test fixes at most.
7. **Codex wording**: "the kit's checks read the primary checkout by design – allowed; never run a git command of your own that writes to that primary checkout". Codex reads "never git in primary" literally and BLOCKs.
8. **Pull the primary before every dispatch after a merge**: a worktree cut from an `origin/main` that is ahead of the primary fails the kit bootstrap step ("existing task asset differs") – seen 2026-09-15 21:58 and 2026-09-16 09:43.
9. **Rotate and record**: every stall, wrong fact or "stopped after diagnosis" goes into the campaign note and, if it changes a row here, into this file and memory `xezar-codex-model-tiers` / `xezar-model-trust-rule`.

## 4. Sources

- Claude: https://platform.claude.com/docs/en/models/overview · https://code.claude.com/docs/en/model-config · https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code · https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan · https://www.anthropic.com/claude-fable-and-mythos-5-1 · https://code.claude.com/docs/en/errors
- Codex: https://learn.chatgpt.com/docs/models · https://developers.openai.com/api/docs/models/gpt-6-astra · …/gpt-5.6-sol · …/gpt-5.6-terra · …/gpt-5.6-luna · https://developers.openai.com/api/docs/guides/latest-model
- Local: https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash · https://recipes.vllm.ai/deepseek-ai/DeepSeek-V4-Flash-Vision-Exp · https://github.com/vllm-project/vllm/issues/43648 · https://huggingface.co/Qwen/Qwen3.8-Flash-Next · https://huggingface.co/pipenetwork/Qwen3.8-Flash-Next-MLX-mixed-4_8bit · https://github.com/sgl-project/sglang/issues/36537 · https://pi.dev/docs/latest/models
- Unconfirmed: exact Claude quota multipliers per model; whether `[1m]` variants are credit-gated on a subscription; `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5-codex`, `gpt-5.1` ids (not in the current Codex model list); coding-benchmark loss of the Qwen 4/8-bit quantisation.
