# Agent quota fixtures

Replies from the agent CLIs that the quota check (`src/workspace/agent-quota-checker.ts`) parses.
Personal data is replaced with neutral text: account ids, e-mail addresses, organisation names,
`session_id` and `uuid`. No file holds a token.

| File | What it is |
| --- | --- |
| `claude-default-usage.json` | A `/usage` text reply with session, weekly and model rows (the S0 sample). |
| `claude-qodeca-priv-usage.json` | A successful `/usage` text reply with no percentage rows. It must read as `unknown`, never `ok`. |
| `claude-usage-composition.json` | The usage-composition-only reply quoted in #893. It has no limit rows and reads as a failed check. |
| `claude-usage-2.1.280-session-started.json` | Real capture, Claude Code 2.1.280, 2026-09-23 (#893). This session has started, so every row has a reset time. |
| `claude-usage-2.1.280-session-unstarted.json` | Real capture, Claude Code 2.1.280, 2026-09-23 (#893). This session has not started, so it prints `Current session: 0% used` with no reset time. The weekly limits are at 100 %. |
| `claude-get-usage-control-response.json` | A `get_usage` `control_response` message from the stream-json output. |
| `claude-get-usage-nested-limits.json` | A `get_usage` reply with the typed limit list nested under `rate_limits` (#906). |
| `codex-account-rateLimits-read.json` | A Codex app-server `account/rateLimits/read` reply. |

Both 2.1.280 captures come from the argv the check runs:
`claude -p /usage --safe-mode --strict-mcp-config --output-format json`. It runs in an empty
temporary directory, with `CLAUDE_CONFIG_DIR` set to the login's config directory.
