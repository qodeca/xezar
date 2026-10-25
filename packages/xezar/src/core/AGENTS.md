# Guidance for `packages/xezar/src/core/`

Cross-repository rules and the task-routing index are in the root `AGENTS.md`.

## Agent runners / backends

**Read `AGENT_PROTOCOL.md` first.** It is the contract every runner satisfies: the runner seam, the
v1 `AgentEvent` and v2 `UiEvent` streams, the per-backend mapping, golden-fixture testing, the
backend-parity rule and the new-runner checklist (§9).

- **One seam.** Every backend is one class behind `AgentRunner`/`AgentSession`, built only through
  `createRunner`, and emits both event streams. Never leak backend-specific types past
  `packages/xezar/src/core/`. The v2 `UiEvent` vocabulary and `toolDisplay()` are not in this
  folder: they are defined once in `packages/contract/src/ui-events.ts` and `tool-display.ts`.
- **Never repurpose or remove a shipped backend id.** `claude-cli` is a legacy id kept so old run
  records parse; `createRunner` maps it onto `claude`.
- **`XEZ_DRY_RUN=1` must keep working** – the bundled mock, no real CLI and no network.
- **The zero-config tool default is a full shell.** `DEFAULT_ALLOWED_TOOLS` includes unrestricted
  `Bash` with no `bashAllowlist` (pre-rename issue 430); never treat it as a sandbox.
- **`isReadOnlyStep` (`read-only-lock.ts`) is the one read-only signal**: a resolved `allowedTools`
  that names neither `Edit` nor `Write`. No step key, no `XEZ_*` variable (#849, #863).
- **Read-only enforcement differs per backend, and the differences are written down** –
  `AGENT_PROTOCOL.md` §6 "Read-only steps – per backend" (including the Windows rules: the Codex
  `unelevated` sandbox, the one-time lift after a Git Bash crash, and the PowerShell reading on
  Codex and Qwen Code).
- **MCP isolation is per backend too** – `AGENT_PROTOCOL.md` §1, `AgentRunSpec` "MCP isolation":
  each runner gives a task run only the project's declared servers, never the person's own or
  xezar's bridge.
- **`claudeSettings` (#1001)** reaches the Claude runner as `AgentRunSpec.claudeSettingsFile`; its
  rules are in `packages/xezar/src/workflows/AGENTS.md`.
