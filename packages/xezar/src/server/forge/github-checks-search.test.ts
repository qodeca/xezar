import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmptyPath } from '../../../test/helpers/empty-path.ts';


// `vi.hoisted` so `execFileMock` exists before the (hoisted) vi.mock factory runs. `gh()` builds
// its subprocess runner from `promisify(execFile)` at module load, so the availability-probe tests
// below drive `gh repo view` entirely through this mock — no real `gh` on the box. Everything else
// in this file is pure and never touches child_process, so the default passthrough is harmless.
const execFileMock = vi.hoisted(() => vi.fn());
useEmptyPath();

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  execFileMock.mockImplementation((...args: unknown[]) =>
    (actual.execFile as (...a: unknown[]) => unknown)(...args),
  );
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

import {
  __clearRepoHandleCacheForTests,
  fetchPrChecks,
  fetchGithub,
  searchGithubItems,
  GH_CHECKS_MAX,
  GH_SEARCH_MAX,
} from './github.ts';

/** `fetchPrChecks` (#664) hydrates the PR row's checks glyph lazily, keyed by PR number — the list
 *  call no longer pays for `statusCheckRollup`. It mirrors `fetchCommitChecks`: aliased so N PRs
 *  cost one subprocess, each alias resolves independently, and any failure degrades to absent
 *  glyphs rather than failing the tab. */
describe('fetchPrChecks (#664)', () => {
  // One aliased `pullRequest` node per PR: `'missing'` → the alias resolved null (unknown PR),
  // `null` → the PR exists but has no CI configured, a state → that rolled-up glyph.
  const reply = (states: Array<string | null | 'missing'>) =>
    JSON.stringify({
      data: {
        repository: Object.fromEntries(
          states.map((state, i) => [
            `p${i}`,
            state === 'missing'
              ? null
              : { commits: { nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }] } },
          ]),
        ),
      },
    });

  it('maps each alias back to its PR number', async () => {
    const runGraphql = vi.fn(async () => reply(['SUCCESS', 'FAILURE', 'PENDING']));
    const checks = await fetchPrChecks(runGraphql, 'o', 'n', [7, 12, 20]);
    expect(checks).toEqual({ 7: 'passing', 12: 'failing', 20: 'pending' });
  });

  it('leaves an unknown PR absent rather than null — the alias resolved null', async () => {
    const runGraphql = vi.fn(async () => reply(['SUCCESS', 'missing']));
    const checks = await fetchPrChecks(runGraphql, 'o', 'n', [7, 8]);
    expect(checks[7]).toBe('passing');
    expect(8 in checks).toBe(false);
  });

  it('distinguishes "no CI configured" (null) from "not looked up" (absent)', async () => {
    const runGraphql = vi.fn(async () => reply([null]));
    const checks = await fetchPrChecks(runGraphql, 'o', 'n', [7]);
    expect(7 in checks).toBe(true);
    expect(checks[7]).toBeNull();
  });

  it('chunks at the given size, and a failed chunk costs only its own glyphs', async () => {
    const runGraphql = vi.fn(async (q: string) => {
      if (q.includes('pullRequest(number: 3)')) throw new Error('HTTP 502');
      return reply(['SUCCESS', 'SUCCESS']);
    });
    const checks = await fetchPrChecks(runGraphql, 'o', 'n', [1, 2, 3, 4], 2);
    expect(runGraphql).toHaveBeenCalledTimes(2); // [1,2] then [3,4]
    expect(checks[1]).toBe('passing');
    expect(checks[2]).toBe('passing');
    expect(3 in checks).toBe(false); // its chunk threw
    expect(4 in checks).toBe(false);
  });

  it('degrades to an empty map when every chunk fails, never throwing', async () => {
    const runGraphql = vi.fn(async () => { throw new Error('offline'); });
    await expect(fetchPrChecks(runGraphql, 'o', 'n', [7])).resolves.toEqual({});
  });

  it('spawns nothing for an empty PR list', async () => {
    const runGraphql = vi.fn();
    expect(await fetchPrChecks(runGraphql, 'o', 'n', [])).toEqual({});
    expect(runGraphql).not.toHaveBeenCalled();
  });

  it('caps a single query at GH_CHECKS_MAX aliases', () => {
    // The route caps the request at GH_CHECKS_MAX; the default chunk size matches so one query
    // never exceeds it. A defensive guard so raising one constant without the other is caught.
    expect(GH_CHECKS_MAX).toBe(100);
  });
});

