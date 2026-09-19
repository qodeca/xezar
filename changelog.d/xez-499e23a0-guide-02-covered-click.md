## 🚀 CI/CD & Infrastructure

- 🚀 **The guide-02 browser spec's tab-strip clicks now go through the covered-click retry — and that
  retry can finally recognize the failure it exists for.** Three CI runs went red inside one hour —
  main 35451994733, PR #702 35451195569 and #706's neighbour — on
  `guide-02-running-a-task.e2e.ts` > "the Changes, Files and Commits tabs show the task's real
  worktree state", all three with `Element '@e13' is covered by <a.-mb-px.flex inside div#root> at
  its click point`, and all three green on re-run. The failing call was a bare
  `clickRole('link', 'Files')`; all four run-header tabs (`Session | Changes | Commits | Files`) now
  click through `clickRoleWhenStable`, because the tab that just became active re-renders with
  `font-semibold` and re-measures that row in one synchronous frame. The same run's log showed the
  retry could not have fired even with the helper in place: agent-browser writes its
  `success:false` JSON to STDOUT and exits 1, so the failure reaches the helper through
  `execFileSync`'s error, whose message names only the command — while the "covered by" phrase the
  retry matches on sits on that error's `stdout` property. The wrapper now carries the CLI's own
  payload into its message on that path too, and a unit case drives that real shape through the
  real `run()`. Test-only: no shipped behaviour changes.
