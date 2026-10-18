## 🐛 Fixes

- 🐛 **A restart no longer finishes a task whose remaining steps never ran.** A Continue after a
  mid-workflow failure hands the later steps over only when its turn ends with `XEZ:DONE`; when it
  stopped to wait for an answer and xezar restarted, recovery settled it as `done` or `review` and
  skipped the remaining checks and reviews. It now fails the task with the same reason a live close
  gives, and the task can still be continued.
