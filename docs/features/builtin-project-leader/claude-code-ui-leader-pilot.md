# Claude Code leader via Chrome DevTools MCP — pilot

This pilot uses the existing Xezar UI. It does not implement or certify the future Xezar MCP server or built-in leader. The [role prompt](../../prompts/claude-code-ui-leader-prompt.md) is an English additive system instruction based on the [leader requirements](builtin-project-leader-requirements.md), [MCP contract](../mcp-server/mcp-project-leader-requirements.md) and [audited practice register](standard-process-source-audit.md).

## Start

Use an interactive Claude Code session with a user-selected model, Chrome DevTools MCP already configured and connected, and the intended local Xezar project visible in the controlled browser. Run from the desired project directory:

```bash
claude --append-system-prompt-file "/absolute/path/to/xezar/docs/prompts/claude-code-ui-leader-prompt.md"
```

Replace the placeholder with the actual prompt-file location. The additive flag preserves Claude Code's built-in instructions. Use one project per conversation. Choose the leader's model through the client's supported selection; executor routing does not change the leader's own model. This guide does not install integrations, change credentials or launch a session. Chrome DevTools MCP is distinct from Claude-in-Chrome.

Supply the project identity and goal. Include known DoD/acceptance criteria, planning mode, constraints and previous decisions when available. Missing facts are discovered or clearly proposed; autonomous mode still requires a visible goal/DoD/AC baseline. The default mode requires plan approval before execution. An explicit autonomous instruction removes that initial approval, not project gates or consequential decisions outside authority.

Optional startup context can identify known local resources and spending/data constraints. For example: “OpenCode and Pi are configured for DeepSeek on our LAN cluster of two DGX Sparks; prefer it for suitable tasks.” This is user-reported evidence until checked. It supplies neither an exact model ID nor a price, throughput measurement or concurrency limit. The leader discovers those details only as needed and keeps unknowns explicit.

For resumed sessions, supply the role file alongside `--resume`, but use a **new conversation to evaluate a revised prompt**: retained session instructions may differ from launch text. Resume reconciles project state before further actions. Official setup references: [Claude CLI](https://code.claude.com/docs/en/cli-reference) and [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp).

## Startup discovery and assignment

The prompt contains the complete dated four-tool comparison and routing policy; a separate research report is not required. Inventory Claude Code, Codex, OpenCode and Pi using Xezar controls and safe, bounded metadata reads. Each entry distinguishes installation, dispatch support, configured models, selected-profile access, actual controls and cost evidence. A missing optional backend must not block a suitable known one.

Use installed help/version information before relying on commands. Where supported, `opencode models`, `opencode auth list` and `pi --list-models` provide useful read-only configuration evidence. Credential presence does not establish inference access; credentialless LAN providers can be configured without an auth-list entry. Prefer Xezar's existing Claude/Codex discovery surfaces over inventing model-list commands or manually starting an app-server. Do not print credentials or inspect private assistant profiles. The effective Xezar executor environment can differ from the leader's shell.

Discovery needs per-call and overall deadlines; record partial results on failure. Do not install, authenticate, benchmark models, scan the LAN or create persistent services merely to complete an inventory. Pi's absence from the current Xezar model-catalog route is a visibility gap, not proof that Pi cannot execute.

For each task/stage, filter by actual requirements and controls, then choose the lowest expected total completion cost. Suitable local DeepSeek work should not use premium reasoning by habit. Both OpenCode and Pi remain candidates; use required integrations, image transport, tool restrictions and observed reliability to decide. A complex or high-risk task may justify a stronger model directly. Record the reason, exact requested versus effective settings, evidence and authorized fallback; model locks and absent effort controls must remain visible. Return later simple stages to cheaper suitable execution when handoff overhead permits.

## Boundaries of this pilot

- Xezar mutations use supported cockpit interactions. Scoped read-only repository, kit, Git/tracker, run/gate and safe tool/model metadata reads are permitted and attributed. Direct API, injected DOM, file or shell mutation and independent executor launches remain prohibited.
- Workspace/global administration is outside this project role. Required effective capability/resource metadata may be read without changing global settings. No permission denial can be routed around through a different executor.
- Project isolation is behavioral, not a server-enforced security boundary. Browser access does not supply ownership, locks, atomic conflict rejection, idempotency or durable checkpoints.
- Existing workflows must preserve required stage order, review and real resource guards. Brief prose cannot replace a lease or quality gate. Active definitions remain unchanged unless their execution versions are preserved.
- Browser waits do not establish asynchronous model wakeup. Without a proven supported wait/event path, checkpoint and use manual continuation. Chained browser/shell polling and hidden watchers are excluded.
- Missing structured questions use the explicitly deficient text fallback; this is not parity with the final feature. Missing checkpoint storage uses the disclosed conversation fallback, never private profile memory or an executor task just to save notes.

## Evidence baseline and integration limits

Online primary-source research and local adapter inspection were completed on **2026-09-09**. Source links for all four products reside in the prompt. These are rolling upstream documents, not a pinned compatibility certification. Check installed versions and effective behavior when a consequential fact differs; in particular, do not apply a newer OpenCode configuration schema to an older installation.

The source baseline is commit `f27933ab99b9f0fef6214e7cc107a9ae233e583e`, with a pending local OpenCode connection-detection fix. The installed Xezar release may differ. Review the [agent protocol](../../../AGENT_PROTOCOL.md), [common runner contract](../../../packages/xezar/src/core/agent-runner.ts), [runner factory](../../../packages/xezar/src/core/runner-factory.ts) and [workflow execution](../../../packages/xezar/src/workflows/run.ts) when updating this comparison.

Consequential inspected limits are also embedded in the prompt: OpenCode sends text and creates a new session on bootstrap; Pi forwards images but does not bridge native extension dialogs; Codex/OpenCode do not enforce Xezar's per-tool allowlist; and the common dispatch input has no independent reasoning-effort field. Native features, configured model lists and normalized requested IDs are not proof of effective execution. No cross-tool performance benchmark or live leader/browser evaluation was performed.

## Evaluation

The [scenario checklist](claude-code-ui-leader-evaluation.md) records fixtures, expected decisions, prompt clauses and static coverage for the enhancement plan. Static coverage establishes that instructions address a case; it does not demonstrate model compliance or future MCP behavior.

A separately requested live evaluation should use a new conversation, a disposable project and harmless tasks first. Record prompt revision, actual leader/browser/backend versions, selected profile/model/effort, fixture, observed actions, evidence and `live-pass` or `live-fail` per case. Include failure paths and preserved working paths. Never relabel static coverage as a live result. Live evaluation remains **not-run**; this checklist does not replace the three-client integration spike in the MCP specification.
