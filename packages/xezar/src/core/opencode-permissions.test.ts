import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decideOpencodePermission,
  MAX_PERMISSION_DENIALS,
  MAX_REPEATED_PERMISSION_DENIAL,
  PermissionDenialGuard,
  resolveAllowedRoots,
} from './opencode-permissions.ts';
import { runEvidenceRoots } from './run-evidence-roots.ts';

/** #578 review: one case per branch of the fail-closed policy. */
let base = '';
let work = '';
let roots: string[] = [];

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'xez-opencode-perm-')));
  work = join(base, 'wt');
  mkdirSync(join(work, 'src'), { recursive: true });
  mkdirSync(join(base, 'wt-evil'));
  roots = resolveAllowedRoots([work]);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const reply = (permission: string, patterns: string[]): string =>
  decideOpencodePermission(permission, patterns, roots).reply;

describe('external_directory asks', () => {
  it('allows an absolute path inside a root, with or without one trailing /* or /** segment', () => {
    expect(reply('external_directory', [join(work, 'src')])).toBe('once');
    expect(reply('external_directory', [`${work}/*`])).toBe('once');
    expect(reply('external_directory', [`${work}/src/**`])).toBe('once');
    expect(reply('external_directory', [join(work, 'not', 'there', 'yet.txt')])).toBe('once');
  });

  it('rejects a path outside every root, and a mixed list with one outside', () => {
    expect(reply('external_directory', ['/etc/passwd'])).toBe('reject');
    expect(reply('external_directory', [`${work}/*`, '/etc/*'])).toBe('reject');
  });

  it('rejects a wildcard anywhere but one whole trailing segment (m1)', () => {
    expect(reply('external_directory', [`${work}*`])).toBe('reject');
    expect(reply('external_directory', [`${work}/src*`])).toBe('reject');
    expect(reply('external_directory', [`${work}/sr?`])).toBe('reject');
    expect(reply('external_directory', [`${work}/**/*`])).toBe('reject');
    expect(reply('external_directory', [`${work}/{a,b}`])).toBe('reject');
  });

  it('rejects relative, home-relative, `..` and empty patterns', () => {
    expect(reply('external_directory', ['src/*'])).toBe('reject');
    expect(reply('external_directory', ['~/secrets'])).toBe('reject');
    expect(reply('external_directory', [`${work}/../wt-evil/*`])).toBe('reject');
    expect(reply('external_directory', [])).toBe('reject');
  });

  it('compares symlink-resolved paths on both sides (m2)', () => {
    const link = join(base, 'link-to-wt');
    symlinkSync(work, link);
    // The root given through the link, the ask through the real path…
    expect(decideOpencodePermission('external_directory', [`${work}/*`], resolveAllowedRoots([link])).reply).toBe(
      'once',
    );
    // …and the other way round, including a tail that does not exist yet.
    expect(reply('external_directory', [join(link, 'src', 'new.ts')])).toBe('once');
    // A link inside the root that points out of it is outside.
    symlinkSync(join(base, 'wt-evil'), join(work, 'escape'));
    expect(reply('external_directory', [join(work, 'escape', 'x')])).toBe('reject');
  });

  it('names the denial, and says nothing when allowed', () => {
    expect(decideOpencodePermission('external_directory', [`${work}/*`], roots).note).toBeUndefined();
    expect(decideOpencodePermission('external_directory', ['/etc/*'], roots).note).toBe(
      "opencode: denied permission 'external_directory' for /etc/* — outside this run's allowed directories",
    );
  });
});

/**
 * #686 — the run's own task evidence directory. The kit writes the diagnosis,
 * the red-proof transcripts and the phase record under
 * `<primary checkout>/.local/xezar/tasks/<runId>/` (and, for a run that already
 * has a directory there, the frozen `<primary checkout>/.local/xezar-tasks/<runId>/`
 * of the #665 dual-read window). It sits in the PRIMARY checkout, outside the
 * worktree an isolated run is confined to, so an `external_directory` ask for it
 * used to be rejected and an OpenCode run could not write the evidence every
 * other backend writes.
 *
 * `runEvidenceRoots` is the one producer of those two roots; the runner feeds
 * them into `resolveAllowedRoots` beside `cwd`. (a) is the regression this
 * closes — it is RED before the fix. (b)-(d) are the guards, and they pass on
 * BOTH sides: widening the grant to a sibling run, to the rest of the state
 * tree or to the project root is the failure mode of the FIX, not of the bug.
 *
 * Deliberately no `os.tmpdir()` root here (unlike the runner's real list): the
 * fixture project lives under the temp dir, so including it would make every
 * guard below pass for the wrong reason.
 */
