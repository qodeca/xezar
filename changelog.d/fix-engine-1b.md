## 🐛 Fixes

- 🐛 **A headless `xezar run` no longer cancels the recovery of other tasks.** It marked every
  queued, running or waiting task in the project as failed, so the next `xezar serve` had nothing
  to resume and dropped the list of programs those tasks had started without stopping them. A
  headless run now touches only the task it creates.
