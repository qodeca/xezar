## 💥 Breaking

- 💥 **`GET /api/v1/health` is same-origin only.** It no longer sends open CORS or
  private-network headers, and the `health` WebSocket topic is readable only by the cockpit's own
  connection, so a script in a browser page on another origin can no longer read health. A
  native client (`curl`, the MCP bridge) is unaffected. `repo.remote` drops a user name and
  password embedded in the URL, and in hosted mode `repo.root` is the folder name only. Read
  health from a native client or from the cockpit's own origin. (#1111)

## 🔒 Security

- 🔒 **Health and repository answers no longer carry remote credentials, and health is
  same-origin only.** A remote URL with a user name and password or token embedded in it is
  sent and shown without them everywhere the service reports it (health, the repository view,
  the MCP tools), while a plain SSH account such as `git@` is kept. In hosted mode health's
  `repo.root` is the folder name only, matching `repoRoot`. `GET /api/v1/health` stops sending
  open CORS and private-network headers, which only the retired bookmarklet probe needed.
  The `health` WebSocket topic is now readable only by the cockpit's own connection, for the
  same reason. (#1111)
