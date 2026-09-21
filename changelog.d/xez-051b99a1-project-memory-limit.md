## ✨ Features

- ✨ **A project can set its own per-task memory limit in the cockpit.** Project Settings → General
  now has a **Per-task memory limit** field. A value there replaces the workspace limit for that
  project's tasks only, lower or higher, and applies straight away, to running tasks too; emptying
  it (or entering 0) removes the project's own limit so it uses the workspace one again. The key
  has been enforced since the per-repo limit came back, but until now only a hand edit of
  `.xezar/config.json` or the MCP could set it — and the Resources page told people to use a
  project control that did not exist. That hint now points at the real field. (#677)
