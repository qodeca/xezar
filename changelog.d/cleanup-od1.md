## 🔒 Security

- 🔒 **An MCP session now stops at a replaced project folder.** Each MCP session is bound to its
  project folder when it opens, and xezar checks that folder again before every tool call. If the
  folder was deleted, moved, re-created at the same path or swapped for a link, the call is refused
  with "the project folder this MCP session is bound to is missing". Before this, the cockpit kept
  serving the folder from its cache. Reconnect from the project folder to start a new session. (#1169)
