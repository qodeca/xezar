# D-06 decision — version checks, durable operation keys, and the audit record

Status: **decision record from a spike. It ships no production code.** Date: 2026-09-10.
Issue: [#83](https://github.com/qodeca/xezar/issues/83), phase 2 of [epic #67](https://github.com/qodeca/xezar/issues/67).
Closes decision row **D-06** of the [MCP requirements](mcp-project-leader-requirements.md) § 10.
Covers **N-03**, **N-04**, **N-08**, **N-10**; acceptance cases **A-13**, **A-14**, **A-16**, **UX-M04**.

Source baseline for every claim below: `9fdcf0e878999783db6c2a69dec93a7d00ccea44`
(`git rev-parse HEAD`, executed and observed). Phase 4 implements this record; nothing here has
been implemented.

## 0. How to read this record

The requirements document keeps a three-way split ([requirements](mcp-project-leader-requirements.md)
§ 2) and this record preserves it. Every statement below carries one of four labels.

| Label | Meaning here |
| --- | --- |
| **Agreed** | Fixed by the requirements document. Not reopened by this record, and not softened. |
| **Decision** | An engineering choice the requirements delegate, **closed by this record**. Phase 4 implements it as written; changing it is a documented decision change, not a free choice. |
| **Technical proposal** | A suggestion that still needs a decision in the phase that owns it. Not approved. |
| **Open** | No decision exists. This record does not create one. |

Evidence is labelled the same way throughout: **executed and observed** (a command was run on this
machine and its output read), **read from source** (a file in this repository at the baseline
revision, with a line reference), **read from official documentation** (a linked upstream spec), or
**not attempted** with the reason. "Should work" appears nowhere as an answer.

Absence claims are scoped to the files examined. They are listed together in § 11.

## 1. Decision summary

Everything this record closes, in one table. Each row links to the section that derives it.

| # | Question | **Decision** | Fixed by |
| --- | --- | --- | --- |
| 1 | Version token shape | `rev1:<kind>:<id>:<seq>:<digest12>`, opaque to the client, echoed back verbatim as `expectedVersion` | § 4.2 |
| 2 | What the token covers | The resource's **decision projection** — fields the server reads to judge the mutation, plus fields the mutation writes. Telemetry counters are excluded | § 4.3 |
| 3 | Stale-write behaviour | Reject with `stale_version`, no partial effect, response carries the current token; the leader must re-read | § 4.4 |
| 4 | Operation identity | Client-supplied `operationId` on every mutating tool; server key is `<projectId>/<operationId>` | § 5.2 |
| 5 | Binding | The receipt stores `action` + `payloadDigest` and both are **verified** on every replay | § 5.3 |
| 6 | Payload digest | SHA-256 over canonical JSON of the **zod-parsed** payload; attachments contribute a byte digest, never a path | § 5.4 |
| 7 | Collision rule | Same key + same action + same digest → replay. Same key + different action or digest → `operation_key_conflict`, **no effect and no original result returned** | § 6 |
| 8 | Storage | `.local/xezar/mcp-operations.ndjson`, append-only, one line per phase transition, folded on load | § 7 |
| 9 | Crash-safe write order | The `intent` line is appended **synchronously before** the effect. The debounced index is never the durable record | § 7.3 |
| 10 | Restart retention | Evict only when **older than 84 h AND outside the newest 50 000** receipts for the project | § 8 |
| 11 | Uncertain outcome status | **`unverified`** — the tool result status, the receipt phase, and the thing a retry returns | § 9 |
| 12 | Reconciliation | Per-action reconciler declared beside the action; an unreachable external system leaves the receipt `unverified` and **never** repeats the effect | § 9.3 |
| 13 | Audit record fields | The 11-field list in § 10.2; free text, payload bodies and diffs are excluded by construction | § 10 |
| 14 | Audit retention | **Open.** N-04 keeps it open and this record does not close it. § 10.5 gives a technical proposal only | § 10.5 |
| 15 | New persisted fields | **None.** The run id is predicted from the operation key instead, because `runRecordSchema` has no `.passthrough()` and a downgrade would erase a new key rather than merely ignore it | § 12.1, § 13.3 |

### 1.1 Every number in this record, and what fixed it

No number below is asserted as a product guarantee, and none is a round figure picked for looking
tidy. No timeout, transport or tool name is invented anywhere.

| Number | Where | What fixed it | Status |
| --- | --- | --- | --- |
| **84 hours** — receipt age floor | § 8.2 | `MAX_AUTO_RESUMES` (12) × the five-hour provider window named in the same file + `AUTO_RESUME_MISSED_WINDOW_MS` (24 h), all read from `run.ts:266-288` | **Decision** |
| **50 000** — receipt count cap | § 8.3 | Measured cold-scan time (§ 3.2) against a 300 ms budget | **Decision** |
| **300 ms** — the recovery budget | § 8.3 | Read from source: the run store's own save debounce, `store.ts:1391-1396` | Adopted, not chosen |
| **417 bytes** — per receipt | § 3.2 | Measured on a realistic record, not estimated | Observation |
| **1 000 journal lines** — snapshot cadence | § 7.2 | Measured: a 1 000-line journal scans in 0.7 ms (§ 3.2), so compacting below that saves under a millisecond and is not worth a write | **Decision** |
| **8–128 characters** — `operationId` length | § 5.2 | Shape bounds only: 8 refuses a trivially short id, 128 bounds a key the journal writes on every line. No behaviour depends on either | **Technical proposal** |
| **12 hex characters** — version digest truncation | § 4.2, § 6 | Not fixed by evidence; phase 4 must evaluate it against the final projection | **Technical proposal** |
| Audit retention | § 10.5 | Nothing yet — the measurement that would fix it does not exist | **Open**, no number proposed |

## 2. What is agreed and is not reopened

**Agreed (N-03).** A leader mutation is rejected when a human changed the relevant state after the
leader read it. There is no silent overwrite and no automatic acceptance of the stale mutation. The
leader must read current state before deciding again. Expected-version checks were a *proposed*
mechanism; § 4 selects them, which is this spike's job. Selecting the mechanism does not weaken the
outcome: § 4.4 rejects, it does not merge.

**Agreed (N-10).** Retrying the same operation identity returns the original result or the current
status **without another effect**. Deliberately new identical work uses a new identity. The key
binds to project, action and payload. Deduplication by text alone is prohibited (§ 5.4 digests the
parsed payload, never the prompt string). The JSON-RPC request ID is **not** used for durable
deduplication — the [compatibility report](mcp-client-compatibility.md) § "Mandatory stale-write
rejection and operation identity" states that JSON-RPC IDs correlate requests and responses and must
not be assumed to provide persistent deduplication, and § 5.2 accordingly puts identity in an
application field the client generates.

**Agreed (N-04), and deliberately weaker.** History **should** identify action, time, project,
resource, outcome and UI/MCP origin without storing secrets. The identity model and audit retention
**remain open**. Source attribution must not bypass permissions. § 10 preserves that weakness: it
splits its own answer into MUST and SHOULD, and it leaves audit retention open.

**Agreed (N-08).** Compatibility is preserved. New persisted fields are optional, a corrupt file
degrades to fresh, and an upgrade must not break project binding or expand permissions. § 12 works
through it against `BACKWARD_COMPATIBILITY.md` § 3.

## 3. Evidence base

### 3.1 Prior art read from source

| Fact | Where | Why it matters here |
| --- | --- | --- |
| `runs.json` is one array, `safeParse`d whole; a corrupt index starts fresh and event files are left untouched | `packages/xezar/src/runs/store.ts:686-698` | The receipt store copies the degrade-to-fresh policy, but § 7.4 shows why *whole-file* parsing is the wrong unit for receipts |
| Index writes are atomic tmp+rename | `store.ts:1399-1404` | Adopted for the compacted snapshot (§ 7.2) |
| Index writes are **debounced 300 ms** | `store.ts:1391-1396` | The measured crash window in § 3.3. This is why the index is not the durable receipt |
| Events are one append-only NDJSON file per run, written with a **synchronous** `appendFileSync`, deliberately: "Sync append keeps event order without a write queue" | `store.ts:1053-1063` | The receipt journal uses exactly this primitive for exactly this reason |
| Event payloads are scrubbed before they touch disk (`redact`, `redactText`, `XEZ_REDACT_SECRETS=0` opts out) | `store.ts:1258-1268` | Best-effort pattern matching. § 10.3 explains why the audit record does not rely on it |
| `seq` is per-run, monotonic, and **never reused** — after a restart it is rehydrated from the NDJSON rather than restarted at 1, because a client's `seq > maxSeq` dedup would silently drop resumed events | `store.ts:1330-1348` | This is the version-token counter (§ 4.2) and the in-repo precedent for recovering a monotonic counter from an append-only file |
| Retention in the run store is **count-based**, not time-based: `MAX_RUNS_KEPT = 300`, `MAX_ARCHIVED_KEPT = 500`, with the event file, handoff and images deleted alongside | `store.ts:328-329`, `store.ts:1370-1387` | The structural floor in § 8.4: receipts must outlive the runs they point at |
| `mergeWriteWorkspaceConfig` re-reads immediately before writing, resolves its path **once**, writes `0600` through a tmp+rename, and snapshots a `.bak` after every successful write | `packages/xezar/src/workspace/config.ts:495-534` | The read-modify-write and mode discipline § 7.2 adopts |
| The staging tmp path is **unique per write** (`pid` + random suffix), explicitly *never* a fixed `${path}.tmp`, because two writers staging through the same name interleave and one renames a truncated file into place | `config.ts:464-477` | § 7.2 follows `config.ts` here, not `store.ts` — see the correction in § 13.1 |
| `atomicWriteJsonSync` **throws** on write failure; degrading is the caller's policy | `config.ts:479-493` | § 7.5 states the receipt store's policy explicitly rather than inheriting one |
| `ownProjectData` gives **one process** ownership of a project's mutable state, published before scanning, independent of port and `XEZ_HOME`; two contenders may both refuse but cannot both see themselves alone | `packages/xezar/src/runs/project-writer.ts:15-60` | The enabling fact for § 4.5: the compare-and-swap needs no cross-process lock because a second writer is already excluded |
| `AUTO_RESUME_GRACE_MS = 30_000`; `MAX_AUTO_RESUMES = 12`, "generous enough to sit through a couple of days of five-hour windows"; `AUTO_RESUME_MISSED_WINDOW_MS = 24 h`, the span a missed deadline "stays worth acting on… kept across a restart or an overnight close" | `packages/xezar/src/workflows/run.ts:266-288`, sweep at `run.ts:1444-1471` | The retention time floor in § 8.2 is derived entirely from these three constants |
| `DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000` | `packages/xezar/src/core/claude-cli-runner.ts:32` | Bounds a single agent step, **not** a task; § 8.2 explains why the step timeout is the wrong anchor |
| `ensureDataGitignore` and `ensureProjectDataIgnored` both write a **blanket `*`** into `<repo>/.local/.gitignore` | `packages/xezar/src/index.ts:681-690`, `packages/xezar/src/project-data-paths.ts:16-25` | The correction in § 13.2 |
| New `runs.json` fields must be optional or defaulted; a required new field "silently drops every pre-existing run because the loader `safeParse`s the whole array". `pinned`/`pinnedAt` are the precedent for optional-with-no-default, and unpinning **deletes** the keys | `BACKWARD_COMPATIBILITY.md` § 3, lines 104 and 106 | § 12.1 follows the `pinned` precedent exactly |

### 3.2 Measurement A — receipt journal cost

**Executed and observed.** A prototype journal built from the same primitives as `store.ts`
(`appendFileSync` NDJSON plus atomic tmp+rename snapshot), with a realistic receipt record.
Prototype lives in `/tmp/d06-spike/`, outside the worktree, and is deliberately not committed.

Host: Apple M5 Max, 18 cores, 128 GiB, macOS 26.6.2, APFS SSD, Node v24.20.0. Five runs per size;
the median is reported with the range.

| Receipts | Journal bytes | Cold scan + fold, median (range) | Same under `node --jitless` |
| --- | --- | --- | --- |
| 1 000 | 417 000 | 0.7 ms (0.6–1.0) | 0.9 ms (0.8–1.3) |
| 10 000 | 4 170 000 | 7.3 ms (6.6–9.7) | 11.6 ms (9.0–13.7) |
| **50 000** | **20 850 000** | **40.6 ms (35.0–43.7)** | **53.7 ms (49.6–55.1)** |
| 100 000 | 41 700 000 | 78.8 ms (78.0–83.7) | 119.9 ms (116.2–122.1) |
| 200 000 | 83 400 000 | 201.1 ms (177.3–210.5) | 216.7 ms (213.5–249.2) |

Bytes per receipt: **417** (measured, not estimated). Append latency over 2 000 appends: p50
0.017 ms, p99 0.044 ms, max 0.208 ms — which reproduces the claim `store.ts:1061-1062` makes about
its own event appends ("local NDJSON appends at agent-event rates are effectively free") for this
record shape too. Snapshot rewrite cost: 0.6 ms at 1 000, 4.8 ms at 10 000, 23.6 ms at 50 000.

`--jitless` is included as a real slow-runtime data point rather than an arithmetic guess about
slower hardware. It is **not** a model of a CI runner; see § 3.4.

### 3.3 Measurement B — the debounced index loses a decision on crash

**Executed and observed.** A child process writes the same record two ways — a synchronous
`appendFileSync` to a journal (the `store.ts:1063` pattern) and a 300 ms debounced tmp+rename index
write (the `store.ts:1391-1396` pattern) — then signals readiness. The parent SIGKILLs it **by saved
PID** (never by command-line pattern) 50 ms later, inside the debounce window, and inspects both
files.

| Kill delay | Runs | Journal after SIGKILL | Index after SIGKILL |
| --- | --- | --- | --- |
| 50 ms (inside the debounce) | 5 / 5 | record present | **absent — decision lost** |
| 400 ms (negative control, after the debounce) | 3 / 3 | record present | record present |

This is why § 7.3 puts the `intent` line in the append-only journal and never in the debounced
snapshot. The negative control is reported because a one-sided result would not distinguish "the
index is unsafe" from "the harness never wrote it".

**Scope limit, stated rather than glossed:** `appendFileSync` does not `fsync`. This experiment
proves survival of a **process** crash, where the OS page cache still holds the write. Power loss
and kernel panic were **not attempted** — reproducing them needs hardware control this spike does
not have. § 8.5 records that as a residual risk rather than a solved one.

### 3.4 What was not attempted, and why

| Not attempted | Reason |
| --- | --- |
| Power-loss / kernel-panic durability | Needs hardware control unavailable in this spike. `fsync` behaviour is therefore unproven; see § 8.5 |
| The same benchmark on a 2-core CI runner | This spike runs on a developer machine. The `--jitless` column is a slow-runtime data point, not a CI measurement. The 50 000 choice is defended in § 8.3 with the margin this leaves |
| Any real MCP client round trip | Client behaviour is issue [#85](https://github.com/qodeca/xezar/issues/85)'s spike, not this one. Nothing here claims a client was exercised |
| A running MCP server | The server does not exist. Every mechanism below is a specification for phase 4 |
| Cross-machine or network-filesystem storage | Version one is local-only ([requirements](mcp-project-leader-requirements.md) F-17). A network filesystem would invalidate the rename-atomicity assumption in § 7.2 and is out of scope |

## 4. Stale-write rejection (N-03)

### 4.1 The problem the token has to solve

A leader reads a task, decides, and submits a mutation. Between the read and the write a human
finishes the task, edits its brief, or archives it. **Agreed:** that mutation is rejected. The
open part was the mechanism.

### 4.2 Decision — the version token

**Decision.** Every read that a mutation can be based on returns a `version` string. Every mutating
tool takes `expectedVersion` and the server compares it against the resource's current token before
any effect.

```
rev1:<kind>:<id>:<seq>:<digest12>
```

| Part | Value |
| --- | --- |
| `rev1` | Format tag. A future shape is `rev2`; a token whose tag the server does not recognise is rejected as stale, never accepted |
| `<kind>` | Resource kind (`run`, `group`, `config`, `workflow`, `automation`, `worktree`, …) |
| `<id>` | The resource id inside the bound project |
| `<seq>` | For run-scoped resources, the run's highest allocated event `seq`. For resources with no event stream, the literal `-` |
| `<digest12>` | First 12 hex characters of SHA-256 over the resource's canonical decision projection (§ 4.3, canonicalised by the § 5.4 rule) |

The token is **opaque to the client**: it is echoed back verbatim, never parsed, never compared for
ordering, never constructed. A client that builds its own token is submitting a forgery, and the
digest half is what makes that fail.

**Why two halves rather than one.** The digest alone cannot see A→B→A: a human who archives a task
and unarchives it leaves the projection byte-identical, and a mutation decided before that pair
would wrongly pass. The `seq` half closes it for anything that emits an event, because
`store.ts:1330-1348` guarantees `seq` is monotonic and never reused **across restarts**. The `seq`
alone is not enough either: it only exists for run-scoped resources, and a project-config edit
allocates no `seq` at all. Each half covers the other's blind spot.

**Why no new persisted field.** Both halves are computed from state the store already keeps. Nothing
in `runRecordSchema` gains a revision counter, so no file format changes and no record needs a
migration (§ 12). This was a deliberate choice over the obvious alternative of adding a `rev`
integer, because an optional `rev` on a pre-existing record reads as absent, and "absent" and "any
value matches" are the same branch — the fail-open trap `AGENTS.md` § "Changing a mechanism that
already works" names. A derived token has no absent case.

### 4.3 Decision — what the token covers

**Decision — the rule.** A resource's **decision projection** is exactly:

1. every field the server **reads** when judging whether a mutation of this kind is legal, plus
2. every field such a mutation **writes**.

**Decision — what is excluded, and why this matters more than it looks.** Continuously-changing
telemetry is excluded: token counters, `costUsd`, `peakRssBytes`, `peakProcCount`, `diffStat`,
`usage`. Including them would make every leader mutation stale within seconds of a running agent
emitting anything — the leader would read a token, and by the time it decided, an agent event had
already moved the number. A version check that always fails is not a safety mechanism; it is an
outage, and it would push implementers toward disabling it. Excluding telemetry is what keeps N-03
enforceable in practice.

Presentation state (`seenAt` where it only drives an unread dot, UI layout state) is excluded on the
same ground as [requirements](mcp-project-leader-requirements.md) M-20: it is presentation, not a
business decision.

**Technical proposal — the concrete run projection**, to be reviewed in phase 4 against the final
`runRecordSchema` rather than accepted from this record:
`status`, `archived`, `pinned`, `title`, `titleOrigin`, `autoResumeAt`, `queuedMessages[].id`,
`steps[].id` and `steps[].status`, `branch`, `workflow`. The rule in this section is the decision;
this field list is a proposal.

### 4.4 Decision — rejection behaviour

**Decision.** On mismatch the server answers `stale_version` with:

```
{ error: "stale_version", resource: { kind, id }, currentVersion: "<token>", changedSince: true }
```

Executable rules, all of which phase 4 can test directly:

1. The check runs **before any effect**, in the same critical section as the write (§ 4.5). A
   rejected mutation leaves state byte-identical.
2. The response carries the **current** token so the leader's next read is cheap. It does **not**
   carry the changed content — the leader must issue a real read, which is what N-03's "read current
   state before deciding again" means.
3. The server **never** merges, never retries with the fresh token, and never asks the human to
   approve the stale write. Automatic acceptance is prohibited by N-03 and no configuration turns
   it on.
4. A **missing** `expectedVersion` on a mutating tool is a schema rejection at the validation
   boundary, not a bypass. This is the populated-input guarantee: "no token supplied" and "token
   matches" must never reach the same branch. The concrete error mapping onto the wire belongs to
   D-01/D-05 and is **not** settled here.
5. An **unparseable or unknown-tag** token is treated as stale, not as an error to the leader's
   client and not as a match.
6. A rejected mutation writes **no `intent`** — the refusal happens before step 3 of § 7.3. It
   writes one `settled` line with outcome `rejected`, so a retry of that same `operationId` returns
   the rejection rather than executing (§ 6). A leader that wants to act on the fresh state issues a
   **new** `operationId`, because it is making a new decision.

**Agreed and unchanged:** this is rejection, not reconciliation. UX row U-M05 already requires the
UI to distinguish "not applied" from "failed after execution", and `stale_version` is unambiguously
the first.

### 4.5 Decision — where the compare-and-swap runs

**Decision.** The token comparison and the write happen inside one synchronous critical section in
the shared business service, on the single `RunStore` instance the project's context owns.

This is safe because of a guarantee read from source, not assumed: `ownProjectData`
(`project-writer.ts:15-60`) gives **one process** ownership of a project's mutable state, publishing
its claim before scanning so two contenders may both refuse but cannot both see themselves alone.
With one writer process and one store instance, a check-then-write pair cannot interleave with
another writer, and no cross-process file lock is needed.

**Limit, stated:** this covers writers that go through `ownProjectData`. A process that writes
`.local/xezar/` directly bypasses it — which is precisely why N-02 forbids MCP from writing JSON or
NDJSON directly and requires it to call the shared services.

## 5. Durable operation identity (N-10)

### 5.1 Why the JSON-RPC id cannot be it

**Read from official documentation**, via the [compatibility report](mcp-client-compatibility.md)
§ "Mandatory stale-write rejection and operation identity", which cites the MCP base protocol:
JSON-RPC IDs correlate a request with its response. They are per-connection and per-session; nothing
in the protocol makes them survive a reconnect, let alone a server restart. A retry after a lost
response is by definition a **new** request on a possibly **new** connection. Using that id for
deduplication would deduplicate nothing in exactly the case the requirement exists for.

### 5.2 Decision — the operation id and the stored key

**Decision.** Every mutating MCP tool takes a required `operationId`: an opaque client-generated
string, 8–128 characters, matching `^[A-Za-z0-9_.:-]+$`. A UUIDv4 is the expected shape; the server
does not require one and does not parse it.

The server's stored key is:

```
operationKey = "<projectId>/<operationId>"
```

**Why the client supplies it and the server does not derive it.** The requirement has two halves
that pull in opposite directions: a retry of the same operation must not repeat, *and* deliberately
new identical work must be allowed. If the server derived the key from `(project, action, payload)`
alone, the second half would be impossible — a leader could never legitimately start the same task
twice. The identity therefore has to come from the caller, which is the only party that knows
whether this is a retry or a new intention. The requirement's "bind key to project/action/payload"
is satisfied by § 5.3's verification, not by making the payload the lookup.

**Why this is not a configuration knob.** `AGENTS.md` § Zero config forbids trading a working
default for a setting. `operationId` is a required protocol argument the bridge fills in, like a
request id — there is no file to author, no environment variable, and no user-visible choice. A user
never sees it.

**Why the project id is in the key and not only in the record.** Two projects must never share an
operation namespace: a leader bound to A must not be able to probe, replay, or collide with an
operation in B, even by guessing an id. F-01 and N-01 make that an isolation requirement, not an
optimisation. The `projectId` is taken from the **trusted connection binding**, never from a tool
parameter ([requirements](mcp-project-leader-requirements.md) § 8, first bullet).

### 5.3 Decision — the binding is verified, not just recorded

**Decision.** Every receipt stores `action` and `payloadDigest`, and every lookup **verifies both**
before returning a replay. Storing them without checking them would satisfy the letter of "bind key
to project, action and payload" and none of its purpose. § 6 is that check.

### 5.4 Decision — the payload digest

**Decision — executable canonicalisation.** `payloadDigest = sha256(canonical)` in lowercase hex,
where `canonical` is produced by exactly these steps:

1. Start from the payload **after** the action's zod schema has parsed it — defaults filled, unknown
   keys stripped, coercions applied. **Never** the raw JSON-RPC `params`. This is what makes the
   digest describe the *effect* rather than the *wire text*, and it is the concrete meaning of
   "do not deduplicate by text alone".
2. Remove the keys in the action's `digestExclude` set. That set ships **empty**. A key may be added
   only if the server generates it or it provably cannot change the effect, and every addition is
   recorded in the action table with its reason. An empty default is what keeps this from becoming a
   quiet dedup-widening surface.
3. Replace every attachment or image blob with `{ sha256: "<hex>", bytes: <n> }`. The digest covers
   the **bytes**, never a filesystem path — a path digest would make the same file at two paths look
   like two operations, and two different files at one path look like one.
4. Serialise: object keys sorted by code unit at every level, arrays in given order, no whitespace,
   `undefined`-valued keys dropped (`JSON.stringify` already does this), and `NaN`/`Infinity`
   refused upstream by zod so they can never reach here.

**Worked consequence, because it is the case the requirement calls out.** Two `runs.create` calls
with byte-identical prompt text are **two operations** when they carry two `operationId`s — that is
"deliberately new identical work uses a new identity", and it works because the prompt text is not
the identity. The same `operationId` submitted twice with the same parsed payload is **one**
operation. The same `operationId` submitted twice with a *different* prompt is a collision, § 6.

## 6. Decision — the collision rule

**Decision.** One lookup, five results, and every mutation takes exactly one of them.

| Stored receipt for this key | Incoming `action` | Incoming `payloadDigest` | Result |
| --- | --- | --- | --- |
| none | — | — | **Execute.** Write `intent`, perform, write `settled` |
| exists, phase `settled` | matches | matches | **Replay.** Return the stored outcome and `resultRef`. No effect. This includes a stored `rejected`: a retry of a rejected operation returns the rejection, it does not re-attempt it |
| exists, phase `intent`, **operation still live in this process** | matches | matches | **Return `in-progress`** with the operation id. No effect, no second attempt |
| exists, phase `intent`, **no live operation** | matches | matches | **Return `unverified`** plus the recorded evidence (§ 9). No effect |
| exists, any phase | **differs** | any | **`operation_key_conflict`.** No effect, and the stored result is **not** returned |
| exists, any phase | matches | **differs** | **`operation_key_conflict`.** No effect, and the stored result is **not** returned |

**Decision — `in-progress` and `unverified` are different answers and are never merged.** A duplicate
request arriving while the first attempt is still running in this process is *not* uncertain: the
server knows the operation is live and will settle it. A dangling `intent` with no live operation is
uncertain, because the only way to get one is a crash between the effect and its receipt. Collapsing
the two would hide a crash behind a routine race, and would make § 9's reconciliation fire against
operations that are simply still working. The requirements name both states — "long operations
expose accepted/running/terminal or explicit uncertain states" (N-05) — and this is that split.
Liveness here means "this process holds the in-flight operation", which after a restart is
structurally false for every receipt, so a restart moves every dangling `intent` to `unverified`
with no timer and no guesswork.

**Decision — the conflict response.**

```
{ error: "operation_key_conflict",
  operationId: "<as supplied>",
  storedAction: "<action>",
  storedAt: "<iso>",
  mismatch: "action" | "payload" }
```

It carries **no** stored payload, no stored result and no resource content. A key collision may be a
client bug, but it may also be a leader that reused an id across two different intentions, and
handing back the other operation's result would be both wrong and a small information leak. The
mismatch field says *which* half disagreed, which is what a client needs to fix the bug.

**Decision — why a conflict is not silently promoted to a new operation.** Generating a fresh id
server-side and executing would make "I sent the wrong payload" indistinguishable from "I meant new
work". UX row U-M05 already forbids the UI equivalent: no retry may silently generate a new
operation identity. The server rule matches the UI rule.

**Decision — digest collisions of SHA-256 are not handled.** A second pre-image on SHA-256 is not a
failure mode this record designs against, and pretending otherwise would be theatre. The 12-hex
truncation in the *version token* (§ 4.2) is a different matter: it is a change-detector inside one
resource's own history, where a truncated collision costs a wrongly-accepted stale write. Phase 4
should measure whether 12 characters is enough for that job or widen it — **technical proposal**,
not closed here, because it needs the final projection field list to evaluate.

## 7. Decision — how a receipt is stored

### 7.1 The receipt record

```jsonc
{
  "v": 1,
  "key": "<projectId>/<operationId>",
  "action": "runs.create",
  "payloadDigest": "<sha256 hex>",
  "phase": "intent" | "settled",
  "outcome": "ok" | "rejected" | "not-applied" | "unverified",   // settled only
  "resultRef": { "kind": "run", "id": "<id>" },                   // settled + ok only
  "expectedVersion": "<token the caller sent>",
  "origin": "mcp",
  "ownerGeneration": 7,
  "reconcile": { "kind": "run-by-key" },                          // intent only, see § 9.3
  "startedAt": "<iso>",
  "settledAt": "<iso>"                                            // settled only
}
```

`ownerGeneration` is the session fencing generation owned by decision **D-02** (issue
[#80](https://github.com/qodeca/xezar/issues/80)). This record only requires that the field exists
and is recorded; its semantics belong to that decision and are **not** settled here.

### 7.2 Files

**Decision.** Two files in the project's own data directory:

| Path | Role |
| --- | --- |
| `.local/xezar/mcp-operations.ndjson` | Append-only journal. One line per phase transition. The durable record |
| `.local/xezar/mcp-operations.json` | Compacted snapshot: latest receipt per key. A load-time shortcut, never the source of truth |

**Decision — write discipline**, following `config.ts` rather than `store.ts` where the two differ
(§ 13.1):

- The journal is written with a **synchronous `appendFileSync`**, the `store.ts:1063` primitive, for
  the reason `store.ts:1061-1062` gives and § 3.2 re-measured: order without a write queue, and
  effectively free at these rates.
- The snapshot is written through a **per-writer tmp path** (`atomicTmpPath`, `config.ts:475-477`),
  never a fixed `${path}.tmp`, and renamed into place. Mode `0600`, directory `0700`, matching
  `atomicWriteJsonSync` (`config.ts:479-493`).
- The snapshot is rewritten on a **cadence, not per operation**: after 1 000 new journal lines or on
  clean shutdown, whichever comes first. Measured cost at 50 000 receipts is 23.6 ms (§ 3.2), which
  is why it is not on the mutation hot path. **1 000 is measured, not chosen:** § 3.2 scans a
  1 000-line journal in 0.7 ms, so compacting below that threshold saves under a millisecond of
  load time and does not repay its own write.

### 7.3 Decision — write order around the effect

**Decision.** For every mutation, in this order and with no reordering permitted:

1. Resolve `operationKey`; run the § 6 lookup. Replay, conflict, or continue.
2. Run the § 4 version check.
3. **`appendFileSync` the `intent` line**, including the `reconcile` predicate (§ 9.3).
4. Perform the effect.
5. **`appendFileSync` the `settled` line** with the outcome.
6. Return.

**A mutation refused at step 1 or step 2 never reaches step 3.** It writes a single `settled` line
with outcome `rejected` and no preceding `intent`, which the § 7.4 fold handles as it would any
other latest-line-wins record. There is deliberately no `intent` for an operation that had no
effect: an `intent` means "an effect may have happened", and writing one for a refusal would
manufacture the exact uncertainty § 9 exists to resolve.

Step 3 is synchronous and precedes step 4 because of § 3.3's measurement: a decision that exists
only in a 300 ms debounced index is lost by a crash 5 times out of 5, while the journal line
survives 5 times out of 5. This is the compatibility report's "persist the decision before external
effects where possible", made specific: *which* write, *which* primitive, and the measurement that
says why the other one does not qualify.

A crash between 3 and 5 is exactly the hard case, and § 9 is its answer.

### 7.4 Decision — load and degradation

**Decision.** On open:

1. Read the snapshot if present. It records the **journal byte offset it covers**; that offset is
   what makes it a shortcut rather than a duplicate. If the snapshot fails to parse, or its offset
   is past the journal's current length, ignore it entirely and start from offset 0.
2. Scan the journal **from that offset**, parsing **line by line**. A line that fails to parse or
   fails its zod schema is **quarantined** — skipped, counted, and reported once — and the scan
   continues.
3. Fold the scanned lines over the snapshot, latest line per key winning.

**Decision — why line-level and not whole-file.** `store.ts:686-698` `safeParse`s `runs.json` as one
array and starts fresh on failure, which is right for an index that can be rebuilt. A receipt
journal cannot be rebuilt: discarding the whole file because one line is torn would discard every
`intent` whose effect already happened, converting a recoverable `unverified` into a silent
"never happened". Line-level quarantine keeps the degrade-to-fresh *spirit* — never crash, never
block boot — at the granularity the data can afford. A torn final line, the realistic crash
artefact, costs exactly that one receipt.

**Decision — a quarantined line must not become a licence to execute.** This is the hole the
quarantine rule would otherwise open, and it needs its own rule rather than a note. A key whose only
journal line was quarantined reads as a **miss**, and § 6 answers a miss by executing — which for an
operation that already happened is the duplicate this whole record exists to prevent.

The rule, executable: the loader counts quarantined lines. **While that count is greater than zero,
a key miss does not execute directly — it runs the action's reconciler first** (§ 9.3). If the
reconciler answers `ok` or `not-applied`, that answer settles the operation with certainty and no
duplicate is possible. If it cannot answer, the mutation returns **`unverified`** with
`reason: "journal_damaged"` and performs no effect. The count returns to zero on its own once
§ 8's eviction compacts the damaged region out; there is no manual step and no setting.

This costs a false `unverified` for the first operation after a torn line, which is the safe
direction: a spurious "check this" is recoverable, a duplicated merge is not.

### 7.5 Decision — failure policy

**Decision.** `atomicWriteJsonSync` throws and leaves degradation to the caller (`config.ts:479-493`).
This caller's policy, stated rather than inherited:

- **Journal append fails** (read-only repository, full disk) → the mutation is **refused** before the
  effect, with a distinct actionable error. An operation whose receipt cannot be written cannot be
  made idempotent, and executing it anyway would break N-10 silently. This is the one place where
  the repository's usual degrade-quietly rule does not apply, and it is deliberate.
- **Snapshot write fails** → logged once, otherwise ignored. The journal is the source of truth, and
  a failed shortcut must never turn a successful mutation into an error. This mirrors the `.bak`
  policy at `config.ts:527-532`.

## 8. Decision — restart retention

### 8.1 The rule

**Decision.** A receipt is evicted only when **both** hold:

- **(a)** it is older than **84 hours**, and
- **(b)** it is not among the newest **50 000** receipts for that project.

Eviction runs at the same moment as snapshot compaction (§ 7.2), rewriting the journal from the
folded set. It never runs mid-mutation.

### 8.2 The 84 hours, and what fixed it

The question is: *for how long can a legitimate retry of one operation still arrive?* Answering it
with a round number would be exactly the failure this spike is told not to commit, so it is derived
from the engine's own constants, read from source at `run.ts:266-288`:

| Term | Value | Source |
| --- | --- | --- |
| Consecutive automatic resumes allowed for one run | 12 | `MAX_AUTO_RESUMES`, `run.ts:280` |
| The provider window each resume waits out | 5 h | Named in that file's own comments, `run.ts:271` ("cheap next to five hours") and `run.ts:278` ("a couple of days of five-hour windows") |
| Tolerance for a deadline missed across a restart or an overnight close | 24 h | `AUTO_RESUME_MISSED_WINDOW_MS`, `run.ts:288`; enforced by the sweep at `run.ts:1462-1469` |
| **Total** | **12 × 5 h + 24 h = 84 h** | |

84 hours is therefore **the longest span over which the engine itself may still resurrect a run that
a single MCP mutation started**. Evicting a receipt sooner would discard the answer to "did my
operation happen?" while the engine still intends to act on it.

**Deliberately not rounded.** 84 h is not "3.5 days" rounded to 4, and not rounded up to a week.
Every rounding step would add a number with nothing behind it, and an odd-looking attributable
number is worth more than a tidy invented one.

**Limit, stated:** the 5-hour figure is read from a code comment describing provider behaviour, not
from a provider's published contract, and providers may change their windows. If that figure moves,
84 h moves with it — the derivation is the decision, and the arithmetic is its output.

**Why the 30-minute step timeout is not the anchor.** `DEFAULT_RUN_TIMEOUT_MS`
(`claude-cli-runner.ts:32`) bounds one agent step, not a task. `AGENTS.md` § Workflows notes that a
workflow's last interactive step is uncapped and that the project kit's author workflows set two
hours. A retention derived from the step timeout would be short by more than an order of magnitude.

### 8.3 The 50 000, and the measurement that fixed it

**Budget anchor, read from source:** 300 ms — the run store's own save debounce
(`store.ts:1391-1396`). That is the latency this codebase already treats as invisible for index
work. Receipt recovery happens **once per project open**, so one debounce window is a defensible
ceiling for it.

Against § 3.2's measurements:

| Receipts | Scan (this host) | % of 300 ms | Scan (`--jitless`) | % of 300 ms |
| --- | --- | --- | --- | --- |
| 10 000 | 7.3 ms | 2.4 % | 11.6 ms | 3.9 % |
| **50 000** | **40.6 ms** | **13.5 %** | **53.7 ms** | **17.9 %** |
| 100 000 | 78.8 ms | 26.3 % | 119.9 ms | 40.0 % |
| 200 000 | 201.1 ms | 67.0 % | 216.7 ms (max 249.2) | 72.2 % (83.1 %) |

**50 000 is chosen** because it holds under a fifth of the budget even on a deoptimised runtime, so
the budget is only reached on a host roughly 5.6× slower than this one *after* deoptimisation.
**200 000 is refused**: it consumes two thirds of the budget at its median on the fastest
configuration measured, and its worst observed run under `--jitless` reached 249 ms — one bad run
from blowing the budget outright, before any slower hardware is considered. 100 000 would also fit,
and 50 000 is taken because § 8.4 shows it already provides ample structural headroom, so the extra
20 MB buys nothing.

Disk cost at 50 000: **20.9 MB** per project, from a measured 417 bytes per receipt.

### 8.4 The structural floor: receipts must outlive their runs

A receipt whose `resultRef` names a deleted run is a dangling pointer, so retention has a second,
non-negotiable requirement: **a receipt must never be evicted before the run it names.**

The run store keeps at most `MAX_RUNS_KEPT` 300 non-archived plus `MAX_ARCHIVED_KEPT` 500 archived
runs, deleting the event file, handoff and images alongside (`store.ts:328-329`, `store.ts:1370-1387`).
That is 800 runs. 50 000 receipts ÷ 800 retained runs = **≈ 62 mutations per retained run** before
the count bound can bite. A leader that issues more than about 62 mutations against a single task will
evict its own oldest receipts first, which is the correct order.

**Decision — phase 4 asserts this rather than assuming it:** the retention test must fail if a
receipt is evicted while the run in its `resultRef` is still in the index.

### 8.5 Residual risk

Neither bound protects against power loss (§ 3.3's scope limit): `appendFileSync` does not `fsync`,
so a machine that loses power may lose the last journal lines from the page cache. This is
**unproven either way** and is recorded here as a known gap rather than solved. It is not a new risk
class — `store.ts` writes its event journal the same way — but a receipt is load-bearing for
idempotency in a way an event line is not, so phase 4 should decide explicitly whether the `intent`
append warrants an `fsync` and measure the cost. **Technical proposal**, not closed here.

## 9. Decision — uncertain external effects

### 9.1 The hard case

A crash lands between step 4 and step 5 of § 7.3: the effect happened, the receipt says only
`intent`. Restart. The leader retries. Blindly repeating creates a second pull request, a second
merge attempt, or a second task.

### 9.2 Decision — the status name

**Decision.** The status is **`unverified`**.

It is one word used in three places so they cannot drift: the receipt `phase`/`outcome`, the tool
result `status`, and the value a retry returns. The corresponding UI label is **"Outcome being
verified"**, which is not invented here — [requirements](mcp-project-leader-requirements.md) row
U-M07 already proposes it, and the state inventory already carries "Error / conflict / uncertain
external outcome". This record supplies the protocol name for the state those rows describe.

`unverified` is distinct from every other outcome and must never be collapsed into one:

| Status | Means |
| --- | --- |
| `ok` | The effect happened and the result is recorded |
| `rejected` | Refused before any effect — validation, `stale_version`, permission |
| `not-applied` | Reconciliation **established** that the effect did not happen |
| `in-progress` | The operation is live **in this process** and will settle. Not a stored outcome — it is derived from liveness at lookup time (§ 6) |
| `unverified` | The effect **may** have happened and reconciliation has not established which. Never retried automatically |

### 9.3 Decision — reconciliation, executably

**Decision.** Each action declares a **reconciler** beside itself. A reconciler answers exactly one
question — *did this effect happen?* — using an **idempotent read**, never a write. The predicate it
needs is recorded in the `intent` line at step 3 of § 7.3, **before** the effect, because after a
crash there is nothing else to reconstruct it from.

| Reconciler kind | Predicate recorded in `intent` | Idempotent read | Verdict |
| --- | --- | --- | --- |
| `run-by-key` | the **predicted run id**, derived from the operation key before the effect (§ 12.1) | `store.getRun(predictedRunId)` — a primary-key lookup, no scan | found → `ok`; absent **and the index can still answer** → `not-applied` (the store write **is** the effect, so its absence is proof); absent **and the index can no longer answer** → `unverified` (see below) |
| `forge-search` | the search terms — head branch, repository, and `startedAt` | The forge's own list/search read, e.g. `gh pr list --head <branch> --json number,createdAt` | a match created at or after `startedAt` → `ok`; the forge answers and has no match → `not-applied`; **the forge is unreachable, unauthenticated, or answers ambiguously → stays `unverified`** |
| `git-state` | the expected ref and its target sha | `git rev-parse` / `git log` in the bound repository | ref at the expected sha → `ok`; ref absent or elsewhere → `not-applied` |
| `none` | — | — | The action has no external effect and cannot reach this state; declaring `none` on an action that does is a phase-4 review failure |

**Decision — `run-by-key` must not read a pruned run as a run that never existed.** The run store
evicts by count, not by age (`store.ts:1370-1387`), so a busy project can delete the very run a
dangling `intent` names while the receipt is still retained — § 8.4's floor guarantees the receipt
outlives the run, which is exactly the direction that creates this hazard. The executable rule:
compare the intent's `startedAt` against the `createdAt` of the **oldest run still in the index**.
If `startedAt` is the older of the two, the index has already pruned past this operation and can no
longer answer the question, so the verdict is **`unverified`** — never `not-applied`. This is the
same fail-open discipline as rule 3 below, applied to xezar's own store rather than to an external
system: "the run is not there" and "the store can no longer tell you" must not share a branch.

**Decision — the rules that hold for every reconciler:**

1. Reconciliation runs for every `intent` with no `settled` — after project open, **in the
   background and never awaited**, and again on demand when a retry arrives for such a key. N-07
   forbids MCP from blocking ordinary cockpit startup, and a `forge-search` reconciler shells out to
   `gh`; making boot wait on that would trade one requirement for another. This follows the
   precedent `openStore` already sets for `armRepoHandle`, which is started in the background
   "never awaited: a `gh`-less or offline machine keeps working exactly as it did"
   (`packages/xezar/src/index.ts:673-675`). Until a receipt's reconciliation completes it reads
   `unverified`, which is the truthful answer, not a placeholder.
2. A reconciler may only **read**. A reconciler that mutates to determine an outcome is prohibited —
   it would be the blind repeat this whole section exists to prevent.
3. `not-applied` requires a **positive answer from the external system**. Silence, a timeout, a
   network error, or a missing `gh` are all `unverified`. This is the fail-open trap in its natural
   habitat: "we could not ask" and "we asked and it is not there" must not share a branch, and phase
   4's test suite must pin the unreachable case explicitly.
4. A key that stays `unverified` **stays `unverified` on disk**, and every retry returns it with the
   recorded evidence and the predicate that was tried. It never decays into `ok` or `not-applied`
   with age.
5. The **only** legitimate leader moves from `unverified` are: read current state, or issue a
   **new** `operationId` for deliberately new work — a conscious decision that any duplicate is
   acceptable. The server never makes that decision.

**Decision — the tool response for an unverified key:**

```
{ status: "unverified",
  operationId: "<as supplied>",
  action: "<action>",
  startedAt: "<iso>",
  reconcile: { kind: "forge-search", attemptedAt: "<iso>", reason: "gh unavailable" },
  guidance: "read current state; a new operationId is a new action" }
```

`reason` is a short machine-readable string, never a raw error body — a raw body from `gh` or a git
command can carry a token or a path, and § 10.3's exclusion rule applies here too.

This satisfies A-14's "uncertain external outcome are explicit and never blindly repeated" and the
state-inventory row "never offer blind repeat with a new key".

## 10. The audit record (N-04)

### 10.1 What is weak here, and stays weak

**Agreed, and deliberately weaker than N-03 and N-10.** N-04 says history *should* identify action,
time, project, resource, outcome and UI/MCP origin without storing secrets, and that the identity
model and audit retention **remain open**. This record does not upgrade "should" to "must", does not
close retention, and does not invent an identity model. What follows is split so the difference is
visible at a glance.

**Scoped absence claim:** no audit-log surface and no `origin` field on run records were found in
the files examined (`packages/contract/src/`, `packages/xezar/src/server/`,
`packages/xezar/src/runs/store.ts`). The audit record is new work, not a change to something
existing.

### 10.2 Decision — the field list

| Field | Type | MUST / SHOULD |
| --- | --- | --- |
| `ts` | ISO 8601 | SHOULD |
| `projectId` | string, from the trusted connection binding | **MUST** |
| `action` | the action id, e.g. `runs.create` | SHOULD |
| `resource` | `{ kind, id }` — never a path, never content | SHOULD |
| `outcome` | `ok` / `rejected` / `not-applied` / `unverified` | SHOULD |
| `origin` | `ui` \| `mcp` \| `automation` \| `cli` | **MUST be server-derived** (§ 10.4) |
| `ownerGeneration` | number, or absent for non-MCP origins | SHOULD |
| `operationKey` | string, absent for non-MCP origins | SHOULD |
| `versionToken` | the `expectedVersion` the caller sent | SHOULD |
| `payloadDigest` | SHA-256 hex | SHOULD |
| `errorCode` | short enum member, absent on success | SHOULD |

The first six fields are exactly the six things N-04 names, one for one: action → `action`, time →
`ts`, project → `projectId`, resource → `resource`, outcome → `outcome`, UI/MCP origin → `origin`.
The remaining five are the joins that make an entry investigable — without `operationKey` an audit
trail cannot be tied to the receipt that explains it.

### 10.3 Decision — what is excluded, and why

**MUST NOT be stored:** prompt and brief text; message bodies; file contents; diffs; command output;
tokens, credentials or connection data; agent account identity; model output; absolute filesystem
paths; any identifier belonging to another project.

Two reasons, and the first is the load-bearing one:

**The record carries no free text at all, by construction.** `store.ts:1258-1268` scrubs event
payloads before they touch disk, and that scrubber is real and on by default — but it is
pattern-and-known-value matching, it has an `XEZ_REDACT_SECRETS=0` opt-out, and it is described in
its own comment as best-effort. An audit trail that holds free text is only as good as that
scrubber on its worst day. Holding **digests and enum members instead of text** removes the failure
mode rather than mitigating it. F-15 requires that credentials never enter history, and this is the
strong form of that.

**Paths and foreign identifiers are an isolation surface.** N-01 requires that an inaccessible
resource must not reveal another project's name, content, or existence, and
`BACKWARD_COMPATIBILITY.md` § 2 records that absolute paths carrying a username were trimmed from
`/api/v1/health` for exactly this reason. An audit reader inherits that rule.

**What is lost, said plainly:** an auditor cannot reconstruct *what* a task said from this record —
only that an action of a kind happened, to which resource, from where, and with what result. That is
the trade this record chooses, and it is the trade N-04's "without storing secrets" asks for.

### 10.4 MUST — attribution cannot bypass permissions

Three rules, all **MUST**, all following from requirements that are themselves hard (N-01, N-09,
F-16):

1. `origin` is written **by the server** from how the request arrived. A client-supplied origin
   field is ignored if present, never trusted. N-09: tasks, files and results are data, not sources
   of authority.
2. Reading the audit trail is a **project-scoped read**, enforced by the same ownership validation as
   every other read (F-02, F-16). A leader bound to A cannot read A's entries about B, because A has
   no entries about B — the trail is per project.
3. An audit entry **grants nothing**. It is a record of a decision, never an input to one. In
   particular, an `origin: "ui"` entry must never widen what MCP may do, and the record's presence
   must never substitute for a permission check.

### 10.5 Open — retention and identity model

**Open.** N-04 keeps audit retention and the identity model open, and this record leaves them open.

**Technical proposal**, offered for the phase that closes it and explicitly not a decision: store the
audit trail as its own append-only NDJSON beside the receipts, with the same line-level quarantine
(§ 7.4), and bound it the way the run store bounds its own history — by count, not by duration.
`store.ts` retains by count (`MAX_RUNS_KEPT`, `MAX_ARCHIVED_KEPT`) rather than by age, and an audit
trail has the same property that motivated that: its size is driven by activity, not by calendar
time. **No number is proposed**, because the measurement that would fix one is a real audit entry
size against a real activity rate, and neither exists yet.

Note the deliberate asymmetry: **receipt** retention is closed by this record (§ 8) because D-06
requires it and idempotency depends on it. **Audit** retention is a different question that N-04
holds open, and closing it here would be softening the requirements document in the other direction.

Operational packaging bounds more broadly are decision **D-09**, issue
[#84](https://github.com/qodeca/xezar/issues/84).

## 11. Scoped absence claims

Each of these is scoped to the files examined at `9fdcf0e`, and none says "does not exist".

| Claim | Files examined |
| --- | --- |
| No `updatedAt`, `rev` or `version` field on `RunRecord` | `packages/xezar/src/runs/store.ts` (full grep for `updatedAt`, `revision`, `version`) |
| No `ETag` / `If-Match` concurrency control on the HTTP API | `packages/xezar/src/server/server.ts`, `packages/contract/src/*.ts` — the only `etag` hits are per-query GitHub ETags in `packages/contract/src/automations.ts:125-126`, which are a rate-limit cache, not concurrency control |
| No audit-log surface | `packages/contract/src/` (full listing), `packages/xezar/src/server/` |
| No `origin` field distinguishing UI from MCP on run records | `packages/contract/src/runs.ts`, `packages/xezar/src/runs/store.ts` |
| No existing durable operation-key or idempotency mechanism | `packages/xezar/src/runs/`, `packages/xezar/src/server/`, `packages/xezar/src/workspace/` |
| No `.passthrough()` anywhere in `packages/xezar/src/runs/store.ts` — so `runRecordSchema` strips unknown keys | `packages/xezar/src/runs/store.ts` (`grep -c passthrough` → 0). This is the finding behind § 12.1 and § 13.3 |

## 12. Backward compatibility (N-08)

`BACKWARD_COMPATIBILITY.md` § 3 line 104 is the governing rule: new `runs.json` fields must be
optional or defaulted, because "a required new field silently drops every pre-existing run — the
loader `safeParse`s the whole array".

The outcome of applying it here is that **this record adds no persisted field at all** — § 12.1
explains why the obvious one was refused, and § 13.3 records what that refusal teaches about the
rule itself.

### 12.1 No new persisted field — a predicted run id instead

The obvious design was an optional `mcpOperationKey` on `runRecordSchema`, giving `run-by-key`
(§ 9.3) a handle to search on. **Reading the source refuted it**, and the refutation is worth
recording because the same trap is waiting for any similar field.

**Read from source:** `runRecordSchema` (`store.ts:109-313`) is a plain `z.object({…})` with **no
`.passthrough()`** — grep for `passthrough` in that file returns nothing. Zod strips unknown keys by
default, so an older xezar that opens `runs.json` **drops** the key on load and its next debounced
save (`store.ts:1391-1404`) writes the record back without it. The field would not merely go unread
on a downgrade; it would be **erased**, permanently, and the reconciler's only handle would be gone
for every run touched while the user was downgraded. `BACKWARD_COMPATIBILITY.md` § 3 line 37 records
the same lesson from agent accounts: putting them in `config.json` "made their survival depend on a
`.passthrough()` in that version's schema".

Adding `.passthrough()` to `runRecordSchema` would fix it and is **refused here** — it changes how
every field of the central record behaves, for the sake of one new key, and that deserves its own
review rather than riding along in an MCP decision.

**Decision — the run id is predicted, not recorded.** The MCP layer derives the run id
deterministically from the operation key before the effect:

```
predictedRunId = uuidv5(operationKey, XEZAR_MCP_NAMESPACE)
```

and writes it into the `intent` line at step 3 of § 7.3. Reconciliation is then a plain
`store.getRun(predictedRunId)` — a lookup on the primary key, no scan and no new field.

Why this is strictly better:

- **Nothing new is persisted.** `id` is an existing required field and its shape is unchanged, so a
  downgrade reads an MCP-created run as an ordinary run and there is nothing to strip.
- **A retry predicts the same id** — which is the behaviour wanted — while two different operations
  cannot collide, because the operation key they derive from is already unique per operation.
- The reconciler's question becomes exact: the run either exists under that id or it does not.

**The one source change phase 4 makes, named and not made here:** `createRun`
(`store.ts:769-784`) generates `id: randomUUID()` internally and accepts no id. It gains an
**optional `id` input**, defaulting to `randomUUID()` exactly as today, and **throws** when a
supplied id already exists. That is a widened input type, not a schema or file-format change, and
every existing caller is unaffected.

### 12.2 The new state files

`.local/xezar/mcp-operations.ndjson` and `.local/xezar/mcp-operations.json` are additive project
state, the same class as `tmp/<runId>/` recorded at `BACKWARD_COMPATIBILITY.md` § 3 line 115.
Nothing else reads them; deleting them loses idempotency history and nothing else, and an older
xezar ignores them entirely. Per N-07, their absence must not block cockpit startup.

**Decision — confine the sweep.** § 8's eviction touches `mcp-operations.*` and nothing else. The
`tmp/<runId>/` entry makes the equivalent rule explicit for its own subtree ("reaping anything under
`runs/`, `worktrees/` or `runs.json` from here would be breaking"), and the same applies here.

### 12.3 `ensureDataGitignore` — the change that is **not** needed

The issue text and `AGENTS.md` § Task routing both say a new state file needs `ensureDataGitignore`
upkeep in `packages/xezar/src/index.ts`. **Read from source, this is not so** — see the correction
in § 13.2. No change to `index.ts` is required for these files.

### 12.4 No permission is expanded

Nothing in this record grants access. The version check and the operation key are **restrictions**:
they cause mutations to be refused that would otherwise proceed. `projectId` comes from the trusted
connection binding, never a parameter (§ 5.2), so project binding is preserved rather than widened.
An upgrade to a xezar that implements this record makes strictly fewer mutations succeed, never more.

## 13. Corrections — where a document and the source disagree

**The source wins**, per this phase's rules. Three disagreements were found, and all three are
recorded here rather than quietly worked around. None is edited into the documents concerned — those
files belong to other tasks.

### 13.1 A fixed `.tmp` name in the run store, versus the rule in the workspace config

`packages/xezar/src/workspace/config.ts:464-477` states the rule and its reason at length: the
staging tmp path must be unique per write, **never** a fixed `${path}.tmp`, because two writers
staging through the same name interleave — writer B's `O_TRUNC` open can empty the file between
writer A's write and rename, so A renames a truncated file into place and B's own rename then throws
`ENOENT`.

`packages/xezar/src/runs/store.ts:1399-1404` uses a **fixed** `${indexPath}.tmp`.

**This record makes no claim that `runs.json` is buggy**, and it is not this task's file: the writer
claim in `project-writer.ts` is designed to keep a project's data directory to one writing process,
which is a plausible reason the fixed name has been safe there. It is recorded because a future
reader copying `store.ts`'s pattern into a new file could inherit a hazard the neighbouring module
documents in detail. **Decision:** the receipt store follows `config.ts`.

### 13.2 `ensureDataGitignore` needs no per-file upkeep

`AGENTS.md` § Task routing says: "Keep `.local/.gitignore` maintenance (`ensureDataGitignore`) in
sync with any new state file", and issue [#83](https://github.com/qodeca/xezar/issues/83) repeats it.

**Read from source**, both helpers write a single blanket rule and nothing per-file:

- `packages/xezar/src/index.ts:681-690` — "Everything the engine writes lives under `.local/`, so one
  blanket rule covers it all"; it appends `*` if the file does not already contain that line.
- `packages/xezar/src/project-data-paths.ts:16-25` — the same `*`, guarded by a `basename(dirname(…))
  === '.local'` check.

**Correction:** a new state file under `<repo>/.local/xezar/` is already ignored, and no code change
in `index.ts` is required for it. The guidance is a stale generalisation of a per-file list that the
current source does not keep. Phase 4 should not open a change there and then find nothing to write.
What **is** required is that the file live under the project data directory that
`ensureProjectDataIgnored` guards — which `.local/xezar/` does.

### 13.3 "Optional so old files still parse" is necessary, not sufficient

Both the issue and `AGENTS.md` § Runs store state the rule as: new persisted fields must be optional
so old files still parse. That is true and it is not the whole test — which this record found by
applying the rule and then reading the schema.

**Read from source:** `runRecordSchema` (`store.ts:109-313`) carries **no `.passthrough()`** (grep
for `passthrough` in that file: zero hits), unlike the workspace config, which uses it at every
object level and explains why (`config.ts:19-21`). An optional field therefore satisfies "old files
still parse" **and is silently erased** by an older xezar, which strips it on load and omits it on
the next save. Parsing and surviving are two different guarantees, and only the first is what the
rule as written asks for.

`BACKWARD_COMPATIBILITY.md` § 3 line 37 already records this from the agent-accounts case
("made their survival depend on a `.passthrough()` in that version's schema"), but the runs-store
guidance does not carry the caveat.

**Correction, for whoever adds the next `runs.json` field:** ask both questions. *Does an old file
still parse?* — optionality answers that. *Does the value survive a round trip through a xezar that
does not know the key?* — only `.passthrough()` answers that, and `runRecordSchema` does not have
it. This record's answer was to need no field at all (§ 12.1). No document is edited here; the two
files that would carry this note belong to other tasks.

## 14. What phase 4 has to build

Enumerated so nothing here is left as an intention. Every item is a **Decision** from this record
unless marked otherwise.

1. A version-token module: compute the token for each resource kind, and one `assertVersion` used by
   every mutating service call (§ 4). Its test must pin the **absent `expectedVersion`** case as a
   rejection, not a pass.
2. The projection field list per resource kind — this record fixes the **rule**; the concrete list is
   a **technical proposal** to be reviewed against the final schemas (§ 4.3).
3. The receipt store: journal, offset-anchored snapshot, line-level quarantine, load-time fold,
   count-and-age eviction (§§ 7, 8). Its test must pin the **torn final line** case, and specifically
   that a key miss with a non-empty quarantine does **not** execute (§ 7.4).
4. `operationId` as a required argument on every mutating tool schema, and the § 6 five-result
   lookup ahead of every effect.
5. The `reconcile` predicate recorded in `intent`, and one reconciler per action kind (§ 9.3). Two
   cases must be pinned by test, because each is a fail-open branch that passes silently when it is
   wrong: the **external system unreachable** case must be `unverified`, not `not-applied`; and the
   **run pruned out of the index** case must be `unverified`, not `not-applied`.
6. An **optional `id` input** on `createRun`, defaulting to `randomUUID()` and throwing on a
   duplicate — the only source change outside the MCP layer, and **no** new persisted field
   (§ 12.1).
7. The audit writer with the § 10.2 fields, server-derived `origin`, and no free text. Its retention
   stays **open** (§ 10.5).
8. Contract schemas for `expectedVersion`, `operationId`, `stale_version`, `operation_key_conflict`
   and `unverified` in `packages/contract`, per `AGENTS.md` § "The HTTP API": one zod definition per
   shape, type inferred, route registered by chaining, validated as middleware.
9. The regression discipline `AGENTS.md` § "Changing a mechanism that already works" requires: for
   each of the four guard tests named above, stash the source files, confirm the test is **red**,
   restore them. A test written after the diagnosis passes against the bug more often than anyone
   expects, and all four of these guard a branch that is silent when it is wrong.

## 15. Dependencies on other decisions

| This record needs | Owner | State here |
| --- | --- | --- |
| `ownerGeneration` semantics — lease, fencing, expiry | D-02, issue [#80](https://github.com/qodeca/xezar/issues/80) | Recorded in the receipt; **not settled here** |
| Event ids, ordering, replay cursor and acknowledgements | D-05, issue [#82](https://github.com/qodeca/xezar/issues/82) | The version token consumes `seq`, which that decision also touches; the two must agree that `seq` stays monotonic and never reused |
| Transport and bridge | D-01, issue [#79](https://github.com/qodeca/xezar/issues/79) | Assumed only to deliver `operationId` and `expectedVersion` as ordinary arguments |
| Operational limits, retention bounds and packaging | D-09, issue [#84](https://github.com/qodeca/xezar/issues/84) | Receipt retention is closed here (§ 8); audit retention is **not**, and belongs with the open question in § 10.5 |
| Whether real clients can carry these fields | issue [#85](https://github.com/qodeca/xezar/issues/85) | **Not attempted here.** No client was exercised by this spike |

## 16. Acceptance-case traceability

| Case | What this record supplies |
| --- | --- |
| **A-13** — human changed a resource after leader read | § 4.4: `stale_version` with no state change, current token returned, fresh read required. § 4.5: the check and the write are one critical section, so concurrent calls cannot both pass |
| **A-14** — mutation executed but response lost | § 6: same key replays without effect; a new `operationId` permits new identical work; a conflicting payload is explicit and returns no result. § 9: crash and uncertain external outcome resolve to `unverified`, never a blind repeat |
| **A-16** — restart, corrupt or absent state | § 7.4: line-level quarantine, snapshot ignored on parse failure, never a boot failure. § 12: two additive files, **no** new persisted field, no expanded authority |
| **A-21** — replay duplicates | § 6 makes a duplicate delivery of the same operation a no-effect replay |
| **UX-M04** — conflict says not applied; retry preserves identity | § 4.4 distinguishes rejection from post-execution failure; § 9.2 supplies the protocol name behind U-M07's "Outcome being verified"; § 6 forbids the server generating a new identity for a retry |

## 17. Limits of this record

- **Nothing here has been implemented or run against a real MCP client.** The measurements in § 3
  exercise a prototype of the storage layer only, on one machine, and the prototype is not committed.
- **The 5-hour provider window** behind § 8.2 is read from a code comment, not a provider contract.
  If it changes, 84 h changes with it.
- **The `--jitless` column is not a CI measurement.** No 2-core runner was exercised.
- **Power-loss durability is unproven** in either direction (§ 3.3, § 8.5).
- **The predicted-run-id design (§ 12.1) was not prototyped.** It rests on a source reading — that
  `runRecordSchema` has no `.passthrough()` and `createRun` generates its own id — which was
  verified, and on a `createRun` change that has not been written.
- **The concrete projection field lists** (§ 4.3) and the **12-hex truncation width** (§ 6) are
  technical proposals, not decisions, and both need the final schemas to settle.
- **Audit retention and the audit identity model stay open** (§ 10.5). This record deliberately does
  not close what N-04 keeps open.
- None of the numbers here is a product guarantee. They are engineering decisions with their
  derivation attached, and § 1 says which section owns each one.
