## 🚀 CI/CD & Infrastructure

- 🚀 **The skills-update browser spec establishes the state it asserts, and waits for the query
  that owns the line it reads.** Two independent defects made
  `packages/web/e2e/skills-update.e2e.ts` red on two different lines across four measured runs.
  The spec asserted "no override is saved" about a scratch home it only snapshotted, so an earlier
  session's leaked `skillsAutoUpdate: false` made it fail; it now writes `null` through the same
  `PUT /api/v1/workspace/config` route the page's own "Use default" button calls and confirms the
  stored value before the page reads it. And it read the installation-status copy after waiting on
  a DIFFERENT query's section, so the pending sentence won whenever
  `GET /workspace/skills-update` lost one round trip; the status paragraph now carries its own
  `data-state` (`pending`/`ready`/`error`, a pure function of that query), and the spec waits for
  `ready` before reading the copy. No timeout, retry, sleep or flake-register entry — both halves
  are proven red against a named break and green after it. (#671)
