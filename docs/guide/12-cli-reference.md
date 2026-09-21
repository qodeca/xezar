# CLI reference

Use the CLI to start the cockpit, run a task in the terminal, scaffold a project kit, manage registered projects or connect a leader agent. This page describes the commands and flags accepted by the [CLI entry point](../../packages/xezar/src/index.ts).

## To start the cockpit: `serve`

```sh
xezar
xezar serve --repo /path/to/project --port 4321 --no-open
```

With no command, `serve` starts the server and browser cockpit. The default bind host is `127.0.0.1`. If the starting port is busy, xezar tries the next one: **50 candidates total**, the starting port through starting port + 49, including when `--port` is explicit. Other bind failures, or exhausting that range, fail startup. Use the URL printed after the server binds; when the port moved, the banner says which port was asked for.

### Which port a project starts from

Each project remembers the port its cockpit last listened on, so a bookmark keeps working and several projects can run side by side on one computer, each on its own port. The starting port is the first of these that is set:

1. `-p` / `--port` on the command line.
2. A port you pinned for the project with `xezar projects port <id> <port>`.
3. The `XEZ_PORT` environment variable.
4. The port this project last listened on.
5. `4321`.

A pinned port beats `XEZ_PORT` on purpose: a variable exported once in a shell profile must not pull every project to the same port. `--port 0` asks the operating system for any free port and is never remembered. A value that is not a whole number from 0 to 65535 stops the start with exit code 1 before anything is claimed. Remembering is best effort: when the workspace file cannot be written, the cockpit still starts and the terminal shows one warning.

### Live activity in the terminal

While the cockpit runs, the terminal shows what happens in the project: tasks queued, started, waiting for you, ready for review, finished, failed or cancelled; check steps that passed or failed; and failed cockpit requests. The boot banner and the `cockpit → <url>` line stay on standard output, unchanged. All activity goes to standard error, so `xezar serve | tee cockpit.out` still captures only the banner.

| Mode (`--output`) | What you see |
| --- | --- |
| `auto` (default) | A live table of active tasks above the activity lines on a terminal at least 60 columns wide; one line per event on a narrower terminal; plain lines when the output is a file, a pipe, CI or `TERM=dumb`. |
| `lines` | One line per event and no live table anywhere. Use this with a screen reader or for a log file. |
| `rich` | Asks for the live table. On a terminal narrower than 60 columns you get one line per event, as with `auto`, and no notice. When the output is a file, a pipe, CI or `TERM=dumb`, xezar prints one notice first and then writes plain lines: `event=output.fallback asked=rich using=plain` with the reason (`stderr is not a terminal`, `CI is set` or `TERM is dumb`). |

Plain lines are `key=value` records with a UTC timestamp, for example:

```text
2026-09-16T12:05:10.000Z level=error project=alpha event=gate.failed run=b98de765 step=unit-tests result_scope=stage exit=1 duration_ms=143118
```

Every line carries an `event=` name. Where the event is also something the project leader receives over MCP, the name is the same one the [MCP leader](13-mcp-leader.md) sees — for example `task.done`, `task.blocked`, `question.asked`, `gate.failed` or `verdict.posted` — so one search finds a fact in both places.

| Names shared with MCP | Meaning |
| --- | --- |
| `task.done`, `task.failed`, `task.cancelled` | The task finished with that outcome. |
| `task.blocked` | The task is waiting for input without a structured question. |
| `question.asked`, `question.answered` | The agent asked a question; someone answered it. |
| `result.ready` | The result is ready for review. |
| `gate.passed`, `gate.failed` | A check step settled. `result_scope` is `routine` or `stage`. |
| `task.stalled`, `task.resumed` | A step looks quiet or near its time limit (advisory); activity returned. |
| `verdict.posted` | A reviewer's verdict was recorded on the task. |
| `executor.available`, `executor.unavailable` | An agent provider can or cannot take work. |
| `config.changed`, `workflow.saved`, `workflow.deleted`, `agent-config.changed` | A change that affects how tasks run. |
| `goal.changed`, `instruction.added`, `instruction.queued`, `instruction.edited`, `instruction.removed` | A person changed a task's prompt or messages (shown at `debug`). |

