# Account limit reading and recovery

Xezar can run tasks under several Agent accounts (Settings → Agent accounts). This page is the recipe for reading a login's quota before dispatch, finding a dead account, and recovering the lane once you know.

## Reading quota before dispatch

Call the MCP `project_config` tool, action `read_quota` (optionally narrowed by `provider` – `claude` or `codex` – and `accountId`). Its `result.accounts` rows use `status: "ok"` when a login can work, `status: "out"` with `resetsAt` when a plan limit is exhausted, and `status: "unknown"` when xezar could not read the answer. Treat `unknown` as "could not read", never as "has budget" – an API-key login is `unknown` because it does not report plan limits. Route away from an `out` login until its `resetsAt`.

`read_quota` waits briefly for a stale reading. `check_quota` forces the same bounded, zero-token check explicitly; a login is checked at most once every five minutes, so a repeated `check_quota` on the same login inside that window returns the cached answer. Both actions accept the same optional `provider`/`accountId` filters and are the same quota answer the cockpit's **Settings → Agent accounts → Plan limits** block and plan-limits chip display.

**Probe tasks are retired.** Do not dispatch a tiny task to see whether an account is limited – `read_quota` answers that without spending a login's quota. A failed run still marks its login out on its own (the engine records the observation from the failure), so a dispatch that hits a limit is still useful signal, but it is never the way to check first.

## What `read_quota` cannot tell you

- The MCP `project_config` tool's `get_account` action lists the accounts, not their usage. It answers `accounts` (the account each backend uses in this project), `profiles` (every account per backend, the one in use marked `selected` and the backend's own login marked `builtIn`) and `problems` (every stored account choice that names no account, with the line that fixes it; tasks still run, on the built-in login).
- `check_account_status` probes one account's sign-in state (`connected`, `disconnected`, `not-installed` or `unknown`) and `get_account_details` says who the account is signed in as. Both are served to a leader; neither carries a usage or quota field – use `read_quota` for that.
- Claude Code itself only shows usage through the interactive `/usage` command, run per login, inside a terminal session. There is no headless command and no API for it; `read_quota` reads the same plan-limit facts xezar's own tooling observes, not that command's output.

## Recovery

1. Read the reset time from `resetsAt` on the `out` row, not from any schedule the engine shows you separately. See the known defect below.
2. For a failed dispatch that hit a limit, call `execution_control` `cancel_auto_resume` with that run's `runId` and `expectedVersion` (from `task_read`). Do this for a weekly limit and for a session limit alike: a limited run must never be allowed to auto-resume on its own.
3. For a short session limit, if the reset is close, you can leave that lane idle until it resets. For a weekly limit, or any long wait, move the lane: re-dispatch the exact same brief on a different account (`agentProfile`).
4. Keep a table of account → state → reset time in the campaign note, read fresh from `read_quota` before you rely on it. That table is the record of the check; nothing else remembers it.
5. Run one lane per account. That way a single limited account stalls one lane, not the whole campaign.
6. If two accounts show the same `resetsAt`, they are probably the same underlying login window, not two independent limits.
7. The leader's own login (`default`, `~/.claude`) never gets work tasks; there is no reason to read its quota either.
8. Re-read `read_quota` only when you are about to rely on an account for a burst of work and are unsure of its state, or once its recorded reset time has passed. Do not call it on a fixed interval or in a loop – `check_quota`'s five-minute floor exists precisely to stop that.

## Known engine defect

The engine has scheduled a weekly-limit auto-resume one day early at least once (seen 2026-09-17: a "resets Sep 19" message produced a resume scheduled for Sep 18). Read the reset time from `resetsAt`, and always cancel auto-resume on a limited run rather than trusting the schedule. Tracked as [#581](https://github.com/qodeca/xezar/issues/581).
