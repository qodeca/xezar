## 🐛 Fixes

- 🐛 **The cockpit now tells you about waiting tasks in every project, not only the one on
  screen.** The sidebar's "needs you" badges for other projects used to freeze, a collapsed project
  showed no badge at all, and browser notifications fired only for the project the tab opened in.
  All of them – plus a new count on "All tasks" and a `(n)` prefix in the browser tab title – now
  read one workspace-wide count that the live event stream keeps current for every project. The
  live connection also recovers on its own when it goes silent, refreshes the cross-project task
  list after activity settles (at least every two seconds while it does not), and ignores a
  malformed status update instead of caching it.
