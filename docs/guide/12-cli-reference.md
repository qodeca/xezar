# CLI reference

Use the CLI to start the cockpit, run a task in the terminal, scaffold a project kit, manage registered projects or connect a leader agent. This page describes the commands and flags accepted by the [CLI entry point](../../packages/xezar/src/index.ts).

## To start the cockpit: `serve`

```sh
xezar
xezar serve --repo /path/to/project --port 4321 --no-open
```

With no command, `serve` starts the server and browser cockpit. The default bind host is `127.0.0.1` and the starting port is 4321. If that port is busy, xezar tries the next one: **50 candidates total**, the requested port through requested port + 49, including when `--port` is explicit. Other bind failures, or exhausting that range, fail startup. Use the URL printed after the server binds.

`--no-open` suppresses browser opening. `--repo` selects the directory; otherwise the current directory is used. Inside Git, xezar resolves that directory to the repository root; outside Git, it uses the directory itself.

`--bind-host` changes the listening host. A non-loopback bind switches off local-machine handoffs. xezar has no built-in authentication: provide an authenticated reverse proxy and TLS for a hosted deployment. See [server installation](../server-install/README.md).

## To run a task headlessly: `run`

```sh
xezar run "Explain the failing test and fix it"
xezar run "Review the parser" --workflow quick-task --model sonnet
```

`run` executes a workflow without starting the HTTP server. `--workflow` selects a loaded workflow by name, defaulting to `quick-task`; `--model` supplies a task model override. Choose a model appropriate to that workflow's backend. The command checks required providers, streams agent/check output in the terminal and persists the task so it can be inspected in the cockpit later. Workspace resource limits still apply.

| Result | Process exit code |
| --- | --- |
| `done` | 0 |
| `review` | 0; changes remain ready for inspection on the task branch/in the cockpit. |
| `failed` or `cancelled` | 1 |
| Missing task text, unknown workflow, or a required provider unavailable at preflight | 1 |

The terminal waiter ends on those four task statuses. A task parked at `waiting` or `monitoring` is not a completed headless run; there is no follow-up text prompt in this command.

## To scaffold a kit: `init`

```sh
xezar init --repo /path/to/project
```

Creates `.xezar/workflows/fix-and-verify.yaml` and `.xezar/skills/project-conventions.md`, leaving existing examples untouched. Replace the example workflow's `echo` check with your real verification command. It also maintains `.local/.gitignore` for runtime state. See [Project layout](../project-layout.md).

## To manage projects: `projects`

These commands edit/read the workspace registry directly and work without a running server. `XEZ_HOME` selects that registry.

| Command | Effect |
| --- | --- |
| `xezar projects` or `xezar projects list` | List registered projects. Missing roots are shown as `missing`; non-Git directories as `not a git repo`. |
| `xezar projects add [<dir>]` | Register the explicit directory; without one use the resolved `--repo`/current project. |
| `xezar projects remove <id>` | Remove the registry entry without deleting the repository. `rm` is an alias for `remove`. |
| `xezar projects tag <id> [<tag>…]` | Replace the project's grouping tags; omitting tags clears them. |

Use an ID from the listing for remove/tag. Registration rejects missing/non-directory paths, your home directory and task worktrees. Tags are trimmed, deduplicated case-insensitively and sorted; the first spelling is preserved. Successful commands return 0; usage errors, unknown IDs and refused registrations return 1.

With `XEZ_SINGLE_PROJECT=1`, listing is limited to the launch project and add/remove/tag are refused. CLI removal is a registry operation: it does not perform the cockpit's active-task removal check. Check your tasks before removing an entry.

## To connect an agent: `mcp`

Configure your agent to launch `xezar mcp` (or `npx -y @qodeca/xezar mcp`) in the project whose cockpit is already running. It is a stdio MCP bridge, not an interactive terminal command. It starts no cockpit server, opens no HTTP port and does not register projects. Its tools are listed in the [MCP API reference](../features/mcp-server/mcp-api.md).

## To install, deploy or remove a hosted instance

| Command | Purpose |
| --- | --- |
| `xezar server-install` | Interactive server-install wizard. |
| `xezar server-deploy` | Redeploy a version, reload the service and verify it. |
| `xezar server-uninstall` | Reverse a server installation. |

Use the [server-install guide](../server-install/README.md) for prerequisites and provider-specific procedures. `--domain` selects a named instance; a new domain during install creates an independent instance. Deploy/uninstall can recover the platform from that instance's saved state.

## To look up every flag

| Flag | Applies to / meaning |
| --- | --- |
| `-p`, `--port <n>` | `serve`: starting port, default 4321, with retry above. `server-install`: explicit instance port; without it, a new named instance chooses a free port. |
| `--repo <dir>` | Project directory, default current directory (Git-root resolution above). |
| `--workflow <name>` | `run`: workflow name, default `quick-task`. |
| `--model <model>` | `run`: task model override. |
| `--no-open` | `serve`: do not open the browser. |
| `--platform <id>` | Server commands: `ubuntu-vps` or `macosx-ngrok`. |
| `--domain <host>` | Server commands: select the domain's instance; install can create a second independent one. |
| `--bind-host <host>` | `serve` / `server-install`: bind host, default `127.0.0.1`. |
| `--external-proxy` | Ubuntu server install: an existing proxy owns ports 80/443; install the service without nginx/certbot. That proxy must provide TLS and authentication. |
| `--yes` | Server commands: accept safe defaults; does not automatically authorize sudo. |
| `--reconfigure <ids>` | `server-install`: rerun comma-separated step IDs. |
| `--reinstall` | `server-install`: rerun every installation step. |
| `-h`, `--help` | Print help and exit. |
| `-v`, `--version` | Print only the package version and exit, without repository lookup or workspace writes. |

Flags are parsed globally, but only the command consumers listed above use them. An unknown top-level command prints an error/help and exits 1.

## Related settings / env / config

- [Environment contract](../../.env.example): backend paths, `XEZ_HOME`, `XEZ_SINGLE_PROJECT`, `XEZ_REMOTE` and mock mode.
- `.xezar/config.json` supplies project defaults; `~/.xezar/config.json` supplies registry and resource settings. [Project layout](../project-layout.md) explains maintained files and runtime state.
- [CLI source](../../packages/xezar/src/index.ts) and [projects command source](../../packages/xezar/src/workspace/projects-cli.ts).

Describes xezar 0.15.0.
