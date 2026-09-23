### 2026-09-23 — Codex hook proof kept the real profile immutable

- A production-runner proof against Codex 0.156.0 copied the active `CODEX_HOME`, isolated
  `XEZ_HOME`, and used a scratch repository under `/tmp`. The trusted `Bash|apply_patch` hook
  blocked an `apply_patch` file creation, and its shared refusal reached the v1 run stream as a
  `note`.
- Hashing both real `~/.codex*` profiles' `config.toml`, `hooks.json`, and `rules/` before and after
  gave byte-identical results. Keeping the profile clone and the xezar cache under the same
  disposable root made the proof exercise persistent registration and trust without touching the
  live profile.
