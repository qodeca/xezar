## 🐛 Fixes

- 🐛 **"Open in default app" works when xezar runs inside WSL.** An image from the diff pane went to
  `xdg-open`, which has no desktop inside WSL; it now opens through Windows Explorer with the
  Windows path, the same way "Open in → file manager" already did.
- 🐛 **The "take over interactively" line in a task's header now resumes on the right account.**
  The cockpit built it itself, without quoting the folder and without the session's account, so a
  folder with a space broke it and a task run under a second account resumed nothing. The server
  now builds it (`GET /runs/:id/resume-command`) with the same builder as the terminal launcher
  and its no-terminal fallback, quoted for the host's shell (`cd /d "…"` on Windows) and carrying
  the account. In hosted mode the line drops the folder and is not offered when it needs a named
  account.

## 🔧 Changed

- 🔧 **A Continue refused because the engine still holds the task now carries a stable code.** The
  `409` from `POST /runs/:id/continue` adds `code: "run_still_active"` beside its unchanged
  message, and the cockpit and the MCP `execution_control` tool retry on that code instead of
  matching the sentence, so rewording the message can no longer break the short retry after an
  idle session closes.
