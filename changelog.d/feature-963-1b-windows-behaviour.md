## 🔧 Changed

- 🔧 **Windows: workflow check steps run in Git Bash, never in WSL.** A check step used to run the
  first `bash.exe` on PATH, which on a stock install is WSL's. It now runs Git for Windows' own
  bash with a plain `-c` (no login shell, so PATH and the temp folder stay Windows'), and a missing
  Git Bash fails the step with a message naming Git for Windows. Linux and macOS keep `bash -lc`.
  (#963)

## 🐛 Fixes

- 🐛 **Windows: stopping a check step stops what its shell started.** A program whose Git Bash
  parent had already exited (`nohup`, a subshell) was out of reach of the Windows process walk and
  kept running; the stop now also reads Git's own process list. (#963)
- 🐛 **Windows: a paused task's leftover programs are reported as stopped when they are.** The
  sweep named and stopped them with two PowerShell runs, which on a busy machine went past its
  10-second limit and reported a stop that had worked as "still running"; it now uses one. (#963)
- 🐛 **Windows: folder checks accept every spelling of the same folder.** A folder written in
  another letter case or as an 8.3 short name is recognised as inside the project or browse root;
  a look-alike sibling (`Root2` next to `Root`) is still refused. (#963)
- 🐛 **Windows: the read-only command lock reads Codex's PowerShell commands as PowerShell.** A
  read-only Codex task on Windows must pass a second, PowerShell reading of each command, and
  program names match with or without `.exe` and in any letter case. Linux and macOS are
  unchanged. (#963)
- 🐛 **Closing a project stops its background GitHub lookup.** The lookup and what it started are
  stopped and awaited, so the project folder can be removed at once on Windows; a cancelled lookup
  is never cached. (#963)
