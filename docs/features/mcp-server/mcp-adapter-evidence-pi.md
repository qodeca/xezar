# pi as an MCP leader client – runtime evidence (first half)

Issue: [#330](https://github.com/qodeca/xezar/issues/330), work package WP1. Part of
[epic #67](https://github.com/qodeca/xezar/issues/67). Covers F-17, F-18, F-20, F-21, D-01, D-02, D-05 and the
A-01 client leg of the [requirements](mcp-project-leader-requirements.md), for pi only.

**This is the first half of the record.** It covers what can be measured before a pi reaction adapter exists:
the one-time setup, the A-01 client leg against the real bridge, and the 13 behaviours of the
[client behaviour spike](mcp-client-behaviour-spike-report.md). The second half – the reaction adapter
(`adapters/pi.ts`, WP2) and its runtime runs – was written with that adapter after #311 merged and is
appended below: [pi reaction adapter – runtime evidence (second half)](#pi-reaction-adapter--runtime-evidence-second-half).

Run date: **2026-09-11**, 17:33–18:15 UTC. Revision under test: **`5031bf8`** (`main`), built with
`npm run build` on branch `xez/95c0a6da`. No product file differs from `main`; this branch adds only this
record. Host: macOS 26.6.2 (Darwin 25.6.0, arm64), Node v24.20.0. pi: **0.85.1**
(`@earendil-works/pi-coding-agent`). pi-mcp-adapter: **2.32.1**. These are the versions #330 verified. They
are installed versions, not certified minimums. The adapter's npm registry answered **2.33.0** as the latest
version on the run date; 2.33.0 was **not tested**.

## Answer first

- **pi works against the real `xezar mcp` bridge (EXECUTED).** pi 0.85.1 with pi-mcp-adapter 2.32.1
  connected to the bridge of a real `xezar serve`, was offered all 11 xezar tools, and called them. `health`
  named project A. `task_read` returned A's task. Nothing of project B reached pi. The wire held only
  `initialize`, `notifications/initialized`, `tools/list` and `tools/call`; the bridge answered no error, so no
  `-32601` was triggered. **The amendment in #330 rests on a real run now, not on a stub.**
- **A-01 client leg: PASSED.** The one-time step is `pi install npm:pi-mcp-adapter@2.32.1` plus one
  `mcp.json` entry with `"directTools": true`. It added nothing to A's working tree.
- **12 of the 13 behaviours PASS, 1 FAILS.** The failure is **prompt persistence**: after a session resume
  without `--append-system-prompt`, the role text was gone. With the flag given again it was back. This is
  the same result as Claude Code, and the same rule follows: the adapter supplies the role on every start. It is a
  known shape, not a pi defect, and a requirement for `adapters/pi.ts` (WP2, finding 1 below).
- **Exclusive ownership holds with pi on either side.** It is on `main` since #302 (PR #305, `a0cf85e`).
  pi as the second client was refused. pi as the owner made a second client get `-32080`. After a service
  restart, pi's first call was fenced with `-32081` and not applied, and the next call worked with no human
  step.
- **Four pi-specific limits matter for the next packages** (details in
  [Findings for WP2 and WP3](#findings-for-wp2-and-wp3)):
  1. When pi is refused as the second client, the model is told only `MCP server "xezar" not available`,
     not why. That is the same as the other three clients (spike decision 7), but pi also marks it as a
     **success** (`isError: false`).
  2. After a tool call times out (60 s), the adapter closes the connection. The bridge exits, so **pi gives
     up project A** until its next call.
  3. A plain RPC `prompt` is refused while pi is busy. An adapter must use `steer` or `follow_up`.
  4. **With the adapter's defaults, an idle pi gives up the project after about 10 minutes.** The adapter
     closes an idle server (its default `idleTimeout` is 10 minutes). The bridge exited between 601 s and 661 s
     after the last call, and another client then took A. With `"lifecycle": "keep-alive"` on the xezar entry,
     pi still held A after 700 s. The setup guidance must include that key.
- **`PI_CODING_AGENT_DIR` held.** pi and the adapter kept everything under the pinned folder: the installed
  extension, `settings.json`, `models.json`, `mcp-cache.json` and the session files. The real `~/.pi` was not
  changed (see [Isolation](#isolation-and-pi_coding_agent_dir)). This confirms #329: pi **does** read
  `PI_CODING_AGENT_DIR`, and what `agent-profiles.ts`, `paths.ts` and `AGENTS.md` say about pi today is wrong.
  **Superseded 2026-09-12 by [#349](https://github.com/qodeca/xezar/pull/349):** the observation stands, the
  "say about pi today is wrong" half no longer does — those files were corrected. Read it as of the run date.
- **A real model reaction is still UNVERIFIED.** Every turn here reached a scripted local endpoint. That proves
  pi starts a real turn. It does not prove what a real model decides. The spike's OB-5 stays open for pi too.

## How to read this record

Evidence labels follow the spike report and the other three adapter records:

| Label | Meaning |
| --- | --- |
| **Executed** | Run on this host on 2026-09-11 against real processes. The scenario name points to the private evidence. |
| **Read from source** | Read in this repository at `5031bf8`, or in the installed pi-mcp-adapter 2.32.1, with the file named. |
| **Documentation only** | A pi or adapter document says so. No run here confirms it. |
| **Not attempted** | Named, with the reason. |
| **UNVERIFIED** | Not observed, and not inferred either. Never counted as a pass. |

**Model reaction, as measured here** (the spike's definition, kept): pi itself sent a new inference request
that carried the event, and the request arrived at the endpoint.

**Real bridge, not a stub.** Every scenario ran the bridge built from `5031bf8`
(`node packages/xezar/dist/index.js mcp`), spawned by the adapter, in front of a real `xezar serve`. Three
scenarios put a transparent logging tee between the adapter and that bridge, to read the wire. The tee
forwards every line unchanged. In one scenario (lost response) it drops one answer on purpose.

## Environment and fixtures

| Piece | What it was |
| --- | --- |
| pi | `pi --mode rpc --offline --no-skills --no-prompt-templates --no-themes --no-context-files --model scripted/scripted-model`, the mode Xezar's pi runner uses. Sessions off (`--no-session`) except in the persistence scenario. |
| Environment | `env -i`: only `PATH` (Node and system folders), `HOME` (a throwaway folder), `PI_CODING_AGENT_DIR` (a throwaway folder), `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `TERM=dumb`, `LANG`. No other variable reached pi. |
| Extension | Installed once with `pi install npm:pi-mcp-adapter@2.32.1` under a throwaway `HOME` and `PI_CODING_AGENT_DIR` (this step needs the network), then copied into each scenario's own pinned folder. pi loaded it from `settings.json`, as a user's pi would. No `-e` path was used. |
| Entry | `<PI_CODING_AGENT_DIR>/mcp.json`: `{ "settings": { "directTools": true }, "mcpServers": { "xezar": { "command": "<node>", "args": ["<repo>/packages/xezar/dist/index.js", "mcp"], "env": { "XEZ_HOME": "<fixture>", "XEZ_DRY_RUN": "1" } } } }`. The same two substitutions as the #118 harness: this revision's built bridge instead of `npx -y @qodeca/xezar mcp`, and `XEZ_HOME` because the fixture service runs under an isolated home. A real user's entry needs neither. |
| Model | A scripted OpenAI-compatible endpoint on `127.0.0.1` (`/v1/chat/completions`, streaming). Not a model. `CALL <tool> [<json>]` in the pending user text becomes a call to the offered tool whose name ends with `_<tool>`; a tool result becomes `SCRIPTED-ACK <result>`; anything else becomes `SCRIPTED-REPLY <text>`. `SLOW` holds the answer 8 s. The key string is a dummy value, not a credential. Every request was logged with the offered tool names and a role-marker check. |
| xezar | A real `xezar serve` (`packages/xezar/dist/index.js --repo <fixture> --no-open`) per project, with `XEZ_DRY_RUN=1`, an isolated `XEZ_HOME` and every agent config folder pinned empty. Two projects, `alpha-proj` (A) and `bravo-proj` (B), each a fresh Git repository with one finished task that carries a unique marker string. |
| Fixture folders | Under `/tmp`, outside this checkout, so nothing found this repository's own config by walking up. |

No personal account, key or real task permission was used. `XEZ_DRY_RUN=1` was set in every xezar process.

Every process the harness started was stopped by its own saved handle or PID. A bridge that pi had spawned was
found by walking pi's child processes by parent PID, and killed by that PID. No process was ever matched by
command-line pattern.

## A-01 client leg: PASSED

Scenario `a01` (executed), with the `wire` and `scope` scenarios for the rows marked so.

| Check | Result |
| --- | --- |
| One-time step | `pi install npm:pi-mcp-adapter@2.32.1` → exit 0, `Installed npm:pi-mcp-adapter@2.32.1`. It wrote `settings.json` (`"packages": ["npm:pi-mcp-adapter@2.32.1"]`) and the package under `<PI_CODING_AGENT_DIR>/npm/`. Plus the `mcp.json` entry above. |
| Handshake | The adapter's notices: `MCP: 1 servers connected (11 tools)`, then `MCP: direct tools refreshed (+11, ~0, -0)`. One bridge process, a child of pi. |
| Discovery | The model was offered `xezar_health`, `xezar_task_read`, `xezar_execution_control`, `xezar_discover_project`, `xezar_organise_work`, `xezar_task_create`, `xezar_handoff_git`, `xezar_read_results_evidence`, `xezar_project_config`, `xezar_local_handoff` and `xezar_leader_events`: all 11, as first-class tools. |
| The client reaches A (`health`) | `xezar 0.13.1 is running for project alpha-proj (alpha-proj).` |
| A registry tool answers with A's data (`task_read`) | A's task id and its marker string were in the result. |
| Nothing of B reaches the client | No B task id or marker in any tool result or any model request. |
| No connection data or secret in the client config | The entry names a command and the two fixture variables only. |
| What the setup added to A's working tree | Nothing. The entry lives in the pinned folder, outside the repository. |
| Negative control | The same folder and prompt with `--no-extensions`: the model was offered 0 xezar tools, and `CALL health` found none. The tool path goes through the extension. |
| Protocol and methods (`wire`) | pi offered `2025-11-25`, which the bridge echoed. pi sent `initialize`, `notifications/initialized`, `tools/list` and `tools/call`, nothing else. The bridge sent no error. |
| Client capabilities (`wire`) | `extensions["io.modelcontextprotocol/ui"]`, `sampling: {}`, `elicitation: { form: {} }`. No `roots`. `clientInfo` is `pi-mcp-xezar` / `1.0.0`. |
| Server `instructions` | Sent by the bridge in `initialize`, and in **no** model request. As #330 found against the stub, the adapter keeps them for its `mcp` proxy tool only. |
| A project-level entry (`scope`) | The same entry in `<A>/.pi/mcp.json` instead of the pinned folder also connected and named A. No trust flag was needed. |

The product-level half of A-01 (the connection file, and the tools reaching the service) is not client-specific.
The [acceptance record](mcp-client-acceptance-record.md) keeps it. This record does not re-run it.

## The 13 behaviours, for pi against the real bridge

The spike report's 13 rows, with its client-level method. One difference changes what could be measured: the
spike ran against a stub because no xezar MCP server existed. pi ran against the real bridge, with exclusive
ownership wired (#302). So the rows that were NOT ATTEMPTED in the spike for server reasons – lease expiry,
fencing, human event, replay – were measured here, end to end.

| Behaviour | Result for pi 0.85.1 + pi-mcp-adapter 2.32.1 | Evidence |
| --- | --- | --- |
| tool call | **PASS** – all 11 tools offered, `health` and `task_read` answered through the real service | Executed, `a01` |
| project scope | **PASS** – the same user-level entry bound B when pi started in B, and A in A. An unregistered repository got `This directory is not a xezar project yet…` and no project's data. The adapter spawns the bridge in pi's session working directory (read from source, adapter `server-manager.ts:799`), and the bridge binds from there. pi declares no `roots`. | Executed, `scope` |
| second-client rejection | **PASS** on the spike's criterion: pi refused as the second client, and the error text reached the operator. Also: once the owner left, pi got in by itself; once pi owned A, another client got `-32080`. **The model is not told why** – see the limits after this table. The scenario also checks that, so its own `result.json` verdict is FAILED on that one check. | Executed, `second` |
| process crash | **PASS** – after the bridge was SIGKILLed, the next call spawned a new bridge (new PID) and succeeded, and so did the call after it. Like Claude Code; Codex and OpenCode failed this row in the spike. | Executed, `crash` |
| lease expiry | **PASS** – an idle pi kept A: a second client was refused at 40 s (past the 30 s lease) and at 300 s. The service renews the lease while the bridge's connection lives; model silence is not a signal. **Past 10 minutes it depends on the entry:** with the adapter's defaults the adapter itself closed the idle bridge (between 601 s and 661 s after the last call), which released A, and a raw client then connected and read A's `health`. With `"lifecycle": "keep-alive"` pi still held A at 700 s. | Executed, `idle-default`, `idle-keepalive`, `idletimeout-default`, `idletimeout-keepalive` |
| fencing | **PASS** – after a `xezar serve` restart, pi's first call (a write) was answered `-32081` / `com.qodeca.xezar/session-expired`, and the title did not change. The adapter then closed that bridge. The next call spawned a new one and worked, and a write after it applied. | Executed, `fencing` |
| idle-but-live session | **PASS** – 300 s idle: the same bridge PID, 0 model requests, and the next call served by the same process. In 700 s of silence there were 0 model requests too, with either entry. **Server pings: UNVERIFIED** – the real bridge sends none, so none were answered (the spike's stub pinged every 30 s). | Executed, `idle-default`, `idle-keepalive`, `idletimeout-default`, `idletimeout-keepalive` |
| asynchronous completion causing a real model reaction | **PASS through step 2**, with the scripted model: `task_create` answered in 122 ms with the task `queued`; `task.done` reached the journal about 27 s later; with pi idle, an RPC `prompt` carrying the event started a turn with it. **Native: no turn** – the bridge advertises tools only and sends no notification, and no model request came in the 15 s after `task.done`. **Real model: UNVERIFIED.** | Executed, `async` |
| human event | **PASS** – a cockpit config write (E-05 `config.changed`) and a queued-prompt edit (E-04 `goal.changed`), both origin `human`, reached pi's model through `leader_events read`. Delivered by RPC `prompt`, the event reached the model too. | Executed, `human` |
| replay and dedup | **PASS** – a new pi session, with a new bridge, read the unacknowledged rows again. After an `ack` through pi, neither the same session nor a new one got them again. | Executed, `human` |
| stale mutation | **PASS** – a human renamed the task after pi read it. pi's write with the old version was not applied, and the model received `status: conflict`, `applied: false`, `error: stale_version` and the guidance, intact. The bridge sends this as an ordinary result, not `isError` (U-M05), and pi passes it on as it is. | Executed, `stale` |
| idempotent lost response | **PASS** – the tee dropped the bridge's answer to `task_create`. pi reported `Failed to call tool: Request timed out` after **60 s** (the adapter's default), sent one `notifications/cancelled`, and sent the call once: no silent retry. The task existed in the service anyway. A retry with the same `operationId` answered `replayed: true` with the same run, and still one task existed. | Executed, `lost` |
| prompt persistence | **FAIL** – with `--append-system-prompt` the role marker was in every request. After `--continue` **without** the flag the conversation came back, but the marker did not. With the flag given again it was present. pi stores no system prompt in its session file (read from pi's `docs/session-format.md`). | Executed, `persist` |

**Tally:** 12 PASS, 1 FAIL, 0 NOT ATTEMPTED. For comparison, the spike's stub-era tallies were Claude Code 8 / 1 / 4,
Codex 8 / 1 / 4 and OpenCode 7 / 2 / 4. The numbers are **not** comparable one to one: the four rows the spike could
not attempt depended on a server that now exists. pi is not held to a higher bar than the three, and not to a lower
one.

**Limits inside the PASS rows.** None of them changes a verdict above. Each is a fact the next packages must use.

- **Second client, warm cache** (pi used xezar before, the usual case). The adapter registers the xezar tools
  from its cache and connects lazily. The first call answered `MCP server "xezar" not available (failed 0s ago)`,
  with `isError: false`. The occupied reason did not reach the model. No notice reached the RPC client either.
  For the adapter's 60 s failure backoff the xezar tools **disappeared** from the model's tool list. After it,
  they came back, and the call reached A.
- **Second client, cold start** (no cache). The adapter connected at start and reported
  `MCP: Failed to connect to xezar: This project is occupied: it is already connected to another MCP client…`
  as a notice and on stderr. The model got **no** xezar tool in that session, only the adapter's `mcp` proxy tool.
  Through the proxy, once A was free, `mcp({ tool: "xezar_health" })` reached A, and the direct tools then came
  back.
- **Adapter decoration.** The adapter appends `Expected parameters: …` with the tool's schema to error results
  (`not running`, `session expired`). The xezar text stays first and intact.

## The delivery hierarchy for pi

The order is agreed (requirements § 12). This record does not reorder it.

| Tier | Route | Status | Basis |
| --- | --- | --- | --- |
| 1 | Native: MCP notifications | **Not adopted** | The real bridge sends none (`SERVER_CAPABILITIES` is tools only, `packages/xezar/src/mcp/protocol.ts`). Against #330's stub, `notifications/resources/updated` and `notifications/message` started no pi turn (executed in #330, run A). pi sends no `resources/subscribe`. |
| 2 | pi's RPC session interface: `prompt` when idle, `steer` or `follow_up` when busy | **Works – driver only** | Executed here (`async`, `human`), by the harness standing in for an adapter. `adapters/pi.ts` does not exist yet (WP2). |
| 3 | Terminal text input | **Refused** | Tier 2 works. Simulated keystrokes are prohibited. |

What tier 2 did, executed (`async`):

- With pi idle, an RPC `prompt` carrying the event started a turn at once, and the model request carried it.
- With pi busy (a turn the endpoint held for 8 s), a plain `prompt` was **refused**:
  `Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`
- `steer` and `follow_up`, sent during that turn, were both delivered after it ended: `steer` first, as the next
  model request, then `follow_up`. The running text-only turn was not cut short.

## Isolation and `PI_CODING_AGENT_DIR`

**It held.** Executed:

- `pi install` wrote the package and `settings.json` under the pinned `PI_CODING_AGENT_DIR`. The throwaway `HOME`
  received only npm's own cache (`.npm/`).
- With `models.json` only in the pinned folder, pi used the scripted provider. #330's control run showed the
  opposite without the variable: `No models available`.
- The adapter wrote `mcp-cache.json` into the pinned folder. It resolves its folder from `PI_CODING_AGENT_DIR`
  (read from source, adapter `agent-dir.ts:10-25`).
- Session files went to `<PI_CODING_AGENT_DIR>/sessions/`.
- pi created an `auth.json` in the pinned folder. It held `{}`.
- The real `~/.pi` was compared before and after every run (file names, sizes and modification times, the
  `sessions/` folder excluded because other tasks on this machine use pi): **1 958 files, no difference**.
  `~/.config/mcp` and `~/.agents` did not exist before or after.

What `HOME` still does: the adapter also reads `~/.config/mcp/mcp.json`, `~/.agents/mcp.json` and
`~/.agents/mcp/mcp.json` from `HOME` (read from source, adapter `config.ts:12-16`). So a pi acceptance run pins
**both** `HOME` and `PI_CODING_AGENT_DIR`, as #330 said.

## Findings for WP2 and WP3

For the reaction adapter (WP2):

1. **Requirement: supply the role on every start, including every resume.** `--append-system-prompt` is not kept
   in the session (prompt persistence FAIL), and server `instructions` never reach the model. This is a known shape,
   not a pi defect: in the spike (T13) Claude Code and OpenCode fail the same row, for the same reason, and their
   adapters re-supply the role. `adapters/pi.ts` must pass the
   role on every pi start and every `--continue`/`--session` resume, and its runtime record must show the role marker
   in the first model request after a resume.
2. **Deliver with `steer` or `follow_up` when pi is busy.** A plain `prompt` is refused then. When idle, `prompt`
   starts a turn at once.
3. **Build pi's arguments without a `--tools` allowlist**, or include the xezar tools in it. #330's run B showed that
   the allowlist Xezar's pi runner builds hides every MCP tool. Not re-run here.
4. **A timed-out call gives up the project.** The adapter closes the connection on any non-abort error (read from
   source, adapter `direct-tools.ts:619-630`); observed: the bridge exited after the 60 s timeout. Until pi's next
   call, another client could take A. The same close happens after a `-32081`, which is harmless there, because
   the next call opens a new session anyway.

For setup guidance and the cockpit card (WP3):

1. **`"directTools": true` is needed.** Without it the model sees one `mcp` proxy tool and must search for the xezar
   tools first (#330, run A).
2. **Either entry location works.** `<PI_CODING_AGENT_DIR>/mcp.json` (user level) binds each project by pi's working
   directory, and adds nothing to the repository. `<project>/.pi/mcp.json` works for one project. The project
   `.mcp.json` also works for pi, but Claude Code reads the same file (#330).
3. **The adapter is a third-party prerequisite.** Without it pi has no xezar tool at all (the negative control
   above).
4. **Set `"lifecycle": "keep-alive"` on the xezar entry.** The adapter's default lifecycle is `lazy` with a
   10-minute `idleTimeout` (read from source, adapter `init.ts:240` and `init.ts:259-262`). Executed with the defaults:
   the bridge was still there 601 s after the last call and gone at 661 s, so pi no longer owned A. A raw client
   then connected and read A. While it held A, pi's next call answered `MCP server "xezar" not available`, and
   after that client left (and the 60 s backoff) pi reached A again with a new bridge. With `keep-alive`: the
   same bridge for all 700 s, and the raw client was refused. A leader that goes quiet for ten minutes must not
   lose its project, so the setup needs this key. A `keep-alive` server is connected when pi starts (read from
   source), so pi takes the project at start rather than at its first call. The source also gives `"idleTimeout": 0`,
   `eager` and `lazy-keep-alive` no idle close; those three were **not run**.

## Open blockers

Each blocker keeps pi in scope. None is solved by polling.

| ID | Blocker | What would close it | Status |
| --- | --- | --- | --- |
| PI-1 | No pi reaction adapter. Tier 2 was driven by the harness here. | `adapters/pi.ts` over pi RPC, wired into #311's controller (WP2). | Open, waits for #311 |
| PI-2 | A pi session the user opened in their own terminal. pi's RPC reaches only a process the adapter started. | pi's extension API can start a turn from inside pi (`pi.sendMessage(…, { triggerTurn: true })`, `docs/extensions.md`), so a xezar pi extension could. **Documentation only**, not run. The same open question as the spike's OB-1 to OB-3. | Open |
| PI-3 | The model is not told why it was refused as the second client, and pi marks the refusal as a success. | The occupied reason needs its own path to the model (spike decision 7). For pi the adapter owns what the model sees. | Open, shared with the three |
| PI-4 (the spike's OB-5) | No real-model reaction. | A run with a real model account on the release-candidate revision, after an account decision. | Open |
| PI-5 | The capability is third-party and moves fast. 2.33.0 was published before this record was finished, and was not tested. | Pin the verified version in setup guidance, and re-run this record's scenarios on an adapter upgrade. | Open |

## Corrections and observations against earlier documents

- **#330, "Not yet run: pi against the real bridge".** Run now, and it works.
- **#330, "Expected outcome: A-17, A-18 and A-23 fail until exclusive ownership is wired".** Ownership is wired on
  `main` since #302. pi's client slices of A-17 and A-18 pass here. The whole-case verdicts belong to the
  [acceptance record](mcp-client-acceptance-record.md) and its pi column (WP5), on one candidate revision.
- **The acceptance record's A-17, A-18 and A-23 rows** still describe the revision before #302. This record does not
  change them.
- **Stale mutation shape.** The spike's stub returned `isError: true` for a conflict. The real bridge returns an
  ordinary result with `status: conflict` (U-M05). The client's job is only to carry it intact, which pi does.
- **Server pings.** The spike's stub sent one every 30 s. The real bridge sends none, so "pings answered" is not
  measured for any client against the real bridge.
- **`PI_CODING_AGENT_DIR`.** Confirmed read by pi 0.85.1 and by the adapter (#329). `packages/xezar/src/paths.ts`,
  `agent-profiles.ts`, `catalog.ts`, `AGENTS.md` and `docs/testing/agent-browser.md` still say pi has no such variable.
  #329 fixes them; this record does not.
  **Superseded 2026-09-12 by [#349](https://github.com/qodeca/xezar/pull/349):** all five files named here now
  state the variable correctly, so the "still say" sentence describes the run date and not the repository today.

## What the second half adds

Written with WP2, on the adapter's own branch, and appended below:

- the runtime runs of `adapters/pi.ts` (a journal row through the event controller to a real pi turn, idle and
  busy, a restart on the xezar side, blockers), in the shape of the other three records;
- its unit tests and their red proof;
- the adapter's delivery rules, derived from the findings above;
- the D-05 negotiation row, checked through the adapter.

Two items named here were **not** measured in the second half, and it says so where they belong: a pi
permission or question prompt (pi's RPC leg here ran with tool approval off, as a headless leader does), and a
restart on **pi's** side (only the xezar side was restarted, `R-03`). Both belong to WP5's run on a candidate
revision with `pi-mcp-adapter` loaded.

## Evidence location

The harness (`lib.mjs`, `scenarios.mjs`, `tee-proxy.mjs`), each scenario's `result.json` and transcripts, the
scripted endpoint's request log, the wire logs, the install output and a SHA-256 manifest are in this task's
private evidence folder, `.local/xezar-tasks/<runId>/pi-real-bridge/`. It is never committed. It holds no
credentials: the only key string is the dummy value in the fixture `models.json`.

**Harness defects found on the way, and how they were handled.** The first runs of four scenarios reported
FAILED for reasons in the harness, not in pi: `second` started pi with an empty tool cache; `async` stopped
reading before the queued messages arrived; `human` and `async` read text the harness had shortened for
printing; and `stale` required `isError`, a requirement copied from the spike's stub, while the real bridge
answers a conflict as an ordinary result by design. Each was
fixed, and every short scenario was then run again, together, with the final harness (18:08–18:15 UTC). The
verdicts above are from that run. The four idle scenarios ran earlier, with a harness that differed only in
those fixes and in waiting for pi's `agent_end` rather than `agent_settled` after a prompt. Their checks use
none of that. One idle probe was mislabelled in its own result: the probe
called "700s-after-last-call" in `idle-default` and `idle-keepalive` ran 440 s after the last call. A
`CORRECTION.txt` beside each result says so, and the 700 s measurement is the separate `idletimeout-*` pair.

To reproduce: build (`npm run build`), install the adapter into a throwaway `PI_CODING_AGENT_DIR` as above, then run
each scenario with `TMPDIR=/tmp node scenarios.mjs <name>`: `a01`, `wire`, `scope`, `second`, `crash`,
`idle-default`, `idle-keepalive`, `idletimeout-default`, `idletimeout-keepalive`, `fencing`, `async`, `human`,
`stale`, `lost`, `persist`.

---

# pi reaction adapter – runtime evidence (second half)

Issue: [#330](https://github.com/qodeca/xezar/issues/330), work package WP2. Covers F-20, A-19 and the § 12
delivery hierarchy for `packages/xezar/src/mcp/adapters/pi.ts`, the adapter WP1 named as blocker PI-1.

Run date: **2026-09-12**, 06:05–06:14 UTC. Revision under test: branch `xez/b074e16c`, based on
[`7bcb258`](https://github.com/qodeca/xezar/commit/7bcb258) (`main`, #311, the commit that first constructs the
event controller and the reaction adapters in the running service). Host: macOS 26.6.2 (Darwin 25.6.0, arm64),
Node v24.20.0. pi: **0.85.1** (`@earendil-works/pi-coding-agent`). These are installed versions, not certified
minimums.

## Answer first

- **The adapter is built, tested and connected, and a real pi turn carries a real journal row (EXECUTED).**
  A row appended to a real `EventJournal` went through the real `EventController`, through
  `PiReactionAdapter`, into a real `pi --mode rpc`, and pi's **first** model request carried it. No poll, no
  notification, no status turn: the request that carried the event was the only request pi made (`R-01`).
- **Both rungs of tier 2 are executed.** With pi idle, RPC `prompt` started the turn (`R-01`). With pi inside
  the person's own turn, the adapter steered, the running turn finished on its own terms, and the following
  model request carried the event (`R-02`). Real pi refuses a plain `prompt` during a turn, so the fallback is
  not optional — the adapter sends `steer` when it knows pi is busy AND falls back to `steer` on the refusal.
- **Delivery is not reaction, and it is measured that way.** `deliver` resolved with `handedThrough: 2` while
  the model had still seen nothing; `reactedSeq` moved only when pi put the text in front of the model
  (`R-02b`, `R-02e`, `R-01f`).
- **A restart does not ask the model twice.** A fresh adapter over the same pi session read pi's own
  conversation (`get_messages`), found its marker, and submitted nothing: zero extra model requests (`R-03`).
- **The production caller is `LeaderDelivery`, and today it answers with a blocker.** `POST /api/v1/mcp/leader`
  accepts `{action: 'attach', client: 'pi'}` and answers `409` with pi's own recoverable reason,
  `pi-not-addressable` (`R-04`). **This half does NOT close A-19 for pi**, and says so plainly below: pi's RPC
  is stdio-only, so no address exists for a pi the person runs in their own terminal. See
  [What this does not close](#what-this-does-not-close).
- **A real model reaction is still UNVERIFIED**, as it is for all four clients. Every turn here reached a
  scripted local endpoint. That proves pi really started a turn and really sent an inference request carrying
  the event. It does not prove what a real model decides. OB-5 / PI-4 stays open.

## What the adapter does, and why each rule exists

Derived from WP1's four findings, each re-checked here against the real binary.

| Rule in `adapters/pi.ts` | Why | Checked |
| --- | --- | --- |
| `prompt` when pi is idle | It starts a turn at once | `R-01b` |
| `steer` when pi is busy, and `steer` again when a `prompt` is refused | Real pi answers a plain `prompt` during a turn with `success: false`, "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." The fallback is what makes a stale idea of "busy" safe: pi can start a turn of its own between the check and the write | `rpc-probe`, `R-02a`, unit `a prompt refused because pi started a turn…` |
| The role instruction rides in **every** submission | pi keeps no system prompt in its session file, so `--append-system-prompt` is gone after a resume (WP1, prompt persistence: FAIL). The adapter starts no pi and cannot pass that flag, so it carries xezar's own role text in the message | `R-01e` |
| The busy flag is also corrected by the heartbeat | `agent_settled` is one line on a stream; a dropped line would otherwise make the adapter steer for ever. `get_state.isStreaming` is pi's own answer | unit `the heartbeat corrects a stale idea of "busy"` |
| Reaction is read from the **user message**, never from the `response` | Measured: pi emits `message_start`/`message_end` with the submitted text as a `user` message immediately before the model request that carries it — for an idle `prompt` and for a steered message alike — and never while the text is still in the steering queue | `rpc-probe`, `R-01f`, `R-02b` |
| Rows are remembered, and pi's conversation is re-read after a lost answer | The controller retries the same rows (at-least-once). A retry whose earlier attempt did reach pi must not start a second turn | `R-03b`, unit `an attempt pi ACTED on whose answer was lost…` |
| `heartbeat` is `get_state` | Metadata only: it starts no turn and reaches no model | `R-05` |
| It never spawns pi | xezar starts no agent process for a leader (owner decision on #311). The adapter imports neither `node:child_process` nor `node:fs`, reads no environment variable, and never names `PI_CODING_AGENT_DIR` | unit `AGENTS.md — no environment, no file writes, no process` |

## Runtime runs of the adapter (executed)

Scenario `adapter-run`. Real `pi --mode rpc` (`--offline --no-extensions --no-skills --no-prompt-templates
--no-themes --no-context-files --no-session --model scripted/scripted-model --append-system-prompt
XEZAR-ROLE-MARKER`), a pinned throwaway `HOME` **and** `PI_CODING_AGENT_DIR`, and a scripted
OpenAI-completions endpoint on `127.0.0.1` that logs every request it is sent. A "model request" is read from
the endpoint's log, never from pi.

| ID | Check | Result |
| --- | --- | --- |
| R-01a | The real `EventController` starts over the pi adapter | **PASS** (`started`) |
| R-01b | A row appended to a real journal reaches real pi, and pi's model request carries it | **PASS** (request 1) |
| R-01c | That request is the FIRST pi made — no status poll brought it about | **PASS** (1 request in total) |
| R-01d | The text names xezar as the source and says it is not an instruction or an approval | **PASS** |
| R-01e | The role instruction rode with the submission | **PASS** |
| R-01f | `reactedSeq` advanced from the observed turn, and `deliveredSeq` with it | **PASS** (`deliveredSeq: 1, reactedSeq: 1, latestSeq: 1`) |
| R-02a | A busy pi is steered and accepts it (`queue_update` carries the text); `handedThrough: 2` | **PASS** |
| R-02b | Delivery is not reaction: nothing had reached the model when `deliver` resolved | **PASS** |
| R-02c | After the running turn finished, the next model request carried the event | **PASS** |
| R-02d | The person's own turn was not cut short: its answer came back first | **PASS** |
| R-02e | The reaction was reported once, and only when the model was really asked | **PASS** (`[2]`) |
| R-03a | `piReactionTarget` over a live link answers with an adapter | **PASS** |
| R-03b | A fresh adapter over the same pi session read pi's conversation and submitted nothing again | **PASS** (0 extra model requests) |
| R-04 | With no link: the recoverable `pi-not-addressable` blocker, naming stdio and `leader_events` | **PASS** |
| R-05 | The heartbeat (`get_state`) started no turn and reached no model | **PASS** |

**Tally: 15 PASS, 0 FAIL.** Verdict `PASSED` in `adapter-run-result.json`.

**What the probe measured first.** Before a line of the adapter was written, the real RPC stream was read
(`rpc-probe`): an idle `prompt` → `response success:true`, `agent_start`, `turn_start`, a `user`
`message_start`/`message_end` carrying the text, the assistant reply, `turn_end`, `agent_end`,
`agent_settled`; a plain `prompt` during that turn → `success: false` with the busy refusal, and it never
reached the model; `steer` during that turn → `queue_update` with the text, then delivery at the next
`turn_start`. Three model requests, carrying markers 1, 2 and 4 — never marker 3, the refused prompt. The
unit tests' `FakePi` reproduces that stream and nothing else.

**The limit of this scenario.** pi ran with `--no-extensions`, so `pi-mcp-adapter` was not loaded and the
model was offered no xezar tool. That is deliberate: the adapter's own leg is "does an event start a real pi
turn carrying it", and WP1 already proved the MCP client leg (all 11 tools offered, called, answered) against
the real bridge. The two legs on ONE pi process, on one candidate revision, is **WP5's** job, and PI-04's
"the adapter's pi process still sees every Xezar tool" is therefore **not** measured here. Note also that the
process here is the harness's, not a person's: see below.

## The D-05 negotiation row, through the adapter

| Row | For the pi adapter |
| --- | --- |
| Tier 1, native MCP notification | **Not adopted.** The bridge advertises tools only (`SERVER_CAPABILITIES`, `protocol.ts`) and sends no notification; against a stub that did, none started a pi turn (#330 run A). The adapter sends none and depends on none. |
| Tier 2, programmatic session interface | **Adopted.** `prompt` / `steer` over pi's RPC (`R-01`, `R-02`). |
| Tier 3, terminal text input | **Refused.** Tier 2 works, and nothing in the module can type: it imports no `node:child_process` and simulates no keystroke (unit test). |
| Delivery vs reaction (§ 6.6) | Separate cursors, measured separately (`R-02b`, `R-02e`). |
| At-least-once redelivery (§ 6.6) | The controller retries the same rows; the adapter dedups on `<eventId>@<ts>` and on pi's own conversation (`R-03b`). |
| Echo guard (§ 6.3, F-13) | A `leader` row caused by this leader's own outstanding operation is dropped before the text is rendered; nothing else is (unit tests). |

## What this does not close

**A-19 is not satisfied for pi by this half, and no reading of the runs above should say it is.**

The runs prove the adapter works. They do not prove a person's pi leader can be reached, because the pi
process in `R-01`–`R-03` is one the harness started and whose stdin it owns. pi's RPC is **stdio-only**: pi
0.85.1 has no port, no socket and no attach mode (`pi --help`, `docs/rpc.md`), so there is no address for a pi
the person runs in their own terminal — and xezar starts no agent process for a leader (owner decision on
#311). This is the same standing Claude Code and Codex have on `main` today, for the same reason, and it is
WP1's blocker **PI-2** unchanged.

What the product does with that fact, rather than hiding it:

- `POST /api/v1/mcp/leader` accepts `{action: 'attach', client: 'pi'}` and answers `409` with
  `pi-not-addressable`: *"xezar cannot wake a pi session you run yourself: pi speaks RPC over its own stdin
  and stdout only … Events stay in the project journal and nothing is lost."* A refused pi attach never
  detaches a leader that is working.
- `GET /api/v1/mcp/leader`'s `no-leader-session` blocker now names pi alongside Claude Code and Codex.
- Nothing is lost: that leader reads its events with `leader_events` (#251), and the next session resumes
  after its last acknowledgement.

Said plainly, because an earlier draft of this record did not: **`PiRpcLink` has no producer anywhere in
the repository.** `piReactionTarget` returns `{kind: 'rpc'}` only when a `link` is passed, its one production
caller (`leader-delivery.ts`, on `{action:'attach', client:'pi'}`) passes none, and `PiReactionAdapter` is
therefore never constructed outside tests and the evidence harness. `renderPiDispatch`, `deliver`,
`heartbeat`, `close`, the steer rung and the never-twice logic are all unreachable in production today. The
one thing that IS live is the `pi-not-addressable` blocker string.

## What would produce a link

Asked properly after the QA on #358, and the answer is **not** "pi cannot do it". Three routes were checked
against the binary and the packages installed on this host; only the third works, and nothing blocks it but
an artifact xezar does not ship.

| Route | Verdict |
| --- | --- |
| **Dial pi's RPC**, the way `opencode` is dialled | **NO.** `pi --help` and `docs/rpc.md` on 0.85.1: RPC is stdio-only and spawn-only. No port, no socket, no attach, no `--host`. Both worked examples in `rpc.md` spawn pi as a subprocess. There is nothing to connect to. |
| **Through the MCP connection xezar already has**, via `pi-mcp-adapter` 2.32.1 | **NO for any protocol message.** The package has exactly two `pi.send*` call sites. `prompts.ts:322` sits inside a slash-command handler — a human types `/mcp__<server>__<prompt>`. `init.ts:195` is reached only from `ui-session.ts`, i.e. an MCP-UI app page. `elicitation/create` ends in a dialog and returns a result (`elicitation-handler.ts`); `sampling/createMessage` calls a model on a side channel that the agent's own conversation never sees (`sampling-handler.ts`); every `notifications/*` refreshes a catalogue or pokes an open UI window. A server can make a slash command APPEAR; it cannot run it. (One narrow exception — a tool carrying `_meta.ui.resourceUri`, whose server-authored page can post a prompt with no gesture — needs a live browser window, dies 60 s after it closes, and is off under `MCP_UI_VIEWER=none`. Not a basis for A-19.) |
| **A xezar-shipped pi extension** connecting out to xezar | **YES, and this is the route.** `ExtensionAPI.sendUserMessage(content, {deliverAs?})` is documented "**Always triggers a turn**" (`dist/core/extensions/types.d.ts:975-983`, `docs/extensions.md:1439-1467`). Extensions are plain ESM loaded through jiti with **no sandbox** (`loader.js`; `docs/security.md` § No Built-in Sandbox), so `node:net`/`node:http`/`fetch` are all available — and `pi-mcp-adapter` already opens a Unix socket and runs an HTTP server in-process. The extension API also covers what this adapter needs: `ctx.isIdle()`, `ctx.hasPendingMessages()`, `pi.on('agent_start'|'agent_settled'|'message_start'|'message_end', …)` and `ctx.sessionManager` for the conversation. |

So the gap is an **artifact, not a capability**: xezar ships no pi extension and exposes no endpoint for one
to connect to. Building it is a work package of its own — an extension plus its packaging, a xezar-side
listener, attach parameters in the contract, and setup guidance on the pi card — which crosses the files WP3
and #264 own. The adapter is deliberately transport-free so such a link drops straight in:
`piReactionTarget({ link })` already answers with a working adapter, which is what `R-03a` exercises.

One mapping caveat for whoever builds it: the extension API has **no `queue_update` event** (it is RPC-only);
`ctx.hasPendingMessages()` is the substitute, and the parked-steer guard below depends on that signal.

## The parked steer: a measured correction to this record

The first version of this record said the refusal fallback "is what makes a stale idea of `busy` safe". That
was true in one direction only, and the QA on #358 found the other. Re-measured here against real pi 0.85.1
with no xezar in the loop (`pi-idle-steer/idle-steer.mjs`, result in `result.json`):

| Step | Observed |
| --- | --- |
| pi idle before | `isStreaming: false`, `pendingMessageCount: 0`, 0 model requests |
| one `steer` into that idle pi | `{"success": true}` — **0 model requests**, **no `agent_start`**, one `queue_update`, `pendingMessageCount` 0 → **1** |
| the person then types something of their own | 1 model request, and it **carries the steered text** |

So a `steer` into an idle pi is **accepted and parked**, and `success: true` is acceptance, never hand-over.
The row is not lost — it reaches the model when a human next acts, which is exactly the outcome A-19 exists
to prevent. Two consequences, both now fixed:

- **`#submit` confirms a believed `busy` against pi (`get_state`) before steering**, and an unreadable state
  deliberately guesses "idle" and prompts: a prompt into a busy pi is refused and recovers on the spot,
  while a steer into an idle pi parks in silence. When failure modes are asymmetric, guess towards the
  recoverable one.
- **A steer that turns out to have parked is not reported as handed over.** pi delivers steering at the end
  of the running turn, so "idle now" alone is ambiguous — `pendingMessageCount > 0` with nothing running is
  the unambiguous half. The row then rejects, the controller retries it, and the retry takes the `prompt`
  rung.

The unit double was wrong in exactly this branch, which is why the suite was green over the bug: `FakePi`
started a turn on a steer into an idle pi. It now parks, reports `pendingMessageCount`, and surfaces the
queue whenever a turn starts. **A test double that is kinder than the real thing does not test, it
reassures** — that lesson is worth more than this fix.

**One honest cost, found by the corrected double rather than reasoned about.** Once the double drained the
steering queue on a turn start — which is what real pi does — the retry-after-parking test went red and
showed the event text reaching the model **twice in one request**: the parked copy surfaces alongside the
re-sent one. That is one turn, one reaction and one `handedThrough`, with the content repeated. It is kept,
because the alternative is worse in both directions: leaving the row parked loses the autonomy A-19 is
about, and retracting the parked copy means `clear_queue`, which would also discard the PERSON's own queued
messages. A model reading the same event block twice is benign; a leader that does not react until a human
types is not.

## Tests and red proof

`packages/xezar/src/mcp/adapters/pi.test.ts`: 41 tests. `leader-delivery.test.ts` gains two for the pi attach
path. Coverage from the MCP suites alone: `pi.ts` **100 % lines, 90.98 % branches**; `leader-delivery.ts`
**95.83 % lines, 84.05 % branches** — both over the 80 / 80 floor.

Each new test was proven RED against a named break in the source it guards. Every run checked
`git status --porcelain` for an `M` on the edited file BEFORE trusting the result, then restored it.

| Break | What was broken | Result |
| --- | --- | --- |
| B1 | Always `prompt`, never fall back to `steer` | RED |
| B2 | Report the reaction from pi's `response` instead of the observed turn | RED |
| B3 | Forget every submitted row | RED |
| B4 | Never read pi's own conversation | RED |
| B5 | Treat an attempt that threw as certain | RED |
| B6 | Build an adapter with no link | RED |
| B7 | Drop the echo guard | RED |
| B8 | Detach the working leader before refusing a pi attach | RED |
| B9 | Trust `#busy` and steer without confirming it (the bug the QA found) | RED — direction A's row never reached the model (`modelRequests: []`), and the parked-steer test resolved `{handedThrough: 1}` instead of rejecting |

One test is a **guard**, green with and without B9's fix, and labelled as such in the source: direction B
(believes idle, pi really busy). It pins the half of the race that was already safe, so that repairing the
other half cannot quietly break it. Its passing is not evidence the fix works — direction A's is.

B5 is not a hypothetical: the adapter really did clear its "uncertain" flag in a `finally`, and the test
written for a lost answer found it before the first green run.

## Open blockers, after this half

| ID | Blocker | Change |
| --- | --- | --- |
| PI-1 | No pi reaction adapter | **Half closed, and the wording here was wrong before (QA on #358).** `adapters/pi.ts` exists and is tested, and `LeaderDelivery` is wired to build it — but only from a live `PiRpcLink`, and **nothing in the repository produces one**, so `PiReactionAdapter` is never constructed in production. What runs today is the `pi-not-addressable` blocker. The adapter is not "connected" until PI-2 is closed. |
| PI-2 | A pi session the person opened in their own terminal cannot be reached | **Open, and the only thing between pi and A-19.** Re-confirmed against 0.85.1 twice (`pi --help`, `docs/rpc.md`): RPC is stdio-only and spawn-only — no port, no socket, no attach. **But it is not a pi limitation.** pi's extension API exposes `sendUserMessage`, documented as "Always triggers a turn"; extensions are unsandboxed and may open sockets; and the already-required `pi-mcp-adapter` does both today. A link is therefore buildable — it needs a xezar-shipped pi extension, which is an artifact this PR does not add. See § "What would produce a link". |
| PI-3 | The model is not told why it was refused as the second client | Open, shared with the three. Untouched here. |
| PI-4 (OB-5) | No real-model reaction | Open, shared with all four. Untouched here. |
| PI-5 | The capability is third-party and moves fast | Open. This half needed no `pi-mcp-adapter`; WP5 does. |

## Evidence location

The probe (`probe.mjs`), the scripted endpoint (`scripted-model.mjs`), the adapter run (`adapter-run.ts`), the
red proof (`red-proof.sh`), their logs and `adapter-run-result.json` are in this task's private evidence
folder, `.local/xezar-tasks/<runId>/pi-adapter/`. It is never committed. It holds no credentials: the only key
string is the dummy value in the fixture `models.json`. The real `~/.pi` was never read or written — both
`HOME` and `PI_CODING_AGENT_DIR` were pinned to throwaway folders for every pi process, and every process the
harness started was stopped by its own saved handle, never by a command-line pattern.

To reproduce: `TMPDIR=/tmp node --import tsx adapter-run.ts` (real pi on `PATH`), and
`bash red-proof.sh` for the red proof.
