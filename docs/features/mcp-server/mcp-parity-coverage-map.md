# MCP parity coverage map (A-05)

Status: **published mapping, checked by the suite in both directions**. Date: 2026-09-11.
Audience: product owner, reviewers and the engineering team.

Tracked by [#116](https://github.com/qodeca/xezar/issues/116) (Phase 8 of [epic #67](https://github.com/qodeca/xezar/issues/67)).

This page links every record of the closed inventory,
[`mcp-ui-action-inventory.md`](mcp-ui-action-inventory.md), to the acceptance cases that prove it.
It makes Definition of Done clause 1 measurable: coverage is judged against that inventory's
140 records, never against a count of tools or endpoints.

## How to read it

- **Record → cases** lists every record with status `covered` (all 89), plus the `global` records a
  case exercises as a refusal. A case marked **(BLOCKED)** is named here but is not passing: see
  [What is blocked](#what-is-blocked).
- **Case → records** lists every case in
  [`packages/xezar/src/mcp/acceptance-parity.test.ts`](../../../packages/xezar/src/mcp/acceptance-parity.test.ts)
  with the acceptance criteria (A-05 … A-11) it serves and the records it names. The vitest title of
  each case starts with the same id and record list, so a failing case names its records in the run
  log.
- **Browser cases** lists the cockpit half of A-08 in
  [`packages/web/e2e/mcp-collaboration.e2e.ts`](../../../packages/web/e2e/mcp-collaboration.e2e.ts)
  (`B-01` …). Their ids also appear in **Record → cases**. Each title starts
  `B-nn (acceptance) [records]`, and that title is what the suite reads.
- The three tables are not hand-maintained prose. The suite's last block (`A-05 — the coverage matrix
  against the closed inventory`) regenerates all three from the registered cases and the browser
  spec's titles, and fails when any table here differs — so a reviewer can check the mapping both ways, and a case added, removed or
  re-pointed without updating this page fails `npm test`. The same block also fails when a covered
  record has no case, when a case names no record, and when a case names a `presentation` record
  (section 3 says those need no tool, so naming one would dress up a non-action as coverage).

## What every case asserts

Each case drives the cockpit's own route (the human's door) and the MCP tool (the leader's door, over
A's real MCP socket) from equivalent starting states in the shared A/B world
([`packages/xezar/test/helpers/ab-fixture.ts`](../../../packages/xezar/test/helpers/ab-fixture.ts),
#115), and compares the **business outcome** — the task record, the file bytes, the branch, the
transcript, the registry row — not a status code. Where an outcome could reach project B, the case
records B's full state before and after and holds it to N-01 (`assertIsolated`). Backends are
controlled: `XEZ_DRY_RUN=1`, provider auth stubbed as connected, a local bare repository behind a
GitHub-shaped remote, hermetic git (no developer identity or config), no personal account, no secret.

Evidence levels, as the kit's reports distinguish them: every runnable `P-` case is **fixture-tested**
(route level, `npm test`). The `B-` cases are **browser-tested**: they run only under
`npm run test:e2e`, against a real `xezar serve` and the real `xezar mcp` bridge, and a run that
reports `TEST_E2E_STATUS=skipped` is not a pass for any of them. None of them is live-client
verified; that is the separate spike and compatibility record
([`mcp-client-behaviour-spike-report.md`](mcp-client-behaviour-spike-report.md)).

## What is blocked

| Case | Records | What is missing |
| --- | --- | --- |
| P-22 | I-138, I-139 | The leader is not told about project changes live. No tool in the registry (`packages/xezar/src/mcp/tools/index.ts`) reads the project event journal, and the bridge sends no journal notification — found in the files examined at `e4228be`. PR #247 (open when this suite was written) composes the writer side: the journal, the event catalog, the echo guard and the audit trail, and hands the tools the service entry. It adds no leader-facing read, so this case stays blocked after it too. A blocked case runs as a vitest `todo` and is never counted as passing. |

What P-19 already shows of I-138's outcome: a change the leader makes travels on the same project
store bus the cockpit's SSE stream relays, and nothing reaches project B's bus. What is missing is
the leader's side of the same stream.

## Browser cases (the cockpit half of A-08)

What only a browser can show is the open cockpit following the leader live, and the human's own
clicks reaching the leader. The rest of A-08 (each side reading, changing and taking over the
other's task, and no MCP-only history or configuration) is proven at the route level by P-19, P-20
and P-21.

The spec boots its own `xezar serve` over a throwaway git repository with `XEZ_DRY_RUN=1` and a
pinned `XEZ_HOME`. Since PR #247 (`269fd79`), that boot composes the MCP service over the running
cockpit. The leader is the real `xezar mcp` stdio bridge, speaking JSON-RPC. Each live assertion
also checks a marker set on the page after its first load, so it cannot pass through a reload.

The file is `mcp-collaboration.e2e.ts`, not the `mcp-collaboration.spec.ts` the brief named:
`packages/web/e2e/vitest.config.ts` collects `**/*.e2e.ts` only, so a `.spec.ts` file would never
run.

<!-- parity-map:browser:start -->
| Case | Acceptance | Records | What it proves |
| --- | --- | --- | --- |
| B-01 | A-08, A-05 | I-001, I-015, I-018 | a task the leader creates, and then renames, appears and renames live in the open cockpit, with no reload |
| B-02 | A-08, A-07 | I-033, I-034 | the human takes over in the thread, the leader reads that reply in the one shared history, and the leader’s reply appears live in the human’s thread |
| B-03 | A-08, A-06 | I-019 | a pin the human sets is the pin the leader reads, and the leader’s unpin shows live in the human’s header |
<!-- parity-map:browser:end -->

## Limits of this evidence

- **Controlled forge.** GitHub is the dry-run forge. It always reports a mergeable pull request, so
  the quality-blocked merge in P-38 replaces only the merge-state answer with a failing required
  check; the tool, its schema and the rest of the service are the real ones.
- **B runs no agent process.** The shared world's project B is seeded state with no run manager, so
  "A's controls never stop B's processes" is shown as: B's recorded state is byte-identical after
  every control, a sibling task inside A keeps running when its neighbour is cancelled (P-13), and
  no tool accepts a process id, signal, command or host path. The per-tool suite
  (`tools/execution-control.test.ts`) runs a live B process for the same claim.
- **Per-project concurrency.** P-28 proves the cap and tags are written to the bound project's
  registry entry only and read back by both doors. The shared world's scheduler is built with a fixed
  limit loader, so it does not show the scheduler enforcing that cap.
- **Hosted mode** is switched with `XEZ_REMOTE=1` in-process (P-27); a non-loopback bind is not
  exercised here.

## Record → cases

<!-- parity-map:records:start -->
| Record | Inventory status | Cases |
| --- | --- | --- |
| I-001 | covered | P-01, P-21, B-01 |
| I-002 | covered | P-03 |
| I-003 | covered | P-04 |
| I-005 | covered | P-05 |
| I-007 | covered | P-01, P-24 |
| I-008 | covered | P-06 |
| I-009 | covered | P-01 |
| I-010 | covered | P-21, P-23 |
| I-012 | global | P-29 |
| I-015 | covered | P-07, B-01 |
| I-016 | covered | P-07 |
| I-017 | covered | P-08 |
| I-018 | covered | P-07, P-21, B-01 |
| I-019 | covered | P-07, B-03 |
| I-020 | covered | P-07 |
| I-021 | covered | P-09 |
| I-024 | global | P-29 |
| I-025 | covered | P-37 |
| I-026 | covered | P-37 |
| I-027 | covered | P-37 |
| I-029 | covered | P-10 |
| I-030 | covered | P-10 |
| I-032 | covered | P-14 |
| I-033 | covered | P-19, P-20, P-30, B-02 |
| I-034 | covered | P-14, P-20, B-02 |
| I-035 | covered | P-11 |
| I-036 | covered | P-15 |
| I-037 | covered | P-13 |
| I-038 | covered | P-14, P-20 |
| I-039 | covered | P-14, P-20 |
| I-040 | covered | P-16 |
| I-041 | covered | P-30 |
| I-042 | covered | P-12 |
| I-044 | covered | P-18 |
| I-045 | covered | P-30 |
| I-049 | covered | P-30 |
| I-051 | covered | P-17 |
| I-052 | covered | P-30, P-31, P-32 |
| I-053 | covered | P-30, P-32 |
| I-054 | covered | P-30, P-31 |
| I-055 | covered | P-31 |
| I-056 | covered | P-36 |
| I-057 | covered | P-36 |
| I-061 | covered | P-33 |
| I-062 | covered | P-33 |
| I-063 | covered | P-33 |
| I-064 | covered | P-33 |
| I-065 | covered | P-23 |
| I-068 | covered | P-32 |
| I-069 | covered | P-34 |
| I-070 | covered | P-34 |
| I-071 | covered | P-34 |
| I-072 | covered | P-34 |
| I-073 | covered | P-34 |
| I-074 | covered | P-34 |
| I-075 | covered | P-34, P-35 |
| I-076 | covered | P-35, P-38 |
| I-080 | covered | P-01 |
| I-083 | covered | P-39 |
| I-085 | covered | P-03 |
| I-086 | covered | P-39 |
| I-087 | covered | P-39 |
| I-088 | covered | P-39 |
| I-090 | covered | P-40 |
| I-091 | covered | P-40 |
| I-092 | global | P-29 |
| I-093 | global | P-29 |
| I-094 | covered | P-02 |
| I-096 | covered | P-41 |
| I-097 | covered | P-41 |
| I-098 | covered | P-41 |
| I-099 | covered | P-41 |
| I-100 | covered | P-41 |
| I-101 | covered | P-41 |
| I-102 | covered | P-41 |
| I-103 | covered | P-23 |
| I-104 | covered | P-24 |
| I-105 | covered | P-23 |
| I-106 | covered | P-23 |
| I-107 | covered | P-23, P-38 |
| I-108 | covered | P-23 |
| I-109 | covered | P-23 |
| I-110 | covered | P-21, P-25 |
| I-111 | covered | P-26, P-27 |
| I-112 | global | P-29 |
| I-113 | covered | P-26, P-27 |
| I-114 | covered | P-18 |
| I-115 | global | P-29 |
| I-117 | global | P-29 |
| I-118 | global | P-29 |
| I-119 | global | P-29 |
| I-120 | global | P-29 |
| I-121 | global | P-29 |
| I-122 | global | P-29 |
| I-123 | global | P-29 |
| I-124 | global | P-29 |
| I-125 | global | P-29 |
| I-126 | global | P-29 |
| I-127 | global | P-29 |
| I-128 | covered | P-28 |
| I-129 | covered | P-28 |
| I-130 | global | P-29 |
| I-131 | global | P-29 |
| I-132 | global | P-29 |
| I-133 | covered | P-42 |
| I-136 | covered | P-42 |
| I-138 | covered | P-22 (BLOCKED) |
| I-139 | covered | P-22 (BLOCKED) |
| I-140 | covered | P-19 |
<!-- parity-map:records:end -->

## Case → records

<!-- parity-map:cases:start -->
| Case | Acceptance | Records | What it proves |
| --- | --- | --- | --- |
| P-01 | A-06, A-05 | I-001, I-007, I-009, I-080 | a start with the form’s values lands the same record through either door, with the same refusals |
| P-02 | A-06 | I-094 | a start from a project skill runs that skill, as the skills panel’s start does |
| P-03 | A-06, A-05 | I-002, I-085 | a plan request answers the steps, rationale and fallback the cockpit’s planner answers |
| P-04 | A-06, A-05 | I-003 | a start from an edited step list runs exactly that list, as the plan review’s start does |
| P-05 | A-06, A-05 | I-005 | saving a step list asks the same overwrite decision and writes the same workflow file |
| P-06 | A-06, A-05 | I-008 | N variants start as one group of isolated tasks through either door |
| P-07 | A-06, A-05, A-08 | I-015, I-016, I-018, I-019, I-020 | rename, pin, archive, restore and read state end the same through either door, and each door sees the other’s |
| P-08 | A-06, A-05 | I-017 | the bulk archive sweeps exactly the project’s own finished tasks |
| P-09 | A-06, A-11, A-05 | I-021 | delete runs without a confirmation parameter and removes the task, transcript, worktree and branch exactly as the cockpit does |
| P-10 | A-06, A-11, A-05 | I-029, I-030 | variants are compared from the group read, the pick waits for every variant, and winner and others end as the cockpit leaves them |
| P-11 | A-06, A-07, A-05 | I-035 | a queued brief and its queued messages are edited and removed with the same effect through either door |
| P-12 | A-06, A-05 | I-042 | a task read answers the runner, model, account handle and label, and the models lock — never the identity behind the account |
| P-13 | A-07, A-05 | I-037 | cancel stops exactly the named task, keeps its worktree as the cockpit does, and never reaches another task or B |
| P-14 | A-07, A-05 | I-034, I-038, I-039, I-032 | messages, finish and continue follow the session state through either door, and an invalid transition changes nothing |
| P-15 | A-07, A-05 | I-036 | an answer reaches the question it names and is delivered as the ask card delivers it |
| P-16 | A-07, A-05 | I-040 | a scheduled automatic resume is inspected and cancelled with the same effect through either door |
| P-17 | A-07, A-10, A-05 | I-051 | at review, accept and send back behave as the review panel’s buttons |
| P-18 | A-07, A-05 | I-044, I-114 | launching a desktop app is reported as a host capability, never promised on the client’s machine |
| P-19 | A-08, A-05 | I-033, I-140 | the leader reads the human’s task, history and handoff as the cockpit does, and the human’s bus carries the leader’s change |
| P-20 | A-08, A-07 | I-033, I-034, I-038, I-039 | either side takes over the other’s task, and one transcript records both |
| P-21 | A-08, A-05 | I-001, I-018, I-010, I-110 | the same work through either door leaves the same files: no MCP-only history or configuration |
| P-22 | A-08 | I-138, I-139 | **BLOCKED** — no MCP tool or notification delivers the project event journal to the leader: the tool registry (`tools/index.ts`) has no journal read and the bridge sends no journal notification. The writer side (journal, event catalog, echo guard, audit trail) is composed by PR #247, still open when this suite was written; a leader-facing read is still missing after it |
| P-23 | A-09, A-05 | I-010, I-065, I-103, I-105, I-106, I-107, I-108, I-109 | a project setting written by the leader is the cockpit’s setting, byte for byte, B is untouched, and the system prompt never reaches a log |
| P-24 | A-09, A-05 | I-104, I-007 | locked models are reported as a reason and refuse a model choice exactly as the cockpit does |
| P-25 | A-09, A-08, A-05 | I-110 | the prompt-template list is read and replaced whole, and each door sees the other’s list |
| P-26 | A-09, A-05 | I-111, I-113 | an agent config file is written through the cockpit’s own route, a stale write is refused, and an MCP-carrying file is read as structure only |
| P-27 | A-09, A-11 | I-111, I-113 | in hosted mode an agent config write is refused with the cockpit’s own 409, through MCP too |
| P-28 | A-09, A-08, A-05 | I-128, I-129 | the bound project’s own cap and tags are written to its registry entry only, and each door sees the other’s |
| P-29 | A-09, A-11 | I-012, I-024, I-092, I-093, I-112, I-115, I-117, I-118, I-119, I-120, I-121, I-122, I-123, I-124, I-125, I-126, I-127, I-130, I-131, I-132 | every global-source, home-file, shared-account and limit write is refused with its boundary, dispatches nothing, and no approval parameter changes that |
| P-30 | A-10, A-05 | I-033, I-041, I-045, I-049, I-052, I-053, I-054 | a result, its files, diff, commits and handoff read the same as the cockpit’s, with references and origin as fields, and `done` is not proof |
| P-31 | A-10, A-05 | I-055, I-054, I-052 | after a commit moves the SHA, earlier evidence reads as stale, and the commit is the one the cockpit makes |
| P-32 | A-10, A-11, A-05 | I-068, I-052, I-053 | with the working tree gone, evidence reads as unavailable rather than empty, and worktree clean-up matches the cockpit’s |
| P-33 | A-10, A-05 | I-061, I-062, I-063, I-064 | the repository reads and branch switch/create match the cockpit’s, refusals verbatim |
| P-34 | A-10, A-05 | I-069, I-070, I-071, I-072, I-073, I-074, I-075 | issues, pull requests, comments, checks, search, PR changes and merge state read as the cockpit reads them, from the bound project’s repository |
| P-35 | A-10, A-11, A-05 | I-076, I-075 | the existing merge is invoked without the confirmation click, re-validating the reviewed head exactly as the cockpit’s merge |
| P-36 | A-10, A-05 | I-056, I-057 | a task branch is pushed and its draft PR created with the same effect through either door |
| P-37 | A-10, A-06, A-05 | I-025, I-026, I-027 | the Inbox is reported off with a reason, then read, started from and cleared as in the cockpit |
| P-38 | A-11 | I-076, I-107 | a merge past a failing required check fails as a reported blocker, and no approval parameter makes it succeed |
| P-39 | A-06, A-11, A-05 | I-083, I-086, I-087, I-088 | the workflow catalog, validation, save and delete match the cockpit’s, built-ins stay protected, and a check step is refused |
| P-40 | A-06, A-05 | I-090, I-091 | the skill catalog, a skill’s body and a team-skill refresh read as the cockpit’s |
| P-41 | A-06, A-05 | I-096, I-097, I-098, I-099, I-100, I-101, I-102 | automations are listed, created from the form’s values, edited under a revision, toggled, checked, logged, retried and deleted as the cockpit’s |
| P-42 | A-05 | I-133, I-136 | discovery answers the cockpit’s capability and tool facts for the bound project, with reasons, and nothing about other projects |
<!-- parity-map:cases:end -->
