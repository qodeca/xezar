import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The disposable onboarding record: `.local/xezar/onboarding-state.json` (#464 P2,
 * `docs/features/onboarding/xez-onboard-contract.md` § Disposable offer state).
 *
 * Everything here is derived — nothing is authored, migrated or repaired by a person. Deleting
 * the file loses the history of checks and nothing else, which is why it lives under
 * `.local/xezar/` (blanket-ignored by `ensureDataGitignore`) and why absent, corrupt and
 * read-only are DESIGNED states rather than errors.
 *
 * **Reads never write.** No boot-time write, no lazy refresh on a GET, nothing that could start
 * costing a person money or touching their files without a click. The record comes into existence
 * on the first deliberate write — a dismissal, or a check that finished — and at no other moment.
 * That is also what lets `GET /onboarding` answer byte-identically under its three URL spellings,
 * which `route-parity.test.ts` requires of every project-scoped GET.
 *
 * ### Why `checked` exists next to `lastCheckedAt`
 *
 * The contract note's four fields describe ONE identity pair: "on an identity change, reset both
 * timestamps for the new pair". That is the right rule — it is what stops a previous successful
 * check being read as current — but it also erases the answer the Settings card has to give after
 * an update: *"the last check finished against xezar 0.14.0; xezar 0.15.0 is running now"*
 * (`states.html` 1c/1d shows the two pairs on two separate rows).
 *
 * So `checked` is an additive, optional field carrying the pair a finished check actually covered,
 * and it survives an identity change. `lastCheckedAt` keeps its contract meaning exactly — the
 * moment of a finished check **for the record's own pair**, and null the instant that pair moves —
 * so a reader that knows only the four fields still cannot mistake an old check for a current one.
 * A file written by an older xezar (no `checked`) is read by falling back to the four fields.
 */

const stampSchema = z.object({
  engineVersion: z.string().min(1),
  kitDigest: z.string().min(1),
  at: z.string().min(1),
});

/** One identity pair plus when it was stamped. */
export type OnboardingStampRecord = z.infer<typeof stampSchema>;

/** `.catch()` per field, `.passthrough()` at the object level — the `~/.xezar/config.json` rules:
 *  one bad key degrades that key, it never evicts the record, and a field a newer xezar wrote
 *  survives an older one rewriting the file. */
export const onboardingRecordSchema = z
  .object({
    engineVersion: z.string().min(1),
    kitDigest: z.string().min(1),
    lastOfferedAt: z.string().nullable().catch(null),
    lastCheckedAt: z.string().nullable().catch(null),
    /** Additive (#464 P2): the pair a finished check covered, surviving an identity change. */
    checked: stampSchema.nullable().catch(null).optional(),
  })
  .passthrough();

export type OnboardingRecord = z.infer<typeof onboardingRecordSchema>;

export function onboardingStatePath(dataDir: string): string {
  return join(dataDir, 'onboarding-state.json');
}

// ---- in-process lock (the `todos.ts` / janitor `withLock` pattern) ----------

const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const next = new Promise<void>((r) => {
    release = r;
  });
  locks.set(key, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}

// ---- read ------------------------------------------------------------------

/**
 * What a read found. `absent` and `corrupt` are kept APART on purpose.
 *
 * They are the fail-open trap AGENTS.md § Changing a mechanism names: against an empty or
 * unreadable input, "we never had a baseline" and "the baseline is unreadable" collapse into one
 * branch unless something keeps them separate. Here they produce two different sentences — "Not
 * set up yet" for a project nothing has looked at, "Provenance unknown" for one whose history we
 * can see exists and cannot trust — and only the second warns.
 */
export type OnboardingReadStatus = 'absent' | 'corrupt' | 'ok';

export interface OnboardingRead {
  status: OnboardingReadStatus;
  record: OnboardingRecord | null;
}

let warnedOnce = new Set<string>();

/** Reset the once-per-path warning memo. Tests only. */
export function resetOnboardingWarnings(): void {
  warnedOnce = new Set<string>();
}

/**
 * Read the record. Never throws, never writes, never creates anything.
 *
 * The warning is emitted at most once per path per process, so a corrupt file cannot spam a log
 * for the life of a cockpit.
 */
export async function readOnboardingRecord(dataDir: string): Promise<OnboardingRead> {
  const file = onboardingStatePath(dataDir);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return { status: 'absent', record: null }; // first use, and that is not an error
  }
  // An empty file is what a torn write leaves behind. It is not "no record".
  if (!raw.trim()) {
    warnOnce(file, 'the file is empty');
    return { status: 'corrupt', record: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnOnce(file, err instanceof Error ? err.message : String(err));
    return { status: 'corrupt', record: null };
  }
  const result = onboardingRecordSchema.safeParse(parsed);
  if (!result.success) {
    warnOnce(file, result.error.issues.map((i) => i.message).join('; '));
    return { status: 'corrupt', record: null };
  }
  return { status: 'ok', record: result.data };
}

