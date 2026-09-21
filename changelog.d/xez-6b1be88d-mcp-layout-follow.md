## 🐛 Fixes

- 🐛 **An MCP client session started before the cockpit no longer needs a `/mcp` reconnect.**
  `xezar mcp` now re-resolves its folder's state layout each time it opens a session, so a bridge
  started before `xezar --single-project` created the folder's `.xezar/workspace.json` reaches that
  cockpit on its next call instead of answering "not a xezar project yet" until it is restarted.
  An explicit global layout still wins, and the socket is still found from the bridge's own
  folder. (#819)
