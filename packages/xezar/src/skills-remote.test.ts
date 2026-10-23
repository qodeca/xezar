import { basename, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bareDirFor, isPinnedSha, shouldPassiveFetch } from './skills-remote.ts';

const TTL = 6 * 60 * 60 * 1_000;

describe('shouldPassiveFetch', () => {
  it('fetches on the first passive touch this process', () => {
    // A clone left by an earlier run must be refreshed on first read, else a
    // long-running server serves whatever ref that old clone happened to have.
    expect(shouldPassiveFetch({ attempted: false, fetchedAt: 0, now: 1_000, ttlMs: TTL })).toBe(true);
  });

  it('does not re-fetch within the TTL once touched', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ attempted: true, fetchedAt: now - 60_000, now, ttlMs: TTL })).toBe(false);
  });

  it('re-fetches once the last fetch is older than the TTL', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ attempted: true, fetchedAt: now - TTL - 1, now, ttlMs: TTL })).toBe(true);
  });

  it('treats exactly-TTL as still fresh (strictly greater re-fetches)', () => {
    const now = 10 * 60 * 60 * 1_000;
    expect(shouldPassiveFetch({ attempted: true, fetchedAt: now - TTL, now, ttlMs: TTL })).toBe(false);
  });
});

describe('bareDirFor', () => {
  it('keys the global cache on owner__name regardless of URL shape', () => {
    const expected = bareDirFor('qodeca/xezar-skills');
    expect(bareDirFor('https://github.com/qodeca/xezar-skills.git')).toBe(expected);
    expect(bareDirFor('git@github.com:qodeca/xezar-skills')).toBe(expected);
    expect(expected.endsWith('qodeca__xezar-skills')).toBe(true);
  });

  // A Windows drive source spelled with backslashes is ONE segment, so its name spelled the whole
  // path and a deep project put the clone folder past what Git for Windows accepts.
  describe('a long Windows drive source', () => {
    const root = dirname(bareDirFor('qodeca/xezar-skills'));
    const deepWindows =
      'C:\\Users\\someone\\Projects\\a-deep-project-folder-22\\.local\\test-tmp\\xez-catalog-web-origin-AVKkwA';

    it('gets a short, stable name with a readable tail', () => {
      const dir = bareDirFor(deepWindows);
      expect(dirname(dir)).toBe(root);
      expect(basename(dir)).toMatch(/^xez-catalog-web-orig-[0-9a-f]{12}$/);
      expect(bareDirFor(deepWindows)).toBe(dir);
    });

    it('keeps two different sources apart', () => {
      expect(bareDirFor(deepWindows)).not.toBe(bareDirFor(deepWindows.replace('-22', '-23')));
    });

    it('keeps a short drive source exactly as it was', () => {
      expect(basename(bareDirFor('C:\\skills'))).toBe('C__-skills');
    });
  });

  // Only a Windows drive source changes: every other name, however long, is the one it always was.
  it.each([
    ['a long owner/name', 'my-organisation-name/company-wide-agent-skills', 'my-organisation-name__company-wide-agent-skills'],
    ['a long https URL', `https://example.test/${'o'.repeat(80)}/${'n'.repeat(80)}.git`, `${'o'.repeat(80)}__${'n'.repeat(80)}`],
    ['a long POSIX path', '/home/someone/projects/a-team-skills-repository-with-a-really-long-name', 'projects__a-team-skills-repository-with-a-really-long-name'],
  ])('keeps the name of %s', (_label, source, name) => {
    expect(basename(bareDirFor(source))).toBe(name);
  });
});

describe('isPinnedSha', () => {
  it('accepts 40- and 64-hex, rejects branch names', () => {
    expect(isPinnedSha('a'.repeat(40))).toBe(true);
    expect(isPinnedSha('b'.repeat(64))).toBe(true);
    expect(isPinnedSha('main')).toBe(false);
  });
});
