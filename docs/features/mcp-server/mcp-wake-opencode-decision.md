# OpenCode: waking a running leader — decision record

Status: **spike decision record with executed evidence**. It answers the OpenCode leg of
[#374](https://github.com/qodeca/xezar/issues/374) (epic [#73](https://github.com/qodeca/xezar/issues/73)):
what is really missing for a project event to wake a running OpenCode leader, and how to close it. It
ships **no production code**; the fixture and driver scripts that produced the evidence stay out of this
commit. The Codex leg ([`mcp-wake-codex-decision.md`](mcp-wake-codex-decision.md)) and the Claude Code leg
(`mcp-wake-claude-code-decision.md`, PR [#401](https://github.com/qodeca/xezar/pull/401), not yet merged)
are separate records; this one follows their shape.

Date: **2026-09-13**. Repository revision: `dc4784ab566b90b7aef7b5a35786af3223e414a9` (branch `xez/c3d056aa`).
Host: macOS 26.6.2, arm64, Node v24.20.0. Installed client: `opencode --version` → **1.18.30**, from
`/Users/marcinobel/.opencode/bin/opencode` — the same version D-05, the spike report and
`mcp-adapter-evidence-opencode.md` already measured. This is the installed version, not a certified
minimum.

## Answer first

- **OpenCode is not a research question the way Claude Code and Codex are — it already has a shipped
  wake path.** Unlike those two clients, OpenCode already has: a contract-level attach action
  (`packages/contract/src/mcp-leader.ts:31-38`, `client: 'opencode'` with `baseUrl` + `sessionId`), a
  production `LeaderDelivery.#act` branch that constructs a real `OpenCodeReactionAdapter`
  (`packages/xezar/src/mcp/leader-delivery.ts:406-424`), and a real adapter
  (`packages/xezar/src/mcp/adapters/opencode.ts`) that calls `POST /session/:id/prompt_async`. This
  spike re-measured that path on the current revision and it still works: one journal row produced one
  model turn, observed **178 ms** after delivery, and the endpoint saw **exactly two requests in total**
  for the whole run — the event turn and OpenCode's own automatic session-title request — with **zero**
  further requests in a 30 s quiet window (§ 2).
- **What is actually missing is not the wake mechanism. It is discovery and the cockpit surface.** The
  attach route needs a `baseUrl` and a `sessionId` that xezar has no way to learn on its own today, and
  the cockpit has no field or button to enter them — `mcp-connection-section.tsx` only explains the
  one-time MCP-server setup, never the attach action (§ 3). A user must call the API by hand.
- **A plain `opencode` (the ordinary interactive TUI a person just starts) exposes no server xezar could
  ever dial.** Executed here: with no `--port`, the TUI process opens no listening TCP or Unix socket at
  all (confirmed by `lsof` on its own PID, twice). Only when `--port` is passed explicitly does the same
  process become a real, curl-reachable HTTP server — and even then it prints no "listening on" line
  anywhere a script could read it back, unlike `opencode serve` (§ 2.3). This closes OC-1's "whether a
  plain `opencode` TUI exposes such a server" as **UNVERIFIED → verified negative**, for the default case.
- **`opencode attach <url>` is a thin, same-process-free client of an existing `opencode serve`,** not a
  second server and not a second session universe: it added one child process, no new listener, and the
  session list on the server was unchanged before and after. But it does **not** land the user on the
  session xezar is driving — it opens its own "new session" composer, so a person who attaches would not
  see the leader's turn unless they explicitly switch to that session (§ 2.3). This is the concrete
  answer to "is the interactive TUI the same session xezar wakes": **yes, when attached to the right
  server, technically the same session is reachable — but nothing points the user at it.**
- **#340 ("`reactedSeq` under-reports") is unchanged at this revision and is why OpenCode is still
  `BLOCKED` on A-19/A-23 despite having a working wake path.** Both causes were re-confirmed by reading
  today's source, not by assuming the old issue still holds (§ 2.4). Closing #340 is the same wiring as
  making the attach experience usable — see § 4.
- **Go, with a scoped implementation task**, sized in § 4. It is materially smaller than the Codex and
  Claude Code tasks: there is no new transport, adapter or contract shape to build, only discovery,
  the cockpit surface, and the #340 fix.

## 1. Inventory: what exists today

**Attaching an OpenCode leader, as a user, today.** Read from source, cross-checked against the running
service in § 2:

1. One-time MCP setup (unchanged from D-04, § 3.3): add the `mcp.xezar` block to the project's
   `opencode.json` so OpenCode can call xezar's tools. This has nothing to do with the leader wake path —
   it is how OpenCode reaches xezar, not how xezar reaches OpenCode.
2. Start `opencode serve` (a headless server) or run the ordinary interactive `opencode` **with an
   explicit `--port`** (§ 2.3 — the bare default does not expose a server at all).
3. Call `POST /api/v1/mcp/leader` by hand: `{ "action": "attach", "client": "opencode", "baseUrl":
   "http://127.0.0.1:<port>", "sessionId": "<ses_…>" }` (`packages/contract/src/mcp-leader.ts:31-38`).
   **There is no cockpit control for this.** `packages/web/src/routes/settings/mcp-connection-section.tsx`
   documents the per-client one-time setup (step 1) for all four clients, including OpenCode, but the
   file contains no call to the attach route and no field for `baseUrl` or `sessionId` — confirmed by
   reading the whole file, and by grepping the cockpit source tree for the route path (only unrelated
   `sessionId` usages in `task-thread`/`task-git` components matched). The user's only way to attach is
   the API.
4. `GET /api/v1/mcp/leader` reports the attached client and delivery status
   (`server.ts:5608`, `mcpLeaderStatus`), but the cockpit's connection section never calls it — `§294` of
   that file documents that the *live owner state* is deliberately not surfaced yet ("no HTTP route
   exposes it") even though this specific route already exists for OpenCode's case.

**What `OpenCodeReactionAdapter` sends.** Read from source, `packages/xezar/src/mcp/adapters/opencode.ts`:
tier 2 of the § 12 delivery hierarchy, `POST /session/:id/prompt_async`, with `system` (xezar's role
instruction, re-sent on every message), `tools: {'*': false, 'xezar_*': true}` (so the reacting turn can
only call xezar's own tools, never the user's `bash`/`edit`), and one text part carrying the event
summaries plus a `metadata.xezar` marker. It waits for the session to be idle with no pending permission
or question before sending (`#waitUntilSafe`), and never types into the TUI's prompt box.

**How the reaction is observed.** The adapter opens OpenCode's `/event` SSE stream once and watches for
`message.part.updated` carrying its own marker, then the paired `message.updated` (role `assistant`,
`parentID` equal to the marked message) — that pairing, not the `204` from `prompt_async`, is what calls
`onReaction` (`opencode.ts:473-496`). `leader_events`'s own `position.reactedSeq` is a **different**
counter, advanced only by `LeaderCursors.markReacted()` (`reconnect.ts:214`) — a method with no production
caller anywhere in `packages/xezar/src` outside its own definition and tests (`grep 'markReacted('`,
re-run at this revision, same empty result #340 reported).

**Why the Definition-of-Done record still lists OpenCode `BLOCKED` for A-19/A-23.** Reading
`mcp-definition-of-done-record.md` rows A-19/A-23 (`ed579e63`) closely: the row that groups
`claude-code, codex, opencode` together under "no attach path exists for these clients ... the contract's
`client` enum admit `opencode` and `pi` only" is **imprecise for OpenCode specifically** — the enum
*does* admit `opencode` (confirmed in the contract file quoted above, present in that same revision per
`git log` on `leader-delivery.ts`), so an attach path genuinely exists. The real reason OpenCode cannot
pass A-19/A-23 today is **#340**: with `reactedSeq` under-reporting, the harness that produced that DoD
run could not certify a reaction the same way it could for pi. This spike does not change the DoD verdict
— OpenCode is still correctly `BLOCKED` — but the *reason* recorded for it should say "#340", not "no
attach path", the day that table is next touched.

## 2. Measurement

### 2.1 Fixture

Isolated, never the developer's real OpenCode state:

| Piece | Value |
| --- | --- |
| `opencode serve` | `--hostname 127.0.0.1 --port 0`, cwd = the fixture's own `git init` project |
| Isolation | `env -u XDG_CONFIG_HOME -u XDG_STATE_HOME -u XDG_CACHE_HOME HOME=<scratch>/home OPENCODE_CONFIG_DIR=<scratch>/cfg XDG_DATA_HOME=<scratch>/data` |
| Model | A scripted stand-in for the Anthropic Messages API (streaming), `127.0.0.1:50311`, logging every request with a wall-clock timestamp |
| Provider | Project `opencode.json`: `provider.scripted` → `@ai-sdk/anthropic`, `baseURL` at the scripted endpoint, dummy API key string (not a credential) |
| Adapter under test | The REAL `OpenCodeReactionAdapter` class, imported unmodified from `packages/xezar/src/mcp/adapters/opencode.ts` at this worktree's revision, run with `node --import tsx/esm` (`TMPDIR=/tmp`, because this task's own `TMPDIR` is 86 characters long and tsx's IPC pipe under it exceeds the Unix socket path limit — the same class of failure the Codex decision record hit with `CODEX_HOME`) |
| Confirmed isolated | `GET /path` reported `home`/`state`/`config` all under the scratch home; `GET /global/health` answered `{"healthy":true,"version":"1.18.30"}` — the same version as the developer's real install, but a throwaway process |

`GET /path` also showed `config` resolves from `HOME/.config/opencode`, not from `OPENCODE_CONFIG_DIR`
directly — consistent with D-04 § 8.4's finding that `OPENCODE_CONFIG_DIR` alone does not isolate OpenCode
and `HOME` is what actually does it.

### 2.2 R-01 equivalent: one event, one turn, one quiet window — Executed

```text
ms=0    start            baseUrl=http://127.0.0.1:4096 sessionId=ses_f648187fbffelQ64AImxIoGfay
ms=30   deliver.resolved status={route: prompt_async, submittedRows: 1, turnsAwaited: 1}
ms=178  adapter.onReaction seq=1
ms=230  after.wait       reactions=[{seq:1, ms:178}] status={submittedRows:1, turnsAwaited:0}
```

Cross-checked independently at the model endpoint (not through the adapter's own bookkeeping):

```text
request 1  atMs=…664   system="You are a title generator…"      lastText contains the xezar event text
request 2  atMs=…551   system="You are opencode, an interactive CLI tool…"   lastText = the xezar event text only
```

Two requests, not one: OpenCode auto-generates a session title from the first message a session ever
receives, exactly the same overhead class the Codex decision record measured for an unnamed thread. The
title request is not a second reaction and did not carry any additional xezar text after the first. After
a held **30 s** quiet window (a real `sleep`, not a race), the request count was still exactly **2**, and
`GET /session/:id` for the session showed the reply's own text (`SCRIPTED_WAKE_ACK`) had become the
session's title. `GET /session/:id/message`, read independently of the adapter, showed exactly one user
message and one assistant message with `parentID` pointing at it — the same pairing the adapter's
`#observeTurn` uses, confirmed from a second vantage point.

**Not carried over from the earlier evidence record on purpose:** that record's own reaction test (R-01)
was run at a different revision (`c1ffa95`/`772f2a7`) with a fixture journal, controller and owner slot
wired around the adapter. This measurement drives the adapter directly with one dispatch, which is enough
to answer "does the wake mechanism still work at `dc4784a`", and does not re-prove the controller wiring
that record already covers.

### 2.3 The attach experience — Executed, new evidence not in the prior records

**`opencode attach <url>` is a thin client, not a second server.** Before: two processes existed
(`opencode serve`, the scripted endpoint). After running
`opencode attach http://127.0.0.1:4096` inside a `script -q` pty and letting it render for 4 s: exactly
one new process appeared (the attach client itself, child of the pty), no new listening port appeared
anywhere on the host, and `GET /session` on the server still listed exactly the one session created
earlier — the attach TUI created no session of its own merely by opening. Its composer showed "New
session" rather than the leader session's own transcript, i.e. **attach does not default to the session
xezar is talking to** — a person would need to switch sessions inside the attached TUI to watch the
reaction happen.

**A plain `opencode` (no flags) opens no reachable server at all.** Launched the same way, in the same
project, with no `--port`: `lsof -p <its own pid>`, checked twice with a fresh launch each time, showed
character-device (tty), kqueue, log-file, sqlite and one *connected* (not listening) Unix socket file
descriptors, one outbound TCP connection (`…->140.82.121.5:443`, consistent with an update check), and
**no `LISTEN` socket of any kind**. `--port` defaults to `0` in `opencode --help`'s text, but the observed
behaviour for the bare/default command is "bind nothing", not "bind an OS-chosen ephemeral port".

**Passing `--port` to the same bare command does open a real server, in the same process.**
`opencode --port 48219 --hostname 127.0.0.1 --print-logs` (still the interactive TUI, not `serve`): `lsof`
on its pid showed a genuine `LISTEN` on `127.0.0.1:48219`, and `curl http://127.0.0.1:48219/global/health`
answered `200 {"healthy":true,"version":"1.18.30"}` from a second, independent process. **But this
process's own log output never printed the URL or port anywhere** — no "listening on" line the way
`opencode serve --print-logs` prints one. A user (or a script) that did not already choose and remember
the port has no way to read it back.

**No discovery file exists.** Searched the entire isolated `XDG_DATA_HOME` and `HOME/.local` tree after
every run above for anything resembling a port, pid or socket descriptor (the kind of file pi's leader
extension writes, `pi-leader.json`): none exists. OpenCode persists a sqlite database, a log file and a
git-shadow "snapshot" directory — no connection descriptor of any kind.

### 2.4 #340, re-checked against this revision — Read from source

Both causes named in [#340](https://github.com/qodeca/xezar/issues/340) were re-read against
`dc4784a`, not assumed carried over:

1. **`deliver()` still opens the `/event` feed before it learns the session's directory.**
   `opencode.ts`'s `deliver()` calls `await this.#openFeed(signal)` first, then
   `await this.#checkSession(target, signal)` — and only `#checkSession` sets `this.#directory`, which is
   what `#call` uses to add `?directory=` to every OpenCode request (`opencode.ts:203-215`, `:292-312`,
   `:378-391`). The order is unchanged from what #340 described. This measurement's own successful run
   (§ 2.2) does not contradict #340: `opencode serve` was started **inside** the project directory, which
   is exactly the case #340's own evidence (`mcp-adapter-evidence-opencode.md` R-01) also measured as
   working. #340's failure case — `opencode serve` started **outside** the project directory it is
   serving — was not re-driven live in this spike (time-boxed; the fix is a one-line reordering, not a
   design question, and the original issue's repro is not in doubt).
2. **`LeaderCursors.markReacted()` still has no production caller.** `grep 'markReacted(' packages/xezar/src`
   (tests excluded) finds only its own definition at `reconnect.ts:214`, same as #340 reported. So
   `leader_events`'s `position.reactedSeq` still cannot be trusted as a reaction signal — only the
   status route's `delivery.reactedSeq` can, and only for the client actually attached.

Both are still open, and neither is a new problem this spike introduces.

## 3. What is missing for zero-config

AGENTS.md § Zero config: discover or default, never ask the person to paste an address as the *only* way.
Three concrete gaps, from § 1 and § 2 above:

1. **No discovery of a running `opencode serve`.** There is no port file, no known process-list pattern
   (an `opencode serve` process's argv carries no project-identifying information beyond its cwd, and a
   bare `opencode` with `--port` looks identical to `serve` in argv only if the user chose to pass one),
   and no config-driven default. The honest options are: (a) tell the user to run `opencode serve` (which
   *does* print its URL) rather than a bare `opencode --port <N>` (which does not), and have xezar scan
   `ps` for an `opencode serve` process whose cwd matches the project root, reading the port from its own
   stdout if xezar started watching before it printed, or by probing a small set of candidate ports
   against `GET /global/health` plus `GET /path` (`directory` must match); or (b) ask OpenCode upstream for
   a discovery file the way pi's ecosystem convention already exists for extensions. (a) requires no
   upstream change and fits this repository's existing "never ask for a port" bar for pi.
2. **No session picker.** Even with a `baseUrl`, xezar needs a `sessionId`, and `GET /session` on that
   server lists every session for every directory it has ever served, not just this project's. The
   existing adapter already refuses a session in the wrong directory (`wrong-project` blocker) — the
   missing piece is a cockpit-side call to `GET /session`, filtered to `directory === projectRoot`, most
   recently updated first, presented as a pick rather than a paste.
3. **No cockpit attach control.** `mcp-connection-section.tsx` needs an "Attach" action for OpenCode
   specifically (pi already needs none, by design — § 1). Proposed copy, following the connected/blocked
   pattern the Codex decision record proposes for its own client:
   - Connected: **"OpenCode connected. Project events can start a turn in the attached session."**
   - No reachable server found: **"xezar found no running `opencode serve` for this project. Start
     `opencode serve` here, then attach the session you want to lead from."**
   - Server found, no session picked: a list of this project's sessions on that server, newest first.

None of this needs OpenCode to change. It needs xezar to look, not ask, for what it can already read
(process list, `/global/health`, `/path`, `GET /session`), and to make the one thing a person must still
choose (which session) a click instead of a curl command.

## 4. Go / no-go, and one feature-implementation task

**Go.** OpenCode is closer to "fully supported leader client" than any other client in this epic: the
transport, the safety rules (idle/permission/question gating, tool restriction, echo guard, replay
dedup) and the contract shape are already shipped and were re-confirmed working at this revision (§ 2.2).
What remains is discovery, the cockpit surface, and one recorded bug — none of it a new mechanism.

**Scope for one feature-implementation task:**

1. **Discover.** A best-effort scan for a reachable `opencode serve` bound to this project: enumerate
   `opencode serve` processes (never by command-line pattern kill — a search, not a signal), read
   candidate ports from an already-open `--print-logs` capture when xezar started the process itself, or
   probe a bounded list of recently-seen ports; confirm with `GET /global/health` then `GET /path`
   (`directory` must equal the project root, cheap and already how the adapter validates a session).
   Never guess a port from the model or accept one from an untrusted source. A miss is the existing
   recoverable `no-target` blocker, not a hang.
2. **Pick.** `GET /session` on a discovered server, filtered to this project's directory, surfaced in the
   cockpit as a list (§ 3.2) rather than requiring the person to already know a `ses_…` id.
3. **Attach, from the cockpit.** Wire `POST /api/v1/mcp/leader` (`client: 'opencode'`) behind the picker
   in `mcp-connection-section.tsx`; no contract change, since the route and schema already exist.
4. **Fix #340, both causes**, in the same task since the reaction signal this feature depends on is the
   one #340 says under-reports:
   - Reorder `deliver()` so `#checkSession` (and therefore `this.#directory`) runs before `#openFeed`, or
     have `#openFeed` re-open once the directory is known, so the very first `/event` stream is scoped
     correctly regardless of where `opencode serve` was started relative to the project.
   - Give `markReacted()` a production caller wherever `leader_events` reports `position.reactedSeq`, so
     that number and the status route's `delivery.reactedSeq` agree, or stop `leader_events` from
     reporting a number it never advances.
5. **Do not touch:** the adapter's transport (`prompt_async`), its safety rules, the contract's attach
   schema, or pi's path. None of them needs to change for this task.

| Acceptance criterion | Verification, mapped to the DoD rows |
| --- | --- |
| xezar finds a running `opencode serve` bound to this project without the user pasting a URL, or reports the recoverable blocker when none is reachable | Real `opencode serve` + real cockpit integration test, including the miss case (no server, wrong-directory server, closed port). **A-23 setup.** |
| The cockpit lists this project's sessions on a discovered server and attaches the chosen one | Real service + cockpit test asserting the attach POST reaches `LeaderDelivery.#act` with the right `sessionId`. **A-23 exclusivity/usable setup.** |
| A real project event still causes exactly one model turn end to end, through the cockpit-driven attach rather than a hand-typed curl | Re-run of § 2.2's measurement through the new attach path: one event POST at the endpoint, zero further in a 30 s quiet window. **A-19 F2/F3 reaction.** |
| `reactedSeq` agrees between the status route and `leader_events`, regardless of where `opencode serve` was started relative to the project | Fixture reproducing #340's outside-the-project case, red before the fix, green after; `leader_events` and status polled side by side. **A-19 recovery; closes #340.** |
| Existing safety rules (idle/permission gating, tool restriction, echo guard, replay dedup) are unaffected | The adapter's existing 31-case test suite (`opencode.test.ts`) stays green with no rule weakened. |

This task can close **#340** as the same wiring, since the reordering and the `markReacted()` caller are
exactly its two causes. It does **not** by itself flip A-19/A-23 to PASSED release-wide: those clauses
require all four clients to pass together with a real model account (`mcp-definition-of-done-record.md`
clause 2), and the real-model clause stays open for every client, OpenCode included, until that is run
separately and authorized.

## 5. Evidence

Durable evidence root, resolved via `.xezar/checks/lib/common.sh` (`task_evidence_dir`):

```text
/Users/marcinobel/Projects/xezar/.local/xezar-tasks/c3d056aa-c10c-4450-bf01-b66541d04691/opencode-wake/
```

| File | What it is |
| --- | --- |
| `scripted-endpoint.mjs` | The scripted Anthropic-Messages-API stand-in, request log with timestamps |
| `drive-adapter.mjs` | Drives the real, unmodified `OpenCodeReactionAdapter` from source |
| `drive-r01.json` | The driver's own transcript (§ 2.2) |
| `endpoint-requests.json` | The two model requests the scripted endpoint received, full bodies |
| `serve-inside.log` | `opencode serve --print-logs` output for the fixture server |
| `session-messages.json`, `sessions-after-attach.json` | Independent cross-checks read directly from the server's own API |
| `attach-tui.typescript`, `bare-tui*.typescript` | Raw pty captures of the attach and bare-TUI experiments (§ 2.3) |
| `project/opencode.json` | The fixture project's provider/agent config |
| `SHA256SUMS` | Hashes of every file above |

No personal account, credential or real `~/.opencode`/`~/.config/opencode` state was read or written —
every run pinned `HOME`, `OPENCODE_CONFIG_DIR` and `XDG_DATA_HOME` to scratch directories, verified via
`GET /path` before any turn ran. The scripted endpoint's API key is the literal string
`dummy-not-a-credential`. Processes were stopped by their own saved PIDs (`kill "$PID"`), and pty children
by `kill`/`pkill -P` on the pty's own pid — no command-line-pattern kill was used, in line with this kit's
standing rule about `.xezar` skill text appearing in every peer agent's argv.

This is the **Update docs** stage. Focused validation here checked this record's links, the evidence
hashes above, and the request counts quoted in § 2 against the retained logs. Full gates, sealing and the
draft PR belong to the subsequent workflow stage; the PR body must say `Part of #374` and `Part of #73`,
not a closing keyword.

Dogfooding observations, at the evidence levels `.xezar/docs/dogfooding.md` asks for: **observed** — a
task-scoped `TMPDIR` broke `tsx`'s own IPC pipe the same way a long `CODEX_HOME` broke a Unix socket path
in the Codex decision record, worked around with `TMPDIR=/tmp` for the driver process only; **executed**
— the wake path, the attach/bare-TUI process and socket behaviour, and the #340 source re-check;
**unknown** — a real model's reaction, and whether the DoD table's row wording for OpenCode was a
one-time slip or reflects something this spike did not see.
