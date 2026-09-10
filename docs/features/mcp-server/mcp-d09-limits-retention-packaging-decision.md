# D-09 – operational limits, retention and packaging

Spike record for [#84](https://github.com/qodeca/xezar/issues/84) (Phase 2, [#69](https://github.com/qodeca/xezar/issues/69); epic [#67](https://github.com/qodeca/xezar/issues/67)). Decision date **2026-09-10**, against `main` at `057ea48`.

This is a **spike**. It records a decision and its evidence and ships no production surface. Nothing here is implemented. No prototype code is committed; the throwaway measurement script stayed in the task's temporary directory.

It closes row **D-09** of [§ 10 Open decisions](mcp-project-leader-requirements.md#10-open-decisions) and serves **N-06**, **N-07** and **F-17**. Its job is to be **the one place the MCP feature's numbers are written down**. An implementing issue that needs a bound cites a `B-` row below. It does not pick its own.

## How to read the labels

The requirements document keeps a three-way split, and this record keeps it:

| Label | Meaning |
| --- | --- |
| **Agreed** | Settled in the requirements document. Not reopened here. |
| **Decided here** | This spike's answer to something the document left open. |
| **Adopted** | A value that already exists in source, or that a sibling D-record decided with its own evidence. This record does not re-decide it; it writes it down in the shared table. |
| **UNRESOLVED** | No measurement could fix it. Named, not guessed. |

Evidence labels:

| Label | Meaning |
| --- | --- |
| **Executed** | A program ran on the host in § 6 and the number is its output. |
| **Documentation** | Read from an official vendor page on 2026-09-10. Not a working integration. |
| **Source** | Read from this repository at `057ea48`, file and line cited. |
| **Peer record** | Executed and recorded by a sibling spike, read from its task branch on 2026-09-10, **not re-run here**. |
| **Reasoning** | Derived from the cited facts; no experiment exists for it. Said so every time. |

Absence claims are scoped: "not found in the files examined".

## 1. What is agreed and not reopened

- **Agreed** (F-17): version one is local-only. Client and xezar run on one machine. No remote exposure is packaged.
- **Agreed** (N-06): reads are bounded and paginated. Significant events are pushed without continuous model polling. Non-model heartbeat, reconnect, acknowledgements and bounded recovery are allowed.
- **Agreed** (N-07): MCP must not block ordinary cockpit startup. Deleting recoverable connection state, or having no client, degrades to a working xezar. No new manually maintained file, no database, no fixed port.
- **Agreed** (§ 9): numeric limits are engineering decisions, and no number may make isolation, idempotency, stale-write rejection, task survival, compatibility or asynchronous reaction optional.
- **Agreed** (`AGENTS.md` § Zero config): never trade a working default for a knob. A `XEZ_*` flag is only for a feature that widens exposure or cost, and is off by default.

## 2. Decision summary

1. **Every bound has a working default and none is a new knob.** Every row in § 3 is a constant or an existing Settings key. **No `XEZ_*` variable is introduced**, so `.env.example` and the README env table do not change (§ 5.3).
2. **MCP reads are budgeted in bytes as well as in items**, because the cockpit's existing caps are sized for a browser, not for a model's context window. The MCP task list, which the cockpit does not paginate at all, is paginated (B-01 to B-05).
3. **No synchronous MCP call may outlive the shortest documented client tool timeout.** Every action whose existing service path can take longer is accept-then-event (B-08, B-09).
4. **Retention of the new MCP state is bounded and deletable**: the event journal and the operation receipts use the values their own records measured. Audit retention is **UNRESOLVED** as a number; its mechanism and floor are decided (B-19 to B-23).
5. **The local surface is a same-user Unix socket and nothing else.** No port, no TCP listener and no remote packaging are added (B-34, § 5).
6. **The bridge ships as `xez mcp` inside `@qodeca/xezar`, with no new runtime dependency.** The official MCP SDK was measured and rejected for version one (B-35, § 5.4).

## 3. The table – every bound, limit and retention value

"Overridable" means a user can change it without editing code. "No" means a constant; tests reach it through a constructor option, the way `ws.ts` takes `heartbeatMs`, never through the environment.

| # | Bound | Default | Unit | Basis – measurement or reasoning | Overridable | Status |
| --- | --- | --- | --- | --- | --- | --- |
| **Reads and payloads** | | | | | | |
| B-01 | MCP tool-result budget (serialized result content of one tool call) | **40 000** | bytes, UTF-8 | A D-05 journal page (100 rows × 399 B = 39 900 B, **peer record**) fits; a raw transcript window does not – worst 100 consecutive events in real transcripts reached **567 209 B**, and one single event **123 684 B** (**executed**, E2). Claude Code warns above **10 000 tokens** and saves results above **25 000 tokens** to a file (**documentation**). The token equivalence of 40 000 bytes is **UNRESOLVED** (U-1). | No | Decided here |
| B-02 | Items per page for any MCP list or history read | **100**, whichever of B-01 and B-02 is reached first ends the page. A caller may ask for fewer, never more | items | `RUN_HISTORY_PAGE_ITEMS = 100` (`packages/contract/src/events.ts:31`, **source**); D-05 N2 reuses it (**peer record**). No second page size is added | No | Adopted |
| B-03 | One item larger than B-01 | Split into chunks with an explicit continuation. Never silently dropped, never silently cut | – | **Reasoning**: E2 shows single events up to 123 684 B. The cockpit's own precedent marks a cut (`… (diff truncated)`, `packages/xezar/src/git-worktree.ts:477`) | No | Decided here |
| B-04 | Cursor size (every MCP cursor) | **2 048** | bytes | `MAX_CURSOR_BYTES` (`packages/xezar/src/runs/event-history.ts:16`, **source**). An oversized or malformed cursor is an explicit error, like `HistoryCursorError` | No | Adopted |
| B-05 | MCP task list | Paginated under B-01/B-02 | – | The cockpit route returns every run unpaginated (`packages/xezar/src/server/server.ts:3517`, **source**), bounded only by B-24 (300 + 500). A full record measured median **6 264 B**, p95 **6 766 B** (**executed**, E1), so 800 records ≈ **5.0 MB**, 125 × B-01. At p95 size a page holds **5** full records; without `steps`/`workflowDef` (p95 **4 172 B**) it holds **9**. The summary projection is [#91](https://github.com/qodeca/xezar/issues/91)'s to design | No | Decided here |
| B-06 | Total ceiling of each text read | Unchanged: `DIFF_CAP` **400 000**, `PATCH_CAP` **200 000**, `FILE_CONTENT_CAP` **512 000**, `CHECK_OUTPUT_CAP` **20 000** | characters (UTF-16 code units, `String.length`) | `packages/xezar/src/git-worktree.ts:21`, `packages/xezar/src/server/git-changes.ts:55` and `:450`, `packages/xezar/src/workflows/run.ts:75` (**source**). N-02: MCP shares the UI's limits. MCP delivers up to the same ceiling in B-01 chunks. Chunk on **serialized bytes**, not characters: worst-case JSON escaping turns 400 000 characters into **2 400 002 B** (**executed**, E3b) | No | Adopted |
| B-07 | Tool-input ceiling and field limits | Unchanged: request body **32 MiB** (`GLOBAL_BODY_LIMIT`); task/plan text **100 000** chars; `systemPrompt` **20 000** chars; **4** images per message; `MAX_QUEUED_MESSAGES` **20**; `MAX_QUEUED_ATTACHMENTS` **8**; `MAX_FOLDED_TASK_CHARS` **200 000**; ui-state body **128 KiB** | as listed | `packages/xezar/src/server/server.ts:863`, `:864`, `:604`, `:581`, `:586`, `:791`–`:793` (**source**). MCP validates through the same shared schemas (N-02) | No | Adopted |
| B-08 | IPC frame ceiling (bridge ↔ service, and the stdio leg) | **33 619 968** (32 MiB + 64 KiB) | bytes per frame | Must admit a B-07 body plus its JSON-RPC envelope; the envelope measured **~106 B** around a 32 MiB argument (**executed**, E3), so 64 KiB is > 600 × headroom (**reasoning** for the margin). Cost of the largest frame: parse **11.4–11.9 ms**, stringify **10.8–15.9 ms** (**executed**, E3), far inside the 900 ms self-block D-02 showed the lease renewal tolerates (**peer record**). A larger frame is refused with an explicit error and closes nothing else | No | Decided here |
| **Time** | | | | | | |
| B-09 | Bridge per-call deadline | **55** | seconds | Shortest documented client tool timeout is Codex's **60 s** default `tool_timeout_sec` (**documentation**). Claude Code's stdio idle window is 30 min; OpenCode documents no per-call tool timeout (its 5 000 ms bounds tool *fetching*) (**documentation**). The 5 s margin is **reasoning**: it lets xezar answer legibly before the client gives up, and is > 1 000 × the 1 ms bridge round trip D-01 measured (**peer record**). On expiry the bridge answers "still running"; **the service operation is not cancelled** (N-05) and its outcome stays retrievable through its operation key (D-06) | No | Decided here |
| B-10 | Operations that must be accept-then-event | Every covered action whose existing service path has a timeout ≥ B-09. Found: `PUSH_TIMEOUT_MS` **60 000** (`packages/xezar/src/server/forge/github.ts:2437`), `PLANNER_TIMEOUT_MS` **60 000** (`packages/xezar/src/planner.ts:18`), remote-skills `CLONE_TIMEOUT_MS` **60 000** (`packages/xezar/src/skills-remote.ts:19`) | – | **Source**, by a grep of `*_TIMEOUT_MS` in `packages/xezar/src`. F-20 requires it. The checkout `CLONE_TIMEOUT_MS` (10 min, `server/checkout.ts:34`) belongs to Add project, which is global and excluded. The grep is a floor, not the list: [#89](https://github.com/qodeca/xezar/issues/89), [#96](https://github.com/qodeca/xezar/issues/96) and [#97](https://github.com/qodeca/xezar/issues/97) check each covered action's longest path | No | Decided here |
| B-11 | Acceptance budget for a long operation | p95 **≤ 250**, ceiling **2 000** | ms | D-05 N5: measured p95 42.6 ms (**peer record**). Consistent with B-09 (2 000 ms ≪ 55 s) | No | Adopted |
| B-12 | Bridge startup (`initialize` + `tools/list`) | Must answer without the service and within **5 000** | ms | The smallest documented client bound is OpenCode's **5 000 ms** tool-fetch timeout; Codex's startup default is **10 s**; Claude Code's `MCP_TIMEOUT` default is not stated (**documentation**). D-01 measured a prototype at median **20.9 ms** and the published CLI's `--version` at **0.11–0.13 s** (**peer record**). The real `xez mcp` startup is **UNRESOLVED** (U-3) | No | Decided here (the bound) |
| B-13 | Lease renewal interval | **5** | seconds | D-02.5: worst renewal lateness 15 ms under load (**peer record**) | No | Adopted |
| B-14 | Owner lease | **30** | seconds | D-02.5: a frozen owner released at 29 940 ms (**peer record**). A renewal gap longer than the lease forces re-acquisition, never renewal (D-02 resumed-owner rule) | No | Adopted |
| B-15 | Owner acquisition retry | **5** attempts, full-jitter backoff, window doubling to a **200 ms** cap | attempts, ms | D-02.2: observed maximum 3 attempts at 8 contenders, worst 98.3 ms (**peer record**) | No | Adopted |
| B-16 | Bridge retry on a dead socket | **None** – fail fast | – | D-01 decision table: failure is legible in ~1 ms (**peer record**) | No | Adopted |
| B-17 | MCP `ping` to the client | **30 000** | ms | D-05 N6, reusing `HEARTBEAT_MS` (`packages/xezar/src/server/ws.ts:34`) (**peer record**, **source**). Uses no model turn | No | Adopted |
| B-18 | Stream keepalive, if D-01's transport streams | **15 000** | ms | D-05 N7, reusing the run-stream ping (`packages/xezar/src/server/server.ts:4714`) (**peer record**, **source**) | No | Adopted |
| **Retention** | | | | | | |
| B-19 | Event journal | **10 000** rows per project, and a row younger than **14** days is never evicted | rows, days | D-05 N1: 13.9 significant events per real task, so ≈ 719 tasks; ≈ **3.81 MiB** per project at 399 B per row (**peer record**). A cursor older than retention gets D-05's explicit `cursor_too_old` answer and current-state recovery | No | Adopted |
| B-20 | Journal replay page | **100** rows | rows | Same value as B-02 (D-05 N2) | No | Adopted |
| B-21 | Operation receipts | Evicted only when **older than 84 h AND outside the newest 50 000** for the project | hours, receipts | D-06 § 8: 84 h from the auto-resume constants in `run.ts`; 50 000 from a measured 40.6 ms cold scan against a 300 ms budget; ≈ **20.85 MB** at the cap (50 000 × 417 B) (**peer record**) | No | Adopted |
| B-22 | Receipt journal snapshot cadence | Every **1 000** lines | lines | D-06 § 7.2: a 1 000-line journal scans in 0.7 ms (**peer record**) | No | Adopted |
| B-23 | Audit trail | Mechanism **decided here**: count-based, not time-based, and an entry that names a run is never evicted while that run is still kept by B-24. The count is **UNRESOLVED** (U-2) | entries | **Reasoning**: the run store retains by count (`packages/xezar/src/runs/store.ts:328`–`:329`, **source**), and D-06 § 10.5 proposes the same shape. An audit trail that forgets a run the cockpit still shows would break N-04's purpose | No | Decided here (mechanism); UNRESOLVED (number) |
| B-24 | Run store | Unchanged: `MAX_RUNS_KEPT` **300**, `MAX_ARCHIVED_KEPT` **500**; the events file, handoff and images go with the run | runs | `packages/xezar/src/runs/store.ts:328`–`:329`, `:1370`–`:1386` (**source**). An MCP-created run is an ordinary run | No | Adopted |
| B-25 | Automation receipts, log and tombstones | Unchanged: **90** | days | `RETENTION_MS` (`packages/xezar/src/automations/store.ts:34`, **source**) | No | Adopted |
| **Existing workspace resources – MCP reads only the safe effective value (D-03)** | | | | | | |
| B-26 | `resources.maxParallel` | **2** (range 1–16) | tasks | `packages/xezar/src/workspace/config.ts:148` (**source**). An MCP-created task takes a slot like a cockpit task. **The MCP session itself holds no slot** – it is not a run | Yes – existing Settings key | Adopted |
| B-27 | `resources.maxMonitoringSessions` | **2** (0–16) | sessions | `config.ts:150` (**source**) | Yes – existing | Adopted |
| B-28 | `resources.memoryLimitMb` | Absent: `floor(totalMiB × 0.6 / 2)` clamped to [1 024, 8 192] – **8 192** on the 128 GiB host of § 6. Explicit `null`: no limit | MiB | `deriveDefaultMemoryLimitMb` (`config.ts:132`–`:139`, `:215`–`:222`, **source**). The absent-versus-explicit-`null` distinction is preserved: MCP never writes this key | Yes – existing | Adopted |
| B-29 | `resources.idleTimeoutMinutes` | **15** (1–1 440; `null` = never) | minutes | `config.ts:94`, `:198`–`:205` (**source**) | Yes – existing | Adopted |
| B-30 | `resources.monitoringWakeIntervalMinutes` | **5** (1–60; `null` = park) | minutes | `config.ts:78`, `:165`–`:172` (**source**) | Yes – existing | Adopted |
| B-31 | `resources.worktreeRetentionDefault` | **10** (0–1 000; 0 = unlimited) | worktrees | `config.ts:224` (**source**) | Yes – existing | Adopted |
| **Concurrency and local surface** | | | | | | |
| B-32 | In-flight calls per MCP session | **No separate cap** | – | **Reasoning**: only the one owner session may mutate (F-18); expensive work is already bounded by B-26 and B-28 (N-02); the cockpit has no such cap either. Volume under load is unmeasured (U-6) | – | Decided here |
| B-33 | Connections per project | **One owner** (Agreed, F-18). A non-owner connection gets the occupied error. **No numeric connection cap** | – | **Reasoning**: the socket admits only the same user (B-34), who can already stop xezar outright, so a cap defends nothing | – | Agreed (owner); Decided here (no cap) |
| B-34 | Local socket | `<xezarHomeDir()>/ipc/<projectId>.sock`; 12-hex fallback when too long; directory `0700`, socket `0600` | path, mode | D-01 decisions 1.3–1.4: the macOS `sun_path` limit is **104 B** and a worktree-local path measured **114 B**; mode `0600` enforced even for the owning uid (**peer record**) | No | Adopted |
| **Packaging** | | | | | | |
| B-35 | New runtime dependencies | **0** | packages | `@qodeca/xezar@0.13.1` unpacks to **7 653 313 B**, 495 files, 7 dependencies. `@modelcontextprotocol/sdk@1.30.0` alone unpacks to **4 322 438 B** with 17 direct dependencies; installed, it is **94 packages, 26 552 KiB** – about 3.5 × xezar itself (**executed**, E4) | – | Decided here |
| B-36 | Node engine | Unchanged: `>=20` | – | `packages/xezar/package.json` (**source**). The bridge needs only `node:net` and `node:readline` | – | Adopted |

## 4. The decisions in detail

### 4.1 Reads carry a byte budget (B-01 to B-06)

**Decided here.** The cockpit's caps protect a browser tab. An MCP result lands in a model's context, which is a much smaller and more expensive place. The measured numbers make the gap concrete: the unpaginated task list is about 125 budgets, and a single 100-event window of a real transcript is up to 14 budgets.

So every MCP read ends a page at 100 items or 40 000 bytes, whichever comes first. That keeps a full D-05 journal page in one message, because the journal was designed to that size.

**What overshoot costs.** Claude Code does not drop an over-limit result. It saves it to a file and tells the model the path (**documentation**). So a budget that turns out slightly too large degrades the answer; it does not lose data. That is why the number is fixed now and the token check is left to a runtime test (U-1), instead of blocking the implementation.

**Parity is preserved.** B-06 keeps the cockpit's total ceilings. MCP can read everything the UI can read, in more steps. It cannot read more.

### 4.2 No call outlives the client's patience (B-09 to B-12)

**Decided here.** A synchronous tool call that the client abandons is the worst shape: the effect may happen, and the model never learns. The shortest documented client tool timeout is Codex's 60 s default. So the bridge answers by 55 s at the latest. If the work is still running, the answer says so. The work is not cancelled.

The grep in B-10 found three existing paths that can take the full 60 s. In the cockpit those are synchronous, and they are fine there because a browser waits. Through MCP they become accept-then-event under F-20. The grep is a floor, and the named issues must check the rest.

### 4.3 Retention (B-19 to B-25)

**Adopted.** The journal and receipt values were measured by their own records, and this record does not second-guess them. D-05 states that a smaller D-09 bound would win. **No smaller bound is set here**, because nothing measured in this spike argues for one: at the cap, the two stores together hold about 25 MiB per project, and each is deletable state.

**Audit retention.** D-06 § 10.5 left it open because the measurement that would fix it – a real audit entry size against a real activity rate – does not exist. This spike tried to measure the activity rate and could not. The primary checkout on this host holds **13** runs in one registered project, created within one day (**executed**, E5). That sample fixes no rate. So:

- **Decided here**: the mechanism. Count-based, following the run store. An entry naming a run stays while B-24 keeps the run.
- **UNRESOLVED**: the count. [#102](https://github.com/qodeca/xezar/issues/102) measures the real entry size and rate, and adds the number to this table in the same change.

### 4.4 Existing resources are shared, not copied (B-26 to B-31)

**Adopted.** MCP adds no resource key. It creates ordinary runs, so the existing keys bound them. The MCP session is not a run, so it holds no `maxParallel` slot and cannot starve the cockpit. MCP reads these values only as the safe effective reads D-03 allows; it never writes them.

## 5. Local surface and packaging

### 5.1 What is exposed

**Adopted from D-01, restated because it is the protection D-09 asks for.** One Unix socket per registered project, in the user's xezar home, directory `0700`, socket `0600`. No TCP listener. No port. No remote packaging (F-17). A project with no client costs one idle listening socket.

### 5.2 Why MCP needs no opt-in flag

**Decided here, by reasoning from source.** `AGENTS.md` puts features that widen exposure behind an off-by-default `XEZ_*` flag. MCP does not widen exposure:

- The loopback HTTP API already accepts a request from **any** local process, because a non-browser caller sends no `Origin` and passes the write guard (`packages/xezar/src/server/server.ts:1239`–`:1245`, **source**). Loopback TCP does not check which OS user connects.
- The MCP socket accepts only the **same** user (D-01 E7, **peer record**).

So the socket is strictly narrower than what already exists. It adds no network surface and no cost while no client is connected. Model turns are spent only by a client the user configured, which is the Agreed product (F-14, F-20).

Hosted mode changes nothing here: the socket stays local to the host, and MCP applies the same capability refusals the cockpit applies (N-02).

### 5.3 Environment variables

**Decided here: none.** Every row in § 3 is a constant or an existing Settings key. A variable would only be a knob beside a working default, which § Zero config forbids. `.env.example` and the README env table are therefore **unchanged**. D-01 names a test override of the socket path as the plausible future case; a test reaches it through a constructor option, and if an implementation ever needs a real variable, that same change updates `.env.example`.

### 5.4 How the bridge ships

**Decided here.**

- **Same package, same binary.** The bridge is the `xez mcp` subcommand (D-01 decision 1.7) inside `@qodeca/xezar`. `AGENTS.md` § Repository layout forbids splitting the CLI into another package, and the bridge is the same program.
- **No new runtime dependency.** The MCP stdio leg is newline-delimited JSON-RPC, and D-01's prototype spoke it in about 70 lines. The official SDK would add 94 installed packages and 26 552 KiB – an HTTP server, an OAuth library and a rate limiter that a stdio bridge never runs. Schemas use `zod`, already a dependency. **Counter-risk, said plainly:** xezar then owns protocol conformance. [#86](https://github.com/qodeca/xezar/issues/86)'s handshake test against all three real clients is what carries that risk. Reversing this decision needs a new measurement of the installed size.
- **Bridge and service versions must match.** A bridge started from one install can meet a service started from another after an upgrade. The bridge reports its version in its first frame, and a mismatch is refused with a message that says which process to restart (**reasoning**). The frame shape is D-01's.
- **The published artifact stays checked by the existing gates.** `npm run build` ends in `check:pack` (`packages/xezar/scripts/check-pack.mjs`) and `npm run test:package` installs the tarball. The subcommand ships in `dist/` and needs no new `files` entry.

### 5.5 N-07 check

| N-07 demand | How this record meets it |
| --- | --- |
| Never block startup | No bound here runs at boot. The socket is created as part of serving a project (D-01 § 5). |
| Deletable connection state | Journal, receipts and audit are written, never required; deleting them discards history and xezar rebuilds the files. |
| No client at all | One idle socket per project. The lease timers (B-13, B-14) concern an owner, so with no client they have nothing to renew or expire. |
| No new manual file, database or fixed port | None added. All values are constants or existing keys. |

## 6. Evidence register

**Host:** Apple silicon arm64, 18 cores, 137 438 953 472 B (128 GiB) RAM, macOS (Darwin 25.6.0), Node **v24.20.0**. The repository requires Node ≥ 20; timings on Node 20 were not measured.

| ID | What ran | Result |
| --- | --- | --- |
| E1 | Byte size of every record in the primary checkout's `.local/xezar/runs.json` (13 runs, 100 301 B) | Full record min 4 444 / median 6 264 / p95 6 766 / max 6 766 B. Without `steps`/`workflowDef`: median 3 221 / p95 4 172 B |
| E2 | Every line of 13 real transcripts in `.local/xezar/runs/*.ndjson` (5 701 events, 11 732 113 B) | Event bytes median 577 / p95 6 747 / max 123 684. Worst 100-consecutive-event window per file: median 380 570 / max 567 209 B. Raw events are a proxy: the history page counts canonical items, which fold events together, so this bounds the problem from above |
| E3 | `JSON.stringify` and `JSON.parse` of one 33 554 326 B `tools/call` frame, three runs | Stringify 15.9 / 10.8 / 13.1 ms; parse 11.9 / 11.4 / 11.8 ms. Envelope ≈ 106 B |
| E3b | JSON size of 200 000 / 400 000 / 512 000 characters, plain and all-control-character | Plain n + 2 B; worst case 1 200 002 / 2 400 002 / 3 072 002 B (6 ×) |
| E4 | `npm view` of `@qodeca/xezar@0.13.1` and `@modelcontextprotocol/sdk@1.30.0`; then `npm install @modelcontextprotocol/sdk@1.30.0 --ignore-scripts` into an empty temporary directory and `du -sk node_modules` | xezar 7 653 313 B / 495 files; SDK 4 322 438 B direct, 17 direct deps; installed 94 packages, 26 552 KiB |
| E5 | Run count and creation span of every registered project's `runs.json` under `~/.xezar/config.json` (counts only; no content read) | One project with a `runs.json`: 13 runs, 1 archived, all created within one day. No activity rate can be derived |

**Documentation**, retrieved 2026-09-10:

- Claude Code MCP ([code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp)): warning above 10 000 tokens; default maximum 25 000 tokens (`MAX_MCP_OUTPUT_TOKENS`); over-limit results without images are saved to a file; per-tool `_meta["anthropic/maxResultSizeChars"]` up to 500 000 characters; stdio idle window 30 min; `MCP_TOOL_TIMEOUT` unset default 28 h; `MCP_TIMEOUT` default not stated.
- Codex configuration reference ([learn.chatgpt.com/docs/config-file/config-reference](https://learn.chatgpt.com/docs/config-file/config-reference)): `startup_timeout_sec` default 10 s; `tool_timeout_sec` default 60 s; `tools.<tool>.output_token_limit` exists with no default stated.
- OpenCode MCP servers ([opencode.ai/docs/mcp-servers](https://opencode.ai/docs/mcp-servers/)): `timeout` 5 000 ms for fetching tools; no tool-output limit documented.

**Peer records**, read from their task branches on 2026-09-10 and not re-run here. They were not yet merged, so they are cited by filename and issue rather than linked:

| Record | Issue | Values adopted |
| --- | --- | --- |
| `mcp-d01-transport-decision.md` | [#79](https://github.com/qodeca/xezar/issues/79) | B-12 timings, B-16, B-34, `xez mcp` |
| `mcp-d02-session-binding-decision.md` | [#80](https://github.com/qodeca/xezar/issues/80) | B-13, B-14, B-15, the 900 ms self-block tolerance in B-08 |
| `mcp-d05-async-event-contract-decision.md` | [#82](https://github.com/qodeca/xezar/issues/82) | B-01 page size, B-02, B-11, B-17, B-18, B-19, B-20 |
| `mcp-d06-versioning-idempotency-audit-decision.md` | [#83](https://github.com/qodeca/xezar/issues/83) | B-21, B-22, the B-23 proposal |

No conflict was found between them. D-05's 30 s `ping` and D-02's 30 s lease are different layers: the ping checks the client, the lease bounds a silent owner, and neither triggers the other.

## 7. Corrections – where the source disagreed with a document

1. **#84 and its brief point to "the pagination and limit handling in `server.ts`".** The source has no generic pagination there. The run list is unpaginated (`server.ts:3517`). Transcript pagination lives in `packages/contract/src/events.ts:31` and `packages/xezar/src/runs/event-history.ts`. `server.ts` holds only per-route limits: automation logs ≤ 100 (`:376`), GitHub search ≤ `GH_SEARCH_MAX` = 50 (`forge/github.ts:503`), GitHub list default 30 (`:4910`). B-05 exists because of this.
2. **The brief places `deriveDefaultMemoryLimitMb` in `semaphore.ts`.** It is defined in `packages/xezar/src/workspace/config.ts:132`; the semaphore consumes `DEFAULT_MEMORY_LIMIT_MB` as its fallback (`semaphore.ts:151`). The behaviour is as the brief describes.
3. **`DIFF_CAP` is a character cap, not a byte cap.** It compares `String.length` (`git-worktree.ts:477`). B-01 is in bytes and B-06 in characters on purpose; E3b shows the two can differ by 6 ×.

## 8. UNRESOLVED

| ID | What | Why it is not fixed | Who closes it |
| --- | --- | --- | --- |
| U-1 | How many tokens 40 000 bytes of a real MCP result are in each client; Codex's default output truncation; any OpenCode output limit | No tokenizer is installed here, and measuring through a live model would spend a real account's turns, which the phase forbids. Codex and OpenCode document no default | [#85](https://github.com/qodeca/xezar/issues/85) with a real transcript; [#91](https://github.com/qodeca/xezar/issues/91) lowers B-01 in this table if a client warns or truncates |
| U-2 | Audit retention count | No real activity rate exists (E5) | [#102](https://github.com/qodeca/xezar/issues/102) |
| U-3 | Real `xez mcp` startup time | The bridge does not exist yet | [#86](https://github.com/qodeca/xezar/issues/86), against B-12 |
| U-4 | Windows named-pipe path and permissions; Linux `sun_path` | Not measured on either platform | [#86](https://github.com/qodeca/xezar/issues/86) |
| U-5 | Claude Code `MCP_TIMEOUT` default | Not stated in the documentation | [#85](https://github.com/qodeca/xezar/issues/85) |
| U-6 | Load: concurrent calls and event volume | Nothing was measured at volume (also D-01's open item 8) | [#86](https://github.com/qodeca/xezar/issues/86)–[#89](https://github.com/qodeca/xezar/issues/89); a cap is added here only with a measurement |

## 9. Rules for the implementing issues

- Cite the `B-` row. Do not add a number that is not in § 3. A new bound, or a changed one, edits this table in the same change, with its evidence.
- If a sibling record's value changes before or after merge, the row that adopted it changes in the same change.
- A new `XEZ_*` variable needs a reason under § 5.3 and updates `.env.example` in the same commit.

| Issue | Rows it implements |
| --- | --- |
| [#86](https://github.com/qodeca/xezar/issues/86) bridge | B-08, B-09, B-12, B-16, B-34, B-35, B-36 |
| [#91](https://github.com/qodeca/xezar/issues/91), [#95](https://github.com/qodeca/xezar/issues/95) reads | B-01 to B-06 |
| [#92](https://github.com/qodeca/xezar/issues/92), [#94](https://github.com/qodeca/xezar/issues/94) writes | B-07, B-10, B-11 |
| [#96](https://github.com/qodeca/xezar/issues/96), [#97](https://github.com/qodeca/xezar/issues/97) Git and project actions | B-10 |
| [#99](https://github.com/qodeca/xezar/issues/99) ownership | B-13 to B-15, B-33 |
| [#101](https://github.com/qodeca/xezar/issues/101) idempotency | B-21, B-22 |
| [#102](https://github.com/qodeca/xezar/issues/102) audit | B-23 |
| [#103](https://github.com/qodeca/xezar/issues/103), [#105](https://github.com/qodeca/xezar/issues/105) journal and replay | B-17 to B-20 |
