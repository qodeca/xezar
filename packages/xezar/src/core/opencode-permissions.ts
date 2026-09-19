import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * How the OpenCode runner answers a `permission.asked` ask (#578). Kept apart
 * from the runner so every branch of the policy is testable without a server.
 *
 * The policy, named on purpose because it fails closed:
 *
 * - `external_directory` with every pattern an ABSOLUTE path inside one of the
 *   run's own directories → `once`. A pattern may end in one whole `/*` or
 *   `/**` segment (the shape OpenCode sends for a directory); any other
 *   wildcard — `/wt*`, `?`, `[`, `{` — is rejected, because stripping it would
 *   widen the match to siblings such as `/wt-evil`. So is a `..` segment.
 *   Both sides are compared after resolving symlinks. Which directories those
 *   are is the caller's list; for this runner it is `spec.cwd`, the shared
 *   `spec.additionalDirectories`, the OS temp dir, and the run's own task
 *   evidence (`runEvidenceRoots`, #686/#652 — see `run-evidence-roots.ts`, the
 *   one producer the pi worktree guard's allowed roots share).
 * - Every other permission (`doom_loop`, `webfetch`, `bash`, `read`, `edit`, a
 *   future one) → `reject`. Their patterns are URLs, commands or globs, not
 *   directories, so no directory rule can judge them.
 *
 * Never `always`: a later ask for a genuinely new path must still be judged,
 * not silently pre-approved by an earlier remembered rule.
 */
export type PermissionReply = 'once' | 'reject';

export interface PermissionDecision {
  reply: PermissionReply;
  /** Transcript text for a denial; absent when the ask is allowed. */
  note?: string;
}

/** The only permission this runner ever approves. */
export const DIRECTORY_PERMISSION = 'external_directory';

/** Total denied asks in one session before the run fails closed. */
export const MAX_PERMISSION_DENIALS = 20;

/** Denials of the SAME `permission`+`patterns` pair back to back — no allowed
 *  ask and no different denial in between — before the run treats it as a
 *  loop the model is not adapting to. */
export const MAX_REPEATED_PERMISSION_DENIAL = 3;

/** Resolve the run's directories once, symlinks included — on macOS
 *  `os.tmpdir()` is `/var/folders/…`, a link to `/private/var/folders/…`. */
export function resolveAllowedRoots(dirs: readonly string[]): string[] {
  return [...new Set(dirs.map((dir) => realPrefix(path.resolve(dir))))];
}

export function decideOpencodePermission(
  permission: string,
  patterns: readonly string[],
  allowedRoots: readonly string[],
): PermissionDecision {
  const patternText = patterns.length > 0 ? patterns.join(', ') : '(no pattern given)';
  if (permission !== DIRECTORY_PERMISSION) {
    return {
      reply: 'reject',
      note: `opencode: denied permission '${permission}' for ${patternText} — xezar answers only '${DIRECTORY_PERMISSION}' asks inside this run's directories and rejects every other permission`,
    };
  }
  const allowed = patterns.length > 0 && patterns.every((pattern) => isInsideRoots(pattern, allowedRoots));
  if (allowed) return { reply: 'once' };
  return {
    reply: 'reject',
    note: `opencode: denied permission '${permission}' for ${patternText} — outside this run's allowed directories`,
  };
}

/** Is `pattern` an absolute path, optionally ending in one whole `/*` or `/**`
 *  segment, that resolves inside one of `allowedRoots`? */
export function isInsideRoots(pattern: string, allowedRoots: readonly string[]): boolean {
  const literal = pattern.replace(/\/\*{1,2}$/, '');
  if (literal === '' || /[*?[\]{}]/.test(literal) || !path.isAbsolute(literal)) return false;
  // A `..` segment is refused rather than collapsed: collapsing it lexically
  // disagrees with the filesystem when the segment before it is a symlink.
  if (literal.split('/').includes('..')) return false;
  const resolved = realPrefix(path.resolve(literal));
  return allowedRoots.some((root) => resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
}

/** The real path of the longest existing prefix of `absolute`, with the
 *  missing tail re-attached — an ask may name a file that does not exist yet. */
function realPrefix(absolute: string): string {
  let existing = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(existing), ...tail);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return absolute;
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** The two loop bounds on denied asks. `record` returns the named failure once
 *  a bound is reached, otherwise `null`. */
export class PermissionDenialGuard {
  private total = 0;
  private lastKey: string | null = null;
  private consecutive = 0;

  record(permission: string, patterns: readonly string[], decision: PermissionDecision): string | null {
    if (decision.reply === 'once') {
      this.lastKey = null;
      this.consecutive = 0;
      return null;
    }
    const key = JSON.stringify([permission, ...patterns]);
    this.consecutive = key === this.lastKey ? this.consecutive + 1 : 1;
    this.lastKey = key;
    this.total += 1;
    const patternText = patterns.length > 0 ? patterns.join(', ') : '(no pattern given)';
    if (this.consecutive >= MAX_REPEATED_PERMISSION_DENIAL) {
      return `opencode denied '${permission}' for ${patternText} ${this.consecutive} times in a row — the model is not adapting, failing the run rather than waiting out the step timeout`;
    }
    if (this.total >= MAX_PERMISSION_DENIALS) {
      return `opencode hit ${this.total} denied permission asks this run (last: '${permission}' for ${patternText}) — failing the run rather than waiting out the step timeout`;
    }
    return null;
  }
}
