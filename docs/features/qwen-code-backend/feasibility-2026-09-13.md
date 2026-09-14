# Qwen Code as a fifth xezar backend – feasibility report

Date: 2026-09-13. Prepared by the project leader from four parallel research passes (product facts, xezar touchpoints, runner template, fit and risks). Every claim is marked **verified** (read at the cited source, or measured on this machine) or **unverified**. Nothing in xezar was changed for this report.

## 1. Answer in one paragraph

Yes, it is technically possible, and mechanically cheaper than any of the four existing backends was: Qwen Code's headless mode emits Claude Code's stream-JSON event shape, it relocates its whole home with one env var (`QWEN_HOME`), it is an MCP client, it takes an OpenAI-compatible endpoint through three env vars, and it even ships two out-of-band ways to wake a running session that Claude Code and Codex lack. The runner seam is ready for a fifth class and about 45 typed places fail to compile until the id is added, so the work is enumerable. The case **for doing it now** is weak: the free Qwen OAuth tier ended on 2026-04-15, the local-model path it offers is the same OpenAI-compatible seam pi and OpenCode already give this project, and two open upstream bugs make a provider failure look like a success with exit 0, which is the one failure xezar's step-status logic cannot tolerate. Recommendation: **a two-hour experiment first, no code**, then decide; today's verdict is "later candidate", not "no".

## 2. What Qwen Code is (verified)

