## 🐛 Fixes

- 🐛 **Starting xezar no longer deletes task work it has no record of.** The start-up cleanup of
  task folders now does what worktree retention does: it removes a folder only when Git shows it
  is a clean worktree on a branch, and it always keeps the task's branch. A folder with
  uncommitted or untracked changes, a detached checkout or one Git does not know is left in place
  and named in the boot output. (#1108)
- 🐛 **One unreadable record in `runs.json` no longer empties the task history.** Every record
  that still reads is kept, the unreadable original is copied to
  `.local/xezar/backups/runs.json.bak` before the next save, a warning names what was dropped, and
  that start skips the task-folder cleanup entirely.
  The cross-project task search reads each project's `runs.json` the same way, record by record,
  so one bad row no longer hides that project's tasks. (#1108)
