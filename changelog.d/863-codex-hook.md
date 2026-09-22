## 🔒 Security

- Read-only Codex steps with a `bashAllowlist` now apply the shared command lock through a headlessly trusted `PreToolUse` hook on both start and resume, failing closed when Codex cannot grant that exact handler trust.
