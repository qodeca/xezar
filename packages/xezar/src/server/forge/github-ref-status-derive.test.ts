import { describe, expect, it, vi } from 'vitest';
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

import { derivePrReferenceStatus, deriveIssueReferenceStatus } from './github.ts';

/**
 * Reference status — the batched read behind a task's PR/issue chip.
 *
 * Two things are worth pinning independently: the PRECEDENCE that collapses four independent PR
 * signals into one word (a merged PR is merged whatever CI says; a human's "changes requested"
 * outranks a red build), and the batching, which mirrors `fetchPrChecks` — one aliased query, an
 * unknown number left absent rather than invented, and any failure degrading to nothing rather
 * than to a wrong glyph.
 */
describe('derivePrReferenceStatus', () => {
  const pr = (over: Partial<Parameters<typeof derivePrReferenceStatus>[0]> = {}) =>
    derivePrReferenceStatus({ state: 'OPEN', isDraft: false, reviewDecision: null, checks: null, ...over });

  it('lets a terminal state win over everything else', () => {
    // A merged PR whose last build went red is still merged — and a draft that was closed is
    // closed, not a draft. Anything else would paint history as a to-do.
    expect(pr({ state: 'MERGED', checks: 'failing', isDraft: true })).toBe('merged');
    expect(pr({ state: 'CLOSED', checks: 'passing', reviewDecision: 'APPROVED' })).toBe('closed');
    expect(pr({ state: 'merged' })).toBe('merged'); // case-insensitive, as GraphQL enums vary
  });

  it('puts draft above every open-PR signal', () => {
    expect(pr({ isDraft: true, checks: 'passing', reviewDecision: 'APPROVED' })).toBe('draft');
  });

  it('puts running checks above a requested change — a run in flight is the newest fact', () => {
    // `reviewDecision` stays CHANGES_REQUESTED until the reviewer comes back, so a PR whose
    // author has already pushed the fix would otherwise claim to be blocked on them for as long
    // as the re-review takes. CI running means something was just pushed.
    expect(pr({ checks: 'pending', reviewDecision: 'CHANGES_REQUESTED' })).toBe('checks-pending');
    expect(pr({ checks: 'pending', reviewDecision: 'REVIEW_REQUIRED' })).toBe('checks-pending');
  });

  it('keeps a CURRENT requested change above a red build', () => {
    // Nothing has been pushed since the review and no re-review asked for, so the reviewer is
    // still describing what is there — and CI goes red and green again on its own, where a person
    // does not. This is the one case that still points at the author.
    expect(pr({ reviewDecision: 'CHANGES_REQUESTED', checks: 'failing' })).toBe('changes-requested');
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'failing',
        changesRequestedAt: '2026-08-11T12:00:00Z',
        headCommittedAt: '2026-08-11T09:00:00Z',
      }),
    ).toBe('changes-requested');
  });

  it('hands the ball back to the reviewer once a re-review is REQUESTED', () => {
    // Observed live: `reviewDecision` stays CHANGES_REQUESTED after the author clicks re-request,
    // and `latestReviews` comes back empty — `reviewRequests` is the only thing that says the ball
    // has moved. Without this the chip points at the author for the whole length of a re-review.
    expect(
      pr({ reviewDecision: 'CHANGES_REQUESTED', checks: 'passing', reviewRequested: true }),
    ).toBe('review-required');
    // …even with nothing pushed since, as long as the request itself POSTDATES the review.
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'passing',
        reviewRequested: true,
        changesRequestedAt: '2026-08-11T12:00:00Z',
        headCommittedAt: '2026-08-11T09:00:00Z',
        reviewRequestedAt: '2026-08-11T12:30:00Z',
      }),
    ).toBe('review-required');
  });

  it('does NOT read a reviewer asked BEFORE the review as an answer to it', () => {
    // The reported case: three reviewers requested at once, one of them requested changes the
    // next day, the other two never looked — so `reviewRequests.totalCount` stays 1 with nothing
    // whatsoever having happened since. Counting that as the author re-requesting painted "Waiting
    // for review" over a live rejection, which is the opposite of whose move it is.
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'passing',
        reviewRequested: true,
        reviewRequestedAt: '2026-08-18T10:28:43Z',
        changesRequestedAt: '2026-08-19T11:00:27Z',
        headCommittedAt: '2026-08-18T10:23:40Z',
      }),
    ).toBe('changes-requested');
    // A stale request does not stop a PUSH from handing the ball back, though — that rule is
    // untouched, and it is the one the reporter called fine.
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'passing',
        reviewRequested: true,
        reviewRequestedAt: '2026-08-18T10:28:43Z',
        changesRequestedAt: '2026-08-19T11:00:27Z',
        headCommittedAt: '2026-08-19T14:00:00Z',
      }),
    ).toBe('review-required');
    // An undated request against a dated review is the unusable-pair case: conservative, so the
    // chip keeps pointing at the author rather than dismissing a review on a guess.
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'passing',
        reviewRequested: true,
        changesRequestedAt: '2026-08-19T11:00:27Z',
      }),
    ).toBe('changes-requested');
  });

  it('hands it back on a PUSH too, for an author who re-requested nothing', () => {
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'passing',
        changesRequestedAt: '2026-08-11T09:00:00Z',
        headCommittedAt: '2026-08-11T12:00:00Z',
      }),
    ).toBe('review-required');
    // One parent is an ordinary commit, stated or not — the count only ever rules a merge OUT.
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'passing',
        changesRequestedAt: '2026-08-11T09:00:00Z',
        headCommittedAt: '2026-08-11T12:00:00Z',
        headParentCount: 1,
      }),
    ).toBe('review-required');
  });

  it('does NOT let "Update branch" clear a rejection — a merge answers nothing', () => {
    // GitHub's Update-branch button writes `Merge branch 'main' into <branch>` dated NOW, newer
    // than any review while addressing none of it. Shape confirmed on a real PR,
    // whose head commit reports two parents. Counting it as a push would let the one click people
    // make reflexively on a stale PR wipe a live rejection off the chip.
    const updated = {
      reviewDecision: 'CHANGES_REQUESTED' as const,
      changesRequestedAt: '2026-08-11T09:00:00Z',
      headCommittedAt: '2026-08-11T12:00:00Z',
      headParentCount: 2,
    };
    expect(pr({ ...updated, checks: 'passing' })).toBe('changes-requested');
    // An octopus merge is no more of an answer than a two-parent one.
    expect(pr({ ...updated, checks: 'passing', headParentCount: 3 })).toBe('changes-requested');
    // …but a re-request still hands the ball back, merge or no merge: that signal is the author
    // SAYING they are done, where the merge only looks like it.
    expect(
      pr({ ...updated, checks: 'passing', reviewRequested: true, reviewRequestedAt: '2026-08-11T12:30:00Z' }),
    ).toBe('review-required');
  });

  it('does NOT let a merge landing on top ERASE an answer the author already gave', () => {
    // The other half of the merge rule, and the one that bites in practice: a merge is transparent,
    // not disqualifying. Sequence — reviewer requests changes at 09:00; author pushes a real fix at
    // 12:00 (chip correctly goes blue); the base moves on and the PR conflicts; the author presses
    // this cockpit's own "Resolve conflicts" (or GitHub's "Update branch") at 15:00. Reading only
    // the head would see a 2-parent commit, discard the 12:00 fix and flip the chip back to red,
    // blaming an author who answered two steps ago. The merge's FIRST parent still carries 12:00.
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'passing',
        changesRequestedAt: '2026-08-11T09:00:00Z',
        headCommittedAt: '2026-08-11T15:00:00Z',
        headParentCount: 2,
        headFirstParentCommittedAt: '2026-08-11T12:00:00Z',
      }),
    ).toBe('review-required');
    // The plain "Update branch" case is unchanged: nothing was pushed after the review, so the
    // first parent is the pre-review commit and the rejection still stands.
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'passing',
        changesRequestedAt: '2026-08-11T09:00:00Z',
        headCommittedAt: '2026-08-11T15:00:00Z',
        headParentCount: 2,
        headFirstParentCommittedAt: '2026-08-11T06:00:00Z',
      }),
    ).toBe('changes-requested');
    // A merge with no first-parent date is the unusable-pair case: conservative, review stands.
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'passing',
        changesRequestedAt: '2026-08-11T09:00:00Z',
        headCommittedAt: '2026-08-11T15:00:00Z',
        headParentCount: 2,
      }),
    ).toBe('changes-requested');
  });

  it('still puts a red build above a waiting reviewer — they cannot approve it anyway', () => {
    const answered = { changesRequestedAt: '2026-08-11T09:00:00Z', headCommittedAt: '2026-08-11T12:00:00Z' };
    expect(pr({ reviewDecision: 'CHANGES_REQUESTED', checks: 'failing', ...answered })).toBe('checks-failing');
    expect(pr({ reviewDecision: 'CHANGES_REQUESTED', checks: 'failing', reviewRequested: true })).toBe(
      'checks-failing',
    );
  });

  it('counts an explicitly requested reviewer even with no review policy at all', () => {
    // `reviewDecision` is null on a repo that requires no reviews — but somebody was still asked,
    // and calling that "ready to merge" would paint over the ask.
    expect(pr({ reviewDecision: null, checks: 'passing', reviewRequested: true })).toBe('review-required');
  });

  it('lets an APPROVAL outrank a reviewer still listed as requested', () => {
    // Real shape, observed live: approved, mergeable, green — and one reviewer left
    // on the request list after someone else approved. That is a courtesy ask, not an unmet gate,
    // and reading it as "waiting for review" would stick for as long as anyone stays listed, which
    // is indefinitely. A repo needing two approvals reports REVIEW_REQUIRED until it has both, so
    // APPROVED never arrives early.
    expect(
      pr({
        reviewDecision: 'APPROVED',
        checks: 'passing',
        reviewRequested: true,
        // A superseded changes-requested review from the same reviewer, days before the approval.
        changesRequestedAt: '2026-08-03T14:54:03Z',
        headCommittedAt: '2026-08-12T07:54:05Z',
      }),
    ).toBe('ready');
  });

  it('still puts a red build above an approval', () => {
    // Approved does not mean mergeable — the build is the author's move either way.
    expect(pr({ reviewDecision: 'APPROVED', checks: 'failing', reviewRequested: true })).toBe('checks-failing');
    expect(pr({ reviewDecision: 'APPROVED', checks: 'pending' })).toBe('checks-pending');
  });

  it('treats an unusable pair of dates as a CURRENT review', () => {
    // Conservative on purpose: a missing or unparseable date, with nothing re-requested, must not
    // silently hand the ball to a reviewer who was never asked.
    const dated = (over: Record<string, unknown>) =>
      pr({ reviewDecision: 'CHANGES_REQUESTED', checks: 'failing', ...over });
    expect(dated({ headCommittedAt: '2026-08-11T12:00:00Z' })).toBe('changes-requested');
    expect(dated({ changesRequestedAt: '2026-08-11T09:00:00Z' })).toBe('changes-requested');
    expect(dated({ headCommittedAt: 'not-a-date', changesRequestedAt: '2026-08-11T09:00:00Z' })).toBe(
      'changes-requested',
    );
  });

  it('reports the machine once no human is blocking', () => {
    expect(pr({ checks: 'failing' })).toBe('checks-failing');
    expect(pr({ checks: 'pending' })).toBe('checks-pending');
  });

  it('names a waited-on review only when nothing is failing or running', () => {
    expect(pr({ reviewDecision: 'REVIEW_REQUIRED', checks: 'passing' })).toBe('review-required');
  });

  it('calls a green PR ready — approved, or on a repo with no review policy at all', () => {
    expect(pr({ reviewDecision: 'APPROVED', checks: 'passing' })).toBe('ready');
    // `reviewDecision: null` is what a repo without required reviews answers. No approval is ever
    // coming, so withholding "ready" would leave that repo's PRs permanently unlabelled.
    expect(pr({ reviewDecision: null, checks: null })).toBe('ready');
  });
});

