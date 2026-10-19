## 🐛 Fixes

- 🐛 **An agent that exits before reading a large first message no longer stops `xezar serve`.**
  When Claude Code or Qwen Code quit before reading a prompt larger than the pipe buffer, the
  failed write to its input took down the whole server and every running task. The step now fails
  on its own with the agent's exit code and error output, and a note records the failed write. A
  Windows pid file that cannot be removed when a shell exits is also left behind quietly instead
  of throwing.
