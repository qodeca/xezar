## 🔒 Security

- 🔒 **Health and repository answers no longer carry remote credentials, and health is
  same-origin only.** A remote URL with a user name and password or token embedded in it is
  sent and shown without them everywhere the service reports it (health, the repository view,
  the MCP tools), while a plain SSH account such as `git@` is kept. In hosted mode health's
  `repo.root` is the folder name only, matching `repoRoot`. `GET /api/v1/health` stops sending
  open CORS and private-network headers, which only the retired bookmarklet probe needed.
