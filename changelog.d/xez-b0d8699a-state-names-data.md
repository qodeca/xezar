## 🔧 Changed

- 🔧 **The `.local/xezar/` top-level name list is now shared, non-test data.** The 27 allowed
  names, their file-vs-directory kind, and the documented suffix/rotation shapes used to live only
  as module-local consts inside `local-xezar-top-level-scan.test.ts`, so nothing outside that test
  could read them — the reason the `xezar-skills` kit still keeps its own hand-copied list and
  goes stale against it. They now live in `packages/xezar/src/local-xezar-top-level-names.ts`,
  which the scan test imports rather than re-declaring, and a committed fixture
  (`local-xezar-top-level-names.expected.json`) pins the exact JSON a future
  `xezar state-names --json` must print. This lands the data and its binding fixture only; the
  CLI subcommand that serves it is a follow-up. (#838)
