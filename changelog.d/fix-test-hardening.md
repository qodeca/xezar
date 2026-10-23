## 🚀 CI/CD & Infrastructure

- 🚀 **Tests that wait on a clock now wait on what happened.** The push-delivery "nothing was
  pushed twice" checks wait for counted heartbeats instead of fixed sleeps, and the lock and
  child-exit timing checks assert that no wait happened instead of reading elapsed time, so a busy
  machine can neither hide a regression nor fail a healthy run. Every route the server registers
  must now be marked local-only or classified for hosted mode, so a new route cannot skip that
  decision; each Qwen Code setting that can widen a read-only step is pinned on its own; the
  Claude Code blocker texts are checked against the exact strings the code sends; and the test
  suite no longer leaves temporary Qwen Code homes behind. A separate mutation run
  (`npm run test:mutation:lock`) now covers the read-only command lock and the Qwen Code tool
  policy, with its own scope apart from the MCP gate's. (#1112)

## 🐛 Fixes

- 🐛 **A Qwen Code leader receives pushed events when the temp folder is deep.** The receipt
  socket xezar opens for each push lived in the temp folder, and a deep `TMPDIR` made its path
  longer than a Unix socket allows, so every push failed. It now moves to `/tmp` only when the
  temp folder is too deep for it; Windows is unchanged. (#1112)
