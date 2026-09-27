## ✨ Features

- ✨ **Every 3.0.3 kit review verdict is recorded on the task.** An architecture review's CONFORMS,
  CONFORMS WITH FOLLOW-UPS and CONTRADICTS are accepted beside APPROVE and REQUEST CHANGES, and two
  new reviewer roles, `security-review` (NO FINDINGS AT THIS HEAD, FINDINGS, BLOCKING FINDINGS) and
  `acceptance-verification` (ALL CRITERIA MET, CRITERIA NOT MET), can be declared as a step's
  `verdictRole`. Before this their packets were refused, so the leader saw no verdict at all.
- ✨ **Workflows of up to 12 steps can be saved and run.** The cap was 8, so the 3.0.3 kit's
  nine-step `localisation` and `performance` workflows loaded but could not be saved again from the
  cockpit, the API or MCP. One contract constant, `WORKFLOW_MAX_STEPS`, now sets it everywhere.
