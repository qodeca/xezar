## 🚀 CI/CD & Infrastructure

- 🚀 **The two per-dataDir todos watch tests no longer wait on macOS to report a file write.**
  (#671) `packages/xezar/src/todos.test.ts` proved "A fires, B stays silent" and "unsubscribe stops
  delivery" by writing `todos.json` and giving the OS up to 4 s to deliver an `fs.watch` event.
  That is not a signal a test can rely on: `fs.watch` announces nothing when it is armed, and a
  write that lands during macOS registration is dropped rather than delayed, so on a loaded
  machine the awaited event simply never came — three red gate runs on 2026-09-20, all with the
  same `no change event for …/project-a/.local/xezar/todos.json within 4000 ms`. `todos.ts` now
  carries a watcher seam (`setTodosWatchFactory`), the cases deliver the raw event themselves and
  advance the product's own 300 ms debounce with fake timers, and the suite runs in 118 ms instead
  of 4.8 s with no wall clock left to lose a race to. Nothing about the shipped behaviour changes:
  the default factory is the same `fs.watch` call, and a new case fails if the default ever stops
  constructing a real watcher. No test was retried, quarantined or given a wider timeout.
