### 2026-09-23 — Trusting the Codex read-only hook headlessly

- The earlier spike's negative result was load-bearing: `thread/start` accepted an inline hook but `hooks/list` still did not discover it after thread creation. The implementation therefore keeps the thread override for session intent and installs the identical generic handler through Codex's user-layer `hooks.json`, the only discovery path proven live on 0.155.1.
- A foreground live `CodexAppServerRunner` run proved the complete path: `git status --short` ran; a semicolon compound, a redirect and `gh pr merge 0` were denied with `syntax.compound`, `syntax.redirection` and `prefix.entry`; neither denied filesystem side effect appeared.
- The app-server's normalized hook hash cannot be recreated safely from file bytes. Asking `hooks/list`, granting the returned key/hash through `config/batchWrite`, then re-reading trust kept the adapter fail-closed and made start/resume use the same sequence.
