## 🐛 Fixes

- 🐛 **A run store whose data directory has been removed now skips that write silently instead of
  logging it as a failure, and writes again if the directory comes back.** (#631, #671) `RunStore`
  debounces its `runs.json` write by 300 ms, and a caller that removed the directory while that
  timer was pending got the timer anyway: `saveNow()` hit `ENOENT` on `runs.json.tmp` and
  `console.error`'d it. A directory that is gone is not a disk failure, so the store drops the
  pending write instead of complaining — and because anything that recreates the directory (a
  worktree creation does) should bring the index back, it is a skipped write rather than a
  shutdown: the next save writes the index out again and says so once. The new `close()` is the
  only thing that ends the write lifecycle (cancel the debounce, write the index out, refuse every
  later write), which is what a project-context teardown and a test fixture both actually want. The
  live path is untouched: an open store still coalesces token-usage updates into one write every
  300 ms, still writes through the atomic tmp+rename, still saves a decision change immediately,
  and a write that fails while the directory IS reachable is still logged — including a permission
  failure on one of its parents.

## 🚀 CI/CD & Infrastructure

- 🚀 **Two flaky test shapes removed at the source rather than retried.** (#631, #671 rows F-26 and
  F-29) That late `console.error` is what vitest reports as
  `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending` — three red
  `MCP per-file coverage` jobs on 2026-09-18 with all 2 267 tests passing — and what a gate reads
  as a timeout in whichever case was running when it landed. Seventeen fixtures plus the two
  shared ones now close their store before removing its temporary directory, through one shared
  helper (`runs/store.testkit.ts`); the remaining sixty-nine that carry the same shape are covered
  by the store's own behaviour above and are listed in a new scan test, which fails for any FUTURE
  test written that way. `acceptance-parity.test.ts`'s waits await the run store's own
  change signal instead of a 30 s inner budget that could pre-empt each case's own 90 s one. No
  test was retried, quarantined or given a wider timeout; the two inner budgets are gone, not
  raised.
