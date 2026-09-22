## ✨ Features

- ✨ **Agent quota can now be refreshed safely.** Xezar performs bounded, zero-token Claude Code and Codex quota checks after startup, refreshes stale observations only while they are being viewed, and exposes the same hosted-safe answer through HTTP and `project_config check_quota`. (#867)
