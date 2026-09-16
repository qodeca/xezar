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

## To let an agent set up this project (optional)

On a fresh project's Tasks page, xezar can offer a guided setup: "New to this project? An agent can look at it and prepare the files it needs, and it shows you every change before anything is written." Choose **Set up this project** to start it — the button only appears once an agent backend is available; without one xezar says so instead: "Setup unavailable — no agent backend was found. Install Claude Code, Codex, OpenCode or pi, sign in, then open this page again."

The setup task looks at what is already there — existing guidance, conventions and decisions — and adapts to that instead of replacing it. It asks you only what it cannot tell from the project itself: your domain (software, a campaign, research or something else), the outputs you want, whether you are working independently or with a project leader, which client to configure if that is ambiguous, a base branch only in a Git project with an ambiguous default, and whether to use the default team-skills source, a custom one, or none. Each question offers two options, the recommended one first, plus room for your own answer.

Before writing anything, it shows you a per-file preview of every change. Applying happens in the task's own isolated copy of the project, the same as any other task — see [Worktrees and Git](03-worktrees-and-git.md) — so nothing touches your working tree until you review and accept the result. The task's own result is the report: which files changed, which checks passed, failed, were unavailable or were not run, and a numbered list of what is left for you to do, such as integrating the change, signing in to a client, or attaching a project leader (see [MCP project leader](13-mcp-leader.md)).

Setup only ever touches project files — `.xezar/config.json`, an optional agent-pipeline file, one client instruction file such as AGENTS.md or CLAUDE.md, and a chosen client's own MCP snippet — never your machine-wide settings. See [Project kit](15-project-kit.md#to-add-an-optional-agent-pipeline) for the optional pipeline step, and setup itself is optional: you can create ordinary tasks without ever running it.

## To re-check after an update

When xezar or its bundled setup defaults change, and this project was already checked once, xezar offers a re-check instead of running anything on its own: a one-time notice above the Tasks page, and a state on **Settings → Project setup** that stays visible either way. Choose **Re-check now** to compare this project's files against the current defaults and preview the differences, or **Later** to dismiss the notice for this version — a re-check itself remains available from Settings at any time, and nothing is applied until you accept a preview.

**Settings → Project setup** shows the current state (Not set up yet, Set up, Changed since the last check, Re-checking, or Provenance unknown) plus three identities: **Last observed** (what is running now), **Last offered** and **Last successfully checked**. Only a check that finishes moves "Last successfully checked"; a cancelled or failed one leaves it where it was.

This history lives in `<project>/.local/xezar/onboarding-state.json`, disposable local scratch: deleting it only forgets when past checks happened, and a missing, empty or unreadable file degrades to "Not set up yet" or "Provenance unknown" rather than blocking anything.

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
- **Settings → Project setup**: guided-setup state and identities.
- `--repo`, `--port`, `--no-open`: where and how the cockpit starts.
- `XEZ_DRY_RUN=1`: use the mock agent.
- `XEZ_HOME`: choose a different workspace-state directory.
- `.xezar/config.json`: optional project configuration. See the [environment contract](../../.env.example) for environment defaults.
- `<project>/.local/xezar/onboarding-state.json`: disposable record of past guided-setup checks.

Next: [Tasks and runs](02-tasks-and-runs.md)

Describes xezar 0.15.0.
