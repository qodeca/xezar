import { z } from 'zod';

/**
 * A REVIEWER'S REPORT about a task, as the task itself reported it (#460).
 *
 * The problem this shape exists for: a finished task is an EXECUTION fact and nothing else. "The
 * chain ran to the end" and "a reviewer approved this work" are different claims, and a consumer
 * that has only the first has to go and parse a review comment to learn the second — or, worse,
 * read `done` as acceptance. Neither is acceptable for an automated reader, so the reviewer's own
 * outcome is recorded on the run in its ORIGINAL vocabulary.
 *
 * Three rules shape every field below, and each of them is a thing that has to stay true rather
 * than a preference:
 *
 *  - **The vocabulary is per role and is never translated.** A code review APPROVEs or REQUESTs
 *    CHANGES; QA PASSes or FAILs; a design review has a third outcome, PASS WITH FOLLOW-UPS, which
 *    is not a PASS and not a FAIL. Collapsing the three into one shared enum is how a design
 *    review's outstanding work disappears and how a QA PASS starts reading as business acceptance.
 *    Hence the discriminated union: a role can only carry its own words.
 *  - **A verdict applies to the commit it was made against.** `reviewedHeadSha` is mandatory and is
 *    a full 40-character SHA, so a consumer can compare it with the target's head before acting on
 *    it. An abbreviated SHA is refused rather than expanded here: this record is REPORTED, and
 *    nothing in it may be completed from a guess.
 *  - **Absent evidence never reads as good evidence.** The label block distinguishes "we read the
 *    labels and there were none" (`verified` with an empty `observed`) from "we could not read
 *    them" (`unavailable`, which may carry no `observed` list at all). Those are the same array
 *    against a fail-open reader, and they must not be the same value.
 *
 * SOURCE. `source` is always `task-reported`: the packet reaches the engine from the task's own
 * work, and it is evidence of what the reviewer SAID, never cryptographic proof of what a forge
 * holds. It is a field rather than an implicit convention so a future first-party source can be
 * added without every consumer silently re-interpreting the old rows.
 */

// ---- bounds --------------------------------------------------------------------------------

/** Bytes of the reported packet file the engine will read. Anything larger is refused whole. */
export const TASK_VERDICT_MAX_BYTES = 40 * 1024;
/** Characters of `summary` — a reviewer's headline, never the review itself. */
export const TASK_VERDICT_SUMMARY_MAX = 2_000;
/** Characters of one label name. */
export const TASK_VERDICT_LABEL_MAX = 100;
/** Entries in one label list. */
export const TASK_VERDICT_LABEL_LIST_MAX = 30;
/** Characters of the stable report id. */
export const TASK_VERDICT_ID_MAX = 200;
/** Current packets kept on a run — one per role, and there are exactly three roles. */
export const TASK_VERDICT_MAX_CURRENT = 3;
/** Ingestion problems kept on a run. Oldest drop first: the newest failure is the useful one. */
export const TASK_VERDICT_MAX_ISSUES = 10;
/** Characters of one ingestion problem's reason. */
export const TASK_VERDICT_ISSUE_REASON_MAX = 300;

// ---- roles and their vocabularies ------------------------------------------------------------

export const TASK_VERDICT_ROLES = ['code-review', 'design-review', 'qa'] as const;
export const taskVerdictRoleSchema = z.enum(TASK_VERDICT_ROLES);
export type TaskVerdictRole = z.infer<typeof taskVerdictRoleSchema>;

/** Each role's own words, declared once so nothing can widen one role with another's. */
export const TASK_VERDICT_VOCABULARY = {
  'code-review': ['APPROVE', 'REQUEST CHANGES'],
  'design-review': ['PASS', 'PASS WITH FOLLOW-UPS', 'FAIL'],
  qa: ['PASS', 'FAIL'],
} as const satisfies Record<TaskVerdictRole, readonly [string, ...string[]]>;

/**
 * Which verdicts COUNT AS APPROVING for their role — the one derived reading this file offers,
 * because every consumer would otherwise write it themselves and one of them would get
 * `PASS WITH FOLLOW-UPS` wrong. It is approving: the design gate lets it through with the
 * follow-ups recorded. `REQUEST CHANGES` and `FAIL` are not.
 */
export const TASK_VERDICT_APPROVING: Readonly<Record<TaskVerdictRole, readonly string[]>> = {
  'code-review': ['APPROVE'],
  'design-review': ['PASS', 'PASS WITH FOLLOW-UPS'],
  qa: ['PASS'],
};

// ---- label evidence ---------------------------------------------------------------------------

const labelSchema = z.string().min(1).max(TASK_VERDICT_LABEL_MAX);
const labelListSchema = z.array(labelSchema).max(TASK_VERDICT_LABEL_LIST_MAX);

export const taskVerdictLabelStateSchema = z.enum(['verified', 'partial', 'unavailable']);
export type TaskVerdictLabelState = z.infer<typeof taskVerdictLabelStateSchema>;

/**
 * What the reviewer asked the forge to do with the task's labels, and what it could then SEE.
 *
 * `state` is the whole point of the block:
 *  - `verified` — every requested change was applied and `observed` is the list that was read back.
 *    An empty `observed` here is a real "this thing carries no labels".
 *  - `partial` — some of it worked, or the read-back disagrees with what was asked for.
 *  - `unavailable` — the labels could not be read or written at all. `observed` must be ABSENT,
 *    not empty: an empty list under this state is exactly the lie this field exists to prevent.
 */
