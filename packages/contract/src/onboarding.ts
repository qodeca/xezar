import { z } from 'zod';

/**
 * The onboarding family of `/api/v1/p/:projectId` — the "Set up this project" entry, the
 * post-update offer row and the Settings → Project setup status surface (#464 P2).
 *
 * One rule shapes every field here, and it is the rule the surface exists for:
 * **observed is not checked.** A version xezar happens to be running proves nothing about this
 * project's files, so the three identity pairs are three separate fields and are never collapsed
 * into one "up to date" flag. `lastChecked` moves only when a check actually finished.
 *
 * The record behind it (`.local/xezar/onboarding-state.json`) is disposable runtime scratch, not
 * configuration: absent, corrupt and read-only are designed states, and none of them blocks boot
 * or an ordinary task. That is why `provenance` is on the wire — a consumer must be able to tell
 * "no baseline" from "nothing changed", which is the fail-open trap this feature would otherwise
 * walk into.
 *
 * Reading this shape writes nothing: the record is created by a dismissal or by a check that
 * finished, never by a page load, never at boot.
 */

/** The identity pair every surface compares: the running engine, and the pinned setup-template
 *  revision that engine bundles. Both are non-empty strings by the contract note. */
export const onboardingIdentitySchema = z.object({
  engineVersion: z.string(),
  kitDigest: z.string(),
});
export type OnboardingIdentity = z.infer<typeof onboardingIdentitySchema>;

/** An identity pair with the UTC ISO-8601 moment it was recorded. */
export const onboardingStampSchema = z.object({
  engineVersion: z.string(),
  kitDigest: z.string(),
  at: z.string(),
});
export type OnboardingStamp = z.infer<typeof onboardingStampSchema>;

/**
 * Which sentence the Settings card shows. Deliberately NOT a boolean pair: `never` (we looked and
 * no check has finished) and `unknown` (there is a record and we cannot read it) read the same to
 * a naive consumer and must not, because only `never` is a statement we have evidence for.
 *
 * - `never`    — no finished check is recorded. The record may be ABSENT (first use, and not an
 *                error) or present with no finished check; both are "nothing has been checked yet"
 * - `set-up`   — a finished check covers the identity that is running now
 * - `changed`  — a finished check exists, for a DIFFERENT identity
 * - `unknown`  — a record EXISTS and could not be read (empty, unparseable, or a shape this
 *                schema rejects); provenance cannot be established
 * - `checking` — a check task for this project is active
 */
export const onboardingStateSchema = z.enum(['never', 'set-up', 'changed', 'unknown', 'checking']);
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

/**
 * The bundled launch definition, named so a leader never has to guess a workflow id.
 *
 * `modes` carries all three the skill contract names, including `preview`; the cockpit
 * deliberately surfaces only `setup` and `recheck` (report-only is a property of a brief, not of
 * a button), but a leader that cannot see `preview` cannot dispatch a report-only check.
 *
 * Starting this definition is IDEMPOTENT while one of its runs is live: a create that arrives
 * while `checkingRunId` is set answers that run rather than starting a second one (`AC-13`). The
 * rule sits at the create route, so it is the same answer for the cockpit's buttons and for a
 * leader's `task_create` — including a second `task_create` under a fresh `operationId`, which the
 * receipt layer's replay would not have caught.
 */
export const onboardingLaunchSchema = z.object({
  workflowId: z.string(),
  modes: z.array(z.enum(['setup', 'preview', 'recheck'])),
});
export type OnboardingLaunch = z.infer<typeof onboardingLaunchSchema>;

/**
 * `GET /api/v1/p/:projectId/onboarding` — everything the three surfaces read, for ONE project.
 *
 * Every optional-looking field is `.nullable()` rather than `.optional()` on purpose: a key
 * `JSON.stringify` drops is a key the route's own inferred type still calls present, and that is
 * the exact drift `contract-parity*.test.ts` fails on.
 */
export const onboardingStatusSchema = z.object({
  state: onboardingStateSchema,
  /** `recorded` when a readable record exists for the observed identity, `unknown` otherwise. */
  provenance: z.enum(['recorded', 'unknown']),
  /** Whether the setup task can be created here at all (an agent backend was detected). */
  available: z.boolean(),
  /** Why not, in the server's own words. `null` exactly when `available`. */
  unavailableReason: z.string().nullable(),
  /** False in hosted mode — setup still runs, but one step finishes on the owning machine. */
  localHandoff: z.boolean(),
  /** True when the offer row should be shown: the identity changed, a baseline exists, it has
   *  not been offered for this pair, and no check is running. Never true without a baseline. */
  offerPending: z.boolean(),
  /** True when this identity was already offered — the Settings card says so, the row does not
   *  come back. */
  dismissed: z.boolean(),
  observed: onboardingIdentitySchema,
  lastOffered: onboardingStampSchema.nullable(),
  /** Moves ONLY when a check finished its promised scope. A cancelled or failed check leaves it. */
  lastChecked: onboardingStampSchema.nullable(),
  /** The active check task, when one is running — the "Open the task" target. */
  checkingRunId: z.string().nullable(),
  launch: onboardingLaunchSchema,
});
export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>;

/**
 * `POST /api/v1/p/:projectId/onboarding/offered` — record that the offer was made for the
 * identity the caller saw, so the same pair does not offer again.
 *
 * The body carries that identity rather than trusting the server's own read: if the running
 * identity moved between the read and the press, writing "offered" against the NEW pair would
 * silently swallow an offer nobody ever saw.
 */
export const onboardingOfferedInputSchema = z.object({
  engineVersion: z.string().min(1).max(200),
  kitDigest: z.string().min(1).max(200),
});
export type OnboardingOfferedInput = z.infer<typeof onboardingOfferedInputSchema>;

/**
 * The answer to that write. `conflict` means the observed identity moved since the read and
 * NOTHING was written; `unwritable` means the record could not be persisted — the row is gone for
 * this session and may come back once, which is the designed read-only degradation.
 */
export const onboardingOfferedResponseSchema = z.object({
  status: z.enum(['recorded', 'conflict', 'unwritable']),
  onboarding: onboardingStatusSchema,
});
export type OnboardingOfferedResponse = z.infer<typeof onboardingOfferedResponseSchema>;
