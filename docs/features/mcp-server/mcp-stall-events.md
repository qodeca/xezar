> **Internal engineering record, not current product documentation.** For how xezar behaves today, read the [root README](../../../README.md).

# Advisory stall and resume events

**Status:** implemented, 2026-09-16 (#460, PR 3 of the 0.15.0 MCP completeness campaign). Fixture-tested;
not yet live-verified with a real attached leader (that is the campaign's T-20 row and remains open).

## The problem

A project leader learned when a task finished, failed, blocked or asked a question, and nothing at all
about the long middle. A task that wedged twenty minutes ago and a task working hard look identical
from the outside until one of them ends.

`packages/xezar/src/mcp/event-catalog.ts` had terminal and waiting cases and no silence case, and the
same file's exclusion rule kept every transcript and counter frame out of the journal — correctly, but
it left nothing at all to reason about a step's liveness with.

## What was built

A per-project monitor that ticks every 30 seconds while a step is executing, and publishes two events.
No model is involved: the two conditions are arithmetic on timestamps.

| Piece | Where |
| --- | --- |
| The shapes and the three numbers | `packages/contract/src/run-progress.ts` — `stepProgressSchema`, `stepStallObservationSchema`, `STALL_QUIET_MS`, `STALL_DEADLINE_RATIO`, `STALL_TICK_MS` |
| On the step | `progress` in `packages/contract/src/runs.ts` and `packages/xezar/src/runs/store.ts` (the store imports the contract schema; there is no second declaration) |
| The monitor | `packages/xezar/src/mcp/stall-monitor.ts`, started and stopped by `EventCatalog.attach` / `detach` |
| The events | `task.stalled` / `task.resumed` (E-01) in `packages/contract/src/mcp-event-catalog.ts`, emitted by `packages/xezar/src/mcp/event-catalog.ts` |
| The timeout the step really got | resolved once in `runAgentStep` (`packages/xezar/src/workflows/run.ts`) from `stepTimeoutMs` and the runner's own `defaultTimeoutMs` |
| A check step's liveness | `RunStore.noteActivity`, called from the output chunks in `runCheckStep` |
| The read | `task_read view=task`, unchanged except for its description; `leader_events` and the pushed channel for the events |

## The two conditions, and why they are separate

**`silence`** — no real agent transcript activity for five minutes. Says nothing about the clock.

**`timeout-near`** — at least 80 % of a *finite* effective timeout is spent. It fires while output is
streaming every second, because a busy step can still be minutes from being killed. Making inactivity a
precondition for it would hide exactly the case a reader most needs.

They are tracked as two flags rather than one "stalled" state because they behave differently when work
comes back: silence re-arms (and publishes `task.resumed`), while the deadline warning fires once and is
not cleared, since the deadline did not move when the step started talking again.

## The rules that are load-bearing

**It is an observation, and it acts on nothing.** No cancellation, no timeout change, no status
transition, no lease. The summary of every `task.stalled` row says so in words — a consumer routing on
the kind alone must not be able to read it as a failure — and the `leader_events` description repeats it
where the leader actually reads it.

**The time limit is asked of the backend that is really running the step.** `AgentRunner` gained an
optional, read-only `defaultTimeoutMs` that reports what a spec with no `timeoutMs` falls through to,
read from the same field the session uses, so a reported deadline and the one that actually kills cannot
drift. An interactive step's `timeoutMs: 0` becomes `null` — unlimited — and a runner reporting no
default leaves it `null` too. Unlimited and unknown behave identically and neither becomes a deadline of
zero, which is the difference between "no deadline to warn about" and "already past it".

**The monitor may only speak for what it watched.** One rule, three floors, latest wins: what the
record claims (the persisted `progress.lastActivityAt`, else the step's `startedAt`), when the monitor
last started watching at all, and when it last saw *that run* not executing. Each floor exists because
of a case the one before it gets wrong. A step found already running at attach — after a restart, or
when the MCP composition opens late — may carry a `startedAt` four hours old, and taking it would
publish a retrospective stall for a span nothing observed; so the earliest a fresh attach can warn is a
full quiet window after the attach. A run parked at `waiting` for an hour was not stuck for that hour,
however old its own timestamps look; so the parked instant is re-stamped on **every** tick, not once
when the wait began — a floor recorded only at the start of the wait leaves fifty-nine minutes of it
looking like quiet, and the re-arm alone does not cover it when another task keeps the clock open.

Every gap in observation is therefore charged to the observer, not to the task. It errs late and never
early, which is the only safe direction here: a warning five minutes later than it could have been
costs nothing, and one that fires the moment a task returns from waiting for a person is simply wrong.
`lastActivityAt` still survives on the record across a restart — it is what a leader reads to see when
a step last did anything — it just does not let a new monitor warn about a span it was not watching.
Nothing backfills it with "now".

**Activity is an allowlist, not a denylist.** Text, tool traffic, images, turn boundaries and the live
`item.*` frames count. Notes, lifecycle and step markers, token and cost counters, session bookkeeping,
the monitoring nudge and a human's own message do not. A denylist would promote every future event type
into a heartbeat by default, and a heartbeat that is not work is how a silence detector quietly stops
detecting silence.

**A check step's output chunks are the one signal no event carries.** `check-output` is written once,
when the command exits, so on the event bus a `npm test` printing a line a second is perfectly silent
for its whole run. `RunStore.noteActivity` reports the chunk without writing anything, allocating a
`seq` or reaching any stream — an ephemeral frame would have put a synthetic heartbeat on the live wire
that the cockpit, the replay dedup and the event catalog would each have had to learn to ignore. It is
throttled to one per second, and the existing `check-output` record at exit is untouched.

**The record is written on transitions only.** The step's start, and a stall appearing or clearing. Every
write bumps the run's version and fans the whole record out over SSE, so a per-tick snapshot would be a
permanent background write for every running task in exchange for a number nobody reads between
transitions. When an episode ends, a lingering `stall` is cleared: the record says what is true now, and
the journal keeps the history.

**The timer exists only while something runs.** Armed on the 0→1 executing step, cancelled on the 1→0 and
on the catalog's `detach`, and unref'd so it never holds the process open. The arm check is O(1) on the
run it was handed rather than a scan, because it runs on every store touch; disarming is the tick's job,
which already knows the whole active set.

**Why the catalog's lifetime.** The monitor needs exactly one instance per project, over the store the
catalog already listens to, reporting through the catalog, stopped when the catalog stops. Composing it
separately in `startMcpService` would have meant a second attach and teardown for one timer — and a
teardown in the wrong order would leave a tick deriving rows into a closed journal. It degrades the same
way every other part does: a monitor that cannot start is one warning and a smaller MCP, never a catalog
that fails to attach.

## What was deliberately NOT built

- **No setting and no environment variable.** An advisory signal that needs configuring before it is
  useful is not zero-config. The three numbers are contract constants. If live evidence ever justifies a
  per-step quiet override, it needs its own default-preserving contract.
- **No cancellation, and no change to any timeout.** Out of scope by the spec and by the design: a stall
  is a suspicion, and acting on a suspicion is the leader's decision, not the monitor's.
- **No push-significance change.** Which events wake a leader is PR 4 of this campaign.
- **No cockpit surface.** The field is on the record and the cockpit ignores it.

## Verification

`packages/xezar/src/mcp/stall-monitor.test.ts` holds T-6 … T-9 of the accepted spec; each describe block
names the break it fails against. `packages/xezar/src/workflows/run-step-progress.test.ts` proves the
engine wiring end to end under `XEZ_DRY_RUN=1` — the runner's own default, an explicit step timeout, an
interactive step's absent deadline, and a check step's honest unknown.
`packages/xezar/src/mcp/event-catalog.test.ts` covers the two kinds, the advisory wording, the
summary-only rule and the monitor's lifetime inside the catalog's.

Thirteen named breaks were injected one at a time against the finished tests, and each was caught; the
PR body lists them with the red assertion each produced. `npm run test:coverage:mcp` passes its per-file
80 % lines / 80 % branches floor with `stall-monitor.ts` at 92.9 % lines and 84.8 % branches, and no
changed file decreased.
