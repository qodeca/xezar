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
 *  - **A bounded report is counted, never silently short.** `findings` is the machine-readable half
 *    of the review and it is optional; whenever it is present `findingsOmitted` is present too, so
 *    a truncated list says so. Absent `findings` means the reviewer reported none IN THIS FORM —
 *    the same distinction `labels.state` draws, and not an approval (#673).
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

// ---- findings bounds (#673) -------------------------------------------------------------------

/** Findings one report may carry. A reviewer with more than this has a comment, not a packet. */
export const TASK_VERDICT_FINDINGS_MAX = 20;
/** Bytes of the serialized `findings` array. The packet's own 40 KB is the file's; this is the
 *  array's, so a long findings list can never crowd out `summary` or the label evidence. It is the
 *  only bound in this file measured in BYTES rather than characters, deliberately: every character
 *  bound here is worth up to four bytes in UTF-8, and the file bound is the backstop for the rest. */
export const TASK_VERDICT_FINDINGS_MAX_BYTES = 16 * 1024;
/** Characters of one finding's stable id, and of its cross-report fingerprint. */
export const TASK_VERDICT_FINDING_ID_MAX = 64;
/** Characters of one finding's file path. */
export const TASK_VERDICT_FINDING_FILE_MAX = 260;
/** Characters of one finding's headline. */
export const TASK_VERDICT_FINDING_TITLE_MAX = 160;
/** Characters of one finding's body — the pointer's one sentence, never the argument. */
export const TASK_VERDICT_FINDING_BODY_MAX = 300;

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

// ---- finding severity (#673) --------------------------------------------------------------------

/**
 * Each role's own severity words, declared the way `TASK_VERDICT_VOCABULARY` declares verdicts.
 * They are identical today. The per-role SHAPE is the point: a role that later needs its own word
 * is then additive, where a single shared enum would make it a break — the same reason the verdict
 * enum is per role and never translated.
 */
export const TASK_VERDICT_FINDING_SEVERITY = {
  'code-review': ['blocker', 'major', 'minor', 'nit'],
  'design-review': ['blocker', 'major', 'minor', 'nit'],
  qa: ['blocker', 'major', 'minor', 'nit'],
} as const satisfies Record<TaskVerdictRole, readonly [string, ...string[]]>;

/** Most-serious first. The one derived reading this file offers, so no consumer re-invents it. */
export const TASK_VERDICT_SEVERITY_ORDER: readonly string[] = ['blocker', 'major', 'minor', 'nit'];

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

// ---- one finding (#673) -------------------------------------------------------------------------

/**
 * ONE FINDING, as the reviewer that wrote the review reports it.
 *
 * A finding is a POINTER plus a headline, never the finding's full argument. The argument stays in
 * the posted review, which `evidenceUrl` already addresses — the same rule `summary` follows. That
 * is what keeps this array bounded and what keeps the packet from becoming a second copy of the
 * comment, which would then have to be kept in step with it.
 *
 * Absent optional fields mean the producer offered nothing, never a value: an absent `file` is a
 * finding that is not anchored to one, never "the repository root", and an absent `fingerprint` is
 * "this producer offers no cross-report identity", never "a new defect".
 */
function findingSchema<R extends TaskVerdictRole>(role: R) {
  return z
    .strictObject({
      /** Addressable within THIS report. Unique across the packet's own findings. */
      id: z.string().min(1).max(TASK_VERDICT_FINDING_ID_MAX),
      severity: z.enum(TASK_VERDICT_FINDING_SEVERITY[role]),
      /** Repo-relative path. Absent means the finding is not anchored to a file — never "root". */
      file: z.string().min(1).max(TASK_VERDICT_FINDING_FILE_MAX).optional(),
      /** 1-indexed. Only meaningful with `file`; refused without one. */
      line: z.number().int().min(1).max(2_000_000).optional(),
      title: z.string().min(1).max(TASK_VERDICT_FINDING_TITLE_MAX),
      /** One sentence of what is wrong. The argument stays where the review was posted. */
      body: z.string().min(1).max(TASK_VERDICT_FINDING_BODY_MAX).optional(),
      /** Stable ACROSS reports for the same defect, so a re-check can say "this one again".
       *  Line-independent by design: a re-check runs against a changed tree, and a line-anchored
       *  identity would report every carried-over finding as new. */
      fingerprint: z.string().min(1).max(TASK_VERDICT_FINDING_ID_MAX).optional(),
    })
    .superRefine((finding, ctx) => {
      if (finding.line !== undefined && finding.file === undefined) {
        ctx.addIssue({ code: 'custom', path: ['line'], message: 'a line number names no file' });
      }
    });
}

/** One finding as any role reports it. The severity words are per role; the shape is not. */
export type TaskVerdictFinding = z.infer<ReturnType<typeof findingSchema<TaskVerdictRole>>>;

/**
 * Bytes of a string as UTF-8, counted rather than encoded. Not `Buffer.byteLength`: this package
 * is Node-free by construction (`types: []`), so a `node:*` import is a compile error. Not
 * `TextEncoder` either — it is a host global this package's `lib` does not declare, and the one
 * thing needed from it is a count. `for…of` walks CODE POINTS, so a surrogate pair is one
 * four-byte character rather than two three-byte ones.
 */
function byteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * The three rules that span a whole packet rather than one finding. Applied to BOTH unions through
 * one helper, because a rule enforced on the reported packet and not on the recorded one is a rule
 * that holds until the first consumer builds a record some other way.
 *
 *   R1  `findings` present  <=>  `findingsOmitted` present
 *   R2  the serialized `findings` array is at most `TASK_VERDICT_FINDINGS_MAX_BYTES`
 *   R3  finding ids are unique within one packet
 *
 * Every one of them REFUSES the whole packet. That is the sharp edge and it is deliberate: a packet
 * recorded with half its findings is exactly the "some of it arrived" state the label block's
 * `state` field exists to prevent, and the producer can retry. A message never quotes a value.
 */
function checkFindingRules(
  packet: { findings?: readonly { id: string }[]; findingsOmitted?: number },
  ctx: z.RefinementCtx,
): void {
  const { findings, findingsOmitted } = packet;
  if (findings !== undefined && findingsOmitted === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['findingsOmitted'],
      message: 'a findings list names how many findings it left out — a missing count would read as complete',
    });
  }
  if (findings === undefined && findingsOmitted !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['findings'],
      message: 'an omitted-findings count without a findings list reports nothing',
    });
  }
  if (findings === undefined) return;
  if (byteLength(JSON.stringify(findings)) > TASK_VERDICT_FINDINGS_MAX_BYTES) {
    ctx.addIssue({
      code: 'custom',
      path: ['findings'],
      message: `the findings are larger than ${TASK_VERDICT_FINDINGS_MAX_BYTES} bytes`,
    });
  }
  const ids = new Set<string>();
  for (const finding of findings) {
    if (ids.has(finding.id)) {
      ctx.addIssue({ code: 'custom', path: ['findings'], message: 'two findings carry one finding id' });
      break;
    }
    ids.add(finding.id);
  }
}

