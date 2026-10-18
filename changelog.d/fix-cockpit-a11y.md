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
- 🐛 **A tab left open across an upgrade recovers by itself.** When a page's code file from the
  old build is gone, the cockpit reloads once (guarded so a real outage cannot loop), and the
  error page's Retry now reloads instead of repeating the failure.
- 🐛 **The Tasks page says when it is loading or could not load.** It used to stay blank until
  the list answered, and blank for good when it failed; a failed "Archive finished" now shows the
  server's message too.
- 🐛 **The ask card is readable and keyboard-friendly in the light theme.** "The agent is asking"
  is no longer pale lime on white, a picked option shows a check mark, and after you answer, focus
  lands on the answer summary instead of the top of the page.
- 🐛 **Agent config edits are no longer thrown away without asking.** "Reload from disk", opening
  another file or agent, and leaving the page now confirm first when the open file has unsaved
  edits, and closing the tab asks too. A newer copy fetched in the background no longer replaces
  your draft.
