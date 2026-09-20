## ✨ Features

- ✨ **A project leader can change the workspace settings over MCP.** `project_config`'s
  `set_workspace_config` used to exist only to refuse; it is now a real write and takes the same
  keys the cockpit's Settings panes write — the seven `resources.*`, `followups`,
  `agentEnvPassthrough`, `composerDefaults.*`, `skillsAutoUpdate` and
  `agentDefaults.{runner,models.*}`. It dispatches `PUT /workspace/config`, the cockpit's own
  route, so it gets the same bounds, the same refusals and the same "takes effect without a
  restart", and it answers in the same words `get_limits` answers in. These settings apply to
  every project on the machine, which is why the change is deliberate rather than incidental: it
  reverses a documented "never from MCP" decision on the owner's rule of 2026-09-20. The two
  workspace folder paths (`browseRoot`, `projectsDir`) are still not accepted. (#677)
