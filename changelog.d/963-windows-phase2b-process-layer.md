## 🔒 Security

- 🔒 **Windows: a folder name or a link can no longer run extra commands when xezar opens a
  terminal or a browser.** These go through the Windows command processor (cmd.exe), which acts on
  characters such as `&` and `%` in a name. xezar now checks every part first and opens nothing
  when one would be acted on: the cockpit shows the command to copy instead, and a link is printed.
  Folder names with spaces, commas, apostrophes or non-English letters still open, in Windows
  Terminal too. A session that runs under a second agent account opens in the classic console
  window instead, because Windows Terminal would drop the quotes around that account's folder and
  point the window at the wrong account. Linux and macOS are unchanged. (#963)
- 🔒 **Windows: a PATH entry that depends on the current folder no longer finds programs.** An
  entry such as `.` or `node_modules\.bin` finds a different program in each folder a task runs
  in, so xezar skips it when it looks for a program to start; list the full folder in PATH
  instead. Linux and macOS are unchanged. (#963)

## ✨ Features

- ✨ **On Windows, `xezar serve` shuts down cleanly with Ctrl+C, Ctrl+Break or by closing its
  window.** Each one saves xezar's state and stops the programs it started, within a few seconds,
  and tasks that were running carry on when xezar starts again, as on Linux and macOS. Closing the
  window gives xezar only about 5 seconds, which on a busy machine may not be enough to stop
  everything, so prefer Ctrl+C or Ctrl+Break. Before,
  Ctrl+Break and closing the window ended xezar without saving. `xezar lease gates` also passes
  Ctrl+Break and a closing window on to the command it runs. (#963)
- ✨ **A task paused for its memory limit, cancelled or stopped at its time limit now also stops the
  background programs it started, such as dev servers, and names them in the task.** xezar stops only
  programs it can prove the task started, never by name or folder. When it cannot confirm which
  process is the task's agent, it says so in the task rather than skipping the cleanup silently.
  This is a cleanup, not a sandbox; on macOS a program that detaches and loses its parent within
  about two seconds can be missed. (#943)

## 🐛 Fixes

- 🐛 **On Windows, agents installed with npm, dry runs and `npm` or `npx` commands now start.**
  Windows cannot start an npm command (`.cmd`) or a script file on its own, so these failed at
  once. xezar now runs the program behind an npm command directly, without the command processor
  (cmd.exe), and runs a `.js` or `.mjs` file with Node, so `XEZ_DRY_RUN=1` and an agent path that
  names a script work too. Any other `.cmd` or `.bat` file starts only when every argument is
  plain text; otherwise xezar refuses it with a message that names the file and the argument's
  position, never its value. Linux and macOS are unchanged. (#963)
- 🐛 **On Windows, stopping an agent also stops the programs it started.** Windows does not end a
  program's children with it, so a stopped agent could leave its tools running. xezar now stops
  them too, checking each one's start time so an unrelated program is never touched, and a stop
  xezar made no longer reads as an agent error. Linux and macOS are unchanged. (#963)
- 🐛 **A sign-in check that hangs now stops everything it started within about 12 seconds.**
  Before, xezar stopped only the agent's own command when its sign-in check timed out, so a
  background program that command had started kept running. (#894)

## 🔧 Changed

- 🔧 **xezar keeps running when a Codex session ends while xezar is still writing to it.** On
  every system, that failed write could end xezar with an unhandled error; now only the request
  waiting on it fails. (#963)
- 🔧 **On macOS, xezar reads the process list in the standard C locale.** Start times and CPU
  figures now read the same whatever the system language; Linux and Windows are unchanged. (#943)
