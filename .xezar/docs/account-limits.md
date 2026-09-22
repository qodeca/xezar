# Account limit probing and recovery

Xezar can run tasks under several Agent accounts (Settings → Agent accounts). None of them expose current usage to a project leader. This page is the recipe for finding a dead account by probing it, and for recovering the lane once you know.

## What cannot be read

- The MCP `project_config` tool's `get_account` action lists the accounts, not their usage. It answers `accounts` (the account each backend uses in this project), `profiles` (every account per backend, the one in use marked `selected` and the backend's own login marked `builtIn`) and `problems` (every stored account choice that names no account, with the line that fixes it; tasks still run, on the built-in login).
- `check_account_status` probes one account's sign-in state (`connected`, `disconnected`, `not-installed` or `unknown`) and `get_account_details` says who the account is signed in as. Both are served to a leader; neither carries a usage or quota field.
- The cockpit's "Connected" / "Check again" state is the same login check, not a quota check. An account can show "Connected" and still be over its limit.
- Claude Code itself only shows usage through the interactive `/usage` command, run per login, inside a terminal session. There is no headless command and no API for it.

So the only working signal is: dispatch a task under the account and see whether it runs.

## The probe

Send one tiny task per account, all in a single message so they run in parallel. Each is the built-in `quick-task` (no `source` field, so no kit, no gates, one agent step):

```
task_create {
  operationId: "probe-<handle>-<yyyymmdd-hhmm>",
  runner: "claude",
  model: "haiku",
  agentProfile: "<handle>",
  worktree: false,
  autonomous: true,
  generateFollowups: false,
  prompt: "Account limit probe. Do nothing else: run no tool, read no file, write nothing. Answer with exactly two lines: the first line `PROBE OK`, the second line `XEZ:DONE`."
}
```

Notes on the shape:

- `worktree: false` means no branch and no worktree to clean up later; the task still waits briefly for the repository-root lease.
- `haiku` and the two-line prompt keep the cost near zero: a few hundred tokens on a healthy account, nothing on a limited one.
- Never dispatch a probe to the leader's own login (see below).

Wait for the `task.done` / `task.failed` events; they normally arrive within a few seconds. Read a failed probe with `task_read` (`view: task` for the `error` field, or `view: history` for the first assistant item).

- `done` → the account works.
- `failed` with an error like `You've hit your session limit · resets 6:30pm (Europe/Warsaw)` → a 5-hour window limit, a short outage.
- `failed` with an error like `You've hit your weekly limit · resets Sep 19 at 6pm (Europe/Warsaw)` → the account is out for days.

Example (this machine, 2026-09-17): four accounts, handles `default` (`~/.claude`, the leader's own login), `qodeca-priv` (`~/.claude.qodeca.priv`), `gmail-priv` (`~/.claude.gmail.priv`) and `eqamana-priv` (`~/.claude.eqamana.priv`). A handle is the account label with every `.` turned into `-`.

## Recovery

1. Read the reset time from the error text itself, not from any schedule the engine shows you. See the known defect below.
2. For every failed probe, call `execution_control` `cancel_auto_resume` with that run's `runId` and `expectedVersion` (from `task_read`). Do this for a weekly limit and for every probe alike: a probe run must never be allowed to auto-resume on its own.
3. For a short session limit, if the reset is close, you can leave that lane idle until it resets. For a weekly limit, or any long wait, move the lane: re-dispatch the exact same brief on a different account (`agentProfile`).
4. Keep a table of account → state → reset time in the campaign note, and update it on every probe. That table is the record of the check; nothing else remembers it.
5. Run one lane per account. That way a single limited account stalls one lane, not the whole campaign.
6. If two accounts show the same reset minute, they are probably the same underlying login window, not two independent limits.
7. The leader's own login (`default`, `~/.claude`) never gets probe or work tasks. Probing it would spend the leader's own session on a check it does not need.
8. Re-probe only when you are about to rely on an account for a burst of work and are unsure of its state, or once its recorded reset time has passed. Do not probe on a fixed interval or in a loop.

## Known engine defect

The engine has scheduled a weekly-limit auto-resume one day early at least once (seen 2026-09-17: a "resets Sep 19" message produced a resume scheduled for Sep 18). Read the reset time from the error text, and always cancel auto-resume on a probe run rather than trusting the schedule. Tracked as [#581](https://github.com/qodeca/xezar/issues/581).