Names for the terminal only: `task.queued`, `task.started`, `task.recovered`, `step.started`, `xezar.ready`, `xezar.stopping`, `xezar.stopped`, `session.summary`, `mcp.ready`, `mcp.unavailable`, `registry.port`, `registry.invalid`, `instance.mode`, `http.error`, `http.refused`, `http.repeated`, `output.fallback` and `output.folded`.

At start-up, `task.recovered count=<n> settled=<n>` is one aggregate about the previous session. `count` is every queued, waiting or running task found before recovery; `settled` is the originally waiting subset that recovery deliberately finished as done or ready for review. It is historical information, never a new per-task outcome, and it does not change the session's done, review, failed or cancelled totals. Under `--quiet` this information-level line is omitted.

Some lines come from the project's MCP event journal rather than from the task itself: an advisory that a step looks stalled (`task.stalled`, a warning followed by the line `still running — nothing was stopped` and the task link; nothing is stopped, unlike `task.blocked`, where the task really waits for you) and the matching `task.resumed`, a recorded reviewer verdict, an agent provider becoming available or unavailable, and configuration or workflow changes. These need the project's MCP service, which the cockpit starts on its own; when the terminal says `mcp · unavailable`, those lines are absent and everything else still works.

A check step marked `resultScope: routine` in its workflow prints its success at `debug` level only, because routine successes are not news; its failure is always an error.

| Flag | Environment | Effect |
| --- | --- | --- |
| `--output <auto\|lines\|rich>` | `XEZ_OUTPUT` | Presentation, as above. |
| `--color <auto\|always\|never>` | `XEZ_COLOR`, `NO_COLOR` | Colour. Every coloured state also has a written label. Files, pipes, CI and `TERM=dumb` never receive colour or cursor movement. |
| `--log-level <debug\|info\|warn\|error>` | `XEZ_LOG_LEVEL` | Lowest level shown. Default `info`. |
| `-q`, `--quiet` | `XEZ_QUIET=1` | Warnings and errors only. The banner shrinks to the cockpit URL, there is no live table, and failures are never hidden. |
| `--instance <project\|workspace>` | `XEZ_INSTANCE` | Which projects this cockpit serves. Default `workspace`. In `project` mode the boot prints one line saying so, and a request for another project answers with a pointer to that project's own cockpit. |

A flag beats a saved value in `~/.xezar/config.json` (`cli.output`, `cli.color`, `cli.logLevel`, `cli.instance`), and a saved value beats the environment variable. The [configuration reference](11-configuration-reference.md) has the exact rules. When you stop the cockpit, the terminal prints a short summary of what finished in this session and how many tasks are still running (not with `--quiet`).

`--no-open` suppresses browser opening. `--repo` selects the directory; otherwise the current directory is used. Inside Git, xezar resolves that directory to the repository root; outside Git, it uses the directory itself.

`--bind-host` changes the listening host. A non-loopback bind switches off local-machine handoffs. xezar has no built-in authentication: provide an authenticated reverse proxy and TLS for a hosted deployment. See [server installation](../server-install/README.md).

### To keep the setup in the project folder: `--single-project`

```sh
xezar --single-project
```

The folder you start in (its repository root, inside Git) owns its xezar setup: settings, agent accounts and the project registry live in `.xezar/`, working files in `.local/xezar/`, and `~/.xezar` is not opened. You need the flag only the first time; afterwards the folder decides, because `.xezar/workspace.json` exists, and every command started there is in the mode. A linked Git worktree, a folder under `.local/xezar/worktrees/` and your home directory are never a project root. Every command except `mcp` prints one line at start:

```text
  single-project mode — settings in <project>/.xezar, working files in <project>/.local/xezar
```

