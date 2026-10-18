## 🐛 Fixes

- 🐛 **A long agent session no longer grows the cockpit's memory with its stderr and tool calls.**
  The Claude Code, Codex and Qwen Code runners kept every byte the CLI wrote to stderr and a copy
  of every tool call's full input, though only the last three stderr lines are ever read and
  nothing read the copies. They now keep the newest 64 KB of stderr and no tool-call copies; tool
  calls still stream as events, and failure messages read as before.
