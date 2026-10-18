## 🐛 Fixes

- 🐛 **Alt+A and Alt+C quick replies only fire while the agent is waiting.** A running, queued or
  review thread keeps its composer enabled, and the shortcut there used to message the agent
  without being asked to.
- 🐛 **Screen readers hear a task's status change.** The run header now has one polite status
  region that says "Task status: needs you" (or the new word) when the status moves, and stays
  silent when a task is opened.
- 🐛 **A long live transcript no longer loses items after you load earlier history.** When the
  live tail is compacted, the thread keeps its older pages only if the new tail reaches them;
  otherwise it keeps the tail alone, and "Load earlier items" walks back through every skipped
  item in order.
