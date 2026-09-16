import { z } from 'zod';

/**
 * A STEP'S LIVENESS, as an advisory observation (#460 § 2).
 *
 * The question this answers is "is this step still moving?", and the only honest answers are
 * yes, no, and — the one that is easy to lose — *we do not know*. Every field here is nullable
 * for that third answer, and `null` means UNKNOWN rather than zero, absent rather than now. A
 * monitor that has never seen activity must say so; filling the gap with `Date.now()` would
 * make "we just started watching" indistinguishable from "it was busy a moment ago", which is
 * exactly the reading that turns an advisory signal into a lie.
 *
 * It is an OBSERVATION and nothing more: nothing here cancels a step, moves a deadline or
 * changes what the runner does. A `stall` is a suspicion a reader should act on by LOOKING, and
 * the two producers of it say so in their own words rather than sharing one.
 *
 * The numbers below are fixed defaults, not settings. An advisory signal that needs configuring
 * before it is useful is not zero-config, and there is no environment variable or config key for
 * any of them; if live evidence ever justifies a per-step override it needs its own contract.
 */

/** How long a step may go without any agent transcript activity before it is called quiet. */
export const STALL_QUIET_MS = 5 * 60_000;

/** The fraction of a FINITE step timeout at which the deadline warning fires, once per episode. */
export const STALL_DEADLINE_RATIO = 0.8;

/** How often the monitor re-evaluates, and therefore the worst-case lateness of a warning. */
export const STALL_TICK_MS = 30_000;

/**
 * Why a step is being called stalled. Two independent conditions, deliberately NOT merged:
 *
 *  - `silence` — no agent transcript activity for `STALL_QUIET_MS`. Says nothing about the clock.
 *  - `timeout-near` — at least `STALL_DEADLINE_RATIO` of a FINITE effective timeout is spent.
 *    Fires even while the step is producing output every second, because a busy step can still
 *    be about to be killed; using inactivity as a precondition for it would hide exactly the
 *    case a reader most needs.
 */
export const stallReasonSchema = z.enum(['silence', 'timeout-near']);
export type StallReason = z.infer<typeof stallReasonSchema>;

/**
 * The current suspicion about one step. `since` is the instant the condition has held FROM (the
 * last activity for `silence`, the step's start for `timeout-near`); `observedAt` is when the
 * monitor last confirmed it. Both are real instants — a `stall` is only ever written when the
 * baseline is known, so this object never carries a guessed time.
 */
export const stepStallObservationSchema = z.object({
  reason: stallReasonSchema,
  since: z.string(),
  observedAt: z.string(),
});
export type StepStallObservation = z.infer<typeof stepStallObservationSchema>;

/**
 * Coarse liveness of one step. Written on MEANINGFUL TRANSITIONS only — the step's start, and a
 * stall appearing or clearing — never per transcript delta and never on a monitor tick that
 * changed nothing. Every write bumps the run's version and fans the record out over SSE, so a
 * per-tick snapshot would be a permanent background write for every running task in exchange for
 * a number nobody reads between transitions.
 *
 *  - `lastActivityAt`: the most recent real agent activity, `null` when none has been seen. A
 *    step that has produced nothing yet is `null`, and so is a step observed for the first time
 *    after a restart — "unknown", not "now".
 *  - `effectiveTimeoutMs`: the wall clock the step actually spawned with, resolved through the
 *    same path the runner resolves it (`stepTimeoutMs`, then that backend's own default).
 *    `null` for an unlimited step and for one whose backend reports no default — unlimited and
 *    unknown both mean "there is no deadline to warn about", and neither is zero.
 *  - `deadlineAt`: when that timeout expires, `null` whenever `effectiveTimeoutMs` is.
 *  - `stall`: present only while a condition holds; absent is the ordinary healthy state.
 */
export const stepProgressSchema = z.object({
  lastActivityAt: z.string().nullable(),
  effectiveTimeoutMs: z.number().finite().nonnegative().nullable(),
  deadlineAt: z.string().nullable(),
  stall: stepStallObservationSchema.optional(),
});
export type StepProgress = z.infer<typeof stepProgressSchema>;
