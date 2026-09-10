# Xezar UI project leader — pilot and operations guide

This temporary pilot coordinates through the existing Xezar UI. It does not implement or certify the future Xezar MCP server or built-in leader. The English [role prompt](../../prompts/xezar-ui-leader-prompt.md) contains the durable, standalone rules; this guide holds dated setup and operational details. The canonical file is `docs/prompts/xezar-ui-leader-prompt.md`, named for its host-neutral role.

The [leader requirements](builtin-project-leader-requirements.md), [MCP contract](../mcp-server/mcp-project-leader-requirements.md) and [audited practice register](standard-process-source-audit.md) supply design context, not proof of installed pilot capabilities.

## Start

Use a host with a supported browser-control interface connected to the intended Xezar project. User target environments are Claude Code with Claude Opus 5 or Claude Fable, and Codex with GPT-6 Astra or later suitable models. These are requested targets, not certification of access or identical performance. Keep host instructions and permissions intact; discover actual tools and model controls in that session.

Supply the role prompt through the host's supported session instruction mechanism. If only ordinary message input is available, supply it as role guidance and disclose that it has not become a system instruction. Do not install global instructions or change model/effort settings as a side effect. For example, Claude Code documents this additive launch form (checked 2026-09-10):

```bash
claude --append-system-prompt-file "/absolute/path/to/xezar/docs/prompts/xezar-ui-leader-prompt.md"
```

Use the real file path and check the installed host's supported behavior. There is no claim of a matching Codex CLI flag. In Codex, use the actual supported task/session instruction surface and inspect its available tools. Evaluate a changed prompt in a new conversation; retained instructions can differ from newly supplied text. Leader model selection and executor routing are separate, and this guide neither launches a session nor changes configuration. [Claude CLI reference](https://code.claude.com/docs/en/cli-reference).

Give the leader one project identity, goal, DoD/acceptance criteria, authorized planning mode, constraints and prior decisions. An approved plan or autonomous instruction removes repeated planning approval, not the visible baseline or required gates. Resume after a pause/restart explicitly, then reconcile; context compaction alone needs reconciliation, not renewed authority.

Optional local context for Marcin's setup: OpenCode and Pi can use the DGX Spark LAN DeepSeekV4Flash deployment configured as `deepseek-v4-flash-vision`; prefer suitable local execution. Verify selected-profile configuration and actual dispatch capabilities. This user-reported preference establishes no price, entitlement, throughput or concurrency limit, and must not become a global model pin.

## Host capability adapter

Record these mappings at startup, with evidence and unknowns. Tool names below are examples only; a name in this document does not make a tool callable.

| Need | Host-specific mapping and fallback |
| --- | --- |
| Browser control | Claude may expose Chrome DevTools MCP; Codex may expose a browser/computer-use interface. Use the actual supported snapshot/read/click/type controls. Missing browser control blocks UI mutation, not permitted analysis. No HTTP, injected JavaScript or direct state-file write substitute. |
| Tool discovery | Inspect the host's exposed catalog/help; use a native discovery tool when available. `ToolSearch` is an optional Claude example, not a core dependency. |
| Human question | Map to an available structured question tool in its permitted mode, such as Claude's `AskUserQuestion` or a Codex request-input interface. Otherwise ask in plain text and disclose the structured-UI limitation. Native permission approval stays separate. |
| Wait and continuation | Verify supported await/event/automation semantics for the specific Xezar outcome and conversation. Native task waits may cover host tasks only. Otherwise use authorized bounded polling or honest manual continuation, as below. |
| Checkpoint | Use a supported authorized project UI field with readback; otherwise publish one coherent conversation checkpoint and disclose that durable Xezar storage is unverified. No private profile memory or executor task solely for administrative notes. |
| Model/effort | Record requested, effective, inherited, locked, not-configurable or unknown separately. No automatic leader model switch, vendor-specific environment variables or assumed effort field. |

The current session's tool schemas are the operational source of truth. Official [Codex app-server documentation](https://developers.openai.com/codex/app-server/) describes an integration interface, not proof that every host exposes its features to a leader. [GPT-6 Astra guidance](https://developers.openai.com/api/docs/guides/latest-model) describes model/API capabilities; the host must still implement tool execution and continuation. Neither source establishes a shell-exit-to-conversation wake path.

## Startup discovery and assignment

Inventory Claude Code, Codex, OpenCode and Pi through Xezar controls and bounded safe metadata reads. Distinguish installation, dispatch support, selected-profile access, configured versus effective models, locks, tools, modality, context, cost and shared resources. Missing optional backends must not block suitable known work. Keep per-call and overall discovery deadlines, preserve partial results and refresh only affected stale entries.

Use installed help before relying on commands. Historically useful read-only examples include `opencode models` and `pi --list-models`; use them only if supported. Prefer existing Xezar catalog surfaces where available. Credential presence is not inference entitlement, and credentialless LAN providers may work without an auth entry. Do not print credentials, read private profiles, install/login, benchmark, scan the LAN or launch persistent services to fill an inventory.

Compare OpenCode and Pi with the same model by verified exposed integrations, tools, image transport, restrictions and reliability, not intelligence by branding. Prefer suitable local execution; justify stronger reasoning directly for difficult/high-risk work, then return suitable later stages to inexpensive execution. Include failed work, waiting, human intervention and CPU/inference contention in cost. Filling slots is not a success metric.

