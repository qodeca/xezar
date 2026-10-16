## ✨ Features

- ✨ **A review task can be given the evidence of the task it checks.** Start a task with the new
  optional `evidenceFromRunId` (on `POST /runs` and the MCP `task_create` tool) and every agent
  step gets a read-only copy of that task's evidence files and handoff in its own run folder, plus
  the same files, size-limited, in its opening message. Claude Code, Codex and Qwen Code therefore judge
  the same evidence, and no step gains new read or write access. A truncated or missing file is
  named, so the reviewer can state it as a gap. Without the field, nothing changes. (#933)
