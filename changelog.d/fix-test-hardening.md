## 🚀 CI/CD & Infrastructure

- 🚀 **Tests that wait on a clock now wait on what happened.** The push-delivery "nothing was
  pushed twice" checks wait for counted heartbeats instead of fixed sleeps, and the lock and
  child-exit timing checks assert that no wait happened instead of reading elapsed time, so a busy
  machine can neither hide a regression nor fail a healthy run. Every route the server registers
  must now be marked local-only or classified for hosted mode, so a new route cannot skip that
  decision; each Qwen Code setting that can widen a read-only step is pinned on its own; the
  Claude Code blocker texts are checked against the exact strings the code sends; and the test
  suite no longer leaves temporary Qwen Code homes behind. A separate, hand-run mutation run
  (`npm run test:mutation:lock`) now covers the read-only command lock and the Qwen Code tool
  policy without touching the nightly MCP gate.
