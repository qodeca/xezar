## 🔒 Security

- 🔒 **A task can no longer record a reviewer's verdict it was not asked to give.** A reviewer packet is now recorded only when the step that wrote it declares that role with the new `verdictRole` step key; a forged-role packet — say a `code-review` packet left by an ordinary `quick-task` — is refused with a named reason on the task's `verdictIssues` instead of overwriting the real reviewer's verdict. A custom workflow whose reviewing step should record a verdict must add `verdictRole: code-review` (or `design-review`, `qa`, `architecture-review`) to that step (`BACKWARD_COMPATIBILITY.md`). (#851)

## ✨ Features

- ✨ **`architecture-review` is a fourth verdict role.** It speaks a code review's words — APPROVE or REQUEST CHANGES — with the same finding severities, and keeps its own slot on the task beside the code review. The role list is now declared once in the contract and every verdict shape is built from it, so the MCP `task_create` `fromFindings.role` argument and the step `verdictRole` key accept it too. (#851)
