## 🔒 Security

- 🔒 **Read-only shell policy is shared by Claude Code and pi adapters.** One module now owns the
  read-only signal, command-prefix rule, strict one-command parser and risky-argument table. pi
  applies the whole policy; Claude Code builds its Bash rules from the same entries and now loads
  user settings only on read-only steps, preventing project settings, hooks or skills from
  re-widening Bash. The five read-only workflows temporarily omit `git fetch`, `git diff`,
  `git show`, `git log` and `find`, whose risky arguments Claude cannot inspect until its hook
  adapter lands. Writing steps and zero-config defaults are unchanged. (#863)
