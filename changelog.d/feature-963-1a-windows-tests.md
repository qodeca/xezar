## 🐛 Fixes

- 🐛 **Windows: a config file swapped for a link after its check is refused.** Windows has no
  "do not follow links" open flag, so the agent-config reader now checks that the file it opened
  is still the plain file at that path. (#963)
- 🐛 **Windows: line endings, renames and folder sizes behave as on Linux and macOS.** A `.gitignore`
  or `info/exclude` saved with Windows line endings no longer gets a duplicate line; the MCP state
  writers and the server-install state replace files with the Windows retry; a worktree's size is
  measured without `du`; seeded personal files are handed to Git with `/` separators. (#963)
- 🐛 **Windows: path guards read both separators.** The `.git` folder check refuses the other names
  Windows opens as `.git`, the OpenCode directory check refuses a `..` written with `\`, and the pi
  worktree guard reads Windows path words and Git Bash `/c/…` paths. (#963)
- 🐛 **Windows: the login-shell PATH merge is skipped.** It could read WSL's Linux PATH and join it
  with `:`, which breaks every `C:\` entry. (#963)

## 🚀 CI/CD & Infrastructure

- 🚀 **Windows and macOS CI legs name a fixed Node major.** The matrix adds Node 24 next to Node 22
  (still informational), keeps `lts/*` as a canary only, and test folders are removed with Node's
  Windows retry, guarded by a scan test. (#963)
