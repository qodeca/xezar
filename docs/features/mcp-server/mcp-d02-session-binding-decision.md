# D-02 — session binding, liveness, occupancy and handover

Spike record for [#80](https://github.com/qodeca/xezar/issues/80) (Phase 2, [#69](https://github.com/qodeca/xezar/issues/69); epic [#67](https://github.com/qodeca/xezar/issues/67)). Decision date **2026-09-10**, against `main` at `9fdcf0e`.

This is a **spike**: it produces a decision and its evidence, and it ships no production surface. Nothing here is implemented. [#99](https://github.com/qodeca/xezar/issues/99) implements what this record chooses, in Phase 4.

It closes row **D-02** of [§10 Open decisions](mcp-project-leader-requirements.md) and serves **F-18**, **F-19**, **N-05**, **A-16**, **A-17**, **A-18** and **A-23**. The transport itself belongs to D-02's neighbour D-01 ([#79](https://github.com/qodeca/xezar/issues/79)); the connection file's name and format belong to D-04 ([#81](https://github.com/qodeca/xezar/issues/81)); operational limits and retention belong to D-09 ([#84](https://github.com/qodeca/xezar/issues/84)). Where this record has to name a path or a transport to be concrete, it says so and defers the spelling to those records.

## How to read the labels

The requirements document keeps a three-way split and this record preserves it. Every statement below carries one:

| Label | Meaning |
| --- | --- |
| **Agreed** | Settled in the requirements document. Not reopened here. |
| **Decided here** | This spike's answer to something the document left as a proposal or open. Phase 4 implements it. |
| **Open** | Still undecided, by this record or by another one. Named, not guessed. |

Evidence carries its own label:

| Label | Meaning |
| --- | --- |
| **Executed** | A program was run on a real host and the numbers below are its output. The host and the scripts are named in [§9](#9-evidence-register). |
| **Documentation** | Read from an official specification or vendor page on the date given. Not a working integration. |
| **Source** | Read from this repository at `9fdcf0e`, with the file and line cited. |
| **Not attempted** | With the reason. Never "should work". |

Absence claims are scoped to what was examined. Where a document and this repository's source disagreed, the source won and the correction is recorded in [§7](#7-corrections-where-the-source-disagreed-with-a-document).

## 1. What was already agreed, and is not reopened

**Agreed** (F-18, F-19, N-05, and the [compatibility report](mcp-client-compatibility.md) § One logical owner):

- Exactly one active logical MCP client/session may own a project. The cockpit stays concurrent, and different projects may have different owners.
- A second client is rejected with a protocol- or transport-compliant *project-occupied* error.
- Multiple requests or streams from the **same** logical owner are not additional clients.
- **No manual disconnect control is added to the UI.** No forced takeover, no per-operation roles.
- Occupancy is released only after confirmed termination or expiry, established by background liveness checks that need no model turn. **Model silence is not session death.** One HTTP request ending or one SSE stream closing is not session death.
- After expiry the old client must reconnect, and a stale owner cannot mutate even if its process is still alive.
- **N-05 is mandatory**: client occupancy is separate from executor lifetime. Releasing a lease never cancels or loses a started task.

Two of these are also independently required by the protocol, which is worth knowing because it means the portable clients already behave this way. **Documentation**, [MCP 2025-11-25 Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), retrieved 2026-09-10:

> The client **MAY** remain connected to multiple SSE streams simultaneously.

> Disconnection **SHOULD NOT** be interpreted as the client cancelling its request.

## 2. The decisions

### D-02.1 — the owner is the service, not the bridge

**Decided here.** The per-project owner record is held by the **xezar service process** on behalf of one logical session, not by the MCP bridge process.

The reason is that the owner record is only worth anything at the place that gates writes. A claim held by a process that does not check the fencing token before a mutation is decoration. The service owns `ProjectContext` (`packages/xezar/src/server/project-context.ts:32`) and therefore owns every write path; the bridge is a transport adapter, exactly as the compatibility report says it should be.

This has one visible consequence, and it is deliberate: **a service restart ends every MCP session.** See [§5](#5-restart-behaviour).

**Source.** The cross-process half of this is already guaranteed. `ownProjectData` (`packages/xezar/src/runs/project-writer.ts:21`) allows exactly one process to own a project's mutable state, and it is called on both paths that open a store — `packages/xezar/src/server/project-context.ts:212` and `packages/xezar/src/index.ts:671`. So "two services fighting over one project" is already refused today, with a 409 (`packages/xezar/src/server/server.ts:1350`). The MCP owner record does not have to re-solve that. It has to solve the part `ownProjectData` does not cover: which *session inside* the owning service may write, and what a returning client is told.

### D-02.2 — acquisition primitive: publish-then-scan with an exclusive create

**Decided here.** A session becomes the owner by **publishing a uniquely named claim file with `openSync(path, 'wx', 0o600)` and only then scanning for peers** — the shape `ownProjectData` already uses (`packages/xezar/src/runs/project-writer.ts:39`). A live peer claim means "not the owner", always. The primitive fails closed: two simultaneous contenders may both refuse, never both succeed.

Two candidates were rejected, and both were rejected on measurements rather than taste.

**Rejected — read-modify-write, the `mergeWriteWorkspaceConfig` shape.** #99 currently suggests persisting owner state "through the atomic read-modify-write + tmp/rename + `0600` shape in `packages/xezar/src/workspace/config.ts` (`mergeWriteWorkspaceConfig`)". That shape is correct for what it was built for and wrong for this. Its own doc comment says so (`packages/xezar/src/workspace/config.ts:495-513`): it converges *because* two writers merge additively, and it is explicitly "last-writer-wins only within the tiny read→rename window — acceptable for a registry that self-heals on next boot". Mutual exclusion is not additive and does not self-heal. **Executed** (X1, `x1-rmw.json`): eight concurrent processes, 150 trials, **144 trials granted two or more owners, and up to eight simultaneous owners in one trial.** It is not a near miss; it is the wrong tool.

The brief asks why the merge-write resolving its path once matters here. It is the same class of bug one layer down. `mergeWriteWorkspaceConfig` resolves `workspaceConfigPath()` once and feeds that single value to both the read and the write, because resolving it twice let an `XEZ_HOME` that changed mid-flight read one file and write another. The lesson generalises to **an acquisition primitive must decide and commit against one identity in one indivisible step**; a read half and a write half that can be separated — by a changing path, by another process, by a scheduler — is not a lock. The merge-write closes the path gap and leaves the read→write gap open, which is exactly the gap X1 measured. `open(…, 'wx')` has no gap to close: the create either happened or it did not.

**Rejected — unlink-and-retry stale reclaim, the `AutomationStore.acquireLease` shape** (`packages/xezar/src/automations/store.ts:210`). That helper takes an exclusive `wx` lock, and on `EEXIST` unlinks a lock older than `staleAfterMs` and retries. Two contenders can both find the lock stale, both unlink, and both create. **Executed** (X1, `x1-stale.json`): with a pre-planted expired lock, **8 of 150 trials granted two simultaneous owners**. This is a note about reusing that helper for ownership, not a defect report against automations polling, where a duplicated poll is a wasted fetch rather than a second leader.

**The measured cost of the chosen primitive is that it needs a retry.** **Executed** (X1, `x1-wx.json`): with no retry, eight simultaneous contenders left **113 of 150 trials with nobody owning the project** — every contender saw a peer and stood down. That is safe and useless. **Executed** (X1b, `x1b-r*.json`, 120 trials per fan-out, winners holding for 1.5 s so overlap is measurable): with a bounded retry and full-jitter backoff, **0 trials had two overlapping owners and 0 trials had no owner**, at 2, 4 and 8 contenders.

| Contenders | Attempts the winner needed (p50 / p99 / max) | Wall clock to acquire (p50 / max) |
| --- | --- | --- |
| 2 | 2 / 3 / 3 | 3.3 ms / 27.9 ms |
| 4 | 2 / 3 / 3 | 2.3 ms / 18.2 ms |
| 8 | 1 / 3 / 3 | 1.9 ms / 98.3 ms |

**Decided here — the retry budget is 5 attempts, with full-jitter backoff over a doubling window capped at 200 ms.** The experiment that fixes it: the observed maximum was **3 attempts** at every fan-out tested, including eight contenders, so 5 is a little under twice the worst measurement. A client that exhausts the budget is told the project is occupied, which is the correct answer for the case the budget exists to survive.

### D-02.3 — the fencing token is minted, never derived

**Decided here.** Acquisition mints a fencing token — `<wall-clock ms>-<random UUIDv4>` — and stores it in the claim. Every mutation carries it, and the service compares it for **equality** against the current live owner's token before doing anything. Not `>=`, not "newer wins": equality.

The wall-clock prefix exists only so tokens sort readably in logs and audit records (N-04). **It is advisory and nothing may fence on it.** The UUID is what makes the check safe.

**This is the correction that came out of building the prototype, and it is the most important line in this record.** The first design derived the token as `max(token on disk) + 1`, which is the obvious reading of "fencing generation". It is broken, because **reaping the old claim deletes the very evidence that counter reads**. A graceful close removes the claim, the next owner computes `max = 0` and takes generation 1 — the same number the previous owner is holding — and the old owner's write then passes an equality check.

**Executed**, and the failing run is kept: `x5-prototype-BEFORE-FIX.json` records `S4_fencing.oldOwnerWrite.allowed === true` — a stale owner writing after handover. The same scenario against the minted token records `allowed: false, reason: "stale-epoch"`. The scenario is unchanged between the two runs; only the token derivation moved, so this is a real red-then-green, not a test written to agree with the fix.

The minted token also survives the case a derived counter cannot: **wiping `.local/` resets a counter to 1 and re-collides with a live stale owner.** **Executed** (X5, `S4_fencing.wipedDirectory`): the owner directory is deleted outright, a new owner acquires, and the old owner holding the pre-wipe token is still refused with `stale-epoch`.

### D-02.4 — liveness: three signals, and only three

**Decided here.** Occupancy is released on exactly these, in this order of confidence. None of them consumes a model turn.

| # | Signal | What it detects | Measured latency |
| --- | --- | --- | --- |
| 1 | Transport close observed by the service — the bridge's stdin EOF, or the local IPC connection closing | The client application or the bridge went away | **1–23 ms** (X2 A and B, 20/20 detected each) |
| 2 | `process.kill(pid, 0)` returning `ESRCH` for the claim holder | The holding process is confirmed dead | **0.26 µs** per probe (X2 D) |
| 3 | Lease expiry — `now − renewedAt > lease` | Everything else: a frozen process, a wedged host, a suspended machine | one lease |

**Executed** (X2). A client SIGKILLed without closing anything: the bridge saw stdin EOF in **2–23 ms**, 20 out of 20 times. A bridge SIGKILLed: the service saw its IPC socket close in **1–3 ms**, 20 out of 20 times. So in the ordinary ungraceful case — someone force-quits their editor — the project is free in milliseconds and the lease never runs.

**Executed** (X2 C), and this is why signal 3 cannot be dropped: a SIGKILLed holder's **claim file stays on disk and its mtime freezes.** File presence is not liveness. The pid probe caught that particular case, but a *frozen* holder defeats the pid probe too — see D-02.6.

**Not a signal, ever** (**Agreed**, F-19): the model going quiet; one HTTP request completing; one SSE stream closing; a task parked at `waiting` for a human answer. The protocol agrees with the requirement here — see the Transports quote in [§1](#1-what-was-already-agreed-and-is-not-reopened).

**Documentation.** MCP's own `ping` is the right shape for the liveness probe on top of the transport, and it costs no generation: "Either the client or server can initiate a ping by sending a `ping` request… The receiver **MUST** respond promptly with an empty response" ([MCP 2025-11-25 Ping](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping), retrieved 2026-09-10). The same page says implementations "**SHOULD** periodically issue pings" and that the frequency "**SHOULD** be configurable". **Open**: whether Phase 4 also drives an application-level `ping` on top of the transport-close signal, and at what cadence. The three signals above do not need it; a bridge that is alive but wedged in userspace would.

### D-02.5 — renewal every 5 s, lease 30 s

**Decided here.** The owner's claim is renewed by a background timer every **5 seconds**. The lease is **30 seconds**, six renewals.

**The experiment that fixed the renewal interval.** The renewal must be far longer than any delay a healthy owner can suffer, and cheap enough to run per project forever.

- **Executed** (X3, `x3-idle.json` / `x3-cpu.json`), 60 s per condition: a 5 s interval was late by at most **13 ms** idle and **11 ms** under 36 busy loops on an 18-core host. External CPU load is not the threat.
- **Executed** (X3b, `x3b-eventloop.json`): the renewal shares an event loop with xezar's synchronous state work, so the real threat is a long blocking parse. A runs.json-shaped index measured **60.4 ms to parse and 51.4 ms to stringify at 5 000 runs (22.9 MB)**. Feeding 112 ms, 250 ms and 900 ms self-blocks back in, once a second, moved the worst renewal lateness to **8 ms, 11 ms and 15 ms** respectively. A 5 s interval has roughly a 300× margin over the worst blocking the service can plausibly inflict on itself.
- **Executed** (X2 D): one renewal write costs **71.68 µs**. At 5 s that is about 14 parts per million of one core per owned project. Cost is not a constraint.

**The experiment that fixed the lease.** The honest finding is that the lease is *not* bounded from below by jitter — the margin above is absurd — and that **no finite lease survives a suspended host.** **Executed** (X4, `x4-suspension.json`): a `SIGSTOP`ped owner is completely healthy and completely unable to renew. `process.kill(pid, 0)` reported it **alive** the whole time. Its claim went **6.5 seconds stale by mid-suspension** and its renewal timer froze for **12 508 ms**. A laptop lid closed for an hour does the same thing for an hour.

So the lease is chosen as the wait a human tolerates when every fast signal has failed, not as a jitter margin:

- **Floor** — it must not punish an ordinary hiccup. 30 s is six missed renewals and roughly 2 000× the worst renewal lateness measured under load.
- **Ceiling** — it is how long a project stays locked after a death that produced no close event and no dead pid: a hard power loss, a wedged filesystem, a host resumed from sleep into a race. **Executed** (X5 `S3_frozen`): a frozen owner's project became acquirable after **29 940 ms** against a 30 000 ms lease, and the next owner then acquired immediately.
- The path a user actually hits is signal 1 or 2 — **milliseconds**, per X2 — so the 30 s ceiling is the rare fallback, not the normal reconnect cost.

**Decided here — the resumed-owner rule, which is what makes an unbounded suspension safe.** A renewal tick that fires far later than its interval means the owner lost time and its lease may already have been reclaimed. **Executed** (X4): the holder self-detected the gap on the very first tick after `SIGCONT` — Node coalesced the twelve missed intervals into **one** tick carrying a 12 508 ms gap, so a resumed owner sees one obvious anomaly rather than silently backdating twelve renewals. On detecting a gap longer than the lease, the owner **must not renew**. It must re-run acquisition from scratch and, if it loses, surface the expired state to the client. Renewing after a lost interval is how two owners are created; this rule is the reason the design does not need a bigger number.

**Both numbers are for a local, single-machine version one, on a host of this class.** They are engineering values recorded here, per D-09's split, and they are not product guarantees. Re-measure before any remote or multi-host use; remote is out of scope for version one (F-17).

### D-02.6 — the state machine, and who fires every exit

`AGENTS.md` § "Changing a mechanism that already works" requires every transition out of every state this mechanism adds to be enumerated, with the actor that fires it named, and the consequence when nobody does. **A state whose only on-by-default exit is a human typing something is a dead end.** This is that table. No exit in it is a human action.

| State | Exit | Who fires it | If nobody fires it |
| --- | --- | --- | --- |
| **unowned** | → `owned` | A client's `initialize`, arriving through the bridge | The project stays unowned forever, which is the correct resting state. The cockpit is unaffected. Not a dead end: nothing is blocked. |
| **acquiring** (inside one `initialize`) | → `owned` | The acquiring session itself, on a scan that finds no live peer | Bounded by construction: at most 5 attempts, capped backoff, measured worst case 98 ms (X1b). Exhaustion is not a hang — it returns the occupied error. |
| **acquiring** | → `rejected` | The acquiring session, on a live peer claim or an exhausted budget | Same bound. |
| **owned** | → `unowned` (confirmed termination) | The service, on transport close or a dead-pid probe | Measured 1–23 ms (X2). Falls through to expiry below. |
| **owned** | → `expired` | The service's lease sweep, on `now − renewedAt > 30 s` | **This is the one that needed a named firer.** The sweep is a background timer in the service and it consumes no model turn. If the sweep alone were relied on, an unswept expired claim would leave the project unreclaimable, so acquisition **also** classifies every claim it scans and reaps dead or expired ones — the reaper has already published its own claim by then, which is what makes reaping safe there. Two independent firers, neither of them a person. |
| **expired** | → `unowned` | Whoever notices first: the sweep, or the next acquirer's scan | Nothing is blocked while a claim sits expired, because the only consumer of the state is a would-be new owner, and its arrival *is* the trigger. |
| **expired** | → `owned` (by a different session) | The next `initialize` | As above. |
| **owned**, and the process is frozen | → `expired` | Nothing but the lease. The pid probe reports the frozen owner **alive** (X4), and no transport event fires. | The lease is the only exit, measured at 29 940 ms (X5 `S3_frozen`). This row is the reason the lease exists at all. |
| **owner resumed after lost time** | → re-acquire, or → `fenced` | The owner itself, on detecting a renewal gap longer than the lease (X4) | If the owner skipped this check it would renew a lease it no longer holds. That is the two-owner bug, so this exit is mandatory, not best-effort. |
| **fenced** (a stale token) | → the client re-initializes | The **bridge**, automatically, on the fenced error — not the model, and not the user | The bridge retries with backoff and reports a connection problem it can act on. **Not a dead end**: the exit is an automatic client-side reconnect, which is also what the HTTP transport mandates (see [§4](#4-the-occupied-and-expired-errors)). |
| **occupied** (a second client was refused) | → `owned` by that client, later | That client retrying after the real owner ends or expires | The project keeps working for its actual owner and for the cockpit. The refused client is told what to do; nothing is parked. |

Two things this table is deliberately built to avoid:

- **No row's only exit is "a human types something."** The cockpit renders these states (UX-M02) and offers no control that changes them, because F-18 forbids a manual disconnect and forced takeover.
- **No row transitions the executor.** See D-02.7.

**Decided here — the cockpit derives occupancy at read time; it never reads a stored "occupied" flag.** Lazy reaping is correct for the mechanism but wrong for display: a dead owner's claim can sit on disk until the next acquirer arrives, and a stored flag would render "Occupied" for a project nobody owns. Every read runs the same classifier the acquirer runs, so `expired` renders as expired the moment it is true. This is what makes the requirements' distinct `Occupied / rejected second client` and `Expired owner` states (§13 State inventory) truthful rather than decorative.

### D-02.7 — releasing the lease touches nothing but the lease (N-05)

**Agreed, mandatory.** Releasing occupancy must never cancel or lose a started task. Client occupancy and executor lifetime are separate lifetimes.

**Decided here.** The release path writes to the claim file and the service's in-memory session table, and calls nothing on `RunManager`. Phase 4 must pin this with a test rather than a convention, because the coupling is one line away in either direction.

**Executed** (X5 `S7_taskSurvivesRelease`): a started task process was running while its owner's claim was reaped and a new owner acquired. The task **kept ticking across the handover** (3 ticks before, 9 after) and was still alive afterwards.

The inverse also holds and is worth stating because it is the mistake that looks helpful: a task ending, failing or parking at `waiting` does **not** release the lease. A task waiting for a human answer is the ordinary case the requirements call out (§13, `Waiting`), and treating it as a disconnect would evict a live leader mid-conversation.

### D-02.8 — where the claim lives

**Decided here (mechanism).** The claim is a small JSON file in a directory under the bound project's own `dataDir` — `<repo>/.local/xezar/` (`packages/xezar/src/server/project-context.ts:38`) — one file per claim, mode `0600`, holding the fencing token, the holder pid, the hostname, `acquiredAt` and `renewedAt`. Not in `~/.xezar/config.json`.

Three reasons, all checkable:

- **It is already ignored by Git and already local.** `ensureDataGitignore` writes a blanket `*` into `<repo>/.local/.gitignore` (`packages/xezar/src/index.ts:681`), so nothing here can reach a commit. F-15 requires exactly that of connection state.
- **N-07 requires that deleting recoverable state degrades to a working xezar.** A per-project claim directory can be deleted at any moment and the next acquisition rebuilds it. The minted token (D-02.3) is what makes that deletion safe rather than a fencing hole.
- **It keeps a per-project concern out of the per-user registry.** `~/.xezar/config.json` is the workspace config and project registry, written through `mergeWriteWorkspaceConfig`, whose whole convergence argument is that writers merge additively (`packages/xezar/src/workspace/config.ts:495`). Putting a mutual-exclusion record in it would be the X1 failure by construction.

**Open — the exact directory and file names.** The connection file's name, format and creation trigger are D-04's ([#81](https://github.com/qodeca/xezar/issues/81)), and this record does not pre-empt them. What it fixes is the shape: per project, under `dataDir`, `0600`, one file per claim, a name unique per claim so a reaper can never unlink a replacement owner's claim — the property `packages/xezar/src/runs/project-writer.ts:15-19` documents and relies on.

## 3. What was deliberately not built

**A monotonic generation counter.** See D-02.3: it is not merely unnecessary, it was measurably wrong, because the reaper deletes what it counts. The ordering it would have provided has exactly one consumer — human-readable audit — and the wall-clock prefix serves that without carrying any authority.

**A second exclusion layer inside the service.** `WorkspaceSemaphore` (`packages/xezar/src/workspace/semaphore.ts:206`) and the repository-root lease (`packages/xezar/src/workflows/run.ts:1691`) both look like prior art for this and neither is. **Source:** the semaphore's `busy()` sums over an in-memory `Set` of participants (`:230`) and the root lease is a promise chain on `repoRootTail` (`:1695-1705`). Both are **in-process only**, both are correct for what they do — capping concurrent runs on one host, serialising working-tree writes inside one manager — and neither survives a second process. The requirements document cites the semaphore as the technical boundary for limits and locks, which is true of limits and not of cross-process exclusion. This record uses the file-claim family instead, which is the part of the repository that already solves the cross-process case: `packages/xezar/src/runs/project-writer.ts:39`, `packages/xezar/src/server-install/state.ts:144`, `packages/xezar/src/skills-update.ts:316`, `packages/xezar/src/automations/store.ts:214`.

**A "take over" affordance of any kind.** F-18 forbids it. The occupied state is exited by the current owner ending or expiring, and nothing else.

## 4. The occupied and expired errors

The compatibility report is right and this was re-verified for this spike. **Documentation**, retrieved 2026-09-10: the [MCP base protocol](https://modelcontextprotocol.io/specification/2025-11-25/basic) page defines the JSON-RPC message shapes and says only that "Error codes **MUST** be integers"; it publishes no error registry. The [Lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) page's sole initialization-error example is an ordinary JSON-RPC error response carrying `-32602`. **There is no reviewed universal "project busy" error in MCP, in the pages examined.** The error below is xezar's own, and this record does not call it standard.

What *is* standard is the range it lives in. **Documentation**, [JSON-RPC 2.0](https://www.jsonrpc.org/specification): `-32000` to `-32099` is "Reserved for implementation-defined server-errors."

**Decided here — the mapping.**

| Situation | JSON-RPC | HTTP (Streamable HTTP only) | stdio |
| --- | --- | --- | --- |
| A second logical client calls `initialize` while the project has a live owner | error response, `code: -32080`, `data.reason: "com.qodeca.xezar/project-occupied"` | **200** with the JSON-RPC error response in the body | the JSON-RPC error response |
| A fenced or expired owner makes any later call | error response, `code: -32081`, `data.reason: "com.qodeca.xezar/session-expired"` | **404 Not Found** for that `MCP-Session-Id` | the JSON-RPC error response, then the server closes its output stream |
| Two live owners are ever observed | never returned — this is an invariant violation and is a bug, not an error class | — | — |

Why an HTTP **200** for occupied and a **404** for expired, rather than one status for both:

- Occupied is a *request-level* failure of `initialize`, which is the same shape the specification's own initialization-error example uses — a JSON-RPC error, not an HTTP status. Sending a non-2xx here risks a client rendering a generic transport failure instead of the message that tells the user what to do.
- Expired is precisely the case the transport already legislates. **Documentation**, Transports: "The server **MAY** terminate the session at any time, after which it **MUST** respond to requests containing that session ID with HTTP 404 Not Found," and "When a client receives HTTP 404 in response to a request containing an `MCP-Session-Id`, it **MUST** start a new session by sending a new `InitializeRequest` without a session ID attached." That is F-19's "the old client must reconnect" already implemented in every conforming client, for free. Using anything else here would throw that away.

**Decided here — the authoritative discriminator is the namespaced string in `data.reason`, not the number.** The numbers were picked by reading what is already claimed rather than by preference: **Source**, `modelcontextprotocol/typescript-sdk` at `main`, `packages/core-internal/src/types/enums.ts`, `ProtocolErrorCode` defines `-32700`, `-32600`, `-32601`, `-32602`, `-32603`, `ResourceNotFound = -32002`, `MissingRequiredClientCapability = -32021`, `UnsupportedProtocolVersion = -32022`, `UrlElicitationRequired = -32042`. `-32080` and `-32081` sit inside the implementation-defined range, clear of every one of those and clear of the `-32000`/`-32001` values generic servers reach for first. A future SDK release could still claim them, which is exactly why a consumer must branch on `data.reason`. The `com.qodeca.xezar/` prefix is deliberate: **Documentation**, base protocol, MCP reserves `_meta` prefixes "where the second label is `modelcontextprotocol` or `mcp`", and explicitly notes `com.example.mcp/` is *not* reserved — so a reverse-DNS prefix under our own domain is safe to mint.

**Decided here — what the error may and may not contain.** N-01 and the compatibility report both require that a rejection reveals nothing about the competing owner. The occupied error carries the project's own id, a human sentence, and `retryable: true`. It carries **no** owner session id, fencing token, pid, client name, client version, or timestamps that would let one client fingerprint another. "Occupied since" is a stale-data leak dressed as helpfulness and is not included; the cockpit, which is the human's own surface, may show more.

**Not attempted — the round trip through a real Claude Code, Codex or OpenCode client.** No client was configured, launched, or authenticated for this spike, and no MCP server was started. So *how each client renders* `-32080` to its user is **unknown**, and this record does not claim it. That is [#85](https://github.com/qodeca/xezar/issues/85)'s job — the twelve-behaviour compatibility spike names second-client rejection explicitly — and it is listed in [§8](#8-what-is-still-unvalidated).

## 5. Restart behaviour

**Decided here.**

| Event | What happens | Why |
| --- | --- | --- |
| The xezar service restarts | Every MCP session ends. Claims from the old process are reaped by the pid probe (the old pid is dead) at the first scan. | The owner is the service (D-02.1). A claim held by a process that no longer gates writes would be a lie. |
| The bridge reconnects after that restart | It re-initializes and acquires a **new** token, automatically, with no model turn and no human step. | The exit from `fenced` in D-02.6. On HTTP this is the client's own MUST after a 404. |
| An in-flight write from before the restart arrives after it | Fenced — its token is not the current owner's. | D-02.3. |
| Tasks that were running | Keep running, and their results stay in the cockpit and are delivered on reconnect. | N-05 and F-21, **Agreed**; measured in X5 `S7`. |
| The whole `.local/xezar/` claim directory is deleted | The next acquisition rebuilds it. A pre-deletion owner is still fenced. | D-02.8, and X5 `S4_fencing.wipedDirectory`. |
| The host resumes from sleep | The owner detects the lost time and re-acquires instead of renewing; if another client took the project meanwhile, the old owner is fenced and reconnects. | D-02.5, measured in X4. |

A-16 additionally requires that a restart never produces two owners and that the built-in leader still requires manual resume. Nothing here changes the built-in leader's resume rule; the built-in leader and an external client contend for the same single owner slot through the same primitive, which is what A-23 asks for.

## 6. What Phase 4 must test

Not a substitute for [#99](https://github.com/qodeca/xezar/issues/99)'s own acceptance, but these are the cases this spike found and each one has a prototype scenario behind it:

1. A second logical client is refused with the occupied error while the first still owns the project; the refusal reveals nothing about the owner (X5 `S5`).
2. Many concurrent requests and streams from the **same** owner all succeed (X5 `S6` — 200 concurrent calls, 200 allowed).
3. A different project is unaffected.
4. After a simulated crash and lease expiry a new owner acquires, and the old token's write is fenced (X5 `S2`, `S3`, `S4`).
5. **The fencing test must be proved red first.** `git stash push` the token derivation, run the test, confirm it fails, restore. The green-either-way version of this exact test is what let the bug in [§D-02.3](#d-023--the-fencing-token-is-minted-never-derived) survive its first review by its author.
6. A task started before the handover is still running after it, and no release path calls into `RunManager` (X5 `S7`).
7. A frozen owner is released only by the lease, and a resumed owner re-acquires rather than renewing (X4).
8. Acquisition under simultaneous arrival never yields two owners **and** never yields none (X1, X1b).

## 7. Corrections where the source disagreed with a document

| Claim | Source at `9fdcf0e` | Correction |
| --- | --- | --- |
| [#99](https://github.com/qodeca/xezar/issues/99): owner state persists "through the atomic read-modify-write + tmp/rename + `0600` shape in … `mergeWriteWorkspaceConfig`". | `packages/xezar/src/workspace/config.ts:495-513` — convergence rests on additive merging and "last-writer-wins only within the tiny read→rename window". | That shape cannot provide mutual exclusion; X1 measured up to eight simultaneous owners. Persist the claim with an exclusive create instead. The tmp/rename and `0600` conventions are kept. |
| §8 of the requirements document names `WorkspaceSemaphore` among the components that retain ownership of "task lifecycle, state, and limits", which reads as prior art for locking. | `packages/xezar/src/workspace/semaphore.ts:206`, `:230` — participants live in an in-process `Set`. | True for limits, not for cross-process exclusion. The semaphore is a per-process object. The claim-file family is the cross-process prior art. |
| The repository-root lease looks like a per-project exclusive lock. | `packages/xezar/src/workflows/run.ts:1691-1725` — a promise chain on `repoRootTail`. | Also in-process, also correct for its job, also not reusable here. |
| `AutomationStore.acquireLease` looks like the repository's existing expiring-lease pattern. | `packages/xezar/src/automations/store.ts:210-228` — `wx`, then unlink-and-retry on a stale mtime. | The stale-reclaim branch can double-admit; X1 measured 8 in 150. Fine for poll coalescing, not for ownership. |

One measurement correction, recorded because it nearly produced a false finding of its own: the first run of X1b reported two owners in **every** trial. That was the harness, not the mechanism — the winner exited immediately, its pid died, and the next contender then legitimately reaped a dead claim and acquired. Sequential ownership is the design working. The harness was changed to make winners hold for 1.5 s and to count only overlapping hold intervals; the numbers in D-02.2 are from the corrected harness.

## 8. What is still unvalidated

Stated plainly, because the acceptance criterion asks which decisions are not proven:

| Item | Status |
| --- | --- |
| The acquisition primitive's exclusion property | **Executed.** 0 double admits in 360 measured trials across three fan-outs, against a read-modify-write baseline that failed 144 in 150. |
| The fencing scheme | **Executed** in prototype, including the wiped-directory case and a red-then-green regression. **Not** executed inside xezar — there is no MCP code yet. |
| Renewal interval, 5 s | **Executed.** Worst lateness 15 ms across idle, CPU-saturated and event-loop-blocked conditions on one host. |
| Lease, 30 s | **Partly executed.** The takeover consequence is measured (29 940 ms to release a frozen owner, then immediate acquisition). Whether 30 s is the right *product* answer for the rare fallback is a judgement, not a measurement, and the suspension case proves no finite value is sufficient on its own — which is why D-02.5 pairs it with the resumed-owner rule. |
| The three liveness signals | **Executed** for transport close (1–23 ms) and dead pid (0.26 µs), 20/20 detections each. |
| N-05 task survival | **Executed** in prototype (X5 `S7`). Not yet against a real `RunManager`. |
| The occupied/expired error mapping | **Documentation** for the spec quotes and the reserved range; **Source** for the SDK codes it avoids. **Unknown** how Claude Code, Codex or OpenCode render it — no client was launched. [#85](https://github.com/qodeca/xezar/issues/85). |
| MCP `ping` as an additional application-level liveness probe | **Documentation** only. Cadence and whether it is needed at all: **Open**. |
| Behaviour on a host that is not this one | **Not attempted.** One macOS 26.6.2 host, 18 cores, Node v24.20.0. Every number is from that host. |
| Behaviour under a remote or multi-host deployment | **Not attempted**, and out of scope: version one is local-only (F-17). |
| A network filesystem holding `.local/xezar/` | **Not attempted.** `O_EXCL` create semantics are not reliable on all network filesystems; a project root on one is untested. |

## 9. Evidence register

Host: macOS **26.6.2** (build 25G83), 18 cores, 128 GiB RAM, Node **v24.20.0**. All experiments executed **2026-09-10**.

| ID | What it fixes | Result file |
| --- | --- | --- |
| X1 | Acquisition primitive: read-modify-write vs exclusive create vs stale reclaim, 8 contenders × 150 trials each | `x1-rmw.json`, `x1-wx.json`, `x1-stale.json` |
| X1b | Retry budget and backoff, 2/4/8 contenders × 120 trials, overlap-checked | `x1b-r2.json`, `x1b-r4.json`, `x1b-r8.json` |
| X2 | Liveness latencies (client kill → stdin EOF; bridge kill → socket close), claim-file survival after SIGKILL, probe and renewal costs | `x2-liveness.json` |
| X3 | Renewal lateness, idle and under CPU saturation | `x3-idle.json`, `x3-cpu.json` |
| X3b | Synchronous state-work cost at four index sizes, and renewal lateness under self-inflicted event-loop blocks | `x3b-eventloop.json` |
| X4 | A suspended owner: pid probe verdict, claim staleness, renewal gap, self-detection | `x4-suspension.json` |
| X5 | The whole mechanism end to end: graceful close, SIGKILL, freeze, fencing, second client, same-owner concurrency, task survival | `x5-prototype.json`, and `x5-prototype-BEFORE-FIX.json` for the red run |

The prototype and its harnesses were written for this spike and are **deliberately not committed** — this is a spike and it ships no production surface. They live outside the repository, in this task's durable evidence directory under `.local/xezar-tasks/<runId>/spike-d02/`, together with the result files named above.
