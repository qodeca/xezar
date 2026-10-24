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
  fetchRefStatuses,
  fetchGithubRefStatus,
  __clearRefStatusCacheForTests,
  forgetRefStatus,
  refNumberFromUrl,
} from './github.ts';

describe('fetchRefStatuses', () => {
  const prNode = (over: Record<string, unknown> = {}) => ({
    __typename: 'PullRequest',
    state: 'OPEN',
    // What GitHub answers for a settled open PR. Defaulted so the cases below stay about
    // STATUSES; the mergeability cases override it, and one of them omits it on purpose.
    mergeable: 'MERGEABLE',
    isDraft: false,
    reviewDecision: null,
    commits: { nodes: [{ commit: { committedDate: '2026-08-11T12:00:00Z', statusCheckRollup: { state: 'SUCCESS' } } }] },
    reviews: { nodes: [] },
    reviewRequests: { totalCount: 0 },
    timelineItems: { nodes: [] },
    ...over,
  });
  /** A requested reviewer as both connections spell one. `Team` uses `slug` instead — see the
   *  team test below. */
  const reviewer = (login: string) => ({ __typename: 'User', login });
  const issueNode = (over: Record<string, unknown> = {}) => ({
    __typename: 'Issue',
    state: 'OPEN',
    stateReason: null,
    ...over,
  });
  const reply = (repository: Record<string, unknown>) => JSON.stringify({ data: { repository } });

  it('asks one alias per NUMBER and files each answer under what it turned out to be', async () => {
    // Issues and pull requests share one numbering space, so `issueOrPullRequest` is the question
    // with an answer — and the answer says which kind it is, rather than trusting the caller.
    let sent = '';
    const runGraphql = vi.fn(async (query: string) => {
      sent = query;
      return reply({ r0: prNode(), r1: prNode({ state: 'MERGED' }), r2: issueNode({ state: 'CLOSED', stateReason: 'NOT_PLANNED' }) });
    });
    const { resolved: out } = await fetchRefStatuses(runGraphql, 'o', 'n', [7, 12, 3]);
    expect(runGraphql).toHaveBeenCalledTimes(1);
    expect(sent).toContain('issueOrPullRequest');
    expect(out[7]).toEqual({ kind: 'pr', status: 'ready', mergeable: 'mergeable' });
    expect(out[12]).toEqual({ kind: 'pr', status: 'merged' });
    expect(out[3]).toEqual({ kind: 'issue', status: 'not-planned' });
  });

  it('files a number the CALLER thought was a PR under the kind it really is', async () => {
    // The screenshot bug's other half: a bare `#774` in a task can be inferred as either kind, and
    // asking `issue(number:)` about a pull request is a question GitHub answers with an error.
    const runGraphql = vi.fn(async () => reply({ r0: issueNode() }));
    const { resolved: out } = await fetchRefStatuses(runGraphql, 'o', 'n', [774]);
    expect(out[774]).toEqual({ kind: 'issue', status: 'open' });
  });

  it('leaves an unknown number absent rather than guessing at it', async () => {
    const runGraphql = vi.fn(async () => reply({ r0: prNode(), r1: null }));
    const { resolved: out } = await fetchRefStatuses(runGraphql, 'o', 'n', [7, 8]);
    expect(out[7]?.status).toBe('ready');
    expect(8 in out).toBe(false);
  });

  it('reads a PR with no CI configured as a PR with nothing failing', async () => {
    const runGraphql = vi.fn(async () => reply({ r0: prNode({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }) }));
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [7])).resolved[7]?.status).toBe('ready');
  });

  it('carries the head-commit and review timestamps into the precedence', async () => {
    // End to end for the "pushed since the review" rule: the two dates ride the same aliased
    // node, so nothing extra is spawned to learn them.
    let sent = '';
    const runGraphql = vi.fn(async (query: string) => {
      sent = query;
      return reply({
        r0: prNode({
          reviewDecision: 'CHANGES_REQUESTED',
          commits: { nodes: [{ commit: { committedDate: '2026-08-11T12:00:00Z', statusCheckRollup: { state: 'FAILURE' } } }] },
          reviews: { nodes: [{ submittedAt: '2026-08-11T09:00:00Z' }] },
        }),
      });
    });
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [7])).resolved[7]?.status).toBe('checks-failing');
    expect(sent).toContain('committedDate');
    expect(sent).toContain('states: CHANGES_REQUESTED');
  });

  it('carries the pending review-request count into the precedence', async () => {
    // The #774 signal, end to end: `reviewDecision` still reads CHANGES_REQUESTED after the author
    // clicks re-request, so only `reviewRequests` says the ball moved. If the query stopped asking
    // for it, or the parse dropped it, the chip would silently go back to blaming the author.
    let sent = '';
    const runGraphql = vi.fn(async (query: string) => {
      sent = query;
      return reply({
        r0: prNode({ reviewDecision: 'CHANGES_REQUESTED', reviewRequests: { totalCount: 1 } }),
      });
    });
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [774])).resolved[774]?.status).toBe('review-required');
    expect(sent).toContain('reviewRequests(first: 20) { totalCount');
  });

  it('carries the review-request DATE too, so an old request cannot dismiss a review', async () => {
    // The reported PR's exact payload. The count alone is identical to the #774 shape
    // above; only the timeline event tells the two apart, so it has to survive the query and the
    // parse — dropping either would silently restore the bug.
    let sent = '';
    const runGraphql = vi.fn(async (query: string) => {
      sent = query;
      return reply({
        r0: prNode({
          reviewDecision: 'CHANGES_REQUESTED',
          commits: {
            nodes: [{ commit: { committedDate: '2026-08-18T10:23:40Z', statusCheckRollup: { state: 'SUCCESS' } } }],
          },
          reviews: { nodes: [{ submittedAt: '2026-08-19T11:00:27Z' }] },
          reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: reviewer('carol') }] },
          timelineItems: { nodes: [{ createdAt: '2026-08-18T10:28:43Z', requestedReviewer: reviewer('carol') }] },
        }),
      });
    });
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [2642])).resolved[2642]?.status).toBe('changes-requested');
    expect(sent).toContain('itemTypes: [REVIEW_REQUESTED_EVENT]');
  });

  it('dates the request that STILL STANDS, not one that was made and then withdrawn', async () => {
    // The two connections answer about different requests: `reviewRequests` is who is on the hook
    // now, a `ReviewRequestedEvent` survives the request being withdrawn. Here carol was asked
    // before the review and never looked (so she still stands), while dave was asked after it and
    // then removed. Taking the newest event blindly would date the request from dave's withdrawn
    // one, read the rejection as answered, and hide it behind "waiting for review" — the same bug
    // one step rarer. Matching by reviewer keeps the date on a request that is really there.
    const runGraphql = vi.fn(async () =>
      reply({
        r0: prNode({
          reviewDecision: 'CHANGES_REQUESTED',
          commits: {
            nodes: [{ commit: { committedDate: '2026-08-18T10:00:00Z', statusCheckRollup: { state: 'SUCCESS' } } }],
          },
          reviews: { nodes: [{ submittedAt: '2026-08-19T11:00:00Z' }] },
          reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: reviewer('carol') }] },
          timelineItems: {
            nodes: [
              { createdAt: '2026-08-18T10:30:00Z', requestedReviewer: reviewer('carol') },
              { createdAt: '2026-08-19T14:00:00Z', requestedReviewer: reviewer('dave') }, // withdrawn
            ],
          },
        }),
      }),
    );
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [7])).resolved[7]?.status).toBe('changes-requested');
  });

  it('hands the ball back when the STANDING reviewer is the one asked after the review', async () => {
    // The mirror of the test above, so the correlation cannot pass by simply never matching:
    // carol's own request postdates the review and still stands, which is a real re-request.
    const runGraphql = vi.fn(async () =>
      reply({
        r0: prNode({
          reviewDecision: 'CHANGES_REQUESTED',
          commits: {
            nodes: [{ commit: { committedDate: '2026-08-18T10:00:00Z', statusCheckRollup: { state: 'SUCCESS' } } }],
          },
          reviews: { nodes: [{ submittedAt: '2026-08-19T11:00:00Z' }] },
          reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: reviewer('carol') }] },
          timelineItems: { nodes: [{ createdAt: '2026-08-19T14:00:00Z', requestedReviewer: reviewer('carol') }] },
        }),
      }),
    );
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [7])).resolved[7]?.status).toBe('review-required');
  });

  it('matches a TEAM reviewer by slug, since a team carries no login', async () => {
    const team = { __typename: 'Team', slug: 'platform' };
    const runGraphql = vi.fn(async () =>
      reply({
        r0: prNode({
          reviewDecision: 'CHANGES_REQUESTED',
          commits: {
            nodes: [{ commit: { committedDate: '2026-08-18T10:00:00Z', statusCheckRollup: { state: 'SUCCESS' } } }],
          },
          reviews: { nodes: [{ submittedAt: '2026-08-19T11:00:00Z' }] },
          reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: team }] },
          timelineItems: { nodes: [{ createdAt: '2026-08-19T14:00:00Z', requestedReviewer: team }] },
        }),
      }),
    );
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [7])).resolved[7]?.status).toBe('review-required');
  });

  it('carries the head commit\'s PARENT COUNT, so "Update branch" cannot clear a review', async () => {
    // A real "Update branch" head's shape: a `Merge branch 'main' into <branch>` head reporting two
    // parents. `parents(first: 0)` asks for the count and no parent — if the query or the parse
    // dropped it, the merge would read as a push and the chip would go blue on a rejected PR.
    let sent = '';
    const runGraphql = vi.fn(async (query: string) => {
      sent = query;
      return reply({
        r0: prNode({
          reviewDecision: 'CHANGES_REQUESTED',
          commits: {
            nodes: [
              {
                commit: {
                  committedDate: '2026-08-19T15:00:00Z',
                  parents: { totalCount: 2 },
                  statusCheckRollup: { state: 'SUCCESS' },
                },
              },
            ],
          },
          reviews: { nodes: [{ submittedAt: '2026-08-19T11:00:27Z' }] },
        }),
      });
    });
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [2639])).resolved[2639]?.status).toBe('changes-requested');
    // `first: 1`, not `first: 0`: the first parent's date is what a merge answers WITH.
    expect(sent).toContain('parents(first: 1) { totalCount nodes { committedDate } }');
  });

  it('reads an absent parent count as an ORDINARY commit, so a real push still counts', async () => {
    // The push rule is the common path; a field GitHub declined to send must not switch it off.
    const runGraphql = vi.fn(async () =>
      reply({
        r0: prNode({
          reviewDecision: 'CHANGES_REQUESTED',
          commits: {
            nodes: [{ commit: { committedDate: '2026-08-19T15:00:00Z', statusCheckRollup: { state: 'SUCCESS' } } }],
          },
          reviews: { nodes: [{ submittedAt: '2026-08-19T11:00:27Z' }] },
        }),
      }),
    );
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [7])).resolved[7]?.status).toBe('review-required');
  });

  it('reads an absent timeline as an UNDATED request, not as a fresh one', async () => {
    // Same defensive shape as the missing `reviewRequests` below: an omitted field must not invent
    // a re-request and dismiss a review that is still about the code on screen.
    const runGraphql = vi.fn(async () =>
      reply({
        r0: prNode({
          reviewDecision: 'CHANGES_REQUESTED',
          reviews: { nodes: [{ submittedAt: '2026-08-19T11:00:27Z' }] },
          reviewRequests: { totalCount: 1 },
          timelineItems: null,
        }),
      }),
    );
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [7])).resolved[7]?.status).toBe('changes-requested');
  });

  it('reads an absent reviewRequests as nobody waiting, not as somebody', async () => {
    // Defensive: a field GitHub omits must not invent a reviewer. Without the guard this would
    // throw or coerce, and every PR in the batch would lose its status.
    const runGraphql = vi.fn(async () =>
      reply({ r0: prNode({ reviewDecision: null, reviewRequests: null }) }),
    );
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [7])).resolved[7]?.status).toBe('ready');
  });

  it('chunks past the cap, and a failed chunk costs only its own numbers', async () => {
    const runGraphql = vi.fn(async (query: string) => {
      if (query.includes('issueOrPullRequest(number: 3)')) throw new Error('HTTP 502');
      return reply({ r0: prNode(), r1: prNode() });
    });
    const { resolved: out, failed } = await fetchRefStatuses(runGraphql, 'o', 'n', [1, 2, 3, 4], 2);
    expect(runGraphql).toHaveBeenCalledTimes(2);
    expect(out[1]?.status).toBe('ready');
    expect(out[2]?.status).toBe('ready');
    expect(3 in out).toBe(false);
    expect(4 in out).toBe(false);
    // …and they are reported as UNASKED, not as absent: the difference is what keeps a network
    // blip from being cached and shown as "no such number".
    expect(failed).toEqual([3, 4]);
  });

  it('degrades to an empty map on any failure, never throwing', async () => {
    const runGraphql = vi.fn(async () => { throw new Error('offline'); });
    await expect(fetchRefStatuses(runGraphql, 'o', 'n', [7])).resolves.toEqual({
      resolved: {},
      failed: [7],
      reason: 'offline',
    });
  });

  it('spawns nothing when nothing is named', async () => {
    const runGraphql = vi.fn();
    expect(await fetchRefStatuses(runGraphql, 'o', 'n', [])).toEqual({ resolved: {}, failed: [] });
    expect(runGraphql).not.toHaveBeenCalled();
  });

  it('carries mergeability as its OWN axis, on the same query and without touching the status', async () => {
    // The reported case: green, nobody waited on, and GitHub refusing to merge it. `ready` is
    // still the honest answer to "whose move is it on the review" — the conflict is the second
    // fact, and it rides the same aliased node, so it costs no extra request.
    let sent = '';
    const runGraphql = vi.fn(async (query: string) => {
      sent = query;
      return reply({ r0: prNode({ mergeable: 'CONFLICTING' }) });
    });
    const { resolved: out } = await fetchRefStatuses(runGraphql, 'o', 'n', [7]);

    expect(runGraphql).toHaveBeenCalledTimes(1);
    expect(sent).toContain('mergeable');
    expect(out[7]).toEqual({ kind: 'pr', status: 'ready', mergeable: 'conflicting' });
  });

  it('keeps "still computing" apart from "merges cleanly" instead of collapsing both to false', async () => {
    // `UNKNOWN` is what GitHub answers while it computes — seconds after every push — so treating
    // it as a conflict would flash an orange chip on half the pushes in the repo. Treating it as
    // CLEAN is the bug this axis was reported for a second time: it is not an answer, and it has
    // to survive as far as the cache, which asks again in seconds rather than in a minute.
    const runGraphql = vi.fn(async () =>
      reply({
        r0: prNode({ mergeable: 'UNKNOWN' }),
        r1: prNode({ mergeable: 'MERGEABLE' }),
        r2: prNode({ mergeable: null }),
        // The field omitted entirely — `prNode` defaults it, so this strips it back off.
        r3: { ...prNode(), mergeable: undefined },
      }),
    );
    const { resolved: out } = await fetchRefStatuses(runGraphql, 'o', 'n', [7, 8, 9, 10]);

    expect(out[7]?.mergeable).toBe('unknown');
    expect(out[8]?.mergeable).toBe('mergeable');
    // A field GitHub omitted, or nulled, is not a statement that the branch is clean.
    expect(out[9]?.mergeable).toBe('unknown');
    expect(out[10]?.mergeable).toBe('unknown');
  });

  it('never calls a merged or closed pull request conflicting', async () => {
    // GitHub reports UNKNOWN on a terminal PR, but a stale CONFLICTING would be worse than
    // useless: there is nothing left to resolve, and the chip would contradict `merged`.
    const runGraphql = vi.fn(async () =>
      reply({
        r0: prNode({ state: 'MERGED', mergeable: 'CONFLICTING' }),
        r1: prNode({ state: 'CLOSED', mergeable: 'CONFLICTING' }),
      }),
    );
    const { resolved: out } = await fetchRefStatuses(runGraphql, 'o', 'n', [7, 8]);

    // No `mergeable` at all — the question does not apply, which is not the same as answering it.
    expect(out[7]).toEqual({ kind: 'pr', status: 'merged' });
    expect(out[8]).toEqual({ kind: 'pr', status: 'closed' });
  });
});

