# Close-out

## Merging a pull request

Required checks must be genuinely green on the PR you merge. Which path applies depends on
whether the base branch has a GitHub merge queue (not the kit's `merge-queue` label). It has one
when `gh api graphql -f query='query{repository(owner:"<owner>",name:"<repo>"){mergeQueue(branch:"<base>"){url}}}'`
answers a non-null `mergeQueue`.

- **No queue.** Update the branch from the base when GitHub says it is behind, wait for the
  required checks on the new head, then merge.
- **Queue on.** `gh pr merge <number> --auto`: the queue tests the PR on top of the ones ahead of
  it and merges it when that passes. Never update-branch in a loop, and never `--admin` past the
  queue. A PR the queue removes comes back to you as a failed check; read it before re-queueing.

Why: `.xezar/docs/leader-guide-detail.md`, "Standing loops".

## Scope dispositions


Each scope item has one disposition: implemented, validated, deferred with reopening trigger, qualification needed, or rejected with reason. Keep partial/context qualifiers. Link exact revision, kit/runtime and evidence tier. Source-reported success and fixture-tested behavior are not real-task verification. Do not mark all complete with required AC/gates missing or actionable follow-ups only in ignored files.

Maintain public-safe conclusions in guidance; keep sensitive logs in primary evidence. Separate integration, target CI, accepted business outcome and root synchronization. Unknown usage is not zero; deduplicate usage before totals. Name environmental limits explicitly without downgrading acceptance. A capability moves observation→change→requalification→recommendation: an observation from real work justifies a narrow change, the change is requalified by evidence at the tier the claim needs, and only a requalified capability earns a recommendation with its limits stated.
