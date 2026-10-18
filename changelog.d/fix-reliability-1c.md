## 🐛 Fixes

- 🐛 **A long agent session no longer grows the cockpit's memory with its stderr and tool calls.**
  The Claude Code, Codex and Qwen Code runners kept every byte the CLI wrote to stderr and a copy
  of every tool call's full input, though only the last three stderr lines are ever read and
  nothing read the copies. They now keep the newest 64 KB of stderr and no tool-call copies; tool
  calls still stream as events, and failure messages read as before.
- 🐛 **The memory limit on Windows no longer counts programs that are not the task's.** Windows
  keeps a process's parent id after the parent exits, so a long-running program whose parent had
  died before the agent got the same id was counted as the agent's child – and toward its memory
  limit. The live usage now counts only processes that started after the agent did.
- 🐛 **One stuck process-table read no longer switches off usage sampling for good.** A `ps` or
  PowerShell read that never returned left the sampler busy for the rest of the server's life,
  which also stopped the memory limit. Each read is now bounded at 10 seconds, and the next
  sample runs as usual.
- 🐛 **A long task's process record no longer fills up and stops recording.** The record xezar
  keeps of a task's programs on Windows and macOS, to stop them at a cancel or a pause, held at
  most 2,048 entries and never dropped programs that had exited, so a long task that ran
  thousands of short commands stopped recording new ones. A full record now forgets programs no
  read has shown alive for a minute – never the task's own agent process – and keeps proof for
  any live program one of them started.