/** The route-facing wrapper: one repo-handle lookup, then one batched query for the misses, and
 *  an in-payload degrade when `gh` is missing. Driven through `execFileMock` so no `gh` runs. */
describe('fetchGithubRefStatus', () => {
  beforeEach(() => {
    vi.stubEnv('XEZ_DRY_RUN', ''); // dry-run would short-circuit the gh path under test
    execFileMock.mockReset();
    __clearRefStatusCacheForTests();
    __clearRepoHandleCacheForTests();
    // The cache is time-based, and one case needs to stand a minute later without waiting one.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function stubGh(graphqlReply: string) {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      cb(null, { stdout: argv[0] === 'repo' ? 'owner/n\n' : graphqlReply, stderr: '' });
    });
  }

  it('serves the second identical request from cache — one visible window, one query', async () => {
    stubGh(JSON.stringify({ data: { repository: { r0: { __typename: 'PullRequest', state: 'MERGED', isDraft: false, reviewDecision: null, commits: { nodes: [] } } } } }));
    const first = await fetchGithubRefStatus('/repo/ref-status-cache', { prs: [7] });
    expect(first.available && first.prs[7]).toBe('merged');
    const calls = execFileMock.mock.calls.length;
    const second = await fetchGithubRefStatus('/repo/ref-status-cache', { prs: [7] });
    expect(second.available && second.prs[7]).toBe('merged');
    expect(execFileMock.mock.calls.length).toBe(calls); // nothing spawned the second time
  });

  it('names the conflicting pull requests beside the statuses, and only those', async () => {
    // Both axes in one answer: #7 is `ready` AND unmergeable, #8 is merely ready. `conflicts` is
    // a list rather than a map because the empty case is the normal one.
    stubGh(
      JSON.stringify({
        data: {
          repository: {
            r0: { __typename: 'PullRequest', state: 'OPEN', isDraft: false, reviewDecision: null, mergeable: 'CONFLICTING', commits: { nodes: [] } },
            r1: { __typename: 'PullRequest', state: 'OPEN', isDraft: false, reviewDecision: null, mergeable: 'MERGEABLE', commits: { nodes: [] } },
          },
        },
      }),
    );
    const out = await fetchGithubRefStatus('/repo/ref-status-conflicts', { prs: [7, 8] });

    expect(out.available).toBe(true);
    if (!out.available) throw new Error('expected available');
    expect(out.prs[7]).toBe('ready');
    expect(out.prs[8]).toBe('ready');
    expect(out.conflicts).toEqual([7]);
  });

  it('remembers the conflict alongside the status, so a cached answer still carries both', async () => {
    // The cache stores the resolved reference, not the payload — a second read that spawns
    // nothing must not quietly lose the axis the first one learned.
    stubGh(
      JSON.stringify({
        data: {
          repository: {
            r0: { __typename: 'PullRequest', state: 'OPEN', isDraft: false, reviewDecision: null, mergeable: 'CONFLICTING', commits: { nodes: [] } },
          },
        },
      }),
    );
    await fetchGithubRefStatus('/repo/ref-status-conflict-cache', { prs: [7] });
    const calls = execFileMock.mock.calls.length;
    const cached = await fetchGithubRefStatus('/repo/ref-status-conflict-cache', { prs: [7] });

    expect(execFileMock.mock.calls.length).toBe(calls);
    expect(cached.available && cached.conflicts).toEqual([7]);
  });

  it('keeps every good alias when gh exits non-zero on a PARTIAL failure', async () => {
    // The screenshot bug. `gh api graphql` exits 1 the moment the reply carries an `errors` array,
    // even though `data` holds every alias that DID resolve — so one number that no longer exists
    // used to throw away the whole batch and report an open PR in this very repository as "not
    // found on this repository".
    const partial = JSON.stringify({
      data: {
        repository: {
          r0: { __typename: 'PullRequest', state: 'OPEN', isDraft: false, reviewDecision: null, commits: { nodes: [] } },
          r1: null,
        },
      },
      errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to an issue or pull request with the number of 99999999.' }],
    });
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      if (argv[0] === 'repo') return cb(null, { stdout: 'owner/n\n', stderr: '' });
      // Exactly what gh does: non-zero exit, the full JSON still on stdout.
      cb(Object.assign(new Error('Command failed'), { code: 1, stdout: partial, stderr: 'gh: Could not resolve…' }), null);
    });

    const out = await fetchGithubRefStatus('/repo/ref-status-partial', { prs: [774, 99999999] });
    expect(out.available).toBe(true);
    if (!out.available) throw new Error('expected available');
    expect(out.prs[774]).toBe('ready');
    expect(99999999 in out.prs).toBe(false);
  });

  it('still degrades when the REPOSITORY itself did not resolve', async () => {
    // A null `repository` is not a partial success — reading it as one would report every number
    // as missing when the truth is that the handle or the token is wrong.
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      if (argv[0] === 'repo') return cb(null, { stdout: 'owner/n\n', stderr: '' });
      cb(
        Object.assign(new Error('Command failed'), {
          code: 1,
          stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: 'NOT_FOUND' }] }),
          stderr: 'gh: Could not resolve to a Repository',
        }),
        null,
      );
    });

    const out = await fetchGithubRefStatus('/repo/ref-status-norepo', { prs: [774] });
    expect(out.available).toBe(false);
  });

  it('never re-asks about a MERGED pull request, and re-asks about a live one', async () => {
    // The refresh policy's whole point: what a reader wants rechecked is what is still moving. A
    // merged PR cannot change (GitHub has no un-merge), so re-asking about it every minute is pure
    // cost — while a running build is the one thing that MUST be re-asked.
    const node = (state: string, rollup: string | null) =>
      JSON.stringify({
        data: {
          repository: {
            r0: {
              __typename: 'PullRequest',
              state,
              isDraft: false,
              reviewDecision: null,
              mergeable: 'MERGEABLE',
              commits: { nodes: [{ commit: { committedDate: '2026-08-11T12:00:00Z', statusCheckRollup: rollup ? { state: rollup } : null } }] },
              reviews: { nodes: [] },
            },
          },
        },
      });

    stubGh(node('MERGED', null));
    expect((await fetchGithubRefStatus('/repo/ttl-merged', { prs: [7] })).available).toBe(true);
    const afterMerged = execFileMock.mock.calls.length;

    stubGh(node('OPEN', 'PENDING'));
    expect((await fetchGithubRefStatus('/repo/ttl-live', { prs: [8] })).available).toBe(true);
    const afterLive = execFileMock.mock.calls.length;

    // Both entries are now 61 s old — past the live TTL, nowhere near the merged one.
    vi.setSystemTime(new Date(Date.now() + 61_000));
    await fetchGithubRefStatus('/repo/ttl-merged', { prs: [7] });
    expect(execFileMock.mock.calls.length).toBe(afterLive); // merged: served from cache, no spawn
    await fetchGithubRefStatus('/repo/ttl-live', { prs: [8] });
    expect(execFileMock.mock.calls.length).toBeGreaterThan(afterLive); // live: asked again
    expect(afterMerged).toBeGreaterThan(0);
  });

  it('tells the cockpit when to ask again, from the same table its own cache uses', async () => {
    // Responsibility lives HERE. Whether a status can still move is forge semantics, and the
    // cockpit holds no copy of them — it obeys `recheckAfterMs`. A value the cache would still be
    // serving is a value there is no point asking for, so the two come off one table.
    const pr = (state: string, rollup: string | null) =>
      JSON.stringify({
        data: {
          repository: {
            r0: {
              __typename: 'PullRequest',
              state,
              isDraft: false,
              reviewDecision: null,
              mergeable: 'MERGEABLE',
              commits: { nodes: [{ commit: { committedDate: '2026-08-11T12:00:00Z', statusCheckRollup: rollup ? { state: rollup } : null } }] },
              reviews: { nodes: [] },
            },
          },
        },
      });

    stubGh(pr('OPEN', 'PENDING'));
    const live = await fetchGithubRefStatus('/repo/recheck-live', { prs: [7] });
    expect(live.recheckAfterMs).toBe(60_000); // checks running — ask again in a minute

    stubGh(pr('MERGED', null));
    const merged = await fetchGithubRefStatus('/repo/recheck-merged', { prs: [8] });
    // Immutable: not "in a long while" but "never" — which is what stops the cockpit scheduling.
    expect(merged.recheckAfterMs).toBeNull();

    stubGh(pr('CLOSED', null));
    const closed = await fetchGithubRefStatus('/repo/recheck-closed', { prs: [9] });
    expect(closed.recheckAfterMs).toBe(10 * 60_000); // reopenable, so long rather than never
  });

  it('paces the whole batch by its most changeable reference', () => {
    // One live PR among settled ones has to keep the batch on a clock — the batch is one request,
    // and the soonest anything in it could differ is the soonest the answer could differ.
    stubGh(
      JSON.stringify({
        data: {
          repository: {
            r0: { __typename: 'PullRequest', state: 'MERGED', isDraft: false, reviewDecision: null, commits: { nodes: [] }, reviews: { nodes: [] } },
            r1: { __typename: 'PullRequest', state: 'OPEN', isDraft: false, reviewDecision: null, mergeable: 'MERGEABLE', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] }, reviews: { nodes: [] } },
          },
        },
      }),
    );
    return fetchGithubRefStatus('/repo/recheck-mixed', { prs: [7, 8] }).then((out) => {
      expect(out.recheckAfterMs).toBe(60_000);
    });
  });

  // The reported regression, and the reason mergeability is a tri-state rather than a boolean:
  // GitHub COMPUTES it when asked and answers `UNKNOWN` while the job runs, which is the normal
  // reply for the first seconds after every push. Cached as an answer for the usual minute, that
  // is a conflicting pull request wearing "Ready to merge" until the page is reloaded.
  const unknownMergeability = (mergeable: string | null) =>
    JSON.stringify({
      data: {
        repository: {
          r0: {
            __typename: 'PullRequest',
            state: 'OPEN',
            isDraft: false,
            reviewDecision: null,
            mergeable,
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
            reviews: { nodes: [] },
          },
        },
      },
    })

  it('comes back in seconds while GitHub is still computing mergeability, not in a minute', async () => {
    stubGh(unknownMergeability('UNKNOWN'));
    const out = await fetchGithubRefStatus('/repo/mergeability-unknown', { prs: [7] });

    expect(out.available).toBe(true);
    if (!out.available) throw new Error('expected available');
    // The status itself is settled and would hold for a minute; the OTHER axis is what is still
    // moving, and the batch travels at the speed of its most impatient member.
    expect(out.prs[7]).toBe('ready');
    expect(out.conflicts).toEqual([]);
    expect(out.recheckAfterMs).toBe(5_000);
  });

  it('and does not cache that non-answer for the usual minute either', async () => {
    stubGh(unknownMergeability('UNKNOWN'));
    await fetchGithubRefStatus('/repo/mergeability-recheck', { prs: [7] });
    const calls = execFileMock.mock.calls.length;

    // Six seconds later the computation has landed. The cache must not still be serving the
    // shrug — this is the read that used to answer "no conflicts" for another 54 seconds.
    vi.advanceTimersByTime(6_000);
    stubGh(unknownMergeability('CONFLICTING'));
    const second = await fetchGithubRefStatus('/repo/mergeability-recheck', { prs: [7] });

    expect(execFileMock.mock.calls.length).toBeGreaterThan(calls);
    expect(second.available && second.conflicts).toEqual([7]);
    // Answered now, so back to the ordinary cadence.
    expect(second.available && second.recheckAfterMs).toBe(60_000);
  });

  it('gives up the fast cadence for a forge that never answers, instead of polling forever', async () => {
    // A five-second poll that outlives the computation it was waiting for is a `gh` subprocess
    // every five seconds, indefinitely, for a repository that is simply never going to say.
    stubGh(unknownMergeability('UNKNOWN'));
    await fetchGithubRefStatus('/repo/mergeability-stuck', { prs: [7] });

    // Past the window, still unknown: the impatience is measured from the FIRST such answer, so
    // it cannot be renewed by the answers that kept it going.
    vi.advanceTimersByTime(61_000);
    const later = await fetchGithubRefStatus('/repo/mergeability-stuck', { prs: [7] });

    expect(later.available && later.recheckAfterMs).toBe(60_000);
  });

  it('asks the cockpit to back off rather than hammer a forge that is not there', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      cb(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }), null);
    });
    const out = await fetchGithubRefStatus('/repo/recheck-nogh', { prs: [7] });
    expect(out.available).toBe(false);
    // Five minutes, not one: a workspace with no `gh` would otherwise spawn a subprocess a minute
    // forever to be told the same thing.
    expect(out.recheckAfterMs).toBe(5 * 60_000);
  });

  it('learns the repo handle once, not once per recheck', async () => {
    // Every tick used to spawn a second subprocess to re-learn an `owner/name` that changes
    // approximately never — doubling the cost of the one query that actually carries information.
    stubGh(JSON.stringify({ data: { repository: { r0: { __typename: 'PullRequest', state: 'OPEN', isDraft: false, reviewDecision: null, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] }, reviews: { nodes: [] } } } } }));

    await fetchGithubRefStatus('/repo/handle-memo', { prs: [7] });
    const repoViews = () => execFileMock.mock.calls.filter((call) => (call[1] as string[])[0] === 'repo').length;
    expect(repoViews()).toBe(1);

    // A minute later the status is stale and is re-queried — but the handle is not re-learned.
    vi.setSystemTime(new Date(Date.now() + 61_000));
    await fetchGithubRefStatus('/repo/handle-memo', { prs: [7] });
    expect(repoViews()).toBe(1);
    expect(execFileMock.mock.calls.filter((call) => (call[1] as string[])[0] === 'api').length).toBe(2);
  });

  it('re-asks about a reference xezar itself changed', async () => {
    // The self-inflicted staleness: after this server merges a PR, its cached status is a value we
    // KNOW is wrong, and the TTL would hold it for up to a minute. `forgetRefStatus` is what the
    // merge and draft-PR routes call so the next reader pays one query and gets the truth.
    const node = (state: string) =>
      JSON.stringify({
        data: {
          repository: {
            r0: {
              __typename: 'PullRequest',
              state,
              isDraft: false,
              reviewDecision: null,
              commits: { nodes: [] },
              reviews: { nodes: [] },
              reviewRequests: { totalCount: 0 },
            },
          },
        },
      });

    stubGh(node('OPEN'));
    expect((await fetchGithubRefStatus('/repo/forget', { prs: [7] })).available).toBe(true);
    const afterFirst = execFileMock.mock.calls.length;
    // Well inside the TTL: without forgetting, this is served from cache.
    await fetchGithubRefStatus('/repo/forget', { prs: [7] });
    expect(execFileMock.mock.calls.length).toBe(afterFirst);

    forgetRefStatus('/repo/forget', 7);
    stubGh(node('MERGED'));
    const after = await fetchGithubRefStatus('/repo/forget', { prs: [7] });
    expect(execFileMock.mock.calls.length).toBeGreaterThan(afterFirst);
    if (!after.available) throw new Error('expected available');
    expect(after.prs[7]).toBe('merged');
    // …and the cockpit is told to stop polling it, so invalidating REDUCES long-run traffic.
    expect(after.recheckAfterMs).toBeNull();
  });

  it('forgets only the reference named, never the batch', async () => {
    stubGh(
      JSON.stringify({
        data: {
          repository: {
            r0: { __typename: 'PullRequest', state: 'OPEN', isDraft: false, reviewDecision: null, commits: { nodes: [] }, reviews: { nodes: [] }, reviewRequests: { totalCount: 0 } },
            r1: { __typename: 'PullRequest', state: 'OPEN', isDraft: false, reviewDecision: null, commits: { nodes: [] }, reviews: { nodes: [] }, reviewRequests: { totalCount: 0 } },
          },
        },
      }),
    );
    await fetchGithubRefStatus('/repo/forget-one', { prs: [7, 8] });
    forgetRefStatus('/repo/forget-one', 7);

    let askedFor = '';
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      if (argv[0] === 'repo') return cb(null, { stdout: 'owner/n\n', stderr: '' });
      askedFor = argv.join(' ');
      cb(null, { stdout: JSON.stringify({ data: { repository: { r0: null } } }), stderr: '' });
    });
    await fetchGithubRefStatus('/repo/forget-one', { prs: [7, 8] });

    expect(askedFor).toContain('issueOrPullRequest(number: 7)');
    expect(askedFor).not.toContain('issueOrPullRequest(number: 8)');
  });

  it('degrades in the payload when gh is not installed', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      cb(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }), null);
    });
    const out = await fetchGithubRefStatus('/repo/ref-status-nogh', { prs: [7] });
    expect(out.available).toBe(false);
    if (out.available) throw new Error('expected unavailable');
    expect(out.reason).toContain('gh CLI not found');
  });
});

describe('refNumberFromUrl', () => {
  it('reads the number a forge URL ends with', () => {
    expect(refNumberFromUrl('https://github.com/o/r/pull/774')).toBe(774);
    expect(refNumberFromUrl('https://github.com/o/r/issues/12/')).toBe(12);
    expect(refNumberFromUrl('  https://github.com/o/r/pull/1  ')).toBe(1);
  });

  it('answers null for a shape it does not recognise, rather than inventing a key', () => {
    // Invalidating the wrong entry is worse than invalidating none: it would evict a status we
    // still hold and leave the changed one cached.
    expect(refNumberFromUrl('https://github.com/o/r/pull/abc')).toBeNull();
    expect(refNumberFromUrl('https://example.com/')).toBeNull();
    expect(refNumberFromUrl('')).toBeNull();
    expect(refNumberFromUrl('https://github.com/o/r/pull/0')).toBeNull();
  });
});

