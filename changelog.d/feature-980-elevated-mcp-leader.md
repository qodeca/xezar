## ✨ Features

- ✨ **Windows: an elevated xezar serves an elevated MCP leader.** When xezar and the leader's
  `xezar mcp` bridge both run as administrator, they now meet in their own administrators-only
  folder (`ipc-admin`, next to `ipc`) instead of MCP being unavailable. A cockpit and a leader that
  differ in elevation are still refused, now with a message that says so. Without administrator
  rights nothing changes. (#980, #1197)

## 🔒 Security

- 🔒 **The elevated MCP folder admits only administrators.** Its access list names only SYSTEM and
  Administrators, it must be owned by Administrators, and an OWNER RIGHTS entry takes away a file
  owner's right to change its access list, so a process of the same user without administrator
  rights can neither write there nor plant a connection file. A folder not yet owned by
  Administrators is emptied before it is taken over. (#980, #1197)
