## 🔒 Security

- Read-only Codex steps with a `bashAllowlist` now intercept `apply_patch` as well as Bash through
  the same shared command policy, and persist the hook's denial reason in the run event stream.
  Existing Bash-only xezar hook registrations are replaced and re-trusted without duplication.
- Maintained backend documentation now spells out compound-command behavior and the intentional
  difference between Claude Code's wrapper handling and the shared Codex/pi matcher. (#849, #863)