export const taskVerdictLabelsSchema = z
  .object({
    /** Labels the reviewer asked to add. */
    requestedAdd: labelListSchema,
    /** Labels the reviewer asked to remove. */
    requestedRemove: labelListSchema,
    /** Labels read back afterwards. Absent means none was read — see `state`. */
    observed: labelListSchema.optional(),
    /** When the read-back happened. Absent when none did. */
    observedAt: z.string().optional(),
    state: taskVerdictLabelStateSchema,
  })
  .superRefine((labels, ctx) => {
    if (labels.state === 'unavailable' && labels.observed !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['observed'],
        message: 'unavailable label evidence carries no observed list — an empty list would read as verified-and-empty',
      });
    }
    if (labels.state !== 'unavailable' && labels.observed === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['observed'],
        message: 'verified and partial label evidence name what was observed',
      });
    }
  });
export type TaskVerdictLabels = z.infer<typeof taskVerdictLabelsSchema>;

// ---- the packet -------------------------------------------------------------------------------

const packetBase = {
  /** Stable report id. Re-reporting it with the same content is a no-op; with different content
   *  it is refused, so one report can never become two, and two can never wear one id. */
  id: z.string().min(1).max(TASK_VERDICT_ID_MAX),
  /** The task this reports on. Must be the task whose step is settling. */
  taskId: z.string().min(1),
  /** The step that produced it. Must be the step that is settling — which is what keeps an
   *  earlier step's leftover packet from being consumed by a later one. */
  stepId: z.string().min(1),
  /** The commit the review was made against — full, never abbreviated. */
  reviewedHeadSha: z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-character commit sha'),
  /** The reviewer's own headline. Bounded: the review itself lives where it was posted. */
  summary: z.string().min(1).max(TASK_VERDICT_SUMMARY_MAX),
  /** When the reviewer recorded it. */
  recordedAt: z.string().min(1),
  /** Where the full review can be read, when it was posted somewhere. */
  evidenceUrl: z.string().max(2_000).optional(),
  labels: taskVerdictLabelsSchema,
};

/**
 * The packet as a task reports it. A discriminated union on `role`, so each role's verdict enum
 * is the only one it can carry.
 */
export const taskVerdictPacketSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('code-review'),
    verdict: z.enum(TASK_VERDICT_VOCABULARY['code-review']),
    ...packetBase,
  }),
  z.object({
    role: z.literal('design-review'),
    verdict: z.enum(TASK_VERDICT_VOCABULARY['design-review']),
    ...packetBase,
  }),
  z.object({
    role: z.literal('qa'),
    verdict: z.enum(TASK_VERDICT_VOCABULARY.qa),
    ...packetBase,
  }),
]);
export type TaskVerdictPacket = z.infer<typeof taskVerdictPacketSchema>;

/** The role of the step's own product — what a leader reads to route the verdict. */
export type TaskVerdictOf<R extends TaskVerdictRole> = Extract<TaskVerdictPacket, { role: R }>;

/** Where a recorded verdict came from. One value today; a field so a second one is additive. */
export const taskVerdictSourceSchema = z.enum(['task-reported']);
export type TaskVerdictSource = z.infer<typeof taskVerdictSourceSchema>;

/**
 * Has this verdict been announced yet?
 *
 * Two durable things happen when a verdict is recorded — it lands on the run, and it is announced
 * on the event journal — and a process can die between them. So the run write goes first and says
 * `pending`; whoever announces flips it to `announced`. A crash in the gap leaves a `pending`
 * record, which is recoverable by its stable id: exactly one announcement, never zero, never two.
 */
export const taskVerdictPublicationSchema = z.enum(['pending', 'announced']);
export type TaskVerdictPublication = z.infer<typeof taskVerdictPublicationSchema>;

/** What the engine adds to a reported packet when it records one. */
const recordedExtras = {
  source: taskVerdictSourceSchema,
  /** When the engine took it in — distinct from the reviewer's own `recordedAt`. */
  ingestedAt: z.string().min(1),
  publication: taskVerdictPublicationSchema,
};

/**
 * A packet as the run record holds it: what the task reported, plus how it got here.
 *
 * Spelled out as its own three-armed union rather than `z.intersection(packet, extras)`. An
 * intersection of a UNION is a type every downstream inference step has to redistribute — the
 * route type, the parity check and hono's own walk over the response shape — and each of them
 * flattens it differently. Three arms cost three lines and infer as one plain discriminated union.
 */
export const taskVerdictSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('code-review'),
    verdict: z.enum(TASK_VERDICT_VOCABULARY['code-review']),
    ...packetBase,
    ...recordedExtras,
  }),
  z.object({
    role: z.literal('design-review'),
    verdict: z.enum(TASK_VERDICT_VOCABULARY['design-review']),
    ...packetBase,
    ...recordedExtras,
  }),
  z.object({
    role: z.literal('qa'),
    verdict: z.enum(TASK_VERDICT_VOCABULARY.qa),
    ...packetBase,
    ...recordedExtras,
  }),
]);
export type TaskVerdict = z.infer<typeof taskVerdictSchema>;

/**
 * A packet that could NOT be recorded, and why. Present so "a reviewer reported something the
 * engine refused" never looks like "no reviewer ran": the failure is on the record, bounded and
 * without the offending content, and it yields no verdict of any kind.
 */
export const taskVerdictIssueSchema = z.object({
  stepId: z.string().min(1),
  at: z.string().min(1),
  reason: z.string().min(1).max(TASK_VERDICT_ISSUE_REASON_MAX),
});
export type TaskVerdictIssue = z.infer<typeof taskVerdictIssueSchema>;

/** Is this recorded verdict an approving one for its own role? */
export function isApprovingTaskVerdict(verdict: Pick<TaskVerdictPacket, 'role' | 'verdict'>): boolean {
  return TASK_VERDICT_APPROVING[verdict.role].includes(verdict.verdict);
}
