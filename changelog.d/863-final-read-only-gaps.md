## 🔒 Security

- Read-only Codex steps with a `bashAllowlist` now intercept `apply_patch` as well as Bash through
  the same shared command policy, and persist bounded `PreToolUse` denial reasons in the run event
  stream without treating their command text as provider-auth failures. Xezar hook registrations
  marked inside the `codex-hook` cache are consolidated to one current entry and re-trusted.
- Maintained backend documentation now spells out compound-command behavior and the intentional
  difference between Claude Code's wrapper handling and the shared Codex/pi matcher. (#849, #863)
