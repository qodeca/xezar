## ✨ Features

- ✨ **Windows: the project leader connects over MCP.** On Windows the running xezar now serves its
  MCP connection on a named pipe with a fresh random name at every start. Its folder is made private
  to you, SYSTEM and Administrators, and every connection must first prove it holds the key stored
  there. A stale or foreign endpoint is never dialled. Linux and macOS keep their Unix socket. (#963)

## 🔧 Changed

- 🔧 **Windows: xezar's MCP connection is unavailable while xezar runs as administrator.** The
  status says so; start xezar without elevation. (#963)
- 🔧 **Windows: attaching to a running Codex session or a pi leader is not available yet.** Each
  attempt fails at once with a clear message instead of a socket error. pi and Codex as task backends
  are not affected. (#963)
- 🔧 **The MCP connection file is written atomically.** A reader never sees a half-written file, and
  on Windows the write retries a briefly locked file. (#963)