## Dated operations notes — 2026-09-10

The 2026-09-09 campaign notes contained useful observations but are not universal recipes. They reported picker ordering, remembered Worktree settings, brief-entry problems and uncertain steering. The following retains their failure modes without prescribing a fixed keyboard sequence or browser-call budget:

- Read fresh state, select the intended workflow/skill through a supported control, then verify its visible identity. `Home`/`End` ordering is not a stable selection contract.
- Read back Worktree, autonomy, runner/profile/model and the complete brief before Start. Previous choices may persist; picker changes may alter settings. If submission is disabled, diagnose the field/application state before trying again.
- After Start, record the full acknowledged task ID/URL and observed branch/worktree metadata. After Send, verify message acknowledgement and later distinguish delivery from execution. Historical steering failures justify readback, not a claim that all steering is unreliable.
- After an ambiguous timeout/click, inspect current state and reconcile identity before retrying. Never duplicate a task, merge or release because a tool timed out.
- Confirm a merge against its intended head/base and tracker merge identity. Confirm root-sync against the full fixed target SHA and clean expected checkout, with the actual root lease supplied by its separate workflow. Read-only Git evidence does not authorize the leader to run root Git mutations.

Source context for adapter limits is the repository at `cf2a85ecb8f79201554c5c57baafbcd3fb469c72`; installed releases and active workflow snapshots can differ. The [common runner contract](../../../packages/xezar/src/core/agent-runner.ts), [runner factory](../../../packages/xezar/src/core/runner-factory.ts), [agent protocol](../../../AGENT_PROTOCOL.md) and [workflow execution](../../../packages/xezar/src/workflows/run.ts) are the starting points for a targeted refresh. Check the actual adapter before relying on image transport, resume, allowlists, native dialogs or effort controls. A native feature or requested model ID is not proof of effective execution.

The inspected Claude runner has a 30-minute non-interactive default, with per-step timeout handling in workflow execution. That is a dated implementation fact, not a universal backend limit or a reason to prefer a plain single-step task. Choose quick versus multi-stage work by scope, risk, stage order and controls; verify installed limits and use suitable finite timeouts/checkpoints/splitting. Last-agent interactivity alone proves no unlimited lifetime. Workflow timeout changes are separately owned and not made by this prompt revision.

## Waiting and recovery

Use the same decision order as the prompt: supported native await/event or authorized automation → supported and authorized explicit bounded polling → manual continuation if no actual wake path exists. An SSE/WebSocket subscription in Xezar or a shell job finishing does not by itself invoke the leader. Do not promise post-session notification without an acknowledged mechanism covering that outcome.

For polling, declare outcome, exact identity/evidence source, interval, deadline and stop conditions. Use bounded reads, short or interruptible waits, one watcher per independent outcome and no hidden or indefinitely chained windows. A sample operating window might be a 30-second interval for five minutes when the host permits it; these numbers are illustrative, not required defaults or a new retry quota. Return control for human questions. On expiry/read error/missing state, report uncertainty, diagnose and checkpoint; do not infer success or cancel work.

State handling is explicit: queued/running/monitoring remain pending; input/approval requires attention; pause stops new leader decisions but not executors; cancellation requires terminal confirmation. Completion or a PR/check/merge milestone ends that wait, then requires fresh evidence and remaining-goal reconciliation. Poll authoritative status rather than page text that can match the brief. Preserve failed attempts and keep workflow-return and same-failure-repair counters separate.

The old shell watcher example is intentionally removed: its condition stopped on `monitoring` despite prose saying otherwise, and its claimed automatic wakeup was not established. The old guide's blanket “no polling adopted” statement is also superseded by the conditional bounded policy above. No live watcher or host wake mechanism was tested for this revision.

## Boundaries of this pilot

All Xezar mutation remains through supported cockpit interactions; implementation and technical changes belong to Xezar executors. Scoped evidence reads are attributed. Workspace/global administration and permission bypass remain outside the role. Browser access supplies no server-enforced ownership, atomic conflict rejection or idempotency. Preserve active tasks and versioned workflow snapshots.

Required tests/reproduction, independent substantive review and hosting approval are distinct. A gate refusal calls for diagnosis of exact head/base, required checks, stale snapshots/configuration and evidence, followed by permitted repair; it is not an automatic waiver question. Root-sync needs its actual lease, expected clean checkout and fixed target. A finished agent or draft PR does not complete the human goal.

## Evaluation

The [scenario checklist](claude-code-ui-leader-evaluation.md) records hypothetical fixtures and static coverage. Static coverage means the instructions address a decision, not that a model followed them. It preserves the earlier valuable scenarios and adds cross-host and recovery cases.

A separately authorized live evaluation should use a new conversation, a disposable project and harmless tasks first. Record the immutable prompt revision, actual leader/browser/backend versions, selected profile/requested and effective model/effort, capabilities, fixture, observed actions, artifacts and `live-pass` or `live-fail` per case. Include missing capabilities and failure paths. All live model/browser results for this rewrite remain **not-run**; this does not replace the future MCP integration spike.
