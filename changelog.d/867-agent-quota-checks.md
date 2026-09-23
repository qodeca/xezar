## ✨ Features

- ✨ **Agent quota can now be refreshed safely.** Xezar performs bounded, zero-token Claude Code and Codex quota checks after startup, refreshes stale observations only while they are being viewed, and exposes the same hosted-safe answer through HTTP and `project_config check_quota`. (#867)
- 📝 **Quota checks document their real provider costs and compatibility.** Readers keep acting only on `status` when a future source or reason appears; a first Codex check may bootstrap that login's own local CLI state inside `CODEX_HOME`, without spending model tokens. (#867)
