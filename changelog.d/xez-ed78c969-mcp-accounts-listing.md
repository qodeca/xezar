## ✨ Features

- ✨ **A project leader can read every agent account, the one in use, and any saved account choice
  that points at a missing account, through MCP.** `project_config` action `get_account` adds
  `profiles` – every account per agent, the built-in login marked `builtIn: true` and exactly one
  marked `selected: true`, the one this project's tasks run under – and `problems`, each stored
  choice that names no account with its raw handle and a one-line `fix`. The existing `accounts`
  list keeps its shape (one row per agent) and gains only `builtIn`; a saved choice that names no
  account now reads as the built-in login, which is what tasks really use, instead of the missing
  name. `discover_project` adds `onboarding.globalImport` (`state` done, declined or unknown, and
  `importable`, a count) in single-project mode – the same values the Agent accounts pane shows. No
  answer carries a label that looks like an e-mail address or an account's folder. (#819)