On the first run in a folder without `.xezar/workspace.json`, xezar asks once, in the terminal, whether to copy your global setup (`~/.xezar`, or `XEZ_HOME`) into the project, answered with `[y/N]`. Settings, agent accounts and GUI preferences are copied; your project list and the machine-scoped `browseRoot`/`projectsDir` roots are not, and nothing is kept in sync afterwards. When standard input or output is not a terminal, for example in a script or CI, nothing is imported and one line says so:

```text
  not a terminal, so nothing was imported from your global setup — starting <project>/.xezar with defaults
```

Two flags answer that question without being asked, so a script, a CI job or an IDE task can answer it too: `--import-global` imports, `--no-import-global` imports nothing. With either flag nothing is read from standard input, giving both refuses the start with exit code 1 and changes nothing, and giving neither keeps the question. A folder that is already set up is not imported into by a flag — a bootstrap script may therefore pass `--import-global` on every start: once there is nothing left to import the flag succeeds in silence, with the start's exit code unchanged. The copy is verbatim: each account's `label` and `configDir` are written as they are into `<project>/.xezar/agent-accounts.json`, which the repository may commit, so a bootstrap shared by a team should not pass `--import-global` when that file is committed. What this machine did is remembered in `<project>/.local/xezar/machine-state.json`, which Git ignores.

`xezar mcp` never asks. A folder that already holds `.xezar/workspace.json`, such as a clone, is never asked. A `.xezar/workspace.json` that is not valid JSON, or a state folder that cannot be written, stops the start with a named error and exit code 1. See [single-project mode](09-projects.md#to-keep-a-projects-xezar-setup-inside-the-project--single-project-mode) for what the mode changes and how it differs from `XEZ_SINGLE_PROJECT=1`.

### To ask for the global layout: `--global-layout`

```sh
xezar --global-layout
```

One launch, the global layout, even in a folder that carries `.xezar/workspace.json`. The folder normally decides, so this is the explicit answer for the other side: the run keeps its settings, accounts and registry in `~/.xezar` (or `XEZ_HOME`) and reads none of the project's committed state. `XEZ_GLOBAL_LAYOUT=1` says the same, and only the exact value `1` enables it. It is the counterpart of `--single-project` and outranks the marker; given both flags, the explicit global request wins. Nothing in the folder is moved, renamed or written, so it is safe to use in a checkout another process — a running cockpit, a peer agent — is serving. `XEZ_HOME` keeps its own meaning: it relocates the global state root and neither turns the layout on nor off.

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

With `--quiet`, `run` prints only the final status line and the agent's own errors instead of the full transcript.

The terminal waiter ends on those four task statuses. A task parked at `waiting` or `monitoring` is not a completed headless run; there is no follow-up text prompt in this command.

## To scaffold a kit: `init`

```sh
xezar init --repo /path/to/project
```

Creates `.xezar/workflows/fix-and-verify.yaml` and `.xezar/skills/project-conventions.md`, leaving existing examples untouched. Replace the example workflow's `echo` check with your real verification command. It also maintains `.local/.gitignore` for runtime state. See [Project layout](../project-layout.md).

It ends by naming the package as npm resolves it (`npx @qodeca/xezar`), the command that copies agent accounts in — `init` never copies them — and, inside a repository, the start that keeps the setup in the project folder.

## To copy your agent accounts into a project: `accounts import-global`

```sh
xezar accounts import-global
```

Copies the agent accounts of your global setup (`~/.xezar`, or `XEZ_HOME`) into a project that owns its own setup. It is the later door of the one-time import above, for the common case where the first run had nobody to ask, or was answered before you knew you wanted your accounts here.

It merges accounts only: `workspace.json` and `workspace-ui.json` are left alone, because a project may already carry committed ones. An account this project already has is kept exactly as it is, never replaced. A default account naming an account that does not exist is skipped and named, because nothing would use it. Running it twice adds nothing and rewrites no bytes. The output names account ids and providers only — never a label or a folder path. Each account's `label` and `configDir`, though, are copied exactly as they are into `<project>/.xezar/agent-accounts.json`: a label is often an identity (an e-mail address, a client's name) and a `configDir` is a path on this machine, and that file is one a repository may commit. A bootstrap shared by a team should therefore not pass `--import-global` when the file is committed. Exit code 0 when it ran, including when there was nothing to copy; 1 for an unknown verb, an unreadable accounts file, or a state file that is a symbolic link. In the global layout it prints one line and exits 0.

