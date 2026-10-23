## 🚀 CI/CD & Infrastructure

- 🚀 **The browser suite runs on Windows.** The `agent-browser` background process kept the
  command's output pipe open, so every browser command waited for its time limit and every spec
  failed. The e2e helpers now read the command's output from files, and a guard test keeps every
  call on that path. (#1135)
- 🚀 **A stuck test can no longer hang the Windows unit gate.** `serve-port-race.test.ts` stops
  each `serve` it starts together with everything that `serve` started, with a bounded clean-up,
  and `test:unit` gives each file at most ten minutes. (#1135)
- 🚀 **Test folders are removed reliably on Windows with Node 24.** Node 24's own `rmSync` retry
  never retries a Windows access-denied error and does not wait between tries, so hundreds of
  tests failed in clean-up. The retry the test bootstrap already gave Node 22 now applies to every
  Node version on Windows. (#1135)