/**
 * The whole combination space, checked against INVARIANTS rather than a second copy of the
 * ranking.
 *
 * The precedence has been edited five times — checks-pending above a requested change, the
 * re-request handoff, `APPROVED` outranking a pending request, that handoff being narrowed to
 * requests that postdate the review, then merge commits dropping out of the push rule — and each
 * edit reordered branches that the curated examples above only sample. Restating the expected
 * answer for all 256
 * combinations would just be the implementation written twice, and would agree with a bug as
 * readily as with a fix. These are the properties that must hold whatever the ordering is; a
 * future edit that violates one is a bug by construction.
 */
describe('derivePrReferenceStatus over every combination', () => {
  const CHECKS = ['passing', 'failing', 'pending', null] as const;
  const DECISIONS = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', null] as const;
  const BOOLS = [true, false] as const;
  const PR_STATUSES = new Set([
    'merged',
    'closed',
    'draft',
    'checks-pending',
    'checks-failing',
    'changes-requested',
    'review-required',
    'ready',
  ]);

  /** Every open, non-draft shape: 4 check states × 4 decisions × requested × pushed-since ×
   *  request-postdates-the-review × head-is-a-merge. */
  const openRows = () => {
    const rows: Parameters<typeof derivePrReferenceStatus>[0][] = [];
    for (const checks of CHECKS) {
      for (const reviewDecision of DECISIONS) {
        for (const reviewRequested of BOOLS) {
          for (const pushed of BOOLS) {
            for (const reRequested of BOOLS) {
              for (const merge of BOOLS) {
                rows.push({
                  state: 'OPEN',
                  isDraft: false,
                  reviewDecision,
                  checks,
                  reviewRequested,
                  changesRequestedAt: '2026-08-11T09:00:00Z',
                  headCommittedAt: pushed ? '2026-08-11T12:00:00Z' : '2026-08-11T06:00:00Z',
                  reviewRequestedAt: reRequested ? '2026-08-11T12:00:00Z' : '2026-08-11T06:00:00Z',
                  headParentCount: merge ? 2 : 1,
                });
              }
            }
          }
        }
      }
    }
    return rows;
  };

  const describeRow = (row: Parameters<typeof derivePrReferenceStatus>[0]) => JSON.stringify(row);

  it('covers 256 open shapes', () => {
    expect(openRows()).toHaveLength(256);
  });

  it('only ever answers with a PULL REQUEST status', () => {
    // Never an issue word: `open`, `completed` and `not-planned` belong to the other kind, and a
    // PR wearing one would be filed under the wrong bucket by the route.
    for (const row of openRows()) {
      expect(PR_STATUSES, describeRow(row)).toContain(derivePrReferenceStatus(row));
    }
  });

  it('lets a terminal state beat everything', () => {
    for (const row of openRows()) {
      expect(derivePrReferenceStatus({ ...row, state: 'MERGED' }), describeRow(row)).toBe('merged');
      expect(derivePrReferenceStatus({ ...row, state: 'CLOSED' }), describeRow(row)).toBe('closed');
      // A draft is terminal for everything below it, but not for merged/closed above.
      expect(derivePrReferenceStatus({ ...row, isDraft: true }), describeRow(row)).toBe('draft');
    }
  });

  it('reports running checks whenever they are running', () => {
    for (const row of openRows()) {
      expect(derivePrReferenceStatus({ ...row, checks: 'pending' }), describeRow(row)).toBe('checks-pending');
    }
  });

  it('never blames the author once the forge says APPROVED', () => {
    // The approved-but-still-requested class of bug: an approved PR must not read as waiting on a
    // reviewer or owing edits, however many reviewers are still listed as requested.
    for (const row of openRows()) {
      const status = derivePrReferenceStatus({ ...row, reviewDecision: 'APPROVED' });
      expect(['review-required', 'changes-requested'], describeRow(row)).not.toContain(status);
    }
  });

  it('only says changes-requested when changes ARE requested', () => {
    for (const row of openRows()) {
      if (derivePrReferenceStatus(row) === 'changes-requested') {
        expect(row.reviewDecision, describeRow(row)).toBe('CHANGES_REQUESTED');
      }
    }
  });

  it('never lets a request OLDER than the review dismiss that review', () => {
    // The stale-review-request class of bug, as an invariant: with nothing pushed since and the
    // standing request predating the review, no combination may report the ball as the reviewer's.
    for (const row of openRows()) {
      if (row.reviewDecision !== 'CHANGES_REQUESTED') continue;
      if (row.checks === 'pending' || row.checks === 'failing') continue; // those outrank it by design
      const stale =
        row.headCommittedAt === '2026-08-11T06:00:00Z' && row.reviewRequestedAt === '2026-08-11T06:00:00Z';
      if (!stale) continue;
      expect(derivePrReferenceStatus(row), describeRow(row)).toBe('changes-requested');
    }
  });

  it('never lets a MERGE at the head stand in for the author answering', () => {
    // The "Update branch" class of bug, as an invariant: with a merge commit on top and no
    // re-request, the head's date is irrelevant — a rejection stays a rejection however fresh the
    // merge is. Only `reviewRequested` may overrule it, and it does so on its own merits.
    for (const row of openRows()) {
      if (row.reviewDecision !== 'CHANGES_REQUESTED') continue;
      if (row.checks === 'pending' || row.checks === 'failing') continue; // those outrank it by design
      if (row.headParentCount !== 2) continue;
      const reRequested = row.reviewRequested === true && row.reviewRequestedAt === '2026-08-11T12:00:00Z';
      if (reRequested) continue;
      expect(derivePrReferenceStatus(row), describeRow(row)).toBe('changes-requested');
    }
  });

  it('only says checks-failing when the checks ARE failing', () => {
    for (const row of openRows()) {
      if (derivePrReferenceStatus(row) === 'checks-failing') {
        expect(row.checks, describeRow(row)).toBe('failing');
      }
    }
  });

  it('only says ready when nothing at all is outstanding', () => {
    for (const row of openRows()) {
      if (derivePrReferenceStatus(row) !== 'ready') continue;
      const why = describeRow(row);
      expect(row.checks === 'failing' || row.checks === 'pending', why).toBe(false);
      // Either the forge approved it, or nobody was ever waited on.
      const nobodyWaiting =
        row.reviewDecision === null && row.reviewRequested !== true;
      expect(row.reviewDecision === 'APPROVED' || nobodyWaiting, why).toBe(true);
    }
  });

  it('never leaves a requested reviewer unmentioned on an otherwise-quiet PR', () => {
    // No policy, nothing failing, nothing running, but somebody was explicitly asked: calling that
    // "ready to merge" would paint over the ask.
    for (const checks of ['passing', null] as const) {
      expect(
        derivePrReferenceStatus({
          state: 'OPEN',
          isDraft: false,
          reviewDecision: null,
          checks,
          reviewRequested: true,
        }),
      ).toBe('review-required');
    }
  });
});

describe('deriveIssueReferenceStatus', () => {
  it('keeps "we did it" and "we will not" apart', () => {
    expect(deriveIssueReferenceStatus({ state: 'OPEN' })).toBe('open');
    expect(deriveIssueReferenceStatus({ state: 'CLOSED', stateReason: 'COMPLETED' })).toBe('completed');
    expect(deriveIssueReferenceStatus({ state: 'CLOSED', stateReason: 'NOT_PLANNED' })).toBe('not-planned');
  });

  it('reads a closed issue with no reason as completed', () => {
    // Pre-`stateReason` issues (and reopened-then-closed ones) carry nothing; "completed" is the
    // honest default — GitHub itself renders them that way.
    expect(deriveIssueReferenceStatus({ state: 'CLOSED' })).toBe('completed');
    expect(deriveIssueReferenceStatus({ state: 'CLOSED', stateReason: null })).toBe('completed');
  });
});
