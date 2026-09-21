## ✨ Features

- ✨ **Answer the one-time import of your global setup with a flag, or run it later with a
  command.** `--import-global` and `--no-import-global` answer the first-run question without being
  asked, so a script, a CI job or an IDE task can answer it too — nothing is read from standard
  input, and giving both refuses the start before anything is read or written. `xezar accounts
  import-global` copies your agent accounts into a project that already owns its setup: it merges
  accounts only, never replaces one the project already has, never writes a default account that
  names no account, and adds nothing on a second run. A default naming no account is skipped and
  named on the first-run `--import-global` flag too, so both doors give the same guarantee. What
  this machine decided is remembered in the
  ignored `<project>/.local/xezar/machine-state.json`, so "declined", "nobody was asked" and
  "imported" are no longer the same state on disk. Without a flag the prompt is exactly what it was.
  (#819)

## 🔒 Security

- 🔒 **`xezar init` now names the package npm can actually resolve.** Its closing line said
  `npx xezar`, an unscoped name nobody publishes — so anyone could publish it and a person following
  our own instruction would run their code. Every line now names `npx @qodeca/xezar`, and `init`
  also says that it does not copy your agent accounts and which command does. (#819)
