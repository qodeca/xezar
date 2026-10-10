## 🔧 Changed

- 🔧 **Windows is supported natively.** The install notes no longer say "in progress" or send
  Windows users to WSL. They list what Windows needs: the full Git for Windows (its Git Bash runs
  workflow check steps), long paths turned on, and xezar started without administrator rights for
  the MCP leader bridge. Attaching a running Codex session or a pi leader is not available on
  Windows yet. (#963)

## 🐛 Fixes

- 🐛 **The first health answer after start-up is immediate.** It reuses the agent and repository
  check xezar just made while starting, instead of starting every agent CLI a second time; the
  first cockpit load and the first leader call no longer wait seconds for it. (#963)
- 🐛 **Windows: xezar no longer freezes for about two seconds after start-up.** The first
  PowerShell a process starts holds its thread for one to two seconds while Windows creates it; xezar
  now starts PowerShell from a worker thread, so requests, the MCP leader and the cockpit keep being
  answered. (#963)
- 🐛 **Windows: a killed xezar no longer blocks the next start with "project data is already in
  use".** Windows reuses process IDs quickly, so the left-behind claim's ID could name an unrelated
  program. A claim now also records when its process started, and an ID that now names a later
  process no longer counts as the writer. Linux and macOS are unchanged. (#963)
