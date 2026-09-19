# Dogfooding improvement candidates

No historical private source backlog is imported as current Xezar issues. Candidate entries require current reproduction or an explicit qualification gap, the affected task/kit/runtime, expected versus actual behavior, impact, proposed bounded change and a trigger to revisit. Record already present, qualification needed, demonstrated gap, deferred or rejected separately.

Remaining qualification gaps: continuation and recovery, protected-branch host policy, proof of the live root lease, checkpoint-only coordinator continuity and questions answered by an MCP-only leader (pushed to it when attached, answered with `execution_control`). Real new-task bootstrap, unprotected-`main` integration and root-sync execution are real-task verified; see `installation.md` for their limits.

Resource contention has moved out of that list: it is a **demonstrated gap with a bounded change landed** (2026-09-10). Several concurrent gate runs on one machine each spawned vitest's default `availableParallelism() - 1` workers — roughly 180 worker processes on an 18-core host — and the result was starvation rather than a bug: unrelated suites timing out at 909s on a single file, and a different 17 files failing every run. The change is a cap in the repository's root `vitest.config.ts` (`min(4, availableParallelism() - 1)`), which is deliberately a no-op on CI's smaller runners and leaves `--maxWorkers=N` and `VITEST_MAX_WORKERS` as overrides. Trigger to revisit: a machine where four workers per run is itself the bottleneck, or a gate step that is not vitest showing the same shape. Isolated tests may qualify helpers; they cannot close real-task/runtime gaps. No automatic issue publication or new development objective follows from recording a candidate.


## Deferred candidates from the task record (2026-09-15)

These are recorded proposals, not authorization to change the guards. Revisit when the same operation is needed again; preserve the failure history and existing ownership checks.

| Candidate | Reproduction / impact | Bounded next step and status |
| --- | --- | --- |
| Commit a resolved merge through the bound Git helper | The #404 conflict task records `gitstate.clean` refusing `MERGE_HEAD`, although the resolution was ready to commit; the helper has only `commit` and `push`. | Deferred: define a merge-continue operation bound to the recorded merge intent before relaxing any refusal. Revisit on the next authorized conflict resolution. |
| Update a named PR branch through the bound Git helper | Run `1d6c6be4` delivered a fix for #415 after its original worktree disappeared; the helper can only push its own run branch. | Deferred: verify an exact expected remote tip and named target before a guarded fast-forward. Related #347 covers rebased own-branch pushes, not this distinct cross-branch case. |
| Reduce conflicts in the shared task ledger | The #289 handoff collision in `dogfooding.md` required a refresh and full revalidation. | Resolved by #668: per-task fragments under `.xezar/docs/dogfooding.d/`, folded by the release role. The ledger stays one file, sorted newest-first (owner decision D3 on #447); no split or archive. |
| Reject changes filed under an already released changelog heading | The #198/#184/#183 entry in `dogfooding.md` records commits absent from the tag under which they were documented; `changelog-check.sh` checks structure. | Deferred: define a tag-aware added-line check with a legitimate correction path. Revisit on the next misplaced released-section entry. |

The audit's proposed shared-contract drift guard is already present: `catalog-check.mjs` requires identical `## Shared contract` tails across the maintained skills. No new guard or shared-source generator is needed for this sweep.