/** The list tier stopped fetching `statusCheckRollup` (#664): it was the dominant cost on repos
 *  with many open PRs. This drives `gh` through `execFileMock` and asserts the PR list call omits
 *  the rollup field and that PR rows come back with `checks: null` (hydrated lazily elsewhere). */
describe('fetchGithub omits statusCheckRollup from the list call (#664)', () => {
  beforeEach(() => {
    vi.stubEnv('XEZ_DRY_RUN', ''); // dry-run would short-circuit the gh path we are asserting on
    execFileMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not request the rollup field and leaves list PR checks null', async () => {
    let prJsonArg = '';
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      let stdout = '{}';
      if (argv[0] === 'repo') stdout = 'owner/n\n';
      else if (argv[0] === 'issue') stdout = '[]';
      else if (argv[0] === 'pr') {
        prJsonArg = argv[argv.indexOf('--json') + 1] ?? '';
        stdout = JSON.stringify([
          {
            number: 7,
            title: 'a pr',
            author: { login: 'x' },
            createdAt: '2026-07-01T00:00:00Z',
            labels: [],
            body: 'b',
            url: 'https://github.com/owner/n/pull/7',
            isDraft: false,
            additions: 1,
            deletions: 2,
          },
        ]);
      }
      cb(null, { stdout, stderr: '' });
    });

    const data = await fetchGithub('/repo/no-rollup-664');
    expect(prJsonArg).not.toContain('statusCheckRollup');
    expect(prJsonArg).toContain('isDraft');
    expect(data.prs[0]?.checks).toBeNull();
  });
});

/**
 * Cross-state search (#730).
 *
 * The bug this covers: `fetchGithub` lists the OPEN set only (`gh issue/pr list` defaults to
 * `--state open`) and the tab's search is an in-memory filter over exactly that payload — so a
 * merged or closed item is unreachable no matter what the user types. `searchGithubItems` is the
 * path that asks GitHub instead, and these tests pin the three things that make it work: the
 * numeric lookup is state-agnostic, the text search does not constrain state, and every failure
 * degrades quietly instead of throwing into the tab.
 */
