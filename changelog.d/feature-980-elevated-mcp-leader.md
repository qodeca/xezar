## ✨ Features

- ✨ **Windows: an elevated xezar serves an elevated MCP leader.** When xezar and the leader's
  `xezar mcp` bridge both run as administrator, they now meet in their own administrators-only
  folder instead of MCP being unavailable. A cockpit and a leader that differ in elevation are still
  refused, now with a message that says so. An elevated xezar also attaches to a running Codex
  session as the leader; Codex's own folder is checked as private to you, as it is without
  administrator rights. Without administrator rights nothing changes. Restart a running leader
  session after upgrading: a bridge from an older version is refused with a message that names the
  version mismatch. (#980, #1197)

## 🔒 Security

- 🔒 **The elevated MCP folder lives where a normal process cannot reach it.** It is placed under a
  machine-owned `%ProgramData%\xezar` parent (not under your per-user state), with a per-user
  subfolder, so a process of the same user without administrator rights can neither rename the folder
  aside nor swap it. Every level is created with its access list already set and owned by
  Administrators; a level a normal user pre-created, or a link planted in the path, is refused rather
  than used, deleted or taken over, and the message names that folder and says an administrator can
  delete it. Each connection file is created owned by Administrators and private from its first
  moment, never owned by the account that runs xezar, and the engine and the bridge now prove the
  shared key to each other before either trusts the connection. The folder's drive is found without
  trusting the `%SystemRoot%` environment variable. (#980, #1197)
