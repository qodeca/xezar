## 🐛 Fixes

- 🐛 **"Open in default app" works when xezar runs inside WSL.** An image from the diff pane went to
  `xdg-open`, which has no desktop inside WSL; it now opens through Windows Explorer with the
  Windows path, the same way "Open in → file manager" already did.

## 🔧 Changed

- 🔧 **A Continue refused because the engine still holds the task now carries a stable code.** The
  `409` from `POST /runs/:id/continue` adds `code: "run_still_active"` beside its unchanged
  message, and the cockpit and the MCP `execution_control` tool retry on that code instead of
  matching the sentence, so rewording the message can no longer break the short retry after an
  idle session closes.
