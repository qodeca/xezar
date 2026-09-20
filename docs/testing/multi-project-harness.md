# Multi-project product harness

This POSIX-only harness checks one built cockpit with two registered scratch Git repositories, one isolated `XEZ_HOME`, isolated agent homes, dry-run agents, and independent MCP owner sessions. It covers product wiring rather than duplicating parser, locking, route-matrix, or scheduler unit tests.

## Run it

1. Use Node 20+ on macOS or Linux with Git available.
2. Run `npm run build:server`.
3. Run `npm run test:multi-project`.
4. Read the printed `result.json` path; logs and `state.json` are beside it.
5. `PASSED` means every observed assertion passed; `FAILED` retains artifacts for diagnosis.
6. `BLOCKED` means a prerequisite such as the built CLI was unavailable; it is not a pass.
7. `NOT-RUN` is reserved for optional legs and is not currently emitted by this mandatory harness.
8. Pass `-- --clean` to remove artifacts after a pass.

The harness records each child PID before proceeding and tears down only those saved PIDs, escalating from `SIGTERM` to `SIGKILL` after a bounded wait. It removes `XEZ_HANDOFF_FILE`, `XEZ_TODOS_FILE`, and `XEZ_TASK_ID` from child environments. A failure retains the scratch directory.

The Worktree-OFF leg covers Xezar's deterministic dry-run launch path only. It does not reproduce issue #342's external-client configuration loading, replace the real-client acceptance suite, or cover browser project switching; those require the separately sliced follow-up tests.

## Runtime and ceiling

Measured on 2026-09-20, Apple-silicon macOS, warm `node_modules` and the built CLI already present:
`npm run test:multi-project` (after `npm run build:server`) takes **1 minute 44 seconds
(104 s)** wall clock. The red-proof scratch runs in the same session took 103-104 s.

**Runtime ceiling: 5 minutes (300 s)** for `npm run test:multi-project` after
`npm run build:server`. Derivation: 300 s is ~2.9x the measured 104 s, which is the same order
of headroom the sibling `Hosted server boundary and proxy` job gives its 45-second harness, and
it sits well above the harness's own per-wait deadline of 60 s so one slow wait is never
mistaken for a hang. The `multi-project` CI job bounds the whole job — `npm ci`,
`npm run build:server` and the harness — at 12 minutes, scaled from the same harness-to-job
ratio the server-mode job uses (45 s harness under a 5-minute job) against the measured 104 s
and a GitHub-hosted x64 runner that is materially slower than the laptop.

`packages/xezar/src/server/multi-project-harness-doc.test.ts` fails when this ceiling line is
removed (`BREAK-MP-RUNTIME-UNSTATED`).

## Recorded named-break proofs

A break is applied to a scratch copy of the tree (never `git stash`, whose stack is shared by
every worktree), the harness or suite is run to confirmed RED, and the scratch is discarded.
PR #567 recorded three and PR #583 one; this table keeps them in the tracked tree.

| Break | Applied to | Observed RED |
| --- | --- | --- |
| `shared-home-split` | B's bridge started with a second, unrelated `XEZ_HOME` | `FAILED` — B's bridge answers "This directory is not a xezar project yet" instead of the expected in-topology error, because it cannot resolve the registered product service (#567) |
| `unstamped-b-event` | the `project` stamp removed from the workspace stream's `onRun` handler in `packages/xezar/src/server/server.ts` | `FAILED` — the `workspace SSE stamps both projects` assertion sees no `project` field on the parsed A or B run event (#567, reproduced below) |
| `patternless-cleanup` | `ChildRegistry.assertOwned`'s enforcement disabled | the unit case `refuses patternless cleanup when a child was not recorded` fails with `Missing expected exception` (#567) |
| `disposed-b-still-attached` | the `project-removed` detach/unsubscribe step removed from the workspace SSE stream in `packages/xezar/src/server/server.ts` | the A/B lifecycle group of `packages/xezar/src/server/multi-project-composition.test.ts` fails after B removal/re-add (#583) |

### In-tree reproduction: `unstamped-b-event`

Re-run on 2026-09-20 against a scratch copy with only the `project` stamp removed from the
workspace stream's `onRun` handler, then rebuilt and driven with the job's exact command
`npm run test:multi-project`. The harness reported `FAILED` (exit 1) and the failing assertion
was:

```
Error: workspace SSE stamps both projects: {"slowAEvent":{"id":"adae0f56-5d62-462d-9ee5-98a4ba754f91","title":"mock:slow mock:done cap holder","workflow":"quick-task","task":"mock:slow mock:done cap holder","generateFollowups":false,"autonomous":true,"status":"queued","createdAt":"2026-09-20T15:02:09.864Z","tokensUsed":0,"archived":false,"steps":[{"id":"task","name":"Do the task","kind":"agent","status":"pending","iterations":0,"tokensUsed":0}],"decisionRevision":0},"quickBEvent":{"id":"5f0fc83b-26f7-4d9b-b890-b759a4db9e88","title":"mock:done queued behind A","workflow":"quick-task","task":"mock:done queued behind A","generateFollowups":false,"autonomous":true,"status":"queued","createdAt":"2026-09-20T15:02:09.977Z","tokensUsed":0,"archived":false,"steps":[{"id":"task","name":"Do the task","kind":"agent","status":"pending","iterations":0,"tokensUsed":0}],"decisionRevision":0}}
    at assertion (file:///private/tmp/mp-scratch/packages/xezar/scripts/multi-project-harness.mjs:290:18)
    at main (file:///private/tmp/mp-scratch/packages/xezar/scripts/multi-project-harness.mjs:440:5)
```

Both parsed run-event payloads carry no `project` field, so the stamp the assertion reads is
gone. The unmodified tree in the same worktree ran `PASSED` in 104 s — the control. That exit
code is what the `multi-project` CI job reads (`BLOCKED` is exit 2, `FAILED` exit 1), so the
same break fails the job (`BREAK-MP-CI-MISSING`).

## B's MCP door (#557)

B is registered through the product API, not booted, and still gets its own MCP door once its
context is built. The harness waits for B's `health` to answer as a non-error result naming B and not
A — the error text for a missing door also names B, which is how an earlier draft passed against the
bug — then checks `discover_project` and B's own `leader_events` session. After B is removed its
bridge must stop answering while A's keeps answering; after B is re-added and rebuilt, a fresh bridge
from B's folder must answer again. B's side of the cap-sharing smoke still goes through the HTTP door
the cockpit's own composer uses.

Run it with a short `TMPDIR` (for example `TMPDIR=/tmp npm run test:multi-project`) when the default
temporary directory is deep: the scratch home's socket path must fit the 104-byte local-socket limit
on macOS, and a longer one makes A's MCP unavailable and the harness fail on A.