// ---- the packet -------------------------------------------------------------------------------

/**
 * The fields every arm of both unions carries. A FUNCTION of the role rather than a constant, so a
 * per-role field — `findings`, and whatever comes after it — is added in one place and reaches all
 * six arms. Adding a key to six arms by hand is the half-a-fix this shape exists to rule out.
 */
const packetBase = <R extends TaskVerdictRole>(role: R) => ({
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
  /** The reviewer's own findings, machine-readable (#673). ABSENT means the reviewer reported none
   *  IN THIS FORM — never "there were none", and never an approval. The posted review stays the
   *  record; this is the half a program can read. */
  findings: z.array(findingSchema(role)).max(TASK_VERDICT_FINDINGS_MAX).optional(),
  /** How many findings did NOT fit. REQUIRED whenever `findings` is present, `0` when the list is
   *  complete. A missing counter beside a present list would read as "complete" on a truncated
   *  report, which is the one failure this field exists to prevent. */
  findingsOmitted: z.number().int().min(0).optional(),
});

/**
 * The packet as a task reports it. A discriminated union on `role`, so each role's verdict enum
 * is the only one it can carry.
 */
export const taskVerdictPacketSchema = z
  .discriminatedUnion('role', [
    z.object({
      role: z.literal('code-review'),
      verdict: z.enum(TASK_VERDICT_VOCABULARY['code-review']),
      ...packetBase('code-review'),
    }),
    z.object({
      role: z.literal('design-review'),
      verdict: z.enum(TASK_VERDICT_VOCABULARY['design-review']),
      ...packetBase('design-review'),
    }),
    z.object({
      role: z.literal('qa'),
      verdict: z.enum(TASK_VERDICT_VOCABULARY.qa),
      ...packetBase('qa'),
    }),
  ])
  .superRefine(checkFindingRules);
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
export const taskVerdictSchema = z
  .discriminatedUnion('role', [
    z.object({
      role: z.literal('code-review'),
      verdict: z.enum(TASK_VERDICT_VOCABULARY['code-review']),
      ...packetBase('code-review'),
      ...recordedExtras,
    }),
    z.object({
      role: z.literal('design-review'),
      verdict: z.enum(TASK_VERDICT_VOCABULARY['design-review']),
      ...packetBase('design-review'),
      ...recordedExtras,
    }),
    z.object({
      role: z.literal('qa'),
      verdict: z.enum(TASK_VERDICT_VOCABULARY.qa),
      ...packetBase('qa'),
      ...recordedExtras,
    }),
  ])
  .superRefine(checkFindingRules);
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
