## 📝 Specs & Documentation

- 📝 **Drifted `path:line` citations in a feature record are re-anchored, two coverage-gap claims
  are updated and five records now state their status.** The MCP result-and-evidence record was
  anchored to revision `9fdcf0e`, so every citation had moved: `RunStatus`, `StepStatus`,
  `StepState.iterations`/`error`, the `RunRecord` field rows, the `NO_WORKTREE` routes, the
  check-output `exitCode` and the SIGTERM, plus `store.ts`, `forge/github.ts`, the merge-state and
  changes schemas. Each anchor is re-derived at `7df2cf4d` and the record's baseline line now says
  so. `docs/testing/coverage-gaps.md` keeps its dated 2026-09-15 nightly observation and adds the
  later first complete six-of-six run (`fe33541`, run 34999068325), and splits a run-on sentence
  into its three dated facts (adopted as a release gate, removed 2026-09-12, scheduled by #433 on
  2026-09-15) with no fact changed. The issue-filing contract, the Codex adapter evidence, the
  real-client acceptance record, the MCP Definition-of-Done record and the pi leader extension
  each gain one dated status line in their first 15 lines. Docs only: no behaviour change. (#447)
