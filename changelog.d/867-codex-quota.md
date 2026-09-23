## ✨ Features

- ✨ **Codex per-model weekly limits are shown.** A Codex login's plan limits now list each model's own weekly window, named by the model slug Codex reports, beside the login's own windows. A per-model limit never changes whether the login can work. (#867)

## 🐛 Fixes

- 🐛 **A Codex usage limit is reported as a usage limit.** A Codex turn that fails with the structured `usageLimitExceeded` or `rateLimitExceeded` error now fails the task with the limit and its reset time instead of "ended its turn without XEZ:DONE", marks that login out until the reset, and lets the existing auto-resume setting act on it. Other failed Codex turns are unchanged. (#565, #867)
