## 📝 Specs & Documentation

- 📝 **The 2026-09-21 leader lessons 12–16 are committed.** A conflict-refresh brief now says to
  merge `main` through `merge-recovery.sh` and rewrite the `DELIVERED` record for the new head, and
  a handoff brief answers a pull request with no checks at all with
  `gh workflow run ci.yml --ref <branch>` rather than a close and reopen – both are rows in
  `.xezar/docs/model-routing.md` § 6. The leader rules – re-read a run's latest text before acting on
  a `continue` note, and grep `merges.md` and `gh pr list --search` before dispatching a flake fix a
  merged pull request has already rebuilt – are in `.xezar/docs/leader-guide.md`. The incidents and
  run ids behind them are a new dated entry in `model-routing.md` § 13.
