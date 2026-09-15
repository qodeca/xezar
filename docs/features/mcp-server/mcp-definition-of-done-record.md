# MCP project leader — whole-feature Definition of Done record

Issue: [#119](https://github.com/qodeca/xezar/issues/119). Phase 8 ([#75](https://github.com/qodeca/xezar/issues/75))
of [epic #67](https://github.com/qodeca/xezar/issues/67). This is the record the eight clauses of
[requirements § Whole-feature Definition of Done](mcp-project-leader-requirements.md#whole-feature-definition-of-done)
are judged by. Its sibling for the rest of the release is
[`docs/releases/0.14.0-definition-of-done.md`](../../releases/0.14.0-definition-of-done.md), which
explicitly leaves the MCP clauses to this page.

## Answer first

**Seven of the eight clauses hold as of 2026-09-15. One does not: clause 2.** The gate still does not
close green.

- **Clause 3 now holds for every client in scope.** A real model reacted to a delivered xezar event
  for **pi** (2026-09-13, `7aa4a02`), **Claude Code** and **Codex** (both 2026-09-15, `a6d53b4`) —
  see [§ Real-model reaction](#real-model-reaction-a-19--a-23-per-client). Push delivery to Claude Code
  and Codex is built (#403, #404; #374 closed). **OpenCode is out of scope for the real-model clause
  by the project owner's decision of 2026-09-13** (5 of 5 stalled runs; its reaction reporting is still
  open as [#340](https://github.com/qodeca/xezar/issues/340)).
- **Clause 8 holds.** Both sign-offs are written down, on
  [#119](https://github.com/qodeca/xezar/issues/119#issuecomment-5646331208) (2026-09-12).
- **Clause 2 does not hold.** A-01–A-23 have never all passed on **one** revision: the whole suite ran
  on `ed579e63`, pi's real-model leg on `7aa4a02`, the Claude Code and Codex legs on `a6d53b4`, and the
  rows that were BLOCKED or FAILED on `ed579e63` (A-20's leader half, pi's `approveTools` edge, fixed
  by #411) have not been re-run on a common revision since.

The verdicts below from 2026-09-12 are kept as they were measured; where a later measurement changed
one, the table says which and when.

| Clause | Verdict |
| --- | --- |
| 1 — every UI business action classified; every project action has a working MCP equivalent | **MET.** Coverage measured below; the product owner's approval is the clause 8 sign-off on #119. |
| 2 — all of A-01–A-23 pass on the same release-candidate revision | **NOT MET.** A-19 and A-23 now PASSED for pi (`7aa4a02`), claude-code and codex (`a6d53b4`); opencode is out of scope for the real-model clause (owner, 2026-09-13, #340). Not one revision: A-20's leader half and pi's `approveTools` edge were BLOCKED/FAILED on `ed579e63` and not re-run on a common revision. |
| 3 — stale writes, idempotency, survival, ownership, async delivery **and model reaction**, live UI, unchanged quality | **MET for the in-scope clients** (2026-09-15). The real model reaction was observed for pi, claude-code and codex; OpenCode is out of scope by the owner's decision of 2026-09-13 (#340). Was NOT MET on `ed579e63`. |
| 4 — D-01–D-09 resolved as needed; the documentation states the actual mechanism | **MET.** |
| 5 — the settings matrix removes ambiguity; negative tests cover each resource family | **MET** on `5834b36` (this record's own commit); one family (`local_handoff`) was uncovered on `ed579e63` and is covered by the two tests that commit adds. |
| 6 — the complete human/leader flow, with no built-in leader, no global administration and no new release engine hidden in it | **MET.** |
| 7 — the repository quality gate; reviewable integration tests and evidence | **MET** for every command run here; the canonical gate is this task's own gate stage. |
| 8 — product approves coverage, the responsible engineer approves the technical evidence; known limitations contradict no obligatory criterion | **MET.** Both sign-offs are written on [#119](https://github.com/qodeca/xezar/issues/119#issuecomment-5646331208) (2026-09-12, against `ed579e63`). The limitation half is met (§ PI-08). The 2026-09-15 real-model evidence postdates those sign-offs. |

## The revision

**`ed579e63cf9e0c30cfa2b2b4fa817fd4798914b5`** (`main`, `docs(mcp): say not to gate xezar's tools with
pi's approveTools (#370) (#371)`), clean tree. Run date **2026-09-12**. Host macOS 26.6.2
(Darwin 25.6.0, arm64), Node v24.20.0, npm 11.19.0. Clients as installed on the host:
**Claude Code 2.1.269**, **Codex CLI 0.154.0**, **OpenCode 1.18.30**, **pi 0.85.1** with
**pi-mcp-adapter 2.32.1**. Installed versions, not certified minimums.

The revision is not an assertion: the real-client harness writes
`revision: { sha: "ed579e63…", dirty: false }` into its own `results.json`, and that file is the
evidence behind every real-client row below.

**Two SHAs, and the difference matters.** Every A-row verdict was measured on `ed579e63`. The two
tests this branch adds (§ What this run added) change **no product file** — `git status --porcelain`
during the run showed exactly one modified file, `acceptance-isolation.test.ts` — so they cannot move
an A-row verdict. They matter to clause 5 only, and clause 5 is recorded against the branch head that
carries them. Nothing else on this page rests on a revision other than `ed579e63`.

## Post-release pi real-model measurement (#373)

This addendum updates only pi's real-model clause; the release measurements and the other
clients' rows below remain historical evidence on `ed579e63`. It does not claim that all
acceptance criteria passed together on a new revision.

| Criterion | Client | Measurement | Verdict |
| --- | --- | --- | --- |
| **A-19 — real-model clause** | pi | Stamp `2026-09-13T17-43-42.875Z`: exact nonce/cursor MCP ack from real model at `deepseek-v4-flash-vision`. Scripted control: 1 request, 0 acks over 45 s quiet window. Real leg: 2 requests, ack at +15.8 s with exact nonce and cursor, window 120 s. | **PASSED** on revision `7aa4a0258cd99852ff0a6878dff1c96257f49024` |
| **A-23 — pi reaction clause** | pi | Dependent on A-19 now met; pi reaction measurement confirms setup and exclusivity. | **PASSED** on revision `7aa4a0258cd99852ff0a6878dff1c96257f49024` |

Evidence: `.local/qa/mcp-real-model/2026-09-13T17-43-42.875Z/` (`results.json`,
`real-pi.ndjson`, `ack-ledger.json`, `requests.json`, and each leg's delivery/command files),
preserved in primary task `.local/xezar-tasks/<runId>/` (local only; QA evidence not pushed).
Measured on revision `7aa4a0258cd99852ff0a6878dff1c96257f49024`;
`results.json` records source hashes and the exact invocation.

The unauthenticated endpoint request is not a measurement of the model. The owner corrected
its initial FAILED classification to NOT-RUN; `results.json` preserves that correction and its
original classification. The transcript records `401 Unauthorized`;
authentication must be supplied through `XEZ_REAL_MODEL_API_KEY` before inference can be
measured. No personal pi configuration or credentials were read. A request count alone and a
model's “I reacted” text remain insufficient to pass. This does not change Clause 2's NOT MET
verdict or convert any claude-code, codex or opencode result. (The Claude Code and Codex results were
measured separately on 2026-09-15 — § Real-model reaction.)

## How to read it

| Label | Meaning |
| --- | --- |
| **PASSED** | Every required check was executed and met, on `ed579e63`. |
| **FAILED** | A required check was executed and not met. The missing piece is named. |
| **BLOCKED** | A required check cannot be observed in a § 9 fixture, or depends on a piece that does not exist. **Never a pass.** |
| **NOT RUN** | Not attempted, with the reason. **Never a pass.** |

A `TEST_E2E_STATUS=skipped` browser run is not a pass and is not used here — the run below reports
`passed`. A model assertion alone is not a pass: A-19's reaction rows count the model's requests at a
scripted endpoint inside the harness, and the real-model clause stays BLOCKED rather than being
converted.

## A-01 … A-23 on `ed579e63`

Fixture configurations referenced in the table:

- **F1 — the shared A/B world** (`packages/xezar/test/helpers/ab-fixture.ts`, #115): two real git
  repositories, A's real `RunManager`, the real MCP service loop on one Unix socket per project,
  `XEZ_DRY_RUN=1`, provider auth stubbed, hermetic git, no personal account and no secret. Route level.
- **F2 — the shipped product**: a real `xezar serve` from `packages/xezar/dist/index.js` over a fresh
  fixture repository, `XEZ_DRY_RUN=1`, isolated `XEZ_HOME`, agent config folders pinned empty, reached
  through the real `xezar mcp` stdio bridge.
- **F3 — real clients, isolated**: each client with `HOME` and its own config folder pinned to a
  scratch folder and every `ANTHROPIC_*`, `OPENAI_*`, `CODEX_*`, `CLAUDE_*`, `OPENCODE_*`, `XDG_*` and
  `XEZ_*` variable removed. Any model turn goes to a scripted local Anthropic-Messages endpoint inside
  the harness. No model, no account, no secret.
- **F4 — the real browser**: `npm run test:e2e`, a real `xezar serve` on a free port with
  `XEZ_DRY_RUN=1` and a pinned `XEZ_HOME`, driven in a real Chrome through the `agent-browser`
  provider.

| Row | Fixture | Client | Scenario | Result |
| --- | --- | --- | --- | --- |
| **A-01** | F2 | (service) | the running service writes `<root>/.local/xezar/mcp-connection.json`, mode 600, matched by `.local/.gitignore` | **PASSED** |
| **A-01** | F2 | (service tools) | the real bridge's `health` and `task_read` reach the service | **PASSED** |
| **A-01** | F3 | claude-code | `claude mcp add --scope local`, then the client reaches A and sees nothing of B | **PASSED** |
| **A-01** | F3 | codex | project `.codex/config.toml` + trust entry, then the client reaches A and sees nothing of B | **PASSED** |
| **A-01** | F3 | opencode | `opencode.json` `mcp.xezar` block, then the client reaches A and sees nothing of B | **PASSED** |
| **A-01** | F3 | pi | `pi install npm:pi-mcp-adapter@2.32.1` into a throwaway `PI_CODING_AGENT_DIR`, then the client reaches A and sees nothing of B | **PASSED** |
| **A-01 edge** | F3 | pi | a xezar tool the person gated behind the adapter's `approveTools` must end with a named reason, not hang | **FAILED** — see § PI-08 |
| **A-02** | F1 | — | a key naming B, `default`, B's root, B's basename, a scoped URL or a `..` path, across five key names and every registered tool | **PASSED** |
| **A-02** | F1 | — | a custom client re-scoping the socket through raw frames, `bind` and `project/select` | **PASSED** |
| **A-03** | F1 | — | valid B ids through 6 reads and 21 mutations; a B message inside an A task; a foreign winner; a hostile mixed A/B group; a B automation and its receipt; the desktop hand-off | **PASSED** |
| **A-04** | F1 | — | search, pagination, foreign cursors, absolute / `..` / symlink paths, workspace events | **PASSED** |
| **A-05 … A-11** | F1 | — | P-01…P-38: each cockpit route and its MCP tool from equivalent starting states, compared on the business outcome | **PASSED** |
| **A-08** | F4 | (real browser) | B-01…B-03: the leader's work appears live in the open cockpit and the human's clicks reach the leader, with no reload | **PASSED** |
| **A-12** | F1 | — | startup, errors, tools, events and history, then the credential found nowhere in the trail, journal, responses or git | **PASSED** |
| **A-13, A-14, A-15, A-16, A-21, A-22** | F1 + core modules | — | stale writes, operation keys and collisions across a real `SIGKILL`, task survival offline, absent and corrupt state files, replay and retention, refused global writes | **PASSED** |
| **A-17** | F2 + F3 | all four | a second logical client of A is refused as occupied while the owner's own requests and project B keep working | **PASSED** |
| **A-18** | F2 + F3 | (bridges), pi | model silence keeps ownership, a crash hands over to exactly one successor, the stale owner is fenced, a started task survives, a service restart ends every session and keeps the work, and a pi-side restart drops and re-attaches the link | **PASSED** |
| **A-19** | F2 | (service events) | acceptance in 38 ms, result later; the journal holds the three rows (E-01, E-02) | **PASSED** |
| **A-19** | F3 | pi | 10 of 10 measured checks met: 1 model request caused by the delivered event, 0 more in the quiet window | **BLOCKED** — the real-model clause alone |
| **A-19** | F3 | claude-code, codex, opencode | on `ed579e63` the leader delivery side covered only `opencode` and `pi`; Claude Code (Channels, #404) and Codex (app-server, #403) were added on 2026-09-13 | **BLOCKED** on `ed579e63` — superseded for claude-code and codex by § Real-model reaction; opencode out of scope (owner, 2026-09-13, #340) |
| **A-20** | F4 | (real browser) | a leader's MCP rename appears in the open task list with no reload; a change made across a lost-server gap appears after reconnect | **PASSED** |
| **A-20** | F3 | pi | a delivered event's own reaction starts no further leader turn — 1 model request in the session's whole life, cursors at rest after 45 s | **PASSED** |
| **A-20** | F2 | (leader half) | every listed check met — mutation reaches the stream, human edits reach the journal, reconnect reconciles and re-delivers only what was unacknowledged, the leader's own effect is marked as its echo — but the no-recursive-loop clause cannot be observed without push delivery | **BLOCKED** |
| **A-23** | F3 | all four | setup PASSED and exclusivity held for every client; the reaction is A-19's | **BLOCKED** |

Harness totals on `ed579e63`: **28 tests — 18 pass, 1 fail, 9 todo (BLOCKED), 0 skipped.**
Route-level acceptance suites: **86 tests, 86 pass, 0 skipped, 0 todo.**
Browser suite: **37 files, 219 pass, 6 skipped, `TEST_E2E_STATUS=passed`** — none of the six skips is
an MCP case; the two MCP specs are **7 of 7 passed**.
`npm run test:unit`: **96 tests, 95 pass, 0 fail, 1 skip** (a `setsid` launcher case, not MCP).

**This run is better than WP5's on `1e1113c`.** The Codex A-01 leg, recorded there as NOT RE-RUN
because of a harness defect, **passed here**, so all four clients now carry a real A-01 row and the
A-23 row that reads it is BLOCKED rather than partly unmeasured.

### Addendum 2026-09-13 — #374 Claude Code Channels, corrected after #404 review

The historical rows above remain unchanged. The production composition now has separate
transport checks and real interactive **Claude Code 2.1.270** PTY checks, with an isolated
`CLAUDE_CONFIG_DIR`, the shipped bridge registered as `xezar`, real `xezar serve`, and a scripted
Anthropic Messages endpoint. No personal account or real model is used. The decision record §5.7
requires this scripted-client evidence; it does not require an account for approval/draft testing.

| AC | Row it maps to | Observed evidence after review fixes |
| --- | --- | --- |
| AC-1 | A-19 F3 claude-code | **PASSED, scripted endpoint.** With `--dangerously-load-development-channels server:xezar`, one config journal event produced exactly one request containing `<channel source="xezar"` and its eventId. Quiet windows before and after were each over 30 seconds with no additional requests. Suggestions after later human input are logged separately. The existing eight bridge checks remain. |
| AC-2 | A-19 negative control | **PASSED.** Without the flag: zero requests after the event, `claude-code-push-unconfirmed` after a heartbeat, and the same event returned by the real client's `leader_events` call. The bridge can write a frame without the client accepting it; a write is not a model reaction. |
| AC-3 | A-19 / F-20 separation | **PASSED.** A channel event while the Bash approval dialog was open produced no request and did not approve the tool. An event during a typed draft did not submit it; subsequent human Enter submitted the preserved draft. These are real-client behaviours with a scripted endpoint, not blocked account tests. |
| AC-4 | A-19 / N-10 | **Unit/composition tested.** Compatible reconnects retain eventIds; acknowledgements and echo suppression remain covered. An incompatible rebound owner receives no frame and advances no delivery cursor. Continuing events and partial acknowledgements do not reset the oldest outstanding delivery's age. |
| AC-5 | A-23 claude-code | **Scripted-client setup and wake PASSED.** The PTY case uses local-scope registration as `xezar` and the attach route the shared cockpit action will call. The generic Attach leader control/status depend on #403 under explicit owner steering; no Claude-specific control ships here. Existing A-01/A-17 ownership/exclusivity checks passed. |
| AC-6 | Contract / BC | **Tested.** Additive attach/status shapes and handshake metadata retained. The actual old handshake with neither metadata field gets the update-bridge remedy. Contract parity and route coverage remain required. |
| AC-7 | Never impersonate approval | **Tested.** No permission-relay capability, non-Claude initialize answer byte-identical to the main constant, identifier metadata keys, and no fabricated `reactedSeq`. |
| AC-8 | Prove red | **Executed.** Per-file logs name the source mutation, quote its failed assertion and record restoration. The real-client mutation removes the production bridge's channel capability and fails waiting for the channel model request. |
| AC-9 | O-1 docs | **Tested.** README, connection section, changelog and adapter evidence carry the flag, allowlist rationale, per-launch confirmation, feature-flag service/organisation conditions and all three blocker messages with `fix:` remedies. |

Reproduce the PTY cases after building, from `packages/xezar`:

```sh
TMPDIR=/tmp node --import ../../scripts/test-local-state.mjs --import tsx --test --test-name-pattern 'development channels' test/integration/mcp-real-clients.test.ts
```

**Merged with #403 (2026-09-13).** #403 landed on `main` as `cc39b8e` with the shared Attach
leader control and the `mcp-leader` WebSocket topic; #404 was merged with it (not rebased). One
control now attaches every client through the same route: the AC-5 row's dependency on #403 is
met, Claude Code is derived from the status like Codex (`owner.client === 'claude-code'`, from
the bridge's announced client name), and the two clients coexist in one status payload
(`leader-delivery.test.ts`, "Codex and Claude Code coexist"). The combined journey was re-run in
the unit and composition suites only; a fresh review and QA on the merged head follow.

The A-19/A-23 Claude Code **real-model clause was BLOCKED** here until a separate decision named
an account that may be used; the owner authorized that usage on 2026-09-15 and the clause PASSED —
see § Real-model reaction. This is the only blocked Claude Channels acceptance clause; a scripted
endpoint is not a real model. It does not certify the whole MCP feature: the complete real-client
suite still fails the existing pi `approveTools` case (#369), and independent design/QA and current
CI remain required before merge. The full-suite result on this repair was 30 tests: 20 passed,
1 failed (pi approval), 9 TODO; the two new Claude PTY cases passed. This records the failure,
not an exemption from it.

## Clause by clause

### Clause 1 — coverage against the closed inventory: MET on coverage

Counted from [`mcp-ui-action-inventory.md`](mcp-ui-action-inventory.md), not taken from its summary:
**140 records — 89 `covered`, 20 `global`, 31 `presentation`, zero unresolved.** The status vocabulary
is closed at three values and the same union is enforced in code
(`acceptance-parity.test.ts:1773`). Every one of the 89 covered records has at least one case in
[`mcp-parity-coverage-map.md`](mcp-parity-coverage-map.md); no covered record has an empty cell; no
`presentation` record is named by any case. The mapping is regenerated and checked **both ways** by
`A-05 — the coverage matrix against the closed inventory` (`acceptance-parity.test.ts:1810`), so a
case added, removed or re-pointed without updating that page fails `npm test`.

`global` and `presentation` are the two statuses deliberately without an MCP equivalent, and both
state their reason in the inventory (`:45`, `:46`).

**What was missing on 2026-09-12 was the approval, not the coverage.** No sentence in these documents
records a product-owner approval of this classification. The twelve decisions of 2026-09-10 are
attributed to "the project leader" (`mcp-ui-action-inventory.md:56`) and the product owner is named
only as audience (`:4`). That is the first half of clause 8, since written down on
[#119](https://github.com/qodeca/xezar/issues/119#issuecomment-5646331208) — see clause 8.

### Real-model reaction (A-19 / A-23), per client

The judge in every leg is the same rule: within 120 s of delivery a real model must call
`leader_events ack` with an **exact nonce** in `operationId` and the **exact cursor** of a page that
holds the event. A request, model prose, a stale ack or a wrong cursor cannot pass (the judges'
own negative controls are in `packages/xezar/test/integration/mcp-real-model.test.ts`). A-23's
reaction half reads A-19's result; its setup and exclusivity halves are unchanged from `ed579e63`.

| Client | A-19 real-model | A-23 reaction half | Revision | Run (UTC stamp) | Model | Delivery path |
| --- | --- | --- | --- | --- | --- | --- |
| pi 0.85.1 | **PASSED** — ack +15.8 s after delivery | **PASSED** | `7aa4a0258cd99852ff0a6878dff1c96257f49024` | `2026-09-13T17-43-42.875Z` | `deepseek-v4-flash-vision`, local endpoint | the pi leader extension's socket |
| Claude Code 2.1.272 | **PASSED** — read +5.8 s, ack +8.6 s after the channel push | **PASSED** | `a6d53b4bccfe07803a792c54ff335432d4ad0b49` | `2026-09-15T10-42-29.522Z` | `sonnet` alias (the TUI showed Sonnet 5), the owner's own login | real `xezar serve` → Channels push (`--dangerously-load-development-channels server:xezar`) |
| Codex CLI 0.154.0 | **PASSED** — read +6.9 s, ack +11.9 s after delivery | **PASSED** | `a6d53b4bccfe07803a792c54ff335432d4ad0b49` | `2026-09-15T10-41-35.784Z` | `gpt-6-astra`, reasoning `medium` (the owner's configured default), the owner's own login | real `xezar serve` → the shared app-server (`codex app-server --listen unix://`, TUI `--remote unix://`) |
| OpenCode | **OUT OF SCOPE** | **OUT OF SCOPE** | — | — | — | Owner's decision of 2026-09-13: OpenCode dropped after 5 of 5 stalled runs; reaction reporting open as [#340](https://github.com/qodeca/xezar/issues/340). Not run. |

`a6d53b4` is `main` at `ab28cb0` plus test-only commits (the two new legs and a stdio tee helper); no
product file differs from `main`. For Claude Code and Codex the nonce is the run id xezar mints for the
task whose `task.done` row is the event, because a serve-delivered row's summary is fixed text; the
pushed message carries no cursor, so the model had to call `leader_events read` itself and ack that
read's `nextCursor`. Both halves were observed on the wire (a pass-through tee between the client and
the real bridge) and confirmed in the service's `leader-cursors.json` (`ackedByLeader: true`, acked
seq covering the row). In both TUIs the model's reaction is visible ("task finished. I marked it as
seen." / "Acknowledged.").

Two earlier attempts on the way were harness defects, kept in the evidence and not counted: the
Claude Code folder-trust screen defaults to "No, exit" (`2026-09-15T10-35-59.329Z`, BLOCKED), and a
plain Codex TUI in the owner's home kept its thread in-process (`2026-09-15T10-39-25.395Z`, BLOCKED:
`thread not found`). A first Claude Code PASS (`2026-09-15T10-38-23.107Z`) ran with an uncommitted
harness fix and was re-run on the clean revision above.

Reproduce, after `npm run build:server`, from `packages/xezar` (paid: uses each client's own login):

```sh
XEZ_REAL_MODEL_CLIENTS=claude-code,codex TMPDIR=/tmp node --import ../../scripts/test-local-state.mjs --import tsx --test --test-name-pattern 'claude-code\]|codex\]' test/integration/mcp-real-model.test.ts
```

Evidence (private, never committed, no credential): `.local/xezar-tasks/a9a867a4-e1d4-4bba-83e0-f6a183671331/real-model-2026-09-15/`,
`MANIFEST.sha256` SHA-256 `7f86d3bff8fd3420f15a738874fd2a927194af8e5ddec63eb087470fbedb8f9e`.

### Clause 2 — all of A-01–A-23 on one revision: NOT MET

Eighteen of the twenty-three rows pass on `ed579e63`. **A-20 (leader half) is BLOCKED**, and the A-01
`approveTools` edge path FAILED. **A-19 and A-23 are now PASSED for pi** in a post-release manual
measurement (stamp `2026-09-13T17-43-42.875Z`, revision `7aa4a0258cd99852ff0a6878dff1c96257f49024`),
and **for Claude Code and Codex on 2026-09-15** (revision `a6d53b4`); OpenCode is out of scope for the
real-model clause by the owner's decision of 2026-09-13 (#340). The clause still does not hold: these
passes sit on three revisions (`ed579e63`, `7aa4a02`, `a6d53b4`), and A-20's leader half and pi's
`approveTools` edge (fixed by #411) have not been re-run on a common one. Closing it takes one
whole-suite run plus the real-model legs on a single revision.

A-19 passed with exact nonce and cursor acknowledgement from a real model (`deepseek-v4-flash-vision`);
the measurement window was 120 s and the ack arrived +15.8 s after delivery. A-23 is dependent on A-19
and passes with it for pi, Claude Code and Codex. Per-client stamps, models and timings are in
§ Real-model reaction.

### Clause 3 — no required outcome deferred as optional: MET for the in-scope clients (was NOT MET on one item)

| Required outcome | Verdict | Where |
| --- | --- | --- |
| stale-write rejection | **PASSES** | A-13; `stale-write.ts`, `rev1:` version token, `stale_version` refusal |
| idempotency | **PASSES** | A-14; required `operationId`, `<projectId>/<operationId>` receipts, collision refused, a real `SIGKILL` between effect and receipt recorded UNVERIFIED and never repeated |
| task survival | **PASSES** | A-15, A-18; the task survives its owner, a service restart and the client going away |
| exclusive ownership | **PASSES** | A-17, A-18, all four clients; wired by #302/#305 |
| **async delivery and model reaction** | **PASSES** (2026-09-15) | push delivery built for pi, Claude Code (#404) and Codex (#403); a real model reacted for all three (§ Real-model reaction). OpenCode out of scope by owner decision 2026-09-13 (#340). Did not pass on `ed579e63`. |
| live UI updates | **PASSES** | A-20 cockpit half, real browser |
| unchanged quality | **PASSES** | A-22; weakening a gate is refused, not offered as an approval option |

Engineering's selected lease, versioning, replay and error details are recorded with their tested
behaviour in [D-02](mcp-d02-session-binding-decision.md) and
[D-06](mcp-d06-versioning-idempotency-audit-decision.md), and exercised by A-13, A-14, A-18 and A-21.

### Clause 4 — D-01–D-09 and what the documentation states: MET

| Decision | Recorded in | Status for 0.14.0 |
| --- | --- | --- |
| D-01 transport | [`mcp-d01-transport-decision.md`](mcp-d01-transport-decision.md) | Decided; stdio bridge + per-project Unix socket, shipped. Its § "What remains unproven" is open work, not an open decision. |
| D-02 session binding | [`mcp-d02-session-binding-decision.md`](mcp-d02-session-binding-decision.md) | Decided and implemented (#99, #302/#305); A-17 and A-18 measure it. |
| D-03 shared/project fields | [`mcp-settings-classification.md`](mcp-settings-classification.md) (`:508`, "resolved for the settings surface") | Resolved; `project-config.ts` applies it. |
| D-04 connection file | [`mcp-d04-connection-file-decision.md`](mcp-d04-connection-file-decision.md), with the #262 implementation note at `:13-26` | Resolved; A-01's product leg measures the file. **The pre-implementation § D-04.6 still argues F-15 "in terms of the token"; there is no token field, and `:18-21` retracts it.** Worth a follow-up edit; it changes no verdict. |
| D-05 async event contract | [`mcp-d05-async-event-contract-decision.md`](mcp-d05-async-event-contract-decision.md) | Decided; the catalog and no-polling rule ship. Its § 4 is why "the client received it" is not A-19. |
| D-06 versioning, idempotency, audit | [`mcp-d06-versioning-idempotency-audit-decision.md`](mcp-d06-versioning-idempotency-audit-decision.md) | Decided and shipped. **Audit retention stays Open** (row 14), and the trail records the `mcp` origin only for 0.14.0 (row 16). Neither blocks a released version. |
| D-07 merge/publication | requirements § 10 (`:234`, "Settled"), applied as inventory record I-076, traced in [`mcp-api.md`](mcp-api.md) `:745` | Settled; P-35 and P-38 measure it. |
| D-08 goal decisions and local hand-off | requirements § 10 (`:235`); the shipped tool text at `mcp-api.md:364` and `local-handoff.ts:33` | Settled for its two in-scope halves. Its third half — "built-in/native handover respects the single owner" — is **out of this epic by design** and is recorded NOT RUN in the acceptance harness. |
| D-09 limits, retention, packaging | [`mcp-d09-limits-retention-packaging-decision.md`](mcp-d09-limits-retention-packaging-decision.md) | Bounds decided. **U-1…U-6 remain unresolved** (token cost per client, audit retention count, real bridge startup, Windows/Linux paths, Claude `MCP_TIMEOUT`, load). None is an obligatory criterion. |

The clause's second sentence, item by item:

| The documentation must state | Where it does |
| --- | --- |
| the actual transport | `mcp-api.md:48-51` — JSON-RPC 2.0, newline-framed, on the stdio of `xezar mcp`, forwarded over the project's local socket |
| the startup method | `mcp-api.md:48-50`; `mcp-d01-transport-decision.md` § 4 — spawned by the MCP client, never by a user and never by a service manager |
| the connection file | `mcp-api.md:630-634`; `mcp-d04-connection-file-decision.md:85-91`; `CHANGELOG.md:88-92` |
| the supported clients | requirements `:15` — Claude Code, Codex, OpenCode and pi, the last through the third-party `pi-mcp-adapter`; per-client setup in D-04 § 3 |
| the project/owner enforcement model | `mcp-api.md:487-493`; `mcp-d02-session-binding-decision.md` § 3–5 |
| the limitations | `mcp-api.md:648-663`; `mcp-client-compatibility.md:105`; each decision record's own unproven/unresolved section; and § PI-08 below |
| setup without secrets in conversation | `mcp-d04-connection-file-decision.md:19-21` — there is no token field, so F-15 holds by construction; `mcp-api.md:655-659`; measured by A-12 |

### Clause 5 — the settings matrix and the negative tests: MET, after one gap was closed

[`mcp-settings-classification.md`](mcp-settings-classification.md) classifies **98 rows** into three
statuses — `project-write`, `safe-effective-read`, `excluded` — with a catch-all § 4.15 that lists
every remaining control "so that *unclassified* cannot be confused with *missed*" (`:400`). Nothing
is left ambiguous; `:416-417` states it and `:35-36` forbids resolving an ambiguity by widening a
schema.

Negative isolation tests cover about two dozen resource families, and the three clause 5 names by
hand are each covered: **accounts** (all seven account actions refused with a named boundary,
dispatching nothing, and `~/.xezar/agent-accounts.json` never created — `acceptance-parity.test.ts`
P-29), **skills** (`apply_skill_updates` and `import_skills` refused; A's leader reads A's skills and
never B's — `project-config.test.ts:854`), and **files** (user-scope catalog files refused by catalog
*scope* rather than by path, so a relocated agent home does not defeat it; absolute, `..` and symlink
paths refused before anything is read). Families are exercised with far more than a wrong
`projectId`: foreign resource ids, ids spelled as paths, URLs and percent-encodings, foreign cursors,
aliases, content-embedded ids, protocol-frame re-scoping, and a line forged into A's audit trail.

**One family was uncovered on `ed579e63`, and it was the one that matters most.** `local_handoff` —
the single tool that launches an application on the machine running the service — had no
cross-project negative test anywhere, and the tool-wide parameter sweep enumerated 8 of the 10
registered tools rather than reading the registry. The behaviour was already correct. Only the proof
was missing, and a proof that is missing is not a proof. See § What this run added.

### Clause 6 — the complete flow, and nothing hidden inside it: MET

The flow is demonstrated end to end, in two layers:

| Stage of the flow | Where it is demonstrated |
| --- | --- |
| configuration | A-01 (all four clients, real setup) and P-23…P-28 |
| delegation | P-01…P-12 and B-01 (a task the leader creates appears live in the open cockpit) |
| question and answer | P-14, P-15 (an answer reaches the question it names) and B-02 (the human takes over in the thread and the leader reads that reply in the one shared history) |
| completed result with evidence | P-30…P-34, A-10 (`done` alone is never proof; the assessed revision is identifiable) |
| next stage or corrections | P-17 (accept and send back), P-35, P-38 (the merge, with the quality gate still blocking) |
| further cockpit work | B-03 and the A-20 browser cases (the human's own clicks reach the leader; the leader's change appears with no reload) |

**No built-in leader implementation is hidden here.** The ability was removed, not merely unused:
commit **`188b0c5`** — *"xezar starts no agent process; a leader is attached, never spawned (#309,
owner decision on #311)"*, 297 insertions against 1971 deletions. Today
`packages/contract/src/mcp-leader.ts:31-44` admits only `attach` and `stop`, and
`packages/xezar/src/server/server.ts:5598` says why. The pin is behavioural, not a comment:
`packages/xezar/src/mcp/push-delivery.test.ts:732` plants executable stand-in `claude` and `codex`
binaries that touch a marker file, points `XEZ_CLAUDE_BIN` and `XEZ_CODEX_BIN` at them, POSTs three
`start` bodies and one `resume`, expects **400** for each, and then asserts neither marker exists.
Two adapters are **retained but unconstructed** — `adapters/claude-code.ts` is 61 lines with no
imports and one function returning `route: 'none'`, and `adapters/codex.ts` says at `:26-30` that
nothing in the product constructs it. That is worth knowing, and it is not a leader: neither can open
a connection.

**No global administration is added.** Every global-reaching action is an explicit entry in
`project-config.ts:182-268`'s refusal table that names its boundary and dispatches nothing, and a
catalog file with `scope: 'user'` is refused as a home file by the catalog field rather than by its
path (`project-config.ts:706-728`). Of the ten registered tools, nine cannot write outside the bound
project at all; the tenth, `local_handoff`, launches an application on the host and is gated on
`capabilities.localHandoff`. `PUT /agent-config/:id` still answers 409 when `localHandoff` is false,
measured by P-27.

**No new release engine is added.** `.github/workflows/` holds exactly two workflows;
`release.yml` is `workflow_dispatch`-only and is the only path that publishes; `ci.yml` carries no
npm credential. `git log v0.13.1..HEAD -- .github/workflows/ scripts/release.mjs` returns **zero
commits** — the release machinery is byte-identical to 0.13.1's. `handoff_git` invokes the cockpit's
own routes and deliberately withholds `overrideRules` from the leader.

The one thing I did **not** verify on a release revision is the release act itself: at `ed579e63` the
manifests still read `0.13.1` and there is no `v0.14.0` tag.

### Clause 7 — the repository quality gate: MET for everything run here

| Command | Result on this branch |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm test` (MCP acceptance suites) | 86 passed, 0 skipped, 0 todo |
| `npm run test:unit` | 96 tests, 95 pass, 0 fail, 1 skip (`setsid`, not MCP) |
| `npm run build` | exit 0, `check:pack` ok |
| `npm run test:e2e` | `TEST_E2E_STATUS=passed`, 219 passed / 6 skipped, MCP specs 7 of 7 |
| `npm run test:coverage:mcp` | exit 0 — every MCP file over 80 % lines and 80 % branches |

The canonical five-command gate in reporting order is this task's own gate stage
(`.xezar/checks/repo-gates.sh --fast`); its evidence is sealed with the task, not restated here.
The MCP integration tests and the UI/MCP evidence are reviewable: the harness is
`packages/xezar/test/integration/mcp-real-clients.test.ts`, run from `packages/xezar` with
`TMPDIR=/tmp node --import ../../scripts/test-local-state.mjs --import tsx --test
test/integration/mcp-real-clients.test.ts`, and it writes `environment.json`, `results.json`,
`results.md` and one transcript per process.

### Clause 8 — the two sign-offs: MET (was NOT MET when this record was first written)

Both sign-offs were recorded on 2026-09-12, against `ed579e63`, in
[#119 comment 5646331208](https://github.com/qodeca/xezar/issues/119#issuecomment-5646331208):

- **Product sign-off — the project owner.** Shown this record's verdict of 5 of 8 with each failing
  clause named, the owner approved publication ("publish it, you have my approval"). Read precisely:
  the approval is of the record as it stood, coverage included; it does not name the classification
  document by file.
- **Engineer sign-off — the project leader.** Approves the technical evidence and states what it does
  not attest: that clauses 2 and 3 were met, or that any BLOCKED row was exercised.
- Both sign-offs predate the 2026-09-15 real-model evidence; nobody has signed that evidence yet.

The original 2026-09-12 finding, kept as history:

- **Product approval of leader-action coverage: not recorded.** Searched
  `mcp-ui-action-inventory.md`, `mcp-parity-coverage-map.md` and
  `mcp-project-leader-requirements.md`. The classification decisions are attributed to "the project
  leader", dated 2026-09-10; the product owner appears as audience. There is no approver name and no
  approval sentence. This is an action, not a defect.
- **The responsible engineer's approval of the technical evidence:** given for everything on this
  page, by the engineer who ran it, on 2026-09-12 at `ed579e63`. It covers what was measured and
  explicitly does not convert any BLOCKED row into a pass.
- **Known limitations contradict no obligatory criterion:** see below.

## PI-08 — the known limitation, and whether it contradicts an obligatory criterion

**It does not, and the reason is specific rather than general.**

A xezar tool that the person gates behind pi-mcp-adapter's `approveTools` makes a headless pi wait
for ever: the gated call opens the extension's approval dialog (`extension_ui_request`,
`method: "select"`), the frame carries no `timeout`, pi's own `docs/rpc.md` says such a dialog blocks
until answered, and nothing in xezar answers one. Measured blast radius, unwidened and unnarrowed:
the default path is unaffected (an ordinary pi task finishes in 2.8 s with the gate on, because the
runner's default `--tools` allowlist offers no `xezar_*` tool), a step that names an `xezar_*` tool
while gated fails at ~121 s on the runner's timeout, and a leader reaction turn waits for ever. This
is **not met**, by the project owner's decision of 2026-09-12: the fix is
[#369](https://github.com/qodeca/xezar/issues/369), deliberately outside this release.

Why it contradicts no obligatory criterion:

- **A-01's obligatory outcome is the documented one-time setup**, and that passes for pi on
  `ed579e63`. `approveTools` is the user's own key and the zero-config default sets no gate, so the
  failing configuration is one the user must create deliberately.
- **The released product tells the user not to create it.** The guidance is on the cockpit's own pi
  setup card (`packages/web/src/routes/settings/mcp-connection-section.tsx:208`, pinned by a test at
  `mcp-connection-section.test.tsx:307`), in
  [the extension guide](pi-leader-extension.md#one-thing-to-leave-alone-approvetools) and in
  [D-04 § 3.4](mcp-d04-connection-file-decision.md#34-pi) — merged as #370/#371 in `ed579e6`, which is
  the candidate revision itself.
- **It adds nothing to A-19 or A-23.** On `ed579e63` both were already BLOCKED, for an unrelated reason, for all
  four clients.
- **An interactive pi answers its own dialog and does not hang**, so the limitation bites only where
  nobody is watching — which is exactly the case #369 is filed for.

The other known limitations carried into this record on 2026-09-12 — no push delivery for the three original
clients and no real model reaction (both since closed for Claude Code and Codex; OpenCode out of scope by the owner's decision of 2026-09-13, #340), audit retention open (D-06 row 14), D-09's U-1…U-6, and the
built-in-leader half of A-23 being out of scope — each sit **on top of** a clause that is already
recorded as not met (clauses 2 and 3) or outside this epic. None of them turns a MET clause into a
contradiction.

## What this run added

Two tests in
[`packages/xezar/src/mcp/acceptance-isolation.test.ts`](../../../packages/xezar/src/mcp/acceptance-isolation.test.ts).
**No product file changed.**

1. **`the desktop hand-off opens nothing for a valid B id, and reads like an id from nowhere`** —
   `open_task_in_terminal` and `open_task_in_app` with a real B run id, beside the same calls with an
   id that exists nowhere. The two answers must be byte-identical once the id is masked, or the answer
   is an existence oracle for another project's tasks. It carries its own populated-input control: it
   asserts the call **was** dispatched, and that every open it made is bound to A's scope — so "the
   service refused it" cannot read like "the hand-off was never available here", which is the branch
   a fail-open would take.
2. **`the sweep above covers every registered tool, so a new tool cannot arrive unswept`** — the A-02
   parameter sweep now reads the tool registry rather than a copied list. `leader_events` is the one
   exemption and it is written down with its reason (the shared world composes the tools without the
   event port, so a call there would answer "not connected" and pass for the wrong reason; its own
   foreign-cursor negative is `leader-feed.test.ts`), and the guard also fails if that exemption stops
   naming a real tool.

Both were proved red against a named break, with `git status --porcelain` checked for an `M` on the
broken file before each run:

| Break | What went red |
| --- | --- |
| `localHandoffInputSchema` `.strict()` → `.passthrough()` (the #271 leniency class) | the A-02 sweep — a tool silently dropped a key naming B |
| `local_handoff` removed from the sweep — the exact state of `ed579e63` | the registry guard: `expected [ 'local_handoff' ] to deeply equal []` |
| `const scope = { projectId }` → `{ projectId: 'default' }` in `local-handoff.ts` | the hand-off case, naming four opens dispatched outside A |

## Where the evidence is

Private, under this task's `.local/xezar-tasks/<runId>/dod/`, never committed and holding no
credential:

| File | What |
| --- | --- |
| `real-clients-2026-09-12T13-15-07-152Z/` | the harness run on `ed579e63`: `environment.json`, `results.json` (with `revision.sha`), `results.md`, one transcript per process |
| `real-clients-run1.log` | the harness console output, 28 tests |
| `vitest-acceptance.log`, `vitest-acceptance-after.log` | the three route-level acceptance suites, before and after the two new tests |
| `e2e.log`, `e2e-mcp-verbose.log` | the browser suite (`TEST_E2E_STATUS=passed`) and the two MCP specs case by case |
| `test-unit.log`, `typecheck.log`, `coverage-mcp.log` | the other gate commands |
| `redproof-a.log`, `redproof-b.log`, `redproof-c.log` | the three red proofs |
| `p10-reruns.log` | P-10 run three times alone after it timed out once under load (below) |

**One flake worth recording rather than hiding.** P-10 (`A-06`, variant comparison) timed out at 30 s
in one run — the run that happened to overlap the real-client harness, four agent CLIs and two
servers on this machine. It passed in the clean run of the same suite and in three consecutive runs
alone afterwards, in 632–655 ms each. It is a load-sensitive 30-second timeout in the test, not a
product defect, and its A-06 verdict above is from the runs where it passed.

## Traceability

DoD-1 … DoD-8; A-01 … A-23; D-01 … D-09. Clause 1 reads
[`mcp-ui-action-inventory.md`](mcp-ui-action-inventory.md) and
[`mcp-parity-coverage-map.md`](mcp-parity-coverage-map.md); clause 2's real-client half is
[`mcp-client-acceptance-record.md`](mcp-client-acceptance-record.md), which holds the per-client
detail this page summarises; clause 5 reads
[`mcp-settings-classification.md`](mcp-settings-classification.md).