function warnOnce(file: string, message: string): void {
  if (warnedOnce.has(file)) return;
  warnedOnce.add(file);
  console.warn(
    `[xez] ${file} could not be read — this project's setup history reads as unknown (${message})`,
  );
}

// ---- write -----------------------------------------------------------------

/** What a write did. `unwritable` means the record is unchanged and the caller should degrade. */
export type OnboardingWriteStatus = 'written' | 'unwritable';

export interface OnboardingWriteResult {
  status: OnboardingWriteStatus;
  record: OnboardingRecord;
}

async function writeAtomic(dataDir: string, record: OnboardingRecord): Promise<boolean> {
  const file = onboardingStatePath(dataDir);
  const tmp = `${file}.tmp`;
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, file);
    return true;
  } catch {
    // A read-only disk, a full one, a home that is not ours. The record is scratch: losing a
    // write costs the memory of one dismissal and nothing else, so this never propagates.
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    return false;
  }
}

/** Build the next record for `observed`, carrying forward only what survives an identity change. */
function rebase(
  previous: OnboardingRecord | null,
  observed: { engineVersion: string; kitDigest: string },
): OnboardingRecord {
  const checked = carriedCheck(previous);
  const sameCheck =
    checked !== null
    && checked.engineVersion === observed.engineVersion
    && checked.kitDigest === observed.kitDigest;
  const samePair =
    previous !== null
    && previous.engineVersion === observed.engineVersion
    && previous.kitDigest === observed.kitDigest;
  return {
    engineVersion: observed.engineVersion,
    kitDigest: observed.kitDigest,
    // An offer belongs to the pair it was made for. A new pair has not been offered.
    lastOfferedAt: samePair ? (previous?.lastOfferedAt ?? null) : null,
    // The contract's rule, kept exactly: null the moment the pair moves.
    lastCheckedAt: sameCheck ? checked.at : null,
    checked,
  };
}

/**
 * The last finished check, whatever pair it covered.
 *
 * Falls back to the four contract fields for a record written before `checked` existed — there,
 * a non-null `lastCheckedAt` can only mean the record's own pair.
 */
export function carriedCheck(record: OnboardingRecord | null): OnboardingStampRecord | null {
  if (!record) return null;
  if (record.checked) return record.checked;
  if (!record.lastCheckedAt) return null;
  return {
    engineVersion: record.engineVersion,
    kitDigest: record.kitDigest,
    at: record.lastCheckedAt,
  };
}

/**
 * Record that the offer was made for `observed` — the pair a person or a leader was actually shown.
 *
 * Idempotent: the same pair offered twice keeps the FIRST moment, so a retried cockpit click and a
 * repeated MCP call with one `operationId` both answer truthfully instead of moving the timestamp.
 *
 * The caller checks that `observed` is still the running identity BEFORE calling; that comparison
 * belongs to whoever knows the running identity, and doing it here would make this function's
 * contract depend on a global.
 */
export async function recordOffered(
  dataDir: string,
  observed: { engineVersion: string; kitDigest: string },
  now: () => string = () => new Date().toISOString(),
): Promise<OnboardingWriteResult> {
  return withLock(dataDir, async () => {
    const { record: previous } = await readOnboardingRecord(dataDir);
    const base = rebase(previous, observed);
    if (base.lastOfferedAt) return { status: 'written', record: base };
    const next: OnboardingRecord = { ...base, lastOfferedAt: now() };
    return { status: (await writeAtomic(dataDir, next)) ? 'written' : 'unwritable', record: next };
  });
}

/**
 * Record that a check FINISHED its promised scope for `observed`.
 *
 * The one write that may claim a project was checked, and the one the surfaces colour green. A
 * cancelled, failed or partial check never calls it — which is the whole of what keeps "Last
 * successfully checked" honest (`AC-12`).
 */
export async function recordChecked(
  dataDir: string,
  observed: { engineVersion: string; kitDigest: string },
  now: () => string = () => new Date().toISOString(),
): Promise<OnboardingWriteResult> {
  return withLock(dataDir, async () => {
    const { record: previous } = await readOnboardingRecord(dataDir);
    const at = now();
    const next: OnboardingRecord = {
      ...rebase(previous, observed),
      lastCheckedAt: at,
      checked: { engineVersion: observed.engineVersion, kitDigest: observed.kitDigest, at },
    };
    return { status: (await writeAtomic(dataDir, next)) ? 'written' : 'unwritable', record: next };
  });
}
