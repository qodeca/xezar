## 🐛 Fixes

- 🐛 **The cockpit now tells you about waiting tasks in every project, not only the one on
  screen.** The sidebar's "needs you" badges for other projects used to freeze, a collapsed project
  showed no badge at all, and browser notifications fired only for the project the tab opened in.
  All of them – plus a new count on "All tasks" and a `(n)` prefix in the browser tab title – now
  read one workspace-wide count that the live event stream keeps current for every project. The
  count also includes tasks older than a project's newest 200, which the cross-project task index
  now counts on the server (`GET /api/v1/workspace/runs-index` gains additive `attention`,
  `unreadable` and `registryUnreadable` fields, so an unreadable registry or project is no longer
  answered as an empty, all-is-well index).
  If that index cannot be read, the current project still counts from its own task list and one
  line under "All tasks" says the other counts may be out of date, instead of them dropping to
  zero. On a phone the menu button carries the same count. Notifications now name the project:
  "Storefront — task needs you". The live connection also recovers on its own
  when it goes silent, refreshes the cross-project task list after activity settles (at least
  every two seconds while it does not), and ignores a malformed status update instead of caching
  it. (#1117)
