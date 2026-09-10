import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` so the mock exists before the (hoisted) `vi.mock` factory runs. `gh()` builds its
// subprocess runner from `promisify(execFile)` at module load, so replacing `execFile` is the only
// seam that reaches it — the same wiring `github.test.ts` uses, for the same reason: no real `gh`
// on the box, and no network.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  // The default THROWS rather than forwarding to the real `execFile`. Forwarding would let a case
  // that forgets `stubGh` spawn an actual `gh` — network, credentials and all — in a suite
  // AGENTS.md requires to stay free of servers. A thrower fails in the test that caused it.
  execFileMock.mockImplementation(() => {
    throw new Error('execFile was called without stubGh() — this suite must never reach a real gh');
  });
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

import {
  fetchGithubPrDiff,
  fetchPrFilePages,
  GH_PR_DIFF_FILE_CAP,
  GH_PR_PATCH_CAP,
  GithubPrNotFoundError,
} from './github.ts';

const row = (n: number) => ({
  filename: `src/file-${n}.ts`,
  status: 'modified',
  additions: 1,
  deletions: 0,
  patch: '@@ -1 +1 @@\n-old\n+new',
});

describe('GitHub PR file pagination', () => {
  it('stops on a short page', async () => {
    const run = vi.fn(async (page: number) => JSON.stringify(page === 1 ? [row(1)] : []));
    expect(await fetchPrFilePages(run)).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never requests beyond the 300-file contract cap', async () => {
    const run = vi.fn(async (page: number) =>
      JSON.stringify(Array.from({ length: 100 }, (_, index) => row((page - 1) * 100 + index))),
    );
    expect(await fetchPrFilePages(run)).toHaveLength(GH_PR_DIFF_FILE_CAP);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenLastCalledWith(3);
  });

  it('rejects malformed GitHub page envelopes at the boundary', async () => {
    await expect(fetchPrFilePages(async () => JSON.stringify({ files: [] }))).rejects.toThrow();
  });
});

/**
 * `fetchGithubPrDiff` end to end, with `gh` replaced.
 *
 * Every cap in this function is a promise the cockpit's PR diff pane makes about a page it can
 * actually render, and every one of them is silent when it breaks: the answer is still
 * `available: true`, just missing files nobody is told about. So the assertions below are on the
 * `truncated` flag and the `reason` sentence as much as on the files themselves.
 *
 * The cache is keyed `repoRoot\0number\0headSha` and has no test-visible reset, so each case
 * below uses a repo root of its own rather than reaching into module state.
 */
describe('fetchGithubPrDiff', () => {
  /** A `gh` that answers `pr view` with `headSha` and the files API from `pages`. */
  function stubGh(options: {
    headSha?: string;
    pages?: (page: number) => unknown[];
    fail?: (argv: string[]) => Error | undefined;
  }) {
    const calls: string[][] = [];
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as (error: unknown, result?: unknown) => void;
      calls.push(argv);
      const failure = options.fail?.(argv);
      if (failure) {
        cb(failure);
        return;
      }
      if (argv[0] === 'pr') {
        cb(null, { stdout: JSON.stringify({ headRefOid: options.headSha ?? 'a'.repeat(40) }), stderr: '' });
        return;
      }
      const page = Number(/[?&]page=(\d+)/.exec(argv[1] ?? '')?.[1] ?? '1');
      cb(null, { stdout: JSON.stringify(options.pages?.(page) ?? []), stderr: '' });
    });
    return calls;
  }

  const file = (n: number, extra: Record<string, unknown> = {}) => ({
    filename: `src/file-${n}.ts`,
    status: 'modified',
    additions: 2,
    deletions: 1,
    patch: '@@ -1 +1 @@\n-old\n+new',
    ...extra,
  });

  beforeEach(() => {
    execFileMock.mockReset();
    vi.stubEnv('XEZ_DRY_RUN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('answers a plausible fixture under XEZ_DRY_RUN without touching gh', async () => {
    vi.stubEnv('XEZ_DRY_RUN', '1');
    execFileMock.mockImplementation(() => {
      throw new Error('the dry run must not shell out');
    });

    const result = await fetchGithubPrDiff('/repo', 42);

    expect(result.available).toBe(true);
    // The fixture carries one of every patch-unavailable reason, so the pane's own branches are
    // all exercisable offline.
    if (!result.available) throw new Error('unreachable');
    expect(result.files.map((f) => f.patchUnavailableReason)).toEqual([
      undefined,
      undefined,
      'binary',
      'too-large',
    ]);
    expect(result.files.find((f) => f.status === 'renamed')?.previousPath).toBe('src/old-name.ts');
  });

  it('reads the head sha first and pages the files API against it', async () => {
    const calls = stubGh({ headSha: 'b'.repeat(40), pages: (page) => (page === 1 ? [file(1), file(2)] : []) });

    const result = await fetchGithubPrDiff('/repo-basic', 7);

    if (!result.available) throw new Error('unreachable');
    expect(result.headSha).toBe('b'.repeat(40));
    expect(result.number).toBe(7);
    expect(result.files.map((f) => f.path)).toEqual(['src/file-1.ts', 'src/file-2.ts']);
    // The totals come from the RAW rows, not from the (possibly trimmed) files list.
    expect(result.additions).toBe(4);
    expect(result.deletions).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(calls[0]?.slice(0, 3)).toEqual(['pr', 'view', '7']);
    expect(calls[1]?.[1]).toContain('/pulls/7/files?per_page=100&page=1');
  });

  it('serves the second read from cache, and refetches on refresh', async () => {
    const calls = stubGh({ headSha: 'c'.repeat(40), pages: (page) => (page === 1 ? [file(1)] : []) });

    await fetchGithubPrDiff('/repo-cache', 7);
    const afterFirst = calls.length;
    await fetchGithubPrDiff('/repo-cache', 7);
    // The head probe still runs — it is what tells the cache whether it is stale.
    expect(calls.length).toBe(afterFirst + 1);

    await fetchGithubPrDiff('/repo-cache', 7, true);
    expect(calls.length).toBeGreaterThan(afterFirst + 2);
  });

  it('a new head commit busts the cache without anyone asking for a refresh', async () => {
    let head = 'd'.repeat(40);
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as (error: unknown, result?: unknown) => void;
      if (argv[0] === 'pr') {
        cb(null, { stdout: JSON.stringify({ headRefOid: head }), stderr: '' });
        return;
      }
      const page = Number(/[?&]page=(\d+)/.exec(argv[1] ?? '')?.[1] ?? '1');
      cb(null, { stdout: JSON.stringify(page === 1 ? [file(1)] : []), stderr: '' });
    });

    const first = await fetchGithubPrDiff('/repo-head', 7);
    head = 'e'.repeat(40);
    const second = await fetchGithubPrDiff('/repo-head', 7);

    if (!first.available || !second.available) throw new Error('unreachable');
    expect(first.headSha).toBe('d'.repeat(40));
    // A force-push must not be served the previous commit's diff.
    expect(second.headSha).toBe('e'.repeat(40));
  });

  describe('the caps, and the sentence each one owes the reader', () => {
    it('drops an oversized patch, says so, and marks the file truncated', async () => {
      stubGh({
        headSha: 'f'.repeat(40),
        pages: (page) =>
          page === 1 ? [file(1, { patch: 'x'.repeat(GH_PR_PATCH_CAP + 1) }), file(2)] : [],
      });

      const result = await fetchGithubPrDiff('/repo-patch', 7);

      if (!result.available) throw new Error('unreachable');
      expect(result.files[0]).toMatchObject({
        truncated: true,
        patchUnavailableReason: 'too-large',
      });
      expect(result.files[0]?.patch).toBeUndefined();
      expect(result.truncated).toBe(true);
      expect(result.reason).toContain('exceeded the per-file limit');
      // The neighbour is untouched — one big file must not cost the rest their patches.
      expect(result.files[1]?.patch).toBe('@@ -1 +1 @@\n-old\n+new');
    });

    it('distinguishes a binary file from a patch GitHub simply did not send', async () => {
      stubGh({
        headSha: '1'.repeat(40),
        pages: (page) =>
          page === 1
            ? [
                { filename: 'logo.png', status: 'modified', additions: 0, deletions: 0 },
                { filename: 'huge.txt', status: 'modified', additions: 900, deletions: 3 },
              ]
            : [],
      });

      const result = await fetchGithubPrDiff('/repo-binary', 7);

      if (!result.available) throw new Error('unreachable');
      // Zero on both sides is how GitHub spells "binary"; a file with real counts and no patch
      // is one GitHub declined to render, which is a different sentence for the reader.
      expect(result.files[0]?.patchUnavailableReason).toBe('binary');
      expect(result.files[1]?.patchUnavailableReason).toBe('not-provided');
      // Neither is a per-file truncation, so neither claims one.
      expect(result.files.some((f) => f.truncated)).toBe(false);
      expect(result.truncated).toBe(false);
    });

    it('calls a full third page partial rather than claiming a completeness it cannot prove', async () => {
      stubGh({
        headSha: '2'.repeat(40),
        pages: (page) => Array.from({ length: 100 }, (_, i) => file((page - 1) * 100 + i)),
      });

      const result = await fetchGithubPrDiff('/repo-cap', 7);

      if (!result.available) throw new Error('unreachable');
      expect(result.files).toHaveLength(GH_PR_DIFF_FILE_CAP);
      expect(result.truncated).toBe(true);
      expect(result.reason).toContain(`Only the first ${GH_PR_DIFF_FILE_CAP} files are shown.`);
    });

    // FEW BIG FILES, not many small ones. The trim loop re-serializes the WHOLE array on every
    // iteration (`github.ts` `while (… JSON.stringify({ …, files: kept }) > CAP)`), so the cost is
    // quadratic in the number of files it has to drop. An earlier version of this fixture used
    // 300 x 40 KB, which crosses the cap by 3x and needs ~200 iterations over ~12 MB: 1.2s alone,
    // but 6s with several gate runs sharing the machine — over the 5s default, every time. 40 x
    // 128 KB crosses the same cap in a handful of iterations and asserts exactly the same three
    // things. The explicit budget below is the belt to that brace: a test about a SIZE cap should
    // not share a timeout with several hundred sub-second unit tests.
    it('trims files from the end until the payload fits, and says the size limit did it', async () => {
      const BIG_FILES = 40;
      stubGh({
        headSha: '3'.repeat(40),
        pages: (page) =>
          page === 1
            ? Array.from({ length: BIG_FILES }, (_, i) => file(i, { patch: 'y'.repeat(128 * 1024) }))
            : [],
      });

      const result = await fetchGithubPrDiff('/repo-json', 7);

      if (!result.available) throw new Error('unreachable');
      // Under the file cap, so this is the SIZE cap talking and nothing else.
      expect(BIG_FILES).toBeLessThan(GH_PR_DIFF_FILE_CAP);
      expect(result.files.length).toBeLessThan(BIG_FILES);
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.truncated).toBe(true);
      expect(result.reason).toContain('response size limit omitted some files');
      expect(result.reason).not.toContain('Only the first');
      // The totals still describe the WHOLE pull request, not the trimmed slice.
      expect(result.additions).toBe(BIG_FILES * 2);
    }, 20_000);
  });

  describe('degradation', () => {
    it('throws the typed not-found error so the route can answer 404', async () => {
      stubGh({ fail: () => new Error('gh: Could not resolve to a PullRequest with the number of 9') });

      await expect(fetchGithubPrDiff('/repo-404', 9)).rejects.toBeInstanceOf(GithubPrNotFoundError);
    });

    it.each(['HTTP 404: Not Found', 'no pull requests found for branch'])(
      'treats %j as not-found too',
      async (message) => {
        stubGh({ fail: () => new Error(message) });

        await expect(fetchGithubPrDiff('/repo-404b', 9)).rejects.toBeInstanceOf(GithubPrNotFoundError);
      },
    );

    it('reports a missing gh with the install hint rather than a raw spawn error', async () => {
      stubGh({ fail: () => new Error('spawn gh ENOENT') });

      const result = await fetchGithubPrDiff('/repo-enoent', 9);

      expect(result).toEqual({
        available: false,
        reason: 'gh CLI not found — install it and run `gh auth login`',
      });
    });

    it("reports any other failure as gh's own first line", async () => {
      stubGh({
        fail: () => new Error('gh: authentication required\nRun gh auth login to authenticate.'),
      });

      const result = await fetchGithubPrDiff('/repo-auth', 9);

      // One line: the rest of gh's output is a wall the dialog has no room for.
      expect(result).toEqual({ available: false, reason: 'gh: authentication required' });
    });

    it('degrades rather than throwing when GitHub answers a shape we do not recognise', async () => {
      stubGh({ headSha: '4'.repeat(40), pages: () => [{ filename: 'a.ts' }] });

      const result = await fetchGithubPrDiff('/repo-shape', 9);

      expect(result.available).toBe(false);
    });
  });
});
