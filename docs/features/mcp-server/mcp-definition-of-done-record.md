# MCP project leader — whole-feature Definition of Done record

Issue: [#119](https://github.com/qodeca/xezar/issues/119). Phase 8 ([#75](https://github.com/qodeca/xezar/issues/75))
of [epic #67](https://github.com/qodeca/xezar/issues/67). This is the record the eight clauses of
[requirements § Whole-feature Definition of Done](mcp-project-leader-requirements.md#whole-feature-definition-of-done)
are judged by. Its sibling for the rest of the release is
[`docs/releases/0.14.0-definition-of-done.md`](../../releases/0.14.0-definition-of-done.md), which
explicitly leaves the MCP clauses to this page.

## Answer first

**Five of the eight clauses hold on the candidate revision. Three do not: clause 2, clause 3 and
clause 8.** The gate does not close green. Clauses 2 and 3 fail on one thing between them — a real
model's reaction, and push delivery to the three original clients, both already placed outside
release 0.14.0 by the leader's decision of 2026-09-11. Clause 8 fails because neither of its two
sign-offs has ever been written down.

| Clause | Verdict |
| --- | --- |
| 1 — every UI business action classified; every project action has a working MCP equivalent | **MET on coverage.** The "product-owner-approved" half is the clause 8 gap. |
| 2 — all of A-01–A-23 pass on the same release-candidate revision | **NOT MET.** A-19 and A-23 are BLOCKED for all four clients; A-20's leader half is BLOCKED. |
| 3 — stale writes, idempotency, survival, ownership, async delivery **and model reaction**, live UI, unchanged quality | **NOT MET on one of seven items** — the real model reaction. The other six pass. |
| 4 — D-01–D-09 resolved as needed; the documentation states the actual mechanism | **MET.** |
| 5 — the settings matrix removes ambiguity; negative tests cover each resource family | **MET** on `5834b36` (this record's own commit); one family (`local_handoff`) was uncovered on `ed579e63` and is covered by the two tests that commit adds. |
| 6 — the complete human/leader flow, with no built-in leader, no global administration and no new release engine hidden in it | **MET.** |
| 7 — the repository quality gate; reviewable integration tests and evidence | **MET** for every command run here; the canonical gate is this task's own gate stage. |
| 8 — product approves coverage, the responsible engineer approves the technical evidence; known limitations contradict no obligatory criterion | **NOT MET.** Neither sign-off exists as a written artefact. The limitation half is met (§ PI-08). |

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
| **A-19** | F3 | claude-code, codex, opencode | no attach path exists for these clients (`LeaderDelivery.#act` and the contract's `client` enum admit `opencode` and `pi` only) | **BLOCKED** |
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

**What is missing is the approval, not the coverage.** No sentence anywhere records a product-owner
approval of this classification. The twelve decisions of 2026-09-10 are attributed to "the project
leader" (`mcp-ui-action-inventory.md:56`) and the product owner is named only as audience (`:4`).
That is the first half of clause 8.

### Clause 2 — all of A-01–A-23 on one revision: NOT MET

Eighteen of the twenty-three rows pass on `ed579e63`. **A-19, A-20 (leader half) and A-23 are
BLOCKED**, and the A-01 `approveTools` edge path FAILED. BLOCKED is never a pass, so the clause does
not hold, however narrow the blocker is.

The blocker is narrow and it is the leader's own decision of 2026-09-11: a real model's reaction and
multi-project MCP are outside release 0.14.0, and push delivery with them. For pi, every other clause
of A-19 was executed — the event was delivered, the model reacted once because of it, and it made no
further request in the quiet window. For Claude Code, Codex and OpenCode there is no attach path at
all. This record passes nothing on documentation.

### Clause 3 — no required outcome deferred as optional: NOT MET on one item

| Required outcome | Verdict | Where |
| --- | --- | --- |
| stale-write rejection | **PASSES** | A-13; `stale-write.ts`, `rev1:` version token, `stale_version` refusal |
| idempotency | **PASSES** | A-14; required `operationId`, `<projectId>/<operationId>` receipts, collision refused, a real `SIGKILL` between effect and receipt recorded UNVERIFIED and never repeated |
| task survival | **PASSES** | A-15, A-18; the task survives its owner, a service restart and the client going away |
| exclusive ownership | **PASSES** | A-17, A-18, all four clients; wired by #302/#305 |
| **async delivery and model reaction** | **DOES NOT PASS** | delivery executed (pi); the real model reaction is BLOCKED for every client |
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

### Clause 8 — the two sign-offs: NOT MET

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
- **It adds nothing to A-19 or A-23.** Both are already BLOCKED, for an unrelated reason, for all
  four clients.
- **An interactive pi answers its own dialog and does not hang**, so the limitation bites only where
  nobody is watching — which is exactly the case #369 is filed for.

The other known limitations carried into this record — no push delivery for the three original
clients, no real model reaction, audit retention open (D-06 row 14), D-09's U-1…U-6, and the
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
