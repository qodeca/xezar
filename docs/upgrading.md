# Upgrading from older releases

The [CHANGELOG](../CHANGELOG.md) is the complete record of every release, and it calls out each
breaking change. This page keeps a short upgrade note for each release that changed something you
may have to act on: 0.31.0, 0.30.0, 0.20.0, 0.16.0 and 0.15.0. Each breaking change, with its symptom
and the way forward, is recorded once in
[Backward compatibility § 9](../BACKWARD_COMPATIBILITY.md#9-recorded-breaking-changes); the notes
below point there instead of repeating it.

To see how far you have to read, compare the version you run with the one you would get:

```bash
xezar --version                 # the version you are on
npm view @qodeca/xezar version  # the version you would get
```

Then read the CHANGELOG from your installed version forward.

If you used the removed pi or OpenCode backends, xezar refuses to start while a stored setting
still names them, and lists each file and field to change. See
[Moving from pi or OpenCode](guide/18-moving-from-pi-or-opencode.md).

## Upgrading to 0.31.0

Two breaking changes, both for a cockpit reached from another machine or another web page. Local
use on your own machine is unchanged.

- **Health is same-origin only.** A script running in a browser page on another origin can no
  longer read `GET /api/v1/health`; a native client such as `curl` or the MCP bridge still can.
  The remote address it reports no longer carries an embedded user name or password.
- **A hosted cockpit narrows what a remote request may change.** It answers `403` to a host name
  it does not know, refuses to save the browse folder, the projects folder, the extra variables
  agents receive and the instance mode from a remote browser, and does not list hidden folders.
  List the public name in `XEZ_ALLOWED_HOSTS` or re-run `xezar server-install --domain`, and
  change those four settings on the machine that runs the cockpit.

The details are in
[Backward compatibility § 9](../BACKWARD_COMPATIBILITY.md#9-recorded-breaking-changes) and in
the CHANGELOG's 0.31.0 Breaking section.

## Upgrading to 0.30.0

The pi and OpenCode backends and leader clients are removed. While any saved setting or task
record still names `pi` or `opencode`, every command that saves settings or records refuses to
start and lists each file and field to change, and the cockpit does not open such a project.
Change each value to `qwen`, `claude` or `codex`, or remove it; stored data is never converted
for you. Follow [Moving from pi or OpenCode](guide/18-moving-from-pi-or-opencode.md), and see
[Backward compatibility § 9](../BACKWARD_COMPATIBILITY.md#9-recorded-breaking-changes) for the
full list of removed ids, variables and files.

## Upgrading to 0.20.0

- **Node.js 22 is the minimum.** Upgrade from Node 20 to Node.js 22 or the current LTS.
- **Setup runs the newer onboarding only.** A project last checked against the older setup
  templates is offered one re-check; a project that carries `.xezar/onboarding.json` reads as set
  up. See [To re-check after an update](guide/01-getting-started.md#to-re-check-after-an-update).
- **Windows only:** the project folder is spelled `C:\…` in health, the start banner and audit
  records; a team skill source on a network share is refused; and a workflow check step runs in
  Git for Windows' Git Bash rather than whichever `bash` is found first.

Each item, with its symptom and the way forward, is in
[Backward compatibility § 9](../BACKWARD_COMPATIBILITY.md#9-recorded-breaking-changes).

## Upgrading to 0.16.0

> pi and OpenCode, named in this section, were removed later, in 0.30.0 – see
> [Moving from pi or OpenCode](guide/18-moving-from-pi-or-opencode.md).

### Audit trail file

The audit trail is now `.local/xezar/audit.ndjson`, with a new record shape (#306). The old
`mcp-audit.ndjson` is read-only: xezar reads it only while the new file does not exist, prints one
deprecation line when it does, and never changes it. Keep it if you want the old history. xezar 0.15.0,
after a downgrade, reads its old file but cannot read records written by 0.16.0. xezar 0.31.0 still
reads the old name read-only; that reader is scheduled for removal in 0.33.0
([Backward compatibility § 5](../BACKWARD_COMPATIBILITY.md#5-configuration-and-state-files)), and the old
file is never deleted. The trail now records cockpit, automation and command-line changes
too, not only MCP; on a hosted server behind a custom reverse proxy, set `X-Xezar-User` to the
authenticated user (the bundled nginx site already does).

### Claude Code, pi and OpenCode runs and your own MCP servers

A task run started with Claude Code, pi or OpenCode no longer loads your own `xezar` MCP entry (#342) –
the same rule Codex runs have had since #324. This closes a real bug: xezar's bridge took your
project's one leader slot the moment it connected, so a task running in the project folder itself
(Worktree off) could hold that slot for its whole lifetime and refuse your own leader session with
"project occupied". Every other MCP server your project declares still loads, for every backend; your
config files are never edited. Two narrowings follow: a Claude Code task now sees only the MCP
servers your project's own `.mcp.json` declares, not the ones in `~/.claude.json`; and for pi and
OpenCode a server literally named `xezar` is switched off in tasks even when it belongs to you, so
rename an unrelated server of that name.
Migration: [Run each supported client as the project leader](guide/13-mcp-leader.md) § "To keep your leader while tasks run in the same folder".

### The sidebar is navigation-only now

The sidebar's task list, the Active/Archived toggle and the "Search… ⌘K" box are gone (#546); the
sidebar shows navigation only. Active/Archived and search now live on the Tasks pages – the
per-project Tasks page and the workspace-wide All tasks page – alongside pin/unpin, unread state
and diff stats, which already lived there; ⌘K still opens the command palette from anywhere, with
no sidebar click target needed.

### Single-project mode

A repository can now carry its own xezar setup so every clone runs the same way with no host setup
step: start `xezar --single-project` once in the project folder – its first run there also offers a
one-time import of your existing global `~/.xezar` setup. See
[Projects § single-project mode](guide/09-projects.md#to-keep-a-projects-xezar-setup-inside-the-project--single-project-mode).

### Hosted WebSocket migration

Hosted mode (`XEZ_REMOTE=1` or a non-loopback bind) now refuses all WebSocket upgrades, including
native clients without an Origin. Use the authenticated HTTP API and SSE event endpoints through
your reverse proxy; the cockpit already uses these transports remotely. Local-mode WebSocket
clients and the Vite development proxy are unchanged.

### MCP door for every registered project

Every project registered in the cockpit now gets its own MCP door, opened at boot and when the
project is registered (#557) – not only the one the cockpit started in. A leader started in a
second project can attach without restarting the cockpit inside that project's folder; nothing to
configure, and the starting project's connection, socket location and connection file are
unchanged. See
[Run a leader in each client](guide/13-mcp-leader.md#to-run-a-leader-in-each-client).

### A few more things to expect

- A pi task in its own isolated working copy (Git worktree) can no longer use its file tools to
  write or edit the repository's primary working copy, and a shell command that names that copy is
  refused (best effort, not containment). A pi task that needs the primary working copy on purpose
  must be created with Worktree off.
- A run xezar itself ends for the memory limit now finishes `failed`, not `done` – expect `failed`
  instead of a done run with no deliverable.
- In an autonomous run, the automatic re-prompt after a Continue on a workflow step still waiting
  for `XEZ:DONE` is capped at 3 attempts; once that step says `XEZ:DONE`, the remaining steps keep
  their usual budget. No flag restores the old 40-retry loop.
- The stdout line `recovered N run(s) from the previous session` is gone; a script that read it
  should instead read stderr's plain output and select `event=task.recovered`.

## Upgrading to 0.15.0

### Codex runs and MCP servers

A Codex run no longer loads the MCP servers, plugins or apps from your own Codex config (#324). To give
Codex runs a server, declare it in the project's own `.codex/config.toml`, trust the project in Codex,
and do not name it `xezar` (reserved for xezar's leader bridge). The run uses the project's settings
for it only: when `~/.codex/config.toml` declares the same server, its settings are left out (#1007).
A setting there that a run cannot leave out – an `env` entry or a `url`, for example – keeps the
server off for the run, and the run's note names it. A Codex CLI that cannot answer `config/read` fails the run – update it with
`npm i -g @openai/codex`.

### Team skills repository

The default team skills repository moved from `open-mercato/skills` (`om-*`) to `qodeca/xezar-skills`
(`xez-*`). A curated selection naming `om-*` keeps working. Move an `npx skills` install by hand:

```sh
npx skills remove om-fix om-code-review … -p   # every om-* name in skills-lock.json; -g for a global install
npx skills add qodeca/xezar-skills --skill '*'
rm -rf ~/.cache/xez/skills/open-mercato__skills .claude/skills/om-*   # optional: orphaned clone cache and copies
```

To keep the old collection, set `"skillsRepos": [{ "repo": "open-mercato/skills" }]` in `.xezar/config.json`
(loaded and enabled, no longer auto-updated).

### Agent config symlinks

Settings → Agent config no longer follows an individual config-file symlink: reads and writes answer
409 and the file is listed read-only (#363). Replace the link with a regular file; relocating a whole
agent home still works.

Describes xezar 0.31.0.
