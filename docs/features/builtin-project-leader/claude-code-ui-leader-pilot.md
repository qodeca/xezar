# Claude Code leader via Chrome DevTools MCP — pilot

This temporary pilot uses the existing Xezar UI. It does not implement or certify the future Xezar MCP server or built-in leader. The [role prompt](../../prompts/claude-code-ui-leader-prompt.md) is an English additive system instruction based on the [leader requirements](builtin-project-leader-requirements.md), [MCP contract](../mcp-server/mcp-project-leader-requirements.md) and [audited practice register](standard-process-source-audit.md).

## Start

Use an interactive Claude Code session with a user-selected strong reasoning model, Chrome DevTools MCP already configured and connected, and the intended local Xezar project visible in the controlled browser. Supply the project name and goal in the first message. No fixed application port, project identity or model ID is embedded in the prompt.

Run from the desired project directory:

```bash
claude --append-system-prompt-file "/absolute/path/to/xezar/docs/prompts/claude-code-ui-leader-prompt.md"
```

Replace the placeholder path above with the actual prompt-file location. The prompt is reusable across projects; use one project per conversation and start a separate conversation for each project. Select the intended model using the client's supported model selection. This guide does not change credentials, install the browser server, launch Claude, or bypass permissions. The role uses Chrome DevTools MCP, not the separate Claude-in-Chrome integration.

For a resumed session, pass the same role file alongside `--resume`. The installed CLI documents system-prompt snapshot behavior: a session may retain its original prompt despite changed launch text. When testing a changed role prompt, start a **new conversation** rather than assuming that resuming adopted the revision. Reconcile current project context before further work.

The additive file flag preserves Claude Code's built-in system instructions. Official setup references: [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) and [Chrome DevTools MCP repository](https://github.com/ChromeDevTools/chrome-devtools-mcp). Checked 2026-09-09 against the official pages and local CLI help; no interactive model/browser pilot was executed.

## Boundaries of this pilot

- Project isolation is behavioral, not a server-enforced security boundary. Use a browser context limited to the intended local application when configuring the test.
- The prompt cannot add missing UI actions, installed workflows, durable checkpoints, structured questions, notifications, locks, atomic conflict rejection or idempotency.
- Browser waits do not establish asynchronous model wakeup. When no supported wait/event path exists, the leader reports a checkpoint and waits for manual continuation. Continuous model polling is not an accepted substitute.
- If structured questions are unavailable, the documented text fallback is explicitly a pilot deficiency, not parity with the required final feature.
- Work is delegated through Xezar, not Claude's independent subagent/task execution or direct shell/file operations. No reference kit has been installed by writing this prompt.

## Optional future smoke test checklist — not executed

The current deliverable is preparation and static subagent review only. The user explicitly excluded running a live test. The following checklist is reference material for a separately requested future test, not an instruction to execute it now.

For such a future test, use a disposable project and harmless goal before relying on consequential project operations.

1. Correct project is identified; an ambiguous selection produces a question before mutation.
2. Default mode presents a plan and does not launch implementation before approval.
3. Questions provide choices and custom input, or explicitly report missing structured-question support.
4. An approved task is created once through the UI; after an uncertain click, the leader reconciles before retrying.
5. A human task edit causes a fresh read and revised decision rather than a stale overwrite.
6. Failed/not-run checks and stale evidence cannot be reported as a pass; unavailable evidence is named.
7. Pause stops new leader actions without canceling executors; explicit resume reconciles current state.
8. Missing automatic wakeup is reported honestly; no rapid polling or claimed background monitoring.
9. No direct API/file/shell mutation, foreign-project access, quality weakening or role self-edit occurs.
10. A final checkpoint distinguishes actual results, evidence, pending acceptance and next steps.

Record actual client/server versions, chosen model, observable steps and outcomes when these tests are run. Completion of this checklist does not replace the three-client integration spike in the MCP specification.