describe('searchGithubItems (#730)', () => {
  /** Capture every `gh` argv while answering with `answer(argv)`. */
  const ghSpy = (answer: (argv: string[]) => string | Error) => {
    const argvs: string[][] = [];
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      argvs.push(argv);
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      const out = answer(argv);
      if (out instanceof Error) cb(out, null);
      else cb(null, { stdout: out, stderr: '' });
    });
    return argvs;
  };

  const searchHit = (over: Record<string, unknown> = {}) => ({
    number: 4507,
    title: 'reconcile payment-session amount with order total',
    author: { login: 'wojciechszyjka' },
    createdAt: '2026-07-25T07:08:17Z',
    labels: [{ name: 'security', color: 'D93F0B' }],
    body: 'body',
    url: 'https://github.com/owner/n/pull/4507',
    isDraft: false,
    commentsCount: 20,
    ...over,
  });

  beforeEach(() => {
    vi.stubEnv('XEZ_DRY_RUN', '');
    execFileMock.mockReset();
    __clearRepoHandleCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves a bare number through `pr view`, which finds merged and closed PRs alike', async () => {
    const argvs = ghSpy((argv) =>
      argv[0] === 'pr' && argv[1] === 'view'
        ? JSON.stringify({
            number: 4507,
            title: 'a merged pr',
            author: { login: 'someone' },
            createdAt: '2026-07-25T07:08:17Z',
            labels: [],
            body: 'b',
            url: 'https://github.com/owner/n/pull/4507',
            isDraft: false,
            additions: 3,
            deletions: 1,
          })
        : '',
    );

    const res = await searchGithubItems('/repo/search-num', 'pr', '4507');

    expect(res.available).toBe(true);
    expect(res.items.map((i) => i.number)).toEqual([4507]);
    expect(res.items[0]?.kind).toBe('pr');
    // A view lookup carries no state filter at all — that is exactly why it reaches a merged PR.
    const view = argvs.find((a) => a[0] === 'pr' && a[1] === 'view');
    expect(view).toBeDefined();
    expect(view).toContain('4507');
    expect(view?.join(' ')).not.toContain('--state');
  });

  it('accepts the `#4507` spelling the search box invites', async () => {
    ghSpy((argv) =>
      argv[0] === 'issue' && argv[1] === 'view'
        ? JSON.stringify({
            number: 4507,
            title: 'an issue',
            author: { login: 'someone' },
            createdAt: '2026-07-25T07:08:17Z',
            labels: [],
            body: '',
            url: 'https://github.com/owner/n/issues/4507',
          })
        : '',
    );

    const res = await searchGithubItems('/repo/search-hash', 'issue', '#4507');
    expect(res.items.map((i) => i.number)).toEqual([4507]);
  });

  it('searches text with NO --state flag, so closed and merged hits are included', async () => {
    const argvs = ghSpy((argv) => {
      if (argv[0] === 'repo') return 'owner/n\n';
      if (argv[0] === 'search') return JSON.stringify([searchHit()]);
      return '';
    });

    const res = await searchGithubItems('/repo/search-text', 'pr', 'payment-session');

    expect(res.available).toBe(true);
    expect(res.items[0]?.number).toBe(4507);
    // `commentsCount` is the search API's spelling of the list tier's `comments`.
    expect(res.items[0]?.comments).toBe(20);
    expect(res.items[0]?.checks).toBeNull();
    expect(res.labelColors).toEqual({ security: 'D93F0B' });
    const search = argvs.find((a) => a[0] === 'search');
    expect(search?.slice(0, 2)).toEqual(['search', 'prs']);
    expect(search).toContain('--repo');
    expect(search).toContain('owner/n');
    // `gh search --state` only accepts open|closed; omitting it is what searches every state.
    expect(search?.join(' ')).not.toContain('--state');
  });

  it('routes the issues view to `gh search issues`', async () => {
    const argvs = ghSpy((argv) => {
      if (argv[0] === 'repo') return 'owner/n\n';
      if (argv[0] === 'search') return JSON.stringify([searchHit({ number: 12 })]);
      return '';
    });

    await searchGithubItems('/repo/search-kind', 'issue', 'flaky');
    expect(argvs.find((a) => a[0] === 'search')?.slice(0, 2)).toEqual(['search', 'issues']);
  });

  /**
   * The query must sit behind an end-of-flags `--` (#836). Ahead of it, `gh` parses a query that
   * starts with `-`/`--` as a flag: `--foo` answers `unknown flag: --foo`, which the quiet degrade
   * turns into the tab's "GitHub could not be searched" — an infrastructure failure reported for
   * ordinary search text — and the exact query `--web` matches `gh search`'s own `-w, --web` and
   * opens a browser on the machine hosting the cockpit. A stub cannot reproduce the CLI's parser,
   * so what is pinned is the argv shape that decides it: `--` immediately before the query, last.
   */
  it('sends the query behind `--`, so a flag-shaped query stays search text', async () => {
    const argvs = ghSpy((argv) => {
      if (argv[0] === 'repo') return 'owner/n\n';
      if (argv[0] === 'search') return JSON.stringify([searchHit()]);
      return '';
    });

    const res = await searchGithubItems('/repo/search-flagish', 'pr', '--web');

    expect(res.available).toBe(true);
    const search = argvs.find((a) => a[0] === 'search');
    expect(search?.at(-1)).toBe('--web');
    expect(search?.at(-2)).toBe('--');
    // Nothing flag-shaped may precede the terminator either — the query is the only trailing arg.
    expect(search?.slice(0, -2)).not.toContain('--web');
  });

  /**
   * `gh search issues` does not define `isDraft` and rejects the whole call with
   * `Unknown JSON field: "isDraft"` — so asking for it made EVERY text query on the Issues tab
   * degrade to "GitHub could not be searched", leaving a closed issue reachable by number only.
   * Stubbing `gh` cannot reproduce the CLI's own rejection, so what is pinned here is the input
   * that provokes it: the field list this path sends, per kind.
   */
  it('never asks `gh search issues` for the PR-only isDraft field', async () => {
    const argvs = ghSpy((argv) => {
      if (argv[0] === 'repo') return 'owner/n\n';
      // The real CLI omits the key entirely for issues; the hit must still parse.
      if (argv[0] === 'search') {
        const { isDraft: _drop, ...issueHit } = searchHit({ number: 797 });
        return JSON.stringify([issueHit]);
      }
      return '';
    });

    const res = await searchGithubItems('/repo/search-issue-fields', 'issue', 'lease timing');

    const search = argvs.find((a) => a[0] === 'search');
    const fields = search?.[search.indexOf('--json') + 1];
    expect(fields).not.toContain('isDraft');
    expect(fields).toContain('commentsCount');
    expect(res.available).toBe(true);
    expect(res.items.map((i) => i.number)).toEqual([797]);
    // Issues have no draft concept — the flag must not leak onto the row or its labels.
    expect(res.items[0]?.isDraft).toBeUndefined();
    expect(res.items[0]?.labels).not.toContain('draft');
  });

  it('still asks `gh search prs` for isDraft, which that search does define', async () => {
    const argvs = ghSpy((argv) => {
      if (argv[0] === 'repo') return 'owner/n\n';
      if (argv[0] === 'search') return JSON.stringify([searchHit({ isDraft: true })]);
      return '';
    });

    const res = await searchGithubItems('/repo/search-pr-fields', 'pr', 'payment-session');

    const search = argvs.find((a) => a[0] === 'search');
    expect(search?.[search.indexOf('--json') + 1]).toContain('isDraft');
    expect(res.items[0]?.isDraft).toBe(true);
    expect(res.items[0]?.labels).toContain('draft');
  });

  it('falls back to a text search when the number resolves to nothing', async () => {
    const argvs = ghSpy((argv) => {
      if (argv[0] === 'repo') return 'owner/n\n';
      if (argv[0] === 'pr' && argv[1] === 'view') return new Error('no pull requests found for 4507');
      if (argv[0] === 'search') return JSON.stringify([searchHit({ title: 'mentions 4507' })]);
      return '';
    });

    const res = await searchGithubItems('/repo/search-fallthrough', 'pr', '4507');

    expect(res.available).toBe(true);
    expect(res.items[0]?.title).toBe('mentions 4507');
    expect(argvs.some((a) => a[0] === 'search')).toBe(true);
  });

  it('marks the hit list truncated when it fills the cap', async () => {
    ghSpy((argv) => {
      if (argv[0] === 'repo') return 'owner/n\n';
      if (argv[0] === 'search') {
        return JSON.stringify(Array.from({ length: 3 }, (_, i) => searchHit({ number: i + 1 })));
      }
      return '';
    });

    const res = await searchGithubItems('/repo/search-cap', 'pr', 'anything', 3);
    expect(res.truncated).toBe(true);
    expect(res.items).toHaveLength(3);
  });

  it('caps the requested limit at GH_SEARCH_MAX', async () => {
    const argvs = ghSpy((argv) => {
      if (argv[0] === 'repo') return 'owner/n\n';
      if (argv[0] === 'search') return '[]';
      return '';
    });

    await searchGithubItems('/repo/search-limit', 'pr', 'anything', 10_000);
    const search = argvs.find((a) => a[0] === 'search');
    expect(search?.[search.indexOf('--limit') + 1]).toBe(String(GH_SEARCH_MAX));
  });

  it('honours `limit` and flags `truncated` in XEZ_DRY_RUN too, on the live rule (#838)', async () => {
    vi.stubEnv('XEZ_DRY_RUN', '1');

    // '1' appears in every fixture issue number (142 / 139 / 135), so the cap has something to bite
    // on. Before #838 the dry-run branch returned ahead of `capped` and shipped all three unflagged
    // — offline mode is the only place cap-and-truncate is exercised without `gh`.
    const capped = await searchGithubItems('/repo/dry-cap', 'issue', '1', 2);
    expect(capped.items.map((i) => i.number)).toEqual([142, 139]);
    expect(capped.truncated).toBe(true);

    const whole = await searchGithubItems('/repo/dry-cap', 'issue', '1');
    expect(whole.items).toHaveLength(3);
    expect(whole.truncated).toBe(false);

    // Still entirely offline — the fixture path must never reach the CLI.
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('degrades to {available:false, reason} instead of throwing when gh fails', async () => {
    ghSpy((argv) => (argv[0] === 'repo' ? 'owner/n\n' : new Error('HTTP 403: rate limit exceeded')));

    const res = await searchGithubItems('/repo/search-fail', 'pr', 'anything');
    expect(res.available).toBe(false);
    expect(res.reason).toContain('rate limit');
    expect(res.items).toEqual([]);
  });

  it('reports a missing gh CLI with the same hint the list tier uses', async () => {
    ghSpy(() => Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));

    const res = await searchGithubItems('/repo/search-enoent', 'pr', 'anything');
    expect(res.available).toBe(false);
    expect(res.reason).toContain('gh CLI not found');
  });

  it('degrades when the repo handle is not parseable, without attempting a search', async () => {
    const argvs = ghSpy((argv) => (argv[0] === 'repo' ? 'not-a-slug/with/too/many/parts\n' : ''));

    const res = await searchGithubItems('/repo/search-nohandle', 'pr', 'anything');
    expect(res.available).toBe(false);
    expect(res.reason).toContain('no GitHub remote');
    expect(argvs.some((a) => a[0] === 'search')).toBe(false);
  });

  it('never shells out for an empty query', async () => {
    const argvs = ghSpy(() => '');
    const res = await searchGithubItems('/repo/search-empty', 'pr', '   ');
    expect(res).toEqual({ available: true, items: [] });
    expect(argvs).toEqual([]);
  });

  it('finds a merged PR that the open-only list never returns — the bug in #730', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      let stdout = '';
      if (argv[0] === 'repo') stdout = 'owner/n\n';
      // The list tier: `gh pr list` without --state returns OPEN PRs only, and #4507 is merged.
      else if (argv[0] === 'pr' && argv[1] === 'list') stdout = '[]';
      else if (argv[0] === 'issue' && argv[1] === 'list') stdout = '[]';
      else if (argv[0] === 'pr' && argv[1] === 'view') {
        stdout = JSON.stringify({
          number: 4507,
          title: 'a merged pr',
          author: { login: 'someone' },
          createdAt: '2026-07-25T07:08:17Z',
          labels: [],
          body: '',
          url: 'https://github.com/owner/n/pull/4507',
          isDraft: false,
          additions: 0,
          deletions: 0,
        });
      } else stdout = '{}';
      cb(null, { stdout, stderr: '' });
    });

    const list = await fetchGithub('/repo/search-regression');
    expect(list.prs.find((p) => p.number === 4507)).toBeUndefined();

    const found = await searchGithubItems('/repo/search-regression', 'pr', '4507');
    expect(found.items.map((i) => i.number)).toEqual([4507]);
  });
});