| Item | Finding | Source |
| --- | --- | --- |
| Product | Alibaba/QwenLM's open-source terminal coding agent, forked from Google Gemini CLI v0.8.2, independent since its own v0.1 – it does not merge upstream | [README](https://github.com/QwenLM/qwen-code/blob/main/README.md) |
| Licence | Apache-2.0, copyright Google LLC and Qwen | [LICENSE](https://raw.githubusercontent.com/QwenLM/qwen-code/main/LICENSE) |
| Version | v0.23.3 (2026-09-10); daily nightlies; separate SDK, desktop, live-host tags | [releases](https://github.com/QwenLM/qwen-code/releases) |
| Health | 27.8 k stars, 3.0 k forks, ~1.1 k open issues; last 90 days: 2 390 issues opened, 1 926 closed, 3 540 PRs merged; four Alibaba engineers with 270–680 commits each | GitHub API, 2026-09-13 |
| Node | `engines.node >= 22` (xezar itself is Node 20+; the CLI is a separate process, so this is a floor for users, not for xezar) | [npm](https://registry.npmjs.org/@qwen-code/qwen-code/latest) |
| On this machine | `/Users/marcinobel/.local/bin/qwen`, version 0.23.3, already installed | `qwen --version` |

## 3. Does it fit the runner seam? (verified against `qwen --help` and the docs)

| xezar needs | Qwen Code has | Notes |
| --- | --- | --- |
| Headless one-shot run | positional prompt (`-p` deprecated but works), stdin piping | [headless docs](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/) |
| Structured events | `--output-format stream-json`, `--include-partial-messages` | Event vocabulary is `system / assistant / user / tool_use / tool_result / result / stream_event` with `session_id`, `parent_tool_use_id` – **Claude Code's shape, not Gemini's** |
| Session continuity for `send_message` | `--continue`, `--resume <uuid>`, `--session-id`, `--fork-session`; `--input-format stream-json` exists but is "under construction, intended for SDK integration" | Per-worktree session folders under `~/.qwen/projects/<project>/chats/` |
| Per-run isolated home | `QWEN_HOME` (defaults to `~/.qwen`) | Only `sessions/` and `.env` lookup are documented under it; whether settings, chats and auth all follow is **unverified** |
| Local OpenAI-compatible model | `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `--auth-type openai`, or `modelProviders.openai[]` in settings – the docs' own example uses `http://127.0.0.1:18000/v1` | [model providers](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/) |
| MCP client (xezar's own server) | stdio, streamable HTTP, SSE; `settings.json` `mcpServers`; `qwen mcp add`; `--mcp-config`, `--allowed-mcp-server-names` | Tool names are unprefixed until a collision, then `server__tool` – allowlists cannot assume one shape |
| Tool permissions | `--yolo`, `--approval-mode plan/default/auto-edit/auto/yolo`, `--allowed-tools`, `--exclude-tools`, `permissions.allow/ask/deny` rules | Headless behaviour of `default` mode when a tool needs approval is **not documented** |
| Budgets and exit codes | `--max-session-turns` (exit 53), `--max-wall-time`, `--max-tool-calls` (exit 55); 41 auth, 42 input, 44 sandbox, 52 config, 130 SIGINT | Better than any current backend |
| Usage and cost | `result.usage`, `stats.models[].tokens`, SDK docs add `num_turns`, `stop_reason`, `total_cost_usd` | Exact key shapes **unverified** (docs print `{}`) |
| Wake a running session (leader push) | (a) cross-session protocol: each session registers `$QWEN_HOME/sessions/<pid>.json` with a Unix-socket inbox and token; (b) `qwen serve` daemon on `127.0.0.1:4170` with `POST /session/:id/prompt` and SSE events; (c) hooks (`SessionStart`, `Stop`, `PermissionRequest`, …) that run in headless mode | This is more than Claude Code Channels offers, and closer to what `opencode serve` gives xezar today |
| Telemetry off | `privacy.usageStatisticsEnabled` defaults **true**; `QWEN_TELEMETRY_ENABLED=false` / `--no-telemetry` for OTLP | xezar would set the privacy key in every per-run home |

## 4. What it would cost inside xezar

The touchpoint sweep found the fifth-backend work is mostly typed and therefore enumerable. Counts are files to touch, not lines.

| Layer | Files | The load-bearing edits |
| --- | --- | --- |
| Contract | ~5 | `runnerSchema` in `packages/contract/src/health.ts:4` (cascades into ~20 cockpit compile errors by design); per-runner model bags in `workspace.ts` (8 spots); `agent-profiles.ts:101`; the api-client `UiBackend` mirror |
| Runner core | 3 new + ~12 edits | `qwen-runner.ts` (template: `claude-cli-runner.ts`, 568 lines, the termination reference), `qwen-ui-mapper.ts`, `qwen-model-catalog.ts`; `RUNNER_IDS` in `agent-runner.ts:24` is the single source; `BACKEND_ALLOW_PREFIXES`, `BACKEND_MODEL_MAP`, `PROFILE_ENV_VAR` + `PROFILE_DIR_MARKERS`, `RUNNER_DISPLAY_NAME`, `provider-auth.ts` descriptor |
| Service | ~15 | models adapter table in `server.ts:1031`, `resumeCommand()` at `server.ts:6176`, `open-in-app.ts` CLI row, `paths.ts` home slot, workspace config/accounts/profiles bags, agent-config catalog rows (dated, verified against the real CLI), `seed.ts` decision |
| MCP / leader | ~4 (+3 if wakeable) | `discovery.ts:49` and `task-create.ts:225` runner lists (the latter is a plain array – no compile error, easy to miss); adapter + link + extension only if the wake path is built; regenerate `mcp-api.md` |
| Cockpit | ~15 | `runner-label.ts` (typed so a fifth backend is a compile error), `new-task-form.ts` (4 spots incl. `PROVIDER_SPANNING_RUNNERS`), `queries.ts` one extra literal hook call, `thread-state.ts:72,195` two hand-written unions, settings descriptors/accounts/provider settings/MCP capabilities |
| Docs | ~10 | `AGENT_PROTOCOL.md` §9 checklist (predates accounts, model discovery, provider auth and leader delivery – worth rewriting anyway), `AGENTS.md` four spots, README ~15 spots + `XEZ_QWEN_BIN` row, `.env.example` same commit, BC additive entries, CHANGELOG, agent-browser pins |
| Tests | ~45 | ~12 compile-gated pins (parity `BACKENDS`, descriptor order, runner-label object, provider order ×4, `PROFILE_CAPABLE_PROVIDERS`), 3 new suites + a `mock-qwen.mjs` for `XEZ_DRY_RUN=1`, golden fixtures for **every** parity capability (pi has 3 scenarios, OpenCode 7) |
| Kit | ~2 | one paragraph in `.xezar/docs/installation.md`; no check or workflow names a backend |

Rough size: comparable to the OpenCode runner (988 lines) plus fixtures and cockpit rows – one focused implementation task with a real-client acceptance leg, plus a separate leader-wake task if push delivery is wanted. The `pi` precedent in this repo is not one PR but eight incremental fixes after the baseline import (models discovery #157, text coalescing #163, output cap #166, foreign signal #167, reaction adapter #358, setup card #343, harness leg #368, error copy #367) – budget for the same tail.

## 5. Why it is not compelling today

1. **The free tier is gone.** Qwen OAuth ended 2026-04-15 ([auth docs](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/)). A real run needs Alibaba Model Studio, OpenRouter/DeepSeek, or a local endpoint. The "free Qwen3-Coder for everyone" argument no longer exists.
2. **No local-model advantage over pi and OpenCode.** Its OpenAI generator has a streaming tool-call parser that repairs fragmented `tool_calls` deltas, and nothing model-specific ([streamingToolCallParser.ts](https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/core/src/core/openaiContentGenerator/streamingToolCallParser.ts)). Issue #176 (local tool calling broken for a year) was closed by server-side fixes, not the client. No benchmark or user report compares it with OpenCode or pi on local models (searched; none found).
3. **Two open bugs hide failures.** #8920 (open, 0.21.9) and #11217: provider errors emit `"subtype":"success","is_error":false` and exit 0 in JSON modes. xezar's step logic reads exactly those fields.
4. **Telemetry on by default** and a Node 22 floor for users.
5. **Security lineage is unverified.** Gemini CLI's April 2026 advisory GHSA-wpqr-6v78-jr5g (headless workspace-trust bypass loading `.env`; `--yolo` ignoring allowlists) names only Google packages; the fork does not merge upstream, so whether it carries the same bugs is unknown. Qwen Code documents `.env` auto-loading as its auth mechanism.

## 6. Why it might still be worth it later

- The wire format is Claude Code's, so the mapper is nearly a port of `claude-ui-mapper.ts`.
- `QWEN_HOME`, `stream-json`, MCP and `--yolo` map one-to-one onto the seam; `--max-wall-time` and the exit-code table are cleaner than any current backend's.
- Its socket inbox and `qwen serve` daemon are real wake paths – a Qwen leader could be attachable the way OpenCode is, without an extension the user must install (pi's case) or a hidden flag (Claude Code's case).
- Real Alibaba investment (≈3 500 merged PRs a quarter).
- It would matter if DashScope-hosted Qwen models or Chinese-market users become a xezar goal.

## 7. The alternatives, one line each

| Tool | Headless JSON | MCP client | OpenAI-compatible local | Resume | Licence |
| --- | --- | --- | --- | --- | --- |
| Gemini CLI | yes | yes | **no** (Gemini/Vertex only) | yes (unverified) | Apache-2.0 |
| Cline CLI | yes (`--json --auto-approve`) | yes | yes | unverified | Apache-2.0 |
| Factory Droid | yes (`droid exec --output-format stream-json`) | unverified in exec mode | yes | yes | proprietary |
| Cursor CLI | yes (`-p --output-format stream-json`) | yes | no | yes | proprietary |
| Amp | yes (Claude-Code-compatible JSONL) | yes | no | yes | proprietary |
| Crush (Charm) | partial (no JSON events) | yes | yes | yes | FSL-1.1-MIT |
| Kilo CLI (OpenCode fork) | partial | yes | yes | yes | MIT |
| Goose | partial | yes (extensions are MCP) | yes | yes | Apache-2.0 |
| Aider | no | no | yes | partial | Apache-2.0 |
| Copilot CLI | partial (ACP stdio) | yes | no | unverified | proprietary |

Of these, Cline CLI is the only open-source one that ticks all four columns and would be the stronger fifth candidate if the goal is "another OSS, local-model-capable, MCP-aware CLI".

## 8. Recommended next step: a two-hour experiment, no xezar code

Run from a throwaway directory, with a throwaway home, against the owner's local endpoint (the key stays in the shell, never in a file that is committed):

```bash
export QWEN_HOME="$(mktemp -d)" OPENAI_BASE_URL=http://127.0.0.1:18000/v1 \
       OPENAI_API_KEY="$LOCAL_KEY" OPENAI_MODEL=deepseek-v4-flash-vision \
       QWEN_TELEMETRY_ENABLED=false
printf '{"privacy":{"usageStatisticsEnabled":false},"security":{"auth":{"selectedType":"openai"}},"mcpServers":{"xezar":{"command":"xezar","args":["mcp"],"trust":true}}}' > "$QWEN_HOME/settings.json"
cd "$(mktemp -d)" && git init -q
qwen "Call the xezar health MCP tool, then write its result to hello.txt" \
  --output-format stream-json --include-partial-messages --yolo | tee events.ndjson
```

Four checks, in order; the first two failing are disqualifiers:

1. Point `OPENAI_BASE_URL` at a dead port and rerun: the `result` element must say `is_error:true` and the exit code must be non-zero (tests #8920 on this build).
2. During the run, confirm no connection leaves 127.0.0.1 after the two opt-outs.
3. The MCP tool call appears in `events.ndjson` and reaches the xezar server.
4. Rerun without `--yolo`: does the write hang, get denied, or exit with a code?

If all four pass, the implementation brief is §4 of this report plus `AGENT_PROTOCOL.md` §9; the acceptance leg is a fifth client row in `packages/xezar/test/integration/mcp-real-clients.test.ts`.

## 9. Sources

Primary: [qwen-code repo](https://github.com/QwenLM/qwen-code), [headless](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/), [settings](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/), [auth](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/), [model providers](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/), [MCP](https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/), [hooks](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/), [cross-session protocol](https://qwenlm.github.io/qwen-code-docs/en/users/features/cross-session-protocol/), [qwen serve](https://qwenlm.github.io/qwen-code-docs/en/users/qwen-serve/), [TypeScript SDK](https://qwenlm.github.io/qwen-code-docs/en/developers/sdk-typescript/), [roadmap](https://qwenlm.github.io/qwen-code-docs/en/developers/roadmap/), [privacy](https://qwenlm.github.io/qwen-code-docs/en/users/support/tos-privacy/). Issues: [#176](https://github.com/QwenLM/qwen-code/issues/176), [#8920](https://github.com/QwenLM/qwen-code/issues/8920), [#11217](https://github.com/QwenLM/qwen-code/issues/11217), [#6131](https://github.com/QwenLM/qwen-code/issues/6131), [#3606](https://github.com/QwenLM/qwen-code/issues/3606). Advisory: [GHSA-wpqr-6v78-jr5g](https://github.com/advisories/GHSA-wpqr-6v78-jr5g). Gemini CLI headless: [geminicli.com](https://geminicli.com/docs/cli/headless/). Alternatives: [Cline CLI](https://cline.bot/cli), [Factory Droid](https://docs.factory.ai/droid-exec/overview), [Cursor CLI](https://cursor.com/docs/cli/headless), [Amp](https://ampcode.com/manual), [Crush](https://github.com/charmbracelet/crush), [Kilo](https://kilo.ai/docs/code-with-ai/platforms/cli), [Goose](https://block.github.io/goose/), [Aider](https://aider.chat/docs/scripting.html), [Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference). Repo: `AGENT_PROTOCOL.md` §9, `packages/xezar/src/core/{agent-runner,runner-factory,backend-detect,pi-runner,claude-cli-runner}.ts`, `packages/contract/src/{health,workspace,mcp-leader}.ts`.
