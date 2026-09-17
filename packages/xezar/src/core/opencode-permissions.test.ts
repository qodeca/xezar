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