describe("the run's own task evidence directory (#686)", () => {
  const RUN = '3d0348dc-815b-4e47-ad89-ef537ca4a2f0';
  const OTHER_RUN = '00000000-1111-4222-8333-444444444444';
  // The convention under test, spelled ONCE here: the evidence root the kit
  // writes today, and the frozen historical root of the #665 dual-read window.
  // A getter, not a const: `base` is assigned in `beforeEach`, so a value
  // captured here would be built from an empty string at describe time.
  const evidenceOf = (runId: string): string => join(base, '.local', 'xezar', 'tasks', runId);
  const frozenOf = (runId: string): string => join(base, '.local', 'xezar-tasks', runId);
  /** The roots list the fix must produce for ONE run, built HERE so the guards
   *  below can run on BOTH sides of the fix — they are controls, not the
   *  regression. (a) additionally pins the production producer to exactly it. */
  const rootsFor = (runId: string): string[] => resolveAllowedRoots([work, evidenceOf(runId), frozenOf(runId)]);
  /** What the runner's list was before the fix: `cwd` and nothing else. */
  const preFixRoots = (): string[] => resolveAllowedRoots([work]);
  const ask = (roots: string[], ...patterns: string[]): string =>
    decideOpencodePermission('external_directory', patterns, roots).reply;

  it('(a) grants this run its own evidence directory, under either evidence root', () => {
    // The producer, pinned to exactly two paths — an over-wide fix (the whole
    // `.local/xezar/tasks` tree, the state root, the project root) fails here.
    expect(runEvidenceRoots(base, RUN)).toEqual([evidenceOf(RUN), frozenOf(RUN)]);
    const roots = resolveAllowedRoots([work, ...runEvidenceRoots(base, RUN)]);
    expect(ask(roots, join(evidenceOf(RUN), 'red-proofs'))).toBe('once');
    expect(ask(roots, `${evidenceOf(RUN)}/*`)).toBe('once');
    expect(ask(roots, join(frozenOf(RUN), 'red-proofs'))).toBe('once');
  });

  it('(b) still rejects the same path for a different run, under either root', () => {
    for (const roots of [preFixRoots(), rootsFor(RUN)]) {
      expect(ask(roots, join(evidenceOf(OTHER_RUN), 'red-proofs'))).toBe('reject');
      expect(ask(roots, join(frozenOf(OTHER_RUN), 'red-proofs'))).toBe('reject');
    }
    // …and the grant is per RUN, not per session: another run's own roots do not
    // reach this run's evidence either.
    expect(ask(rootsFor(OTHER_RUN), join(evidenceOf(RUN), 'red-proofs'))).toBe('reject');
  });

  it('(c) still rejects the rest of the state tree beside the evidence directory', () => {
    for (const roots of [preFixRoots(), rootsFor(RUN)]) {
      expect(ask(roots, join(base, '.local', 'xezar', 'campaigns', 'x'))).toBe('reject');
      expect(ask(roots, join(base, '.local', 'xezar', 'tasks'))).toBe('reject');
      expect(ask(roots, join(base, '.local', 'xezar', 'worktrees', RUN, 'src', 'a.ts'))).toBe('reject');
      expect(ask(roots, join(base, '.local', 'xezar', 'runs'))).toBe('reject');
    }
  });

  it('(d) still rejects the project root itself', () => {
    for (const roots of [preFixRoots(), rootsFor(RUN)]) {
      expect(ask(roots, base)).toBe('reject');
      expect(ask(roots, `${base}/*`)).toBe('reject');
      expect(ask(roots, join(base, '.local'))).toBe('reject');
    }
  });

  it('(e) grants nothing for a missing or malformed run id — fail closed', () => {
    expect(runEvidenceRoots(base, undefined)).toEqual([]);
    expect(runEvidenceRoots(base, '')).toEqual([]);
    expect(runEvidenceRoots(base, '..')).toEqual([]);
    expect(runEvidenceRoots(base, '../..')).toEqual([]);
    expect(runEvidenceRoots(base, 'a/b')).toEqual([]);
    expect(ask(resolveAllowedRoots([work, ...runEvidenceRoots(base, '..')]), join(base, '.local'))).toBe('reject');
  });
});

describe('every other permission is rejected (M1)', () => {
  // Each of these used to resolve relative to cwd and come back `once`.
  for (const [permission, pattern] of [
    ['webfetch', 'https://evil.example/x'],
    ['bash', 'rm -rf /'],
    ['doom_loop', 'read'],
    ['read', `${work}/.env`],
    ['edit', `${work}/src/a.ts`],
  ] as const) {
    it(`rejects '${permission}' for ${pattern}`, () => {
      const decision = decideOpencodePermission(permission, [pattern], roots);
      expect(decision.reply).toBe('reject');
      expect(decision.note).toBe(
        `opencode: denied permission '${permission}' for ${pattern} — xezar answers only 'external_directory' asks inside this run's directories and rejects every other permission`,
      );
    });
  }
});

describe('PermissionDenialGuard (m3)', () => {
  const once = { reply: 'once' } as const;
  const reject = { reply: 'reject' } as const;

  it('fails on the same denial three times back to back', () => {
    const guard = new PermissionDenialGuard();
    for (let i = 1; i < MAX_REPEATED_PERMISSION_DENIAL; i++) expect(guard.record('bash', ['x'], reject)).toBeNull();
    expect(guard.record('bash', ['x'], reject)).toContain('3 times in a row');
  });

  it('resets the run on an allowed ask', () => {
    const guard = new PermissionDenialGuard();
    guard.record('bash', ['x'], reject);
    guard.record('bash', ['x'], reject);
    expect(guard.record('external_directory', ['/w/*'], once)).toBeNull();
    expect(guard.record('bash', ['x'], reject)).toBeNull();
    expect(guard.record('bash', ['x'], reject)).toBeNull();
    expect(guard.record('bash', ['x'], reject)).toContain('in a row');
  });

  it('resets the run on a different denial', () => {
    const guard = new PermissionDenialGuard();
    guard.record('bash', ['x'], reject);
    guard.record('bash', ['x'], reject);
    expect(guard.record('bash', ['y'], reject)).toBeNull();
    expect(guard.record('bash', ['x'], reject)).toBeNull();
    expect(guard.record('bash', ['x'], reject)).toBeNull();
  });

  it('fails on the total bound even when no denial repeats', () => {
    const guard = new PermissionDenialGuard();
    for (let i = 1; i < MAX_PERMISSION_DENIALS; i++) expect(guard.record('bash', [`cmd ${i}`], reject)).toBeNull();
    expect(guard.record('bash', ['last'], reject)).toContain(`${MAX_PERMISSION_DENIALS} denied permission asks`);
  });
});
