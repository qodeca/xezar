## 🔧 Changed

- 🔧 **The agent-quota answer now has a frozen, shared contract before its runtime surfaces land.**
  Claude Code and Codex quota entries use one Zod-defined shape for the planned HTTP and MCP
  readers, with a committed byte fixture covering known, exhausted and unavailable quota data.
  This change adds the answer shape only; it does not add a route, a check process or cockpit UI.
  (#867)
