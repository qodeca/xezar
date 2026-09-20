# Troubleshooting and FAQ

Use this page when a task will not start, the cockpit is unavailable, or you need to understand usage and local state. Start with the exact error in the terminal or task thread. Preserve task work before resetting data, and include the error and version when asking for help.

## To fix common failures

### A task says “worktree creation failed”

In a Git project, requested isolation fails closed: `worktree creation failed: …` is followed by “task stopped before workflow execution”. xezar marks the task failed instead of silently running it in your checkout.

Read the Git error after the prefix. Check the selected base branch and inspect `git status` and `git worktree list` in that project. Resolve the reported branch, path or permission problem before retrying. Do not delete an existing worktree directory without preserving its changes. If you deliberately want a task to edit the project checkout, start it with **Worktree** off; that changes where the task works, rather than repairing isolation.

### The port is busy

A normal launch starts from the port this project used last time (or the one you pinned), else `4321`, and then tries higher ports when the address is in use. Use the URL actually printed in the terminal. The [CLI reference](12-cli-reference.md#which-port-a-project-starts-from) lists the full order. If the whole search range is occupied, the error is `no free port in … on …; free one or pass --port <port>`.

Choose another starting port for one launch, or pin one for the project, for example:

```sh
xezar --port 4400
xezar projects port <id> 4400
```

A different error, `cannot listen on …`, includes the underlying listener error; changing ports is not a fix for every bind failure.

### “project data is already in use or its writer cannot be verified”

Use the existing cockpit, as the message recommends. One process owns a project's mutable run data; choosing another port or `XEZ_HOME` does not grant another writer access to the same project's `.local/xezar/`.

Stop the process that owns the project before starting a replacement. Do not delete an active writer claim to bypass the check. If the error specifically identifies a foreign-host claim, remove only that named claim file after establishing that the other machine no longer uses the directory. The error includes the claim path, recorded host and PID to help identify it.

### GitHub actions say “gh CLI not found”

The error says ``gh CLI not found — install it and run `gh auth login` ``. Install the GitHub CLI on the machine running xezar and sign in there. A `GITHUB_TOKEN` in that process's environment can supply credentials to `gh`; it does not replace the executable. For a draft PR, the related error is `gh not found — install the GitHub CLI and run …, or merge the branch locally`.

### A task hit a usage limit

When a failed, unarchived task has a saved agent session and a recognized reset time, automatic resume is enabled by default. The thread records `usage limit reached — resuming automatically at …`. The scheduled time includes a 30-second grace period after the parsed reset time; consecutive automatic attempts without a human turn are capped at 12.

Wait for the displayed resume time rather than repeatedly restarting the task. If the error has no recognized reset time, no session can be resumed, or automatic resume is disabled, the task stays failed. After resolving the provider limit, use **Continue** where available. The message `automatic resume cap reached (12) — continue this task manually` means the automatic attempts have stopped.

Global **Settings → Resources → Auto-resume after a usage limit** controls `resources.autoResumeOnUsageLimit`. It can start paid agent work again without a new click; turn it off if you want to decide when to resume.

### The browser shows a missing-cockpit hint

When the built cockpit is absent, the server logs ``xezar: the cockpit files (web/dist) are missing — reinstall xezar, or build the web interface when running from source`` and serves a hint page. From a source checkout, build the web assets:

```sh
npm run build:web
```

This is a checkout build command. The published package is meant to include the built cockpit; if an installed package shows the hint, include the installation method and version in a bug report.

## Does it send my code anywhere?

xezar keeps its run state on disk and has no xezar cloud service. It launches [agent backends](04-agent-backends.md) and passes them your task and working directory. Those agent CLIs communicate with their configured model providers; prompts and code an agent reads can therefore leave your machine. Check the provider and account you use before giving it sensitive work. “Local cockpit” is not a promise of offline model execution.

xezar itself also makes network requests. By default it loads the `qodeca/xezar-skills` team catalog from GitHub, checks npm for a newer xezar version, and can check and automatically update tracked installations of those skills. GitHub features use `gh` to communicate with GitHub. These are separate from the agent's model traffic; the skills updater is not the only network activity.

To disable automatic skill **application**, turn off **Update xezar-skills automatically** in global **Settings → Skills**. Alternatively, set `XEZ_SKILLS_AUTO_UPDATE=0` when no stored `skillsAutoUpdate` override is set; a stored value wins. Read-only update detection and team-catalog loading are separate, so this flag is not an offline switch. An explicit `skillsRepos: []` in project `.xezar/config.json` disables that project's team catalog.

## To read costs and tokens

The Tasks table reads dollar cost from `costUsd`. Its token cell shows input/output counts when supplied, falling back to the recorded `tokensUsed` total when directional counts are absent. A missing cost or usage value is not evidence that the task was free. These displays summarize the metrics recorded for the run; consult your provider account for billing.

If metrics are missing across the cockpit, check the server environment: `XEZ_HIDE_TOKEN_USAGE=1` hides token usage, `XEZ_HIDE_COST=1` hides cost, and `XEZ_HIDE_TOKEN_METRICS=1` hides both. These control display capabilities, not provider charges.

## To reset local state

Stop the cockpit and its task processes first. Preserve any task work you want to keep, including uncommitted changes in worktrees. Resetting is destructive to local history; it is not a routine fix for an individual failed task.

| Location | Reset scope |
| --- | --- |
| `<project>/.local/xezar/` | Project run history, transcripts, handoff notes and task worktree directories. Removing it loses that state. |
| `~/.xezar/` (or `XEZ_HOME`) | Workspace settings, project registry and agent-account records. Removing the whole directory resets that workspace state. |
| `<project>/.xezar/` | Maintained project kit. Keep it when resetting runtime state. |

Deleting only workspace `config.json` is not a reliable reset: xezar can restore a missing, empty or corrupt file from `config.json.bak`. A valid configuration with no projects is treated as your chosen state rather than overwritten from backup. See [Project layout](../project-layout.md) for the distinction between maintained files and runtime data.

## To get help

For a reproducible product problem, open a [GitHub issue](https://github.com/qodeca/xezar/issues). Include:

- `xezar --version`, your OS and installation method.
- The agent backend and whether `XEZ_DRY_RUN` was set.
- Whether the cockpit is local or hosted, and the smallest steps that reproduce the error.
- The relevant error text, with credentials and private content removed.

For a suspected vulnerability, follow [SECURITY.md](../../SECURITY.md) and report it privately through the repository's Security tab. Do not put vulnerability details in a public issue.

## Related settings / env / config

- `--port`, `--repo`: select the starting port and project; `--output lines` and `--log-level debug` show more of what the cockpit is doing in the terminal. See the [CLI reference](12-cli-reference.md#live-activity-in-the-terminal).
- Global **Settings → Resources**: `resources.autoResumeOnUsageLimit` in `~/.xezar/config.json`.
- Global **Settings → Skills**: `skillsAutoUpdate`, which overrides `XEZ_SKILLS_AUTO_UPDATE` when stored.
- `XEZ_HOME`, `XEZ_HIDE_TOKEN_USAGE`, `XEZ_HIDE_COST`, `XEZ_HIDE_TOKEN_METRICS`, `XEZ_DRY_RUN`: [environment contract](../../.env.example).
- [Security policy](../../SECURITY.md) and [project layout](../project-layout.md): boundaries and state locations.

Next: [User guide index](README.md)

Describes xezar 0.16.0.
