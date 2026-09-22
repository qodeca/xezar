## 📝 Specs & Documentation

- 📝 **The user guide describes 0.18.0, and the two places it was most wrong are fixed.** All 17
  parts and the index said they described 0.16.0, two releases after the fact, which is why the
  drift below went unnoticed. `xezar init`'s generated workflow no longer has a placeholder `echo`
  check to replace — the guide and the CLI reference had a reader hunting for a block that does not
  exist — so both now describe what `init` actually writes, in both branches: `implement` → `verify`
  → `report` around a check it discovered (a real `test` script in `package.json`, or a `test`/
  `check` target in a `Makefile`), and `implement` → `verify` with `verify` as an agent review when
  it found none. Both pages also state the contract a consumer needs: the generated file is
  recognised by its step shape — the step ids, and the last step being an agent step — never by its
  bytes, so rewording its prose is safe and adding, renaming or reordering a step is a break.
- 📝 **The configuration reference documents `resources.gateSlots`, the `cli.*` keys and
  `XEZ_INSTANCE`.** `gateSlots` gets its range, the 1 an absent key derives, why it has no `null`
  where `memoryLimitMb` does (clearing it deletes the key rather than storing a number nobody
  chose), and that the lease it bounds is machine-wide across every project, checkout and layout —
  which is also why it appears in the project kit's list of settings that belong to the machine.
  The workspace `cli` keys and a registry row's own `cli.port` are described with their
  stored-beats-environment rule, and the CLI reference gains `xezar lease gates -- <command>` with
  `--status-file`, its 20-minute bound and its fail-open behaviour.
- 📝 **Agent accounts, the Skill catalog and 0.18.0's new leader reads are documented.** The agent
  backends and settings pages describe the pane as it now is — every agent stacked rather than
  tabbed, the login in use named in words, a saved choice pointing at a missing account reported
  with its one-click fix, and the single-project copy of your machine-wide accounts — and give both
  locations of `agent-accounts.json`. The skills and settings pages describe the Skill catalog
  block and each of its six states. The project-leader guide names `project_config` `list_models`,
  `get_account`'s `profiles` and `problems`, `import_global_accounts` and `check_skill_updates`, and
  `discover_project`'s `onboarding.globalImport`.
- 📝 **Getting started leads with the reader's outcome, and a release-checking trap is written
  down.** The first task now comes before the optional guided-setup material instead of behind 45
  lines of it, and the login section names `xezar providers connect`. Troubleshooting explains why
  "the tag exists but npm still shows the old version" is a normal publish rather than a failed
  one: npm's `latest` can lag the tag and the GitHub release, and a repository whose release stamps
  its own version keeps naming the previous one until the follow-up bump lands. Internal
  test-harness case ids and an HTTP-endpoint pointer are gone from the remote-access and workflows
  pages, and the README says outright that its upgrade sections stop at the release they name.
