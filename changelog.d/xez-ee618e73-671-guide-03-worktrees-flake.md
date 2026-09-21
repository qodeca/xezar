## 🚀 CI/CD & Infrastructure

- 🚀 **The guide-03 worktrees spec waits for the query that owns the line it reads.**
  `packages/web/e2e/guide-03-worktrees-and-git.e2e.ts` asserted "No task worktrees on disk."
  straight after waiting for the "Worktrees" heading — but that heading belongs to the project
  config query, while the sentence belongs to a second, independent worktrees query, so the
  panel's pending state won whenever `GET /worktrees` lost one browser round trip (measured red in
  1 of 3 default-order runs). The panel's loading line now carries `role="status"` with its own
  `aria-label`, and the spec waits for that region to clear before reading the copy — the query's
  own rendered state, never text and never time. The label is part of the fix rather than
  decoration: `status` is not a name-from-content role, so without it the region has no accessible
  name and the wait would pass while the indicator is still on screen. No timeout, retry, sleep or
  flake-register entry — the new wait is proven red against a component holding its query back
  three seconds and green under the identical build. (#671)
