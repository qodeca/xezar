## 🐛 Fixes

- 🐛 **Alt+A and Alt+C quick replies only fire while the agent is waiting.** A running, queued or
  review thread keeps its composer enabled, and the shortcut there used to message the agent
  without being asked to. (#1120)
- 🐛 **Screen readers hear a task's status change.** The run header now has one polite status
  region that says "Task status: needs you" (or the new word) when the status moves, and stays
  silent when a task is opened. (#1120)
- 🐛 **A long live transcript no longer loses items after you load earlier history.** When the
  live tail is compacted, the thread keeps its older pages only if the new tail reaches them;
  otherwise it keeps the tail alone, and "Load earlier items" walks back through every skipped
  item in order. (#1120)
- 🐛 **A tab left open across an upgrade recovers by itself.** When a page's code file from the
  old build is gone, the cockpit reloads once (guarded so a real outage cannot loop), and the
  error page's Retry now reloads instead of repeating the failure. (#1120)
- 🐛 **The Tasks page says when it is loading or could not load.** It used to stay blank until
  the list answered, and blank for good when it failed; a failed "Archive finished" now shows the
  server's message too. (#1120)
- 🐛 **The ask card is readable and keyboard-friendly in the light theme.** "The agent is asking"
  is no longer pale lime on white, a picked option shows a check mark, and after you answer, focus
  lands on the answer summary instead of the top of the page. (#1120)
- 🐛 **Agent config edits are no longer thrown away without asking.** "Reload from disk", opening
  another file or agent, and leaving the page – by a link, Back or Forward, or the ⌘K palette –
  now confirm first when the open file has unsaved edits, and closing or reloading the tab asks too. A newer copy fetched in the background no longer replaces
  your draft. (#1120)
- 🐛 **Screen readers hear the composer's choices.** The runner, model, variants, base branch and
  project pills now say both the setting and its value ("Model: sonnet"), and the `/` and `@`
  suggestion list is announced as you move through it and when Enter inserts one. (#1120)
- 🐛 **On a phone the top bar says which project and which settings you are in.** A quiet line
  above the page name shows the project, and Global settings is titled as such instead of plain
  "Settings". A page outside the menu, such as New task, shows its own name. (#1120)
- 🐛 **A greyed-out composer control says why on screen.** The model, variants, Worktree and
  Autonomous controls used to explain a disabled state only in a hover tooltip, which a phone or a
  keyboard never shows; a short reason now sits beside them. (#1120)
- 🐛 **Switching projects no longer sends the old page's requests to the new project.** The
  project scope now changes only when the new project's page is actually shown, so the page you
  are leaving can no longer fetch, or cache answers, under the project you are opening. (#1120)
- 🐛 **Links in rendered Markdown are readable in the light theme.** Transcript, GitHub and skill
  links were pale lime on white (about 1.3:1); they now use the text colour with an underline. The
  dark theme is unchanged. (#1120)
- 🐛 **No more pale lime text in the light theme.** Selected-item check marks, the Workflows drop
  hint and the MCP "completed" mark now use the text colour on white, as links already do; the dark
  theme keeps the lime. (#1120)
- 🐛 **Readable green, red and violet text in the light theme.** Diff counts, check words, failed
  states and reference chips were too pale on white (2.5–3.8:1); the light theme now uses darker
  shades of the same colours (5.7–6.0:1), with white text on the red and violet badges and buttons.
  The dark theme is unchanged. (#1120)
