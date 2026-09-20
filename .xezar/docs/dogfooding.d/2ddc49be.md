### 2026-09-20 — Guarding the review-response destination and current seal

- Observed: PR #775's first candidate documented an identical cross-branch push but the only
  guarded push still fixed both sides to this run's own branch. The response workflow therefore
  needed an executable, record-bound destination rather than prose permitting raw Git.
- Observed: a `DELIVERED` record was previously interpreted only for an empty task branch. Once a
  response correctly retained its commit, stale live tips, missing heads and a prior round's head
  bypassed that validation. The disposition is now validated in readiness and evidence modes
  regardless of own-commit count, while strict preflight remains available before the guarded push.
- Fixture-tested: the guarded path refuses an unrecorded target and a target advanced from the
  recorded base, then succeeds for the sole authorized branch without force; the unchanged
  zero-argument path still pushes only the task branch.
- Fixture-tested: `BREAK-756-STALE-DELIVERY` covers live advancement after sealing, with separate
  missing-head and superseded-round refusals. `BREAK-756-PROSE-ONLY` keeps verification-only
  responses pushless and requires handoff to state that their task seal does not certify the
  separately verified pull-request revision.
- Red-proved against byte-identical pre-fix files in durable scratch clones: the old push guard
  failed `BREAK-756-UNAUTHORIZED-PUSH` with `expected exit 0, got 2`; the old preflight let
  `BREAK-756-STALE-DELIVERY` exit 0; and the old handoff text failed `BREAK-756-PROSE-ONLY` with
  `expected exit 0, got 1`. Paths, SHA-256 values, exact commands and full logs are in this run's
  evidence directory.
- Merge resolution: refreshed from main at `5b5cc84c` with a merge commit and took main's complete
  `todos.ts` and `todos.test.ts`; PR #773 remains the owner of that redesign.
