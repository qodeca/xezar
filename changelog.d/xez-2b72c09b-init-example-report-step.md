## 🐛 Fixes

- 🐛 **The example workflow `xezar init` writes now ends with an agent step, so the run stays
  interactive.** When the project already has a check, the generated `fix-and-verify` workflow ended
  with its `verify` command step. The engine keeps a run interactive only when its last agent step
  is also its last step, so XEZ:ASK and XEZ:DONE were silenced for the whole run and a task could
  never report a result or ask a question. The example now appends a `report` agent step after
  `verify` — it summarises what changed, states the check's result and what it did not cover, and
  asks whether anything is still unclear. The `implement` step and the `verify` → `implement` retry
  loop are unchanged, and the branch with no discovered check was already correct. (#819)
