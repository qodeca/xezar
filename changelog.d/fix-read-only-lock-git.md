## 🔒 Security

- 🔒 **Read-only steps now check git against an explicit list of reading subcommands.** The shared
  read-only command check (Codex and Qwen Code) refuses any git subcommand or global option it has
  not reviewed, and refuses the options and modes of the reviewed ones that run another program,
  write a file or change repository state. Ordinary reads such as `git status`, `git diff`,
  `git log`, `git grep`, `git branch --list` and `git config --get` keep working; the bundled hook
  programs are rebuilt with the new check. (#1109)
