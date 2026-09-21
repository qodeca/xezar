## 🚀 CI/CD & Infrastructure

- 🚀 **The bounded CI observation no longer carries a rerun list.** (#671) `KNOWN_LOAD_FLAKES` in
  `.xezar/checks/ci-watch.sh` named one job left, `MCP per-file coverage` — its only recorded flake
  (F-29, `stale-write.test.ts`'s teardown race, #631) was fixed by #634 and #765. `gh run list`/
  `gh run view` against the last 15 completed `main` CI runs since `215d1e2f` showed it green on 14
  and cancelled-superseded on 1, zero failures, so the entry and the one-rerun rule it granted are
  retired: a failed job is a failure, full stop, and the integration `report` step always asks the
  leader to revert, forward-fix or hold rather than auto-rerunning. Internal to this repository's
  own kit — `.xezar/` ships in nothing published.
