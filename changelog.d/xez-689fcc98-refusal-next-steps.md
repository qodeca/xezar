## ✨ Features

- ✨ **Every MCP refusal now says what to do instead.** A `project_config` action a leader may not
  take – connecting a provider, opening an account folder or the project in a desktop application,
  adding, cloning or removing a project, reading a home file – answers on the first call with
  `Next step: …` (and `nextStep` in the answer): a tool call the leader can make, or a command or a
  cockpit page to give the person. `discover_project` carries the cockpit's address as `cockpit`
  (the project page plus the providers, agent accounts and MCP connection pages) and the `health`
  tool as `cockpitUrl` – the running cockpit's real address, left out when it is not known, such as
  in hosted mode. `GET /api/v1/health` is unchanged. Starting a task on an agent that is disabled
  or not signed in names the fix the same way: `project_config set_provider_enabled` for a disabled
  one, `xez providers connect <provider>` for one that is not signed in, and the install command for
  one that is not installed. (#819)
- ✨ **`xezar providers connect <provider> [--account <id>]` signs an agent tool in from the
  terminal.** It opens a login terminal on the machine that runs xezar, the same sequence as
  **Connect** in the cockpit's Providers settings, and needs no running cockpit. It refuses in
  hosted mode before it reads or opens anything, and names the agent's own login command to run on
  the machine where it runs tasks. (#819)

## 🐛 Fixes

- 🐛 **A terminal command never carries a C1 control character.** An agent account folder holding
  one – such as U+009B, which a terminal reads as an escape sequence – is now refused like any other
  control character, so `xezar providers connect`, **Connect** and every other command xezar hands
  to a terminal answer with a refusal instead of writing that character to the terminal. (#819)

## 🔧 Changed

- 🔧 **`set_provider_enabled` says where it wrote.** Its answer adds `scope` – `machine`, or
  `project` when the project keeps its own setup (single-project mode) and the switch is saved in the
  project's own settings file – and `live: true`. Its argument descriptions no longer call the switch
  machine-wide in every layout. (#819)
