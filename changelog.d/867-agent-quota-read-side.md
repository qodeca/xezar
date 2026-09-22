## ✨ Added

- ✨ **Agent quota observations are now readable by clients and project leaders.** Xezar stores
  Claude Code and Codex quota observations per login, learns live and failed-run limits, and serves
  the shared contract through `GET /api/v1/workspace/agent-quota`, `project_config read_quota`, a
  local WebSocket topic, and a hosted SSE change hint. Active checks and refresh remain follow-up
  work; this read side starts no new process. (#867)
