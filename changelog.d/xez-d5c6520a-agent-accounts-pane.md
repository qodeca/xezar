## ✨ Features

- ✨ **Settings → Agent accounts shows every agent at once, which login each one uses, and any saved
  choice that points at a missing account.** The four agents are stacked instead of tabbed, each
  with a one-line heading (installed, version, how many logins). The login tasks run under is marked
  "In use" in words ("Default" in the global layout, where it is the machine-wide choice); the
  server decides which one, the same way a run does, through a new additive `selected` flag on
  `GET /api/v1/workspace/agent-profiles`. The login each agent finds by itself is now called
  "Built-in login" instead of "Default" / "discovered", in the pane and in the Defaults picker. A
  saved default or project choice that names an account the list does not have is shown at the top
  of the pane and in its agent's group, with what tasks do instead and a one-click "Use the built-in
  login" fix. An account name that looks like an e-mail address is shown as "Name hidden" until you
  press Show details. In single-project mode the pane also says whether the accounts of your
  personal xezar setup were copied into the project and how many could still be — a count, never
  their names — with a "Copy {n} accounts" button that runs the same merge as
  `xezar accounts import-global`; it is refused in hosted mode. A project leader can run the same
  copy through MCP with `project_config` action `import_global_accounts` (it needs only an
  `operationId`), and `get_account` now reports the same import state. (#819)
