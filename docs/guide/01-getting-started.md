# Getting started

Use xezar to give coding tasks to an agent and follow its work in a browser. This page takes you from installing the command to opening your first task, with a mock-agent option for trying the cockpit before connecting an account.

## To check prerequisites

Have Node.js 20 or newer and npm available. Install Git to use isolated task branches and the Git views. For real agent work, install and sign in to a supported agent CLI: Claude Code, Codex, OpenCode or pi. GitHub features also need `gh`; `GITHUB_TOKEN` is the authentication fallback when `gh` is not signed in. You can start a local task without it.

## To install xezar

For a command you can reuse from any project:

```sh
npm install -g @qodeca/xezar
xezar --version
```

Or run it without a global installation:

```sh
npx @qodeca/xezar
```

The installed command also has the short name `xez`.

## To start the cockpit and choose a port

Open a terminal in your project folder and run:

```sh
xezar
```

This starts the server and opens the browser. The server binds to `127.0.0.1` by default and tries port `4321` first. If that port is occupied, it tries higher ports; use the URL printed in the terminal. You can choose a project and port explicitly, or stop the automatic browser opening:

```sh
xezar --repo /path/to/project --port 4322 --no-open
```

`xezar serve` is the explicit spelling of the same command. No `.xezar/config.json` is required, and xezar does not automatically load a `.env` file.

## To log in to an agent CLI

Run the login command for the CLI you installed in your own terminal, and complete its prompts:

| Agent | Login command |
| --- | --- |
| Claude Code | `claude auth login` |
| Codex | `codex login` |
| OpenCode | `opencode auth login` |
| pi | `pi /login` |

In the cockpit, open the project's **Settings → Agents** to check provider availability. Select the available agent in the new-task composer.

## To start your first task

1. Open **New task** in the project you want to work on.
2. Describe a small, concrete result, for example: “Explain how this project's tests run. Do not change files.”
3. Choose an available agent and model. Leave the skill/workflow selection empty for one plain agent step, or choose an existing workflow.
4. In a Git repository, keep **Worktree** on for an isolated checkout. Leave **Autonomous** off if you want the agent to pause for your answers.
5. Choose **Start** and send the task. Open its thread to follow the response.

![New-task composer with task options](../screenshots/0.15.0/new-task-dark-1280.png)

See [Tasks and runs](02-tasks-and-runs.md) for replies, review and task controls, and [Worktrees and Git](03-worktrees-and-git.md) for where changes go.

## To try without a login

In a POSIX shell, start the cockpit with the bundled mock agent:

```sh
XEZ_DRY_RUN=1 npx @qodeca/xezar
```

Create a task to see the mock event stream without invoking a real agent CLI. This exercises the cockpit, not a real model's ability to complete your task. Restart without `XEZ_DRY_RUN=1` when you want real agent work.

## To upgrade

Stop the running cockpit before starting the new version. For a global installation:

```sh
npm install -g @qodeca/xezar@latest
xezar --version
xezar
```

For an `npx` launch:

```sh
npx @qodeca/xezar@latest
```

## To find data or reset local state

| Location | What it holds |
| --- | --- |
| `<project>/.local/xezar/` | Task history, transcripts, handoff notes and task worktrees |
| `~/.xezar/` | Workspace settings, the project registry and agent-account records |
| `<project>/.xezar/` | Maintained project configuration, workflows and skills |

Before resetting, stop the cockpit and preserve any work you need from task worktrees. Removing a project's `.local/xezar/` discards its local task history and worktree directories. Use the [worktree cleanup controls](03-worktrees-and-git.md#to-set-retention-and-reclaim-now) first when you only need disk space.

For a workspace reset, remove the whole `~/.xezar/` directory, or the directory selected by `XEZ_HOME`. Removing only `config.json` can restore the registry from `config.json.bak`. xezar rebuilds runtime infrastructure on the next launch. Keep the project's `.xezar/` kit: it is maintained source, not disposable history.

## Related settings / env / config

- **Settings → Agents**: provider availability and project agent defaults.
- `--repo`, `--port`, `--no-open`: where and how the cockpit starts.
- `XEZ_DRY_RUN=1`: use the mock agent.
- `XEZ_HOME`: choose a different workspace-state directory.
- `.xezar/config.json`: optional project configuration. See the [environment contract](../../.env.example) for environment defaults.

Describes xezar 0.15.0.