## To manage projects: `projects`

These commands edit/read the workspace registry directly and work without a running server. `XEZ_HOME` selects that registry, except in single-project mode, where the registry is the project's own `.xezar/workspace.json`.

| Command | Effect |
| --- | --- |
| `xezar projects` or `xezar projects list` | List registered projects. Missing roots are shown as `missing`; non-Git directories as `not a git repo`. |
| `xezar projects add [<dir>]` | Register the explicit directory; without one use the resolved `--repo`/current project. |
| `xezar projects remove <id>` | Remove the registry entry without deleting the repository. `rm` is an alias for `remove`. |
| `xezar projects tag <id> [<tag>…]` | Replace the project's grouping tags; omitting tags clears them. |
| `xezar projects port <id> [<port>]` | Pin the port the project's cockpit starts from; omitting the port clears the pin. See [Which port a project starts from](#which-port-a-project-starts-from). |

Use an ID from the listing for remove/tag. Registration rejects missing/non-directory paths, your home directory and task worktrees. Tags are trimmed, deduplicated case-insensitively and sorted; the first spelling is preserved. Successful commands return 0; usage errors, unknown IDs and refused registrations return 1.

With `XEZ_SINGLE_PROJECT=1`, listing is limited to the launch project and add/remove/tag/port are refused. In [single-project mode](#to-keep-the-setup-in-the-project-folder---single-project), listing shows the one project and add/remove/tag/port are refused with exit code 1 and the message `this project owns its xezar state; <action> is disabled`. CLI removal is a registry operation: it does not perform the cockpit's active-task removal check. Check your tasks before removing an entry.

## To connect an agent: `mcp`

Configure your agent to launch `xezar mcp` (or `npx -y @qodeca/xezar mcp`) in the project whose cockpit is already running. It is a stdio MCP bridge, not an interactive terminal command. It starts no cockpit server, opens no HTTP port, does not register projects and has no port setting: it finds the running cockpit through the project folder, whatever port that cockpit uses. Its standard output carries only MCP messages, whatever the output and colour settings say. Its tools are listed in the [MCP API reference](../features/mcp-server/mcp-api.md); setting up and attaching a leader is described in [MCP project leader](13-mcp-leader.md). The cockpit's terminal prints `mcp · ready` once the project's MCP service listens.

## To install, deploy or remove a hosted instance

| Command | Purpose |
| --- | --- |
| `xezar server-install --platform ubuntu-vps` | Interactive Ubuntu server-install wizard. |
| `xezar server-deploy` | Redeploy a version, reload the service and verify it. |
| `xezar server-uninstall` | Reverse a server installation. |

Use the [server-install guide](../server-install/README.md) for prerequisites and provider-specific procedures. On `ubuntu-vps` only, `--domain` selects a named instance; a new domain during install creates an independent instance. Deploy/uninstall can recover the platform from that instance's saved state.

## To look up every flag

| Flag | Applies to / meaning |
| --- | --- |
| `-p`, `--port <0..65535>` | `serve`: starting port, with retry above; without it, the order in [Which port a project starts from](#which-port-a-project-starts-from). `0` asks for any free port. `server-install`: explicit instance port; without it, a new named instance chooses a free port and never uses the remembered `serve` port. |
| `--output <mode>` | `serve`: `auto` (default), `lines` or `rich`. |
| `--color <when>` | `serve`: `auto` (default), `always` or `never`. |
| `--log-level <level>` | `serve`: `debug`, `info` (default), `warn` or `error`. |
| `-q`, `--quiet` | `serve` and `run`: warnings, errors and results only. |
| `--repo <dir>` | Project directory, default current directory (Git-root resolution above). |
| `--workflow <name>` | `run`: workflow name, default `quick-task`. |
| `--model <model>` | `run`: task model override. |
| `--no-open` | `serve`: do not open the browser. |
| `--instance <mode>` | `serve`: which projects this cockpit serves — `workspace` (the default: every project you have registered) or `project` (the project it started in; your other projects stay listed and manageable, and open in their own cockpit). `XEZ_INSTANCE` says the same, a saved `cli.instance` beats the variable, and this flag beats both. `--single-project`, and a folder that owns its xezar state, already serve one project and win over it — an explicit `workspace` then says so in one line. Accepted and ignored by `xezar mcp`. |
| `--single-project` | Every command: this folder owns its xezar setup — settings, accounts and the registry in `.xezar/`, working files in `.local/xezar/`, `~/.xezar` not opened. Needed only the first time; afterwards the folder decides. The first run asks once, in a terminal, whether to copy your global setup in (never the project list). A linked Git worktree is never a project root. See [above](#to-keep-the-setup-in-the-project-folder---single-project). |
| `--import-global` | Every command, single-project layout: answer the first-run import question with yes, without being asked. Nothing is read from standard input. On a folder that is already set up it imports nothing and is quiet, so a bootstrap may pass it on every start. In the global layout it prints one line. |
| `--no-import-global` | Every command: answer the same question with no. Giving both flags refuses the start with exit code 1, before anything is read or written. |
| `--global-layout` | Every command: resolve the global layout for this launch, even in a folder that carries `.xezar/workspace.json`. The explicit counterpart of `--single-project`, and it outranks the marker; nothing is moved, renamed or written. `XEZ_GLOBAL_LAYOUT=1` says the same. See [above](#to-ask-for-the-global-layout---global-layout). |
| `--platform <id>` | Server commands: `ubuntu-vps` or `macosx-ngrok`. Required for install; optional for deploy/uninstall only when saved instance state supplies it. |
| `--domain <host>` | `ubuntu-vps` server commands only: select the domain's instance; install can create a second independent one. |
| `--bind-host <host>` | `serve` / `server-install`: bind host, default `127.0.0.1`. |
| `--external-proxy` | Ubuntu server install: an existing proxy owns ports 80/443; install the service without nginx/certbot. That proxy must provide TLS and authentication. |
| `--yes` | Server commands: accept safe defaults; does not automatically authorize sudo. |
| `--reconfigure <ids>` | `server-install`: rerun comma-separated step IDs. |
| `--reinstall` | `server-install`: rerun every installation step. |
| `-h`, `--help` | Print help and exit. |
| `-v`, `--version` | Print only the package version and exit, without repository lookup or workspace writes. |

Flags are parsed globally, but only the command consumers listed above use them. An unknown top-level command prints an error/help and exits 1.

## Related settings / env / config

- [Environment contract](../../.env.example): backend paths, `XEZ_HOME`, `XEZ_SINGLE_PROJECT`, `XEZ_REMOTE`, mock mode, and the port and terminal-output variables `XEZ_PORT`, `XEZ_OUTPUT`, `XEZ_COLOR`, `XEZ_LOG_LEVEL` and `XEZ_QUIET`.
- [Troubleshooting](16-troubleshooting-faq.md) for a busy port or a cockpit that will not start.
- `.xezar/config.json` supplies project defaults; `~/.xezar/config.json` supplies registry and resource settings, or `.xezar/workspace.json` in single-project mode ([file locations](11-configuration-reference.md#to-find-where-the-files-live-in-each-layout)). [Project layout](../project-layout.md) explains maintained files and runtime state.
- [CLI source](../../packages/xezar/src/index.ts) and [projects command source](../../packages/xezar/src/workspace/projects-cli.ts).

Next: [MCP project leader](13-mcp-leader.md)

Describes xezar 0.16.0.
