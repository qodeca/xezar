#!/usr/bin/env node
import { projectDataDir } from './project-data-paths.ts';
import { projectKitDir } from './project-kit-paths.ts';
import { parseArgs } from 'node:util';
import { spawn, execFileSync } from 'node:child_process';
import type { Server } from 'node:net';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectEnvironment } from './core/backend-detect.ts';
import {
  ProviderAuthService,
  providerAuthChecksDisabled,
} from './core/provider-auth.ts';
import { applyProviderEnablement } from './core/provider-availability.ts';
import { runUnderGateLease } from './core/gate-lease.ts';
import { pruneOrphans } from './git-worktree.ts';
import { getRepoInfo } from './server/git.ts';
import { DEFAULT_WORKTREE_RETENTION, loadConfig, resolveWorktreeRetention } from './config.ts';
import { reclaimWorktrees } from './runs/retention.ts';
import { armRepoHandle } from './runs/arm-repo-handle.ts';
import { watchSetupCompletion } from './onboarding/watch.ts';
import { RunStore } from './runs/store.ts';
import { ownProjectData } from './runs/project-writer.ts';
import { RunManager } from './workflows/run.ts';
import { loadWorkflows } from './workflows/load.ts';
import { startServer, WorkspaceEventBus } from './server/server.ts';
// Type-only: erased at run time, so the MCP module stays a lazy import (N-07).
import type { ServiceDispatch } from './mcp/service-adapter.ts';
// Type-only imports inside, so this static import does not load the MCP module either.
import { followProjectDoors } from './mcp/project-doors.ts';
import type { McpJournalRow, ProviderStatus } from '@qodeca/xezar-contract';
import {
  ProviderRuntimeAuthObserver,
  recoverWithProviderRuntimeAuthObservation,
} from './server/provider-auth-runtime.ts';
import {
  providersRequiredByWorkflow,
  unavailableProviderMessage,
} from './server/provider-action-gate.ts';
import { checkForUpdate } from './update-check.ts';
import { detectInstallChannel } from './install-channel.ts';
import { printSkillsBanner } from './skills-banner.ts';
import { loadWorkspaceConfig } from './workspace/config.ts';
import {
  CliSettingsError,
  parseCliInvocation,
  resolveCliSettings,
  PORT_MAX,
  type CliInvocation,
} from './cli-settings.ts';
import {
  firstUnreservedPort,
  portsReservedByOtherProjects,
  readStoredCliSettings,
  rememberLastListen,
} from './workspace/port-memory.ts';
import { entry as activityEntry, startTerminalActivity, type TerminalActivity } from './terminal/index.ts';
import { recoverAndReport } from './terminal/recovery.ts';
import { formatDuration, formatTokens, glyphsFor } from './terminal/format.ts';
import { runMigrations } from './workspace/migrations.ts';
import {
  instanceBootLine,
  instanceModeInForce,
  registerProject,
  shouldRegisterProject,
  singleProjectNarrowing,
  singleProjectRegistry,
} from './workspace/projects.ts';
import { runProjectsCommand } from './workspace/projects-cli.ts';
import { cliAudit, PROJECTS_SUBCOMMANDS, projectResource, type CliAudit } from './cli-audit.ts';
import { WorkspaceSemaphore } from './workspace/semaphore.ts';
import { discoverProjectCheck, fixAndVerifyWorkflow, PROJECT_CONVENTIONS_SKILL } from './init-kit.ts';
import { resolveCapabilities } from './server/capabilities.ts';
import { recordOwnListen } from './server/instance-liveness.ts';
import {
  assertProjectStateUsable,
  resolveStateLayout,
  setActiveStateLayout,
  SingleProjectStateError,
  type StateLayout,
  stateLayoutBootLine,
} from './state-layout.ts';
import { createProjectStateFiles } from './workspace/config.ts';
import { npxCommand, readOwnName } from './own-package.ts';
import {
  accountImportLines,
  askInTerminal,
  firstRunImportLine,
  globalImportStateOf,
  importGlobalAccounts,
  IMPORT_FLAG_CONFLICT,
  IMPORT_IN_GLOBAL_LAYOUT_LINE,
  projectHasAccounts,
  repeatedImportLine,
  resolveImportDecision,
  runFirstRunImport,
  skippedDefaultLines,
} from './workspace/import-global.ts';
import {
  readGlobalImportState,
  recordGlobalImportState,
  type RecordedGlobalImportState,
} from './workspace/project-machine-state.ts';

const HELP =`xezar — local cockpit for AI agent tasks in any project folder

Usage:
  xezar                     start the cockpit (server + GUI) for the current repo
  xezar run "<task>"        run a task headless in the terminal
  xezar init                scaffold .xezar/ (example workflow + skill)
  xezar projects            list the projects this cockpit serves
                            (also: projects add [<dir>] · projects remove <id>
                             · projects port <id> [<port>])
  xezar accounts import-global
                            copy your global agent accounts into this project's
                            own setup (never overwrites one it already has).
                            Each account's label and config folder are copied
                            as they are, into a file the project may commit
  xezar providers connect <provider> [--account <id>]
                            open a terminal that signs an agent tool (claude,
                            codex, opencode or pi) in — the built-in login, or
                            the named account. Only on the machine that runs
                            xezar: hosted mode refuses it
  xezar mcp                 MCP bridge for a coding agent — the agent starts it
                            (stdio), in a project whose cockpit is running
  xezar lease gates -- <cmd>
                            run <cmd> holding one of this machine's gate slots,
                            so several checkouts do not run their full test
                            suites at once. How many run together is
                            resources.gateSlots (default 1). Bounded: after 20
                            minutes of waiting, or if the slot folder cannot be
                            written, it says so and runs <cmd> anyway.
  xezar server-install      interactive wizard to host xezar on a server
  xezar server-deploy       redeploy a new version (reload the service) + verify
  xezar server-uninstall    reverse a server-install

Options:
  -p, --port <0..65535>       cockpit port. Without it: this project's saved port,
                              then XEZ_PORT, then the port it last listened on,
                              then 4321 — and the next free one from there.
                              \`--port 0\` asks the OS for any free port.
                              (server-install: this instance's loopback port —
                              auto-picked per domain, never from serve memory)
      --output <mode>         serve activity: auto (default), lines, rich
                              lines   one line per event, no live table
                                      (use with a screen reader)
      --color <when>          auto (default), always, never (NO_COLOR honoured)
      --log-level <level>     debug, info (default), warn, error
  -q, --quiet                 warnings and errors only
      --instance <mode>       which projects this cockpit serves: workspace (the
                              default — every project you have registered) or
                              project (the project it started in; your other
                              projects stay listed and manageable, and open in
                              their own cockpit). A saved \`cli.instance\` beats
                              XEZ_INSTANCE; this flag beats both. --single-project
                              and a folder that owns its xezar state already serve
                              one project and win over it.
      --repo <dir>            repo to operate on (default: cwd)
      --workflow <name>       workflow for \`run\` (default: quick-task)
      --model <model>         model override for \`run\`
      --no-open               don't open the browser
      --single-project        this folder owns its xezar setup: settings, accounts
                              and the registry live in .xezar/, working files in
                              .local/xezar/, and ~/.xezar is not opened. Needed
                              only the first time — afterwards the folder decides.
                              That first run asks once, in a terminal, whether to
                              copy your global setup in (never the project list).
                              A linked git worktree is never a project root.
      --import-global         answer that question with yes, without being asked —
                              so a script, a CI job or an IDE task can import too.
                              Each account's label and config folder are copied
                              as they are, into a file the project may commit,
                              so do not pass it from a shared bootstrap.
      --no-import-global      answer it with no. Giving both refuses the launch;
                              giving neither keeps the question. After the first
                              run either flag only points at the command:
                              \`xezar accounts import-global\`.
      --global-layout         resolve the GLOBAL layout for this launch, even in a
                              folder that carries .xezar/workspace.json — the
                              explicit answer to "which layout", and the
                              counterpart of --single-project. XEZ_GLOBAL_LAYOUT=1
                              says the same; XEZ_HOME still only relocates the
                              global state root and neither turns the layout on
                              nor off. Nothing is written or renamed.
      --platform <id>         server-install target (ubuntu-vps | macosx-ngrok)
      --domain <host>         server-install (ubuntu-vps): host a SECOND, independent
                              cockpit for this domain (own nginx site + service + port).
                              A new domain never resumes/clobbers the first install.
      --external-proxy        server-install (ubuntu-vps): the box ALREADY has a
                              reverse proxy owning :80/:443 (Dokploy/Traefik, Coolify,
                              Caddy, your own nginx). Installs the service only — no
                              nginx, no certbot. That proxy must provide TLS + auth.
      --bind-host <host>      host the cockpit binds (default 127.0.0.1). Use with
                              --external-proxy when the proxy runs in a container and
                              cannot reach loopback (e.g. docker bridge 172.17.0.1).
                              xezar has NO built-in auth — never expose this publicly.
      --yes                   server-install: accept safe defaults (never auto-sudo)
      --reconfigure <ids>     server-install: force re-run of step id(s), comma-separated
      --reinstall             server-install: force re-run of every step (full reinstall)
  -h, --help                  show this help
  -v, --version               print the version and exit

Zero config: uses the agent CLI you are already logged in to (Claude Code, Codex,
OpenCode or pi), and \`gh\` only for GitHub features in a GitHub project.
Skills live in .ai/skills/, .xezar/skills/ and your team skills repo
(default qodeca/xezar-skills; override via .xezar/config.json);
workflows in .xezar/workflows/.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      // No `default` any more (#467): the fallback is no longer a constant but a
      // precedence chain that needs the registry, so "the flag was not given" has to
      // stay observable here. That also retires the argv sniff below.
      port: { type: 'string', short: 'p' },
      output: { type: 'string' },
      color: { type: 'string' },
      'log-level': { type: 'string' },
      quiet: { type: 'boolean', short: 'q', default: false },
      // Registered globally, like `--single-project`, because `parseArgs` is strict: a
      // subcommand that does not use the setting — `xez mcp` — must still ACCEPT the flag
      // rather than die on an unknown option (#467, spec § 3.3). PR 1 only resolves the
      // value; nothing reads it yet, and the help text lands with the behaviour in PR 2.
      instance: { type: 'string' },
      repo: { type: 'string' },
      // `xezar lease gates --status-file <path>` (#672). Registered globally for the same reason
      // `instance` is: `parseArgs` is strict, so a flag only one subcommand uses must still be
      // declared here or every other subcommand dies on it as an unknown option. Only
      // `leaseCommand` reads it.
      'status-file': { type: 'string' },
      // `xezar providers connect <provider> --account <id>` (#819 item 8). Global for the same
      // reason as `status-file`; only `runProvidersCommand` reads it.
      account: { type: 'string' },
      workflow: { type: 'string' },
      model: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      platform: { type: 'string' },
      domain: { type: 'string' },
      'bind-host': { type: 'string' },
      'external-proxy': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      reconfigure: { type: 'string' },
      reinstall: { type: 'boolean', default: false },
      // Registered so `parseArgs` accepts and documents it; the VALUE is read
      // from argv by `resolveStateLayout`, which owns the detection rule and
      // stays a pure function of `(cwd, argv, env)` so it can be tested
      // without a process. One source of truth for what the flag means, and
      // this entry is only what keeps `xez --single-project` from being an
      // unknown option.
      'single-project': { type: 'boolean', default: false },
      // The two answers to the first-run import question (#819 item 1a), registered globally for
      // the same `parseArgs`-is-strict reason as the flags around them. Node has no notion of a
      // negated boolean, so `--no-import-global` is its OWN option rather than the negation of the
      // one above — which is also what lets both being given be refused instead of last-wins.
      'import-global': { type: 'boolean', default: false },
      'no-import-global': { type: 'boolean', default: false },
      // The same arrangement for the flag that answers "global" (#657). The
      // value is read from argv by `resolveStateLayout`, which owns the
      // detection rule and stays a pure function of `(cwd, argv, env)`; this
      // entry is only what keeps `xez --global-layout` from being an unknown
      // option under `parseArgs`' strict default.
      'global-layout': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
    allowPositionals: true,
  });

  // server-install needs to know whether a port was actually asked for (explicit port wins;
  // otherwise a new named instance auto-picks a free one). With the `default` gone, the
  // parsed value answers that directly — no argv sniffing, and no `-p=` spelling to guess at.
  const portExplicit = values.port !== undefined;

  // `--bind-host ""` behaves exactly like the flag being absent (owner decision, #838 item A):
  // a script that passes an unset variable stays safe rather than exposing every interface.
  // Normalised ONCE, here, where the flag is parsed — `serveCommand`, `providersCommand` and
  // `serverCommand` below all read this same already-resolved value, so none of them re-decides
  // what `''` means on its own.
  const bindHost = values['bind-host'] === '' ? undefined : values['bind-host'];

  if (values.help) {
    console.log(HELP);
    return;
  }

  // Bare version string only — no banner, no update check, no repo lookup, so it
  // works outside any git repository and never touches ~/.xezar.
  if (values.version) {
    console.log(readOwnVersion());
    return;
  }

  // The import answer is resolved before anything else is read or written, for the same reason
  // the settings below are: a launch that says both "import" and "do not import" is a typo, and a
  // typo must touch nothing — not a state file, not the global home it names.
  const importDecision = resolveImportDecision({
    import: values['import-global'],
    skip: values['no-import-global'],
  });
  if (importDecision === 'conflict') {
    console.error(`error  ${IMPORT_FLAG_CONFLICT}`);
    process.exitCode = 1;
    return;
  }

  // Flags and environment are validated FIRST, before the registry is read, before the
  // project writer claim and before any listener (`multi-instance.md` § 9). A refused
  // invocation must touch nothing: `xez --port 43a1` is a typo, not a half-started cockpit.
  let invocation: CliInvocation;
  try {
    invocation = parseCliInvocation(
      {
        ...(values.port !== undefined ? { port: values.port } : {}),
        ...(values.output !== undefined ? { output: values.output } : {}),
        ...(values.color !== undefined ? { color: values.color } : {}),
        ...(values['log-level'] !== undefined ? { logLevel: values['log-level'] } : {}),
        ...(values.instance !== undefined ? { instance: values.instance } : {}),
        quiet: Boolean(values.quiet),
      },
      process.env,
    );
  } catch (err) {
    if (!(err instanceof CliSettingsError)) throw err;
    console.error(`error  ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const command = positionals[0] ?? 'serve';
  const cwd = resolve(values.repo ?? process.cwd());
  const repoInfo = await getRepoInfo(cwd);
  const repoRoot = repoInfo?.root ?? cwd;

  // WHERE this process keeps its state is decided here and nowhere else (#600
  // DC-1). This is the first point in the boot that knows which folder xezar
  // was asked to operate on, and it is deliberately ahead of every command:
  // `initWorkspace`, the registry read, the settings routes, the migrations and
  // the MCP bridge all resolve their paths through the layout installed below,
  // so none of them can read one layout and write another.
  //
  // The project ROOT decides, not the cwd, so a `xez` started in a
  // subdirectory of a single-project repository is in the mode too — which is
  // what "the folder you are in is your project root folder" means in a repo.
  const stateLayout = resolveStateLayout(repoRoot, process.argv.slice(2), process.env);
  try {
    // Q1: a project root whose `workspace.json` is corrupt or unwritable
    // refuses the boot with a named error, because degrading would silently run
    // this project off the user's global setup. The other three state files
    // keep their existing degrade-with-one-warning contracts.
    assertProjectStateUsable(stateLayout);
    setActiveStateLayout(stateLayout);
  } catch (err) {
    if (!(err instanceof SingleProjectStateError)) throw err;
    console.error(`error  ${err.message}`);
    process.exitCode = 1;
    return;
  }
  // The one boot line naming the mode and the state folder (FR-9.1). Not for
  // `mcp`: that command's stdout carries JSON-RPC frames for the agent, and a
  // human-readable line there is a protocol error, not a banner.
  // Not for `lease` either: its stdout is the wrapped command's stdout, and a banner in the
  // middle of a gate log is noise at best and a parse failure at worst. Its own lines go to
  // stderr, which is where a wait notice belongs.
  const modeLine = stateLayoutBootLine(stateLayout);
  if (modeLine !== null && command !== 'mcp' && command !== 'lease') console.log(modeLine);
  // What `init`'s closing lines need to know about this same launch (#825): the accounts line
  // exists to tell a person their agent accounts were NOT brought along, so a run that just
  // copied them — the prompt answered yes, or `--import-global` — must not print it and send
  // them to a command that already ran. The predicate is the copied FILE, not the outcome kind:
  // a global setup with no accounts file, or a project that already carried one, imported no
  // accounts and the line is still the truth there.
  let accountsImported = false;
  if (stateLayout.mode === 'project') {
    // The first-run ask (#600 FR-4.1, SP-5.1/5.2): a folder with no state yet
    // is asked, once, in the terminal, whether to copy the global setup in —
    // BEFORE the four files exist, so a decline writes nothing and a folder
    // that already holds `workspace.json` is never asked. `mcp` has nobody to
    // ask (its stdio is the protocol), so it imports nothing and says nothing.
    // `lease` joins `mcp` in having nobody to ask: it is spawned by a check script inside a gate
    // run, whose stdin is not a terminal, and a question there would hang the run rather than
    // being answered. Neither command writes project state of its own, so importing nothing
    // costs nothing.
    //
    // `accounts` is skipped entirely: the command IS the import, so a prompt in front of it would
    // ask a question the person already answered by typing it.
    const silent = command === 'mcp' || command === 'lease';
    if (command !== 'accounts') {
      // A flag (#819 item 1a) is the person's own answer and replaces the question, in every
      // command: `runFirstRunImport` never calls the ask, so stdin is not read even here.
      const outcome = await runFirstRunImport(
        stateLayout,
        silent ? async () => null : askInTerminal,
        process.env,
        importDecision,
      );
      // A bootstrap that starts the engine may pass `--import-global` on every start, so a folder
      // that is already set up says nothing at all once there is nothing left to import: no
      // prompt, no second copy, no error, and the launch's exit code is untouched.
      const importLine = silent
        ? null
        : outcome.kind === 'already-set-up'
          ? repeatedImportLine(stateLayout, readGlobalImportState(stateLayout))
          : firstRunImportLine(outcome, stateLayout);
      if (importLine !== null) console.log(importLine);
      // A default the import left out is named on its own line (#824), so a program reading this
      // output can tell "a default was skipped" from "there was nothing to skip". It is the same
      // line the `accounts import-global` door prints, from the same helper. Like `importLine`
      // above it is suppressed for `mcp` and `lease`, which own their stdout (#823 F7): the line is
      // routed off a channel that is not the boot's, never deleted — the ordinary boot and the
      // command door still print it, and a later `accounts import-global` re-derives it from the
      // global file, so a handle skipped by a silent launch is still named when someone asks.
      if (!silent) {
        for (const line of skippedDefaultLines(outcome)) console.log(line);
      }
      // What happened is remembered per machine (#819 item 1d), so "declined", "nobody was asked"
      // and "imported" stop being the same disk state. Best-effort by contract: a launch that
      // cannot record a report still starts.
      await rememberGlobalImport(globalImportStateOf(outcome), stateLayout);
      accountsImported =
        outcome.kind === 'imported' &&
        outcome.files.some((file) => file.to === stateLayout.accountsPath && file.outcome === 'copied');
    }
    createProjectStateFiles(stateLayout);
  } else if (importDecision !== 'ask' && command !== 'mcp' && command !== 'lease') {
    // A flag in the global layout: there is no project file to import INTO, and the global setup
    // is already what this launch runs on. One line, and the launch carries on.
    console.log(IMPORT_IN_GLOBAL_LAYOUT_LINE);
  }

  switch (command) {
    case 'serve':
      await serveCommand(repoRoot, invocation, !values['no-open'], bindHost, cliAudit('serve', repoRoot));
      return;
    case 'run':
      await runCommand(
        repoRoot,
        positionals.slice(1).join(' ').trim(),
        values.workflow,
        values.model,
        invocation.quiet,
        cliAudit('run', repoRoot),
      );
      return;
    case 'init': {
      initCommand(repoRoot, accountsImported);
      const audit = cliAudit('init', repoRoot);
      await audit.applied({ resource: projectResource(await audit.scope()) });
      return;
    }
    case 'projects':
      // Registry-only (no server, no HTTP) — see workspace/projects-cli.ts.
      // With the registry narrowed to one project a listing is a launch-context
      // read: register the boot repo through the normal self-healing path and
      // pin the output to that explicit identity. Mutations are left to their
      // own guards. EITHER narrowing qualifies (#600 SP-3.1) — the folder that
      // owns its xezar state is exactly as much "the one project" as
      // `XEZ_SINGLE_PROJECT=1` is, and registering it here is what puts its row
      // in `<project>/.xezar/workspace.json` now that `projects add` is refused.
      const projectArgs = positionals.slice(1);
      const isList = projectArgs.length === 0 || projectArgs[0] === 'list';
      const bootProjectId = singleProjectRegistry() && isList
        ? await initWorkspace(repoRoot)
        : undefined;
      // One audit record per VALID subcommand (#306 part 2); an unknown word gets none.
      const projectsCommand = PROJECTS_SUBCOMMANDS[projectArgs[0] ?? 'list'];
      process.exitCode = await runProjectsCommand(projectArgs, {
        defaultRoot: repoRoot,
        bootProjectId,
        ...(projectsCommand ? { audit: cliAudit(projectsCommand, repoRoot) } : {}),
      });
      return;
    case 'lease': {
      process.exitCode = await leaseCommand(positionals[1], process.argv.slice(2), values['status-file']);
      return;
    }
    case 'accounts': {
      process.exitCode = await accountsCommand(positionals[1], stateLayout);
      return;
    }
    case 'providers': {
      // No server: the person at the host's terminal is the one the refused MCP action names.
      const { runProvidersCommand } = await import('./providers-cli.ts');
      process.exitCode = await runProvidersCommand(positionals.slice(1), values.account, {
        cwd: repoRoot,
        bindHost,
      });
      return;
    }
    case 'mcp': {
      // The MCP bridge (#86, D-01): stdio for the client, the project's socket for
      // the running service. Starts no server, opens no port, registers nothing —
      // so no `initWorkspace` here. Lazy, like server-install below.
      const { runMcpCommand } = await import('./mcp/index.ts');
      const audit = cliAudit('mcp', repoRoot);
      let recorded: Promise<void> | undefined;
      await runMcpCommand({
        repoRoot,
        version: readOwnVersion(),
        // The first `session/open` is the command's effect boundary; later reconnects are not new invocations.
        onSessionOpen: (outcome) => {
          recorded ??= audit
            .scope()
            .then((scope) =>
              outcome.kind === 'owner'
                ? audit.applied({ resource: projectResource(scope) })
                : audit.refused(outcome.reason, { resource: projectResource(scope) }),
            );
        },
      });
      await recorded;
      return;
    }
    case 'server-install':
      await serverCommand('install', repoRoot, values.platform, cliAudit('server-install', repoRoot), {
        yes: Boolean(values.yes),
        reconfigure: values.reconfigure,
        reinstall: Boolean(values.reinstall),
        domain: values.domain,
        // server-install keeps its OWN port semantics: an explicit port, or a port this
        // installer picks per domain from its own state. `serve`'s memory never reaches
        // here — a hosted instance's port belongs to its systemd unit and its nginx site.
        port: portExplicit ? invocation.flagPort : undefined,
        externalProxy: Boolean(values['external-proxy']),
        bindHost,
      });
      return;
    case 'server-deploy':
      await serverCommand('deploy', repoRoot, values.platform, cliAudit('server-deploy', repoRoot), {
        yes: Boolean(values.yes),
        domain: values.domain,
      });
      return;
    case 'server-uninstall':
      await serverCommand('uninstall', repoRoot, values.platform, cliAudit('server-uninstall', repoRoot), {
        yes: Boolean(values.yes),
        domain: values.domain,
      });
      return;
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

// ---- accounts ----------------------------------------------------------------

/**
 * `xezar accounts import-global` (#819 item 1b) — the later door of the one-time import.
 *
 * A person typing this command is the consent the mode requires before the global home is read,
 * exactly as an answered prompt is; nothing else reaches it. It merges ACCOUNTS only, never
 * overwrites a row the project already has, and writes nothing when there is nothing to add, so
 * running it twice is safe and running it on a shared checkout cannot replace a teammate's row.
 *
 * Exit 1 only where the import could not be done at all — an unknown verb, a refused symbolic
 * link, an unreadable file. "Nothing to import" is a successful answer, not a failure.
 */
async function accountsCommand(verb: string | undefined, layout: StateLayout): Promise<number> {
  if (verb !== 'import-global') {
    console.error(`unknown accounts command: ${verb ?? '(none)'}\n`);
    console.error('usage: xezar accounts import-global');
    return 1;
  }
  const report = importGlobalAccounts(layout);
  for (const line of accountImportLines(report, layout)) console.log(line);
  if (report.outcome === 'refused-symlink' || report.outcome === 'unreadable') return 1;
  // Recorded only when something was actually imported, or the project already holds accounts
  // (#819 F4). The state names what happened, and on a folder whose global setup holds no
  // accounts file nothing did — an `imported` here would silence `repeatedImportLine` for good,
  // so an account created in the global setup afterwards would never be copied in. Leaving the
  // state as it was keeps that door open.
  if (report.changed || projectHasAccounts(layout)) {
    await rememberGlobalImport('imported', layout);
  }
  return 0;
}

/**
 * Persist what happened to the global import, and never let that report fail a launch.
 *
 * The same best-effort contract `recordProjectOpened` has: a read-only `.local`, a lock that
 * cannot be taken or a folder that is gone means "this machine will not remember", which is not a
 * reason to refuse to start or to fail a command that did its work.
 */
async function rememberGlobalImport(
  state: RecordedGlobalImportState | null,
  layout: StateLayout,
): Promise<void> {
  if (state === null) return;
  try {
    await recordGlobalImportState(state, layout);
  } catch {
    // a report nothing runs on is never worth a failed boot
  }
}

// ---- workspace boot ----------------------------------------------------------

/**
 * Boot-time workspace bookkeeping (spec 2026-07-20-multi-project-workspace,
 * "Boot flow"): run pending `~/.xezar` migrations first, then register the
 * boot repo in the per-user project registry. Registration is suppressed for
 * task worktrees and `$HOME` itself (`shouldRegisterProject`) — the process
 * still serves those folders normally. Strictly non-fatal: the zero-config
 * law says a broken or read-only home degrades to a smaller cockpit, never a
 * failed boot, so any workspace error logs one warning and boot continues.
 *
 * Returns the boot project's registry id when registration happened —
 * `serveCommand` plumbs it into the server (`ServerDeps.bootProjectId`) so
 * `/api/projects` and `/api/v1/health` can name the boot project without a
 * lookup. Undefined when registration was suppressed or the workspace is
 * unavailable; the server then derives a fallback on its own.
 */
async function initWorkspace(repoRoot: string): Promise<string | undefined> {
  try {
    await runMigrations({ bootRepoRoot: repoRoot });
    if (await shouldRegisterProject(repoRoot)) return (await registerProject(repoRoot)).id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[xez] workspace registry unavailable (${message}) — continuing without it`);
  }
  return undefined;
}

// ---- lease -----------------------------------------------------------------

/**
 * `xezar lease gates -- <command>` — run `<command>` holding one of this machine's gate slots
 * (#672 G2, option (a)).
 *
 * WHY A VERB rather than a lock re-implemented in the kit's bash, or a number passed down as an
 * env var. A verb reads `resources.gateSlots` through the same resolver everything else does, so
 * there is nothing to configure, nothing to pass and no second copy of a lock algorithm whose
 * "never two holders" guard cost a measured 27 double acquisitions before it existed. An env var
 * would also have missed the case #672 names: roughly half the gate attempts are an agent running
 * the gates inside its own step, where the engine is not the parent that would set it.
 *
 * The command tail is taken from `process.argv` rather than from `positionals`, because
 * `parseArgs` folds everything after `--` into positionals and the boundary is exactly what this
 * needs. `<command>` is spawned WITHOUT a shell and with its argv passed through verbatim.
 *
 * NO `cliAudit`, and that is a decision rather than an omission. The audit trail records what
 * xezar DID to a project or a workspace; this verb takes and gives back a lock file in a cache
 * directory and then runs a command the caller had already decided to run. Auditing it would
 * record the caller's action as xezar's, and every gate run would write a row saying nothing the
 * gate attempt record does not already say — including `leaseWaitMs`, which is where the wait
 * actually belongs.
 */
async function leaseCommand(
  subject: string | undefined,
  argv: readonly string[],
  statusFile: string | undefined,
): Promise<number> {
  if (subject !== 'gates') {
    console.error(`xezar lease: the only lease is "gates", got ${subject === undefined ? 'nothing' : `"${subject}"`}`);
    console.error('usage: xezar lease gates -- <command> [args…]');
    return 2;
  }
  const separator = argv.indexOf('--');
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  if (command.length === 0) {
    console.error('xezar lease: nothing to run. Put the command after `--`.');
    console.error('usage: xezar lease gates -- <command> [args…]');
    return 2;
  }
  // A config that cannot be read is not a reason to refuse: the derived default is what an
  // install with no `~/.xezar/config.json` gets anyway, and § Zero config wants the smaller
  // working xezar, not a failed gate run.
  const slots = await loadWorkspaceConfig()
    .then((config) => config.resources.gateSlots)
    .catch(() => undefined);
  // `--status-file` is what lets a caller that keeps the lease across its own work
  // (`repo-gates.sh`) record `leaseWaitMs` without parsing human-readable stderr.
  return await runUnderGateLease(command, {
    ...(slots !== undefined ? { slots } : {}),
    onEvent: (event) => {
      if (statusFile === undefined) return;
      if (event.type !== 'acquired' && event.type !== 'timeout' && event.type !== 'unavailable') return;
      try {
        writeFileSync(
          statusFile,
          `${JSON.stringify({
            held: event.type === 'acquired',
            outcome: event.type,
            slot: event.type === 'acquired' ? event.slot : null,
            slots: event.slots,
            waitedMs: event.waitedMs,
          })}\n`,
        );
      } catch {
        // The status file is diagnostics, not the lease. A caller that cannot read one treats
        // the wait as unknown, which is exactly what it is.
      }
    },
  });
}

// ---- serve -----------------------------------------------------------------

async function serveCommand(
  repoRoot: string,
  invocation: CliInvocation,
  openBrowser: boolean,
  bindHost?: string,
  audit?: CliAudit,
): Promise<void> {
  const bootProjectId = await initWorkspace(repoRoot);
  // The registry is read AFTER registration, so a first start in a repo already sees its own
  // row. Everything below is best-effort: a home that cannot be read resolves to "nothing
  // stored", which is the 4321 default and the behaviour every xezar before this had.
  const stored = await readStoredCliSettings(bootProjectId);
  const settings = resolveCliSettings(invocation, stored, {
    isTty: process.stderr.isTTY === true,
  });
  const glyphs = glyphsFor();

  // Skipping applies only when the start port came from memory or from the 4321 default: a
  // port a PERSON asked for is tried as asked, however busy the registry thinks it is.
  const reserved =
    settings.port.explicit || !stored.config
      ? new Set<number>()
      : portsReservedByOtherProjects(stored.config, bootProjectId);
  const requestedPort = settings.port.ephemeral
    ? settings.port.value
    : firstUnreservedPort(settings.port.value, reserved);
  // ONE workspace semaphore for the whole process (spec 2026-07-20, step 2.5):
  // the boot manager and every lazily-built project context count their runs
  // against the same `resources.maxParallel`. The boot refresh() below is the
  // cache hook's first call; PUT /api/workspace/config (step 2.7) re-fires it.
  const semaphore = new WorkspaceSemaphore();
  await semaphore.refresh();
  // keepLive + recover() (#367): runs that were queued/running/waiting when
  // the previous process exited are re-queued or resumed instead of failed.
  const store = openStore(repoRoot, { keepLive: true });
  // The terminal starts HERE — after the store exists and before anything recovers it (#467,
  // PR 3, analysis § 6(d)). Attaching later would miss the first transitions of every task the
  // previous process left live, which is AC-06's `late-subscribe`. Attaching here means the
  // recovery sweep is seen too, so the source seeds those records instead of announcing them.
  const terminal = startTerminalActivity({
    settings,
    store,
    ...(bootProjectId ? { projectId: bootProjectId } : {}),
  });
  // One line per mangled stored value, then the key is treated as absent (A10). A file
  // someone's editor broke must never be the reason a cockpit does not start.
  for (const warning of settings.warnings) {
    const detail = warning.replace(/^\[xez] /, '');
    terminal.log(
      activityEntry({
        level: 'warn',
        subject: 'registry',
        message: detail,
        event: 'registry.invalid',
        // The message is the human surface and is NOT in the plain output, which carries the
        // event name and the fields only. Which key was broken, and what the value was, is the
        // entire content of this warning — so it travels as a field or it is lost.
        fields: [['detail', detail]],
      }),
    );
  }
  // What this process actually serves (#467, PR 2, spec § 2.5). ONE line at most, on stderr with
  // the rest of the activity, and only when there is news: the default `workspace` mode prints
  // nothing, so a start that changed nothing says nothing. `xez mcp` never reaches here — its
  // stdout stays JSON-RPC and nothing else (AC-2.4).
  const instanceMode = instanceModeInForce(settings);
  const instanceNarrowing = singleProjectNarrowing();
  const bootLine = instanceBootLine({
    mode: instanceMode,
    narrowing: instanceNarrowing,
    requested: settings.instance,
    explicit: settings.instanceExplicit,
    projectName: bootProjectId ?? basename(repoRoot),
  });
  if (bootLine) {
    terminal.log(
      activityEntry({
        level: bootLine.level,
        subject: 'instance',
        message: bootLine.message,
        event: 'instance.mode',
        // The message is the human surface and does NOT appear in the plain output, which
        // carries the event name and the fields only — the same rule the `registry.invalid`
        // warning above follows. So what the sentence says travels as fields or it is lost:
        // what is in force, and what was asked for when the two differ.
        fields:
          instanceMode === 'narrowed'
            ? [['mode', instanceMode], ['requested', settings.instance]]
            : [['mode', instanceMode]],
      }),
    );
  }
  const manager = new RunManager(store, repoRoot, { semaphore });
  const providerAuth = new ProviderAuthService();
  const workspaceEvents = new WorkspaceEventBus();
  const providerRuntimeAuth = new ProviderRuntimeAuthObserver(providerAuth, (status) => {
    workspaceEvents.emit('provider-status', status);
  });
  const version = readOwnVersion();
  const channel = detectInstallChannel(import.meta.url);

  const checks = await detectEnvironment();
  const repo = await getRepoInfo(repoRoot);

  // Startup reconcile (spec 006): sweep worktrees whose run no longer exists.
  if (repo) {
    const orphans = await pruneOrphans(repoRoot, new Set(store.listRuns().map((r) => r.id))).catch(
      () => [] as string[],
    );
    if (orphans.length > 0) {
      console.log(`  cleaned ${orphans.length} orphaned worktree(s): ${orphans.map((id) => id.slice(0, 8)).join(', ')}`);
    }
    // Count-based worktree retention (#483): reclaim finished worktrees beyond
    // the keep-limit (directory only — `xez/<id8>` branch kept, so recoverable).
    // Best-effort; never blocks boot.
    const keep = await resolveWorktreeRetention(repoRoot).catch(() => DEFAULT_WORKTREE_RETENTION);
    const reclaimed = await reclaimWorktrees(repoRoot, store, keep).catch(() => [] as string[]);
    if (reclaimed.length > 0) {
      console.log(`  reclaimed ${reclaimed.length} old worktree(s), branch kept: ${reclaimed.map((id) => id.slice(0, 8)).join(', ')}`);
    }
  }

  await recoverAndReport(
    () => store.listRuns(),
    () => recoverWithProviderRuntimeAuthObservation(
      store,
      () => manager.recover(),
      providerRuntimeAuth,
    ),
    (count, settled) => terminal.reportRecovery(count, settled),
  );
  // Recovery is over: from here a status change is news, and a `failed` really is an outcome.
  terminal.endRecovery();

  // Update discovery (#368) — fire-and-forget; the banner prints whenever the
  // registry answers and /api/v1/health picks it up for the GUI chip.
  const pkgName = readOwnName();
  const update: { latest?: string } = {};
  void checkForUpdate(pkgName, version).then((latest) => {
    if (!latest) return;
    update.latest = latest;
    console.log(`\n  ⬆ xezar ${latest} is available (running ${version}) — restart with: npx ${pkgName}@latest\n`);
  });

  let app: ServiceDispatch | undefined;
  // The same rows `GET /providers/status` answers, so E-06 starts from what the cockpit shows.
  // Shared by every project's MCP door, the boot one included.
  const providerBaseline = async (): Promise<readonly ProviderStatus[]> => {
    const discovered = await providerAuth.status();
    if (providerAuthChecksDisabled()) return applyProviderEnablement(discovered, []).providers;
    return applyProviderEnablement(discovered, (await loadWorkspaceConfig()).disabledProviders).providers;
  };
  const localHandoff = (): boolean => resolveCapabilities(process.env, bindHost).localHandoff;
  let mcpService: { close(): void } | undefined;
  let projectDoors: { close(): void } | undefined;
  let stopping = false;
  const server = startServer({
    repoRoot,
    store,
    manager,
    version,
    channel,
    update,
    bootProjectId,
    // Resolved ONCE, here, and handed over (#467, PR 2): it is a boot decision — the MCP socket,
    // the bind and every context this process builds are all settled under it — so the server
    // reads the answer rather than re-deriving it per request.
    instanceMode,
    ...(instanceNarrowing !== null ? { instanceNarrowing } : {}),
    semaphore,
    bindHost,
    providerAuth,
    providerRuntimeAuth,
    workspaceEvents,
    onApp: (built) => {
      app = built;
    },
    // Every project built later gets its own subscription, taken before ITS recovery, and
    // released when its context is disposed (#467, PR 3).
    onContexts: (contexts) => {
      terminal.onContexts(contexts);
      // Every project built after boot gets the MCP door the boot project has (#557): opened when
      // its context is built, closed when it is disposed. The boot project is skipped — its door is
      // the one opened below, unchanged.
      projectDoors = followProjectDoors(contexts, {
        ...(bootProjectId ? { bootProjectId } : {}),
        open: async (ctx) => {
          const handle = await startMcpSocket({
            projectId: ctx.id,
            version,
            service: app,
            store: ctx.store,
            workspaceEvents,
            providerBaseline,
            localHandoff,
            // No `onEventRow`: the terminal's journal lines are labelled as the boot project's.
            onUnavailable: (reason) =>
              terminal.log(
                activityEntry({
                  level: 'warn',
                  subject: 'mcp',
                  message: `unavailable ${glyphs.dash} ${reason}. The cockpit works without it.`,
                  event: 'mcp.unavailable',
                  projectId: ctx.id,
                  fields: [['reason', reason]],
                }),
              ),
          });
          return handle;
        },
        // Fires only when the handle above is kept as the project's door — never for a project
        // disposed while its open was still in flight, whose handle `followProjectDoors` closes
        // silently instead. `open`'s own return does not carry that distinction.
        onOpened: (ctx) => {
          if (stopping) return;
          terminal.log(
            activityEntry({
              level: 'info',
              subject: 'mcp',
              message: `ready ${glyphs.dash} run xez mcp in ${ctx.root}`,
              event: 'mcp.ready',
              projectId: ctx.id,
            }),
          );
        },
      });
    },
    // One safe line per returned 4xx and thrown 5xx. Observe-only: the response is untouched.
    onHttpFailure: terminal.onHttpFailure,
  }, requestedPort);
  // Nothing below may claim a cockpit before the bind really succeeded (#238): the port
  // comes from the listening server itself, never from an earlier "is it free" probe.
  let port: number;
  try {
    port = await listenOnFreePort(server, requestedPort, bindHost ?? '127.0.0.1', reserved);
  } catch (err) {
    // The terminal goes first: a bind failure is the one moment a live region must not be left
    // on screen, and the error below is the only thing a person should see.
    terminal.stop({ stillRunning: 0 });
    store.flush();
    // No listener, no cockpit: refused before the command's effect (#306 part 2).
    await audit?.refused('listen_failed', { resource: projectResource(await audit.scope()) });
    throw err;
  }
  // The server owns its listening socket: `cli.serve` took effect.
  await audit?.applied({ resource: projectResource(await audit.scope()) });
  // The address the MCP hands a leader for the person (#819 item 8), read from the socket that
  // really listens and recorded only on the host — hosted mode records nothing, so it is omitted.
  recordOwnListen(server, localHandoff());
  terminal.setUrl(`http://localhost:${port}`, {
    port,
    requestedPort,
    // `--port 0` asks the OS for any port, so getting a different one is not "busy".
    ...(requestedPort !== 0 && port !== requestedPort ? { reason: 'busy' } : {}),
  });
  // SECURITY: xezar executes agents. A non-loopback bind exposes that box to
  // whatever can reach the interface, and xezar itself has NO auth — it is only
  // for a deliberate hosted setup where a reverse proxy in front provides TLS +
  // auth (see `server-install --external-proxy`). Say so, loudly, every start.
  if (bindHost && !['127.0.0.1', 'localhost', '::1'].includes(bindHost)) {
    console.log(
      `\n  ⚠ binding ${bindHost}:${port} — xezar has no built-in auth.\n` +
        `    Only do this behind a reverse proxy that enforces authentication,\n` +
        `    and make sure this interface is not reachable from the internet.\n`,
    );
  }
  // Remember the address this project's cockpit really holds (#467) — AFTER the bind, with
  // the port the listener reported, never the one that was requested. A `--port 0` start is
  // deliberately not remembered: "any free port" is a request for anything, and storing the
  // 53122 the OS handed out would make the next plain `xez` start at a random high port.
  // Best-effort in every direction: no row, no home, or a home that cannot be written costs
  // one warning and nothing else (`error-cases.txt` A11).
  if (bootProjectId && !settings.port.ephemeral) {
    const remembered = (await rememberLastListen(bootProjectId, port, bindHost ?? '127.0.0.1')) !== null;
    terminal.log(
      activityEntry({
        level: remembered ? 'debug' : 'warn',
        subject: 'registry',
        message: remembered
          ? `remembered port ${port} for this project`
          : `could not remember port ${port} for this project ${glyphs.dash} the cockpit works anyway`,
        event: 'registry.port',
        fields: [
          ['port', port],
          ['remembered', remembered],
        ],
      }),
    );
  }

  // The boot project's MCP socket (#86, D-01 § 5.4), composed over the same app and store
  // the cockpit uses (#243). Fire-and-forget: it never delays or fails boot (N-07), and a
  // failure is one warning.
  if (bootProjectId) {
    void startMcpSocket({
      projectId: bootProjectId,
      version,
      service: app,
      store,
      workspaceEvents,
      providerBaseline,
      localHandoff,
      // Stall advisories, reviewer verdicts and executor changes reach the terminal as the MCP
      // journal wrote them (#467, PR 4), rather than as a second derivation of the same facts.
      onEventRow: (row) => terminal.onEventRow(row),
      // The MCP socket opens asynchronously, so its own line is the only honest place to say it
      // is ready: the banner is printed before it listens, and a banner that claims an unopened
      // socket is the `false-mcp-ready` break (AC-10).
      onUnavailable: (reason) =>
        terminal.log(
          activityEntry({
            level: 'warn',
            subject: 'mcp',
            message: `unavailable ${glyphs.dash} ${reason}. The cockpit works without it.`,
            event: 'mcp.unavailable',
            fields: [['reason', reason]],
          }),
        ),
    }).then((handle) => {
      // A shutdown that won the race still releases what the late start composed.
      if (stopping) handle?.close();
      else mcpService = handle;
      if (handle && !stopping) {
        terminal.log(
          activityEntry({
            level: 'info',
            subject: 'mcp',
            message: `ready ${glyphs.dash} run xez mcp in this project folder`,
            event: 'mcp.ready',
          }),
        );
      }
    });
  }
  const url = `http://localhost:${port}`;

  // The stdout banner is unchanged, byte for byte, for every start that is not `--quiet`
  // (`open-questions.md` Q-11: `xez | tee` and scripts that read the URL keep working). Quiet
  // shrinks it to what a person or a script needs — which is new behaviour of a new flag, not a
  // change to the default (`quiet.txt` scene 1).
  if (!settings.quiet) {
    console.log(`\n  xezar v${version} — ${repoRoot}`);
    console.log(`  ${repo ? `branch ${repo.branch}` : 'not a git repository (tasks run in place, one at a time; repo view is empty)'}`);
    for (const check of checks) {
      const mark = check.available ? '✓' : '✗';
      const detail = check.available ? (check.version ?? 'ok') : (check.hint ?? 'missing');
      console.log(`  ${mark} ${check.name.padEnd(6)} ${detail}`);
    }
  }
  // Printed in EVERY mode, quiet included: a port that moved is the difference between a
  // bookmark that works and one that does not, and quiet may never hide it (`quiet.txt`).
  // `--port 0` asks the OS for any port; getting one is not "busy".
  if (port !== requestedPort && requestedPort !== 0) console.log(`  (port ${requestedPort} was busy — using ${port})`);
  console.log(`${settings.quiet ? '' : '\n'}  cockpit → ${url}\n`);
  // Silenced by XEZ_NO_BANNER=1 or by dismissing the cockpit's banner (#391), and by quiet.
  if (!settings.quiet) await printSkillsBanner(repoRoot);
  terminal.startDisplay();

  let shuttingDown = false;
  const shutdown = () => {
    // A second Ctrl-C exits at once and prints nothing more (`tty.txt` scene 5).
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    stopping = true;
    // The terminal first: the live region has to be erased and the cursor restored while there
    // is still a process to do it. `stop()` never throws, so nothing below can be skipped.
    terminal.stop({ ...(repo ? { projectName: bootProjectId ?? repo.branch } : {}) });
    // MCP next, so no MCP listener is still attached while the store flushes.
    mcpService?.close();
    projectDoors?.close();
    store.flush();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Open the browser only once the server actually answers, so the first
  // paint is the cockpit and never a connection error.
  if (openBrowser) {
    const healthy = await waitForHealth(`${url}/api/v1/health`, 5_000);
    if (healthy) openUrl(url);
  }
}

/**
 * Open the MCP socket for `projectId`, or log ONE warning and return undefined. The
 * module is imported lazily, so even a broken MCP module leaves a working cockpit.
 */
async function startMcpSocket(opts: {
  projectId: string;
  version: string;
  service: ServiceDispatch | undefined;
  store: RunStore;
  workspaceEvents: WorkspaceEventBus;
  providerBaseline: () => Promise<readonly ProviderStatus[]>;
  localHandoff: () => boolean;
  /** Every journal row as it is appended, for the terminal's activity lines. Boot project only. */
  onEventRow?: (row: McpJournalRow) => void;
  /**
   * Where the one unavailability line goes (#467, PR 3).
   *
   * Required rather than optional on purpose: two spellings of the same warning is how a message
   * a person greps for quietly becomes two. Both callers (the boot door and #557's later-project
   * doors) emit the same `mcp.unavailable` event.
   */
  onUnavailable: (reason: string) => void;
}): Promise<{ close(): void } | undefined> {
  try {
    const { startMcpService } = await import('./mcp/index.ts');
    return await startMcpService({
      projectId: opts.projectId,
      version: opts.version,
      store: opts.store,
      workspaceEvents: opts.workspaceEvents,
      providerBaseline: opts.providerBaseline,
      localHandoff: opts.localHandoff,
      ...(opts.onEventRow ? { onEventRow: opts.onEventRow } : {}),
      ...(opts.service ? { service: opts.service } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.onUnavailable(message);
    return undefined;
  }
}

/** How many BINDS `serve` tries before giving up. Ports skipped for another project do not
 *  spend from this budget — see `listenOnFreePort`. */
const PORT_SPAN = 50;

/**
 * Wait for `server` — whose first `listen(first, host)` is already under way — to really
 * listen, and resolve the port it bound. A busy port moves the SAME server to the next one
 * (BACKWARD_COMPATIBILITY.md §1/§3: "auto-picks the next free port"), until PORT_SPAN
 * binds are used up or the range would pass 65535; any other bind error, or running out,
 * rejects with one clear line.
 *
 * `reserved` (#467) names ports OTHER registered projects hold or remember. It is populated
 * only when the start port came from memory or from the 4321 default — never for a port a
 * person asked for — and it exists to stop two projects that are rarely both running from
 * swapping ports on every restart, which breaks every bookmark they had.
 *
 * This replaces a probe that proved a port free and then released it, which let anything
 * take the port before the real bind and left a printed cockpit URL with nobody behind it
 * (#238). There is no gap now: the port is the one the server holds.
 *
 * Re-listening after a failed `listen` is allowed by Node without `close()` — and `close()`
 * must not be called here: it emits `close`, which `startServer` treats as the end of the
 * server and uses to stop its schedulers.
 */
function listenOnFreePort(
  server: Server,
  first: number,
  host: string,
  reserved: ReadonlySet<number> = new Set(),
): Promise<number> {
  return new Promise((resolvePort, reject) => {
    let port = first;
    // How many binds have been ATTEMPTED. A port skipped because another project holds it
    // costs nothing from this budget: the guarantee is "at most 50 binds", and spending the
    // budget on ports we never even tried would shrink the real range without saying so.
    let attempts = 1;
    let last = first;
    const fail = (message: string) => {
      server.off('error', onError);
      server.off('listening', onListening);
      reject(new Error(message));
    };
    /** The next port to bind: one past the current one, then past anything reserved. */
    const advance = (): number | null => {
      let next = port + 1;
      while (next <= PORT_MAX && reserved.has(next)) next += 1;
      return next <= PORT_MAX ? next : null;
    };
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE') {
        fail(`cannot listen on ${host}:${port} (${err.message})`);
        return;
      }
      const next = attempts >= PORT_SPAN ? null : advance();
      if (next === null) {
        fail(`no free port in ${first}–${last} on ${host}; free one or pass --port <port>`);
        return;
      }
      port = next;
      last = next;
      attempts += 1;
      try {
        server.listen(port, host);
      } catch (listenErr) {
        fail(`cannot listen on ${host}:${port} (${listenErr instanceof Error ? listenErr.message : String(listenErr)})`);
      }
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      resolvePort(address && typeof address === 'object' ? address.port : port);
    };
    server.on('error', onError);
    server.once('listening', onListening);
  });
}

async function waitForHealth(healthUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// ---- run (headless) ----------------------------------------------------------

async function runCommand(
  repoRoot: string,
  task: string,
  workflowName: string | undefined,
  model: string | undefined,
  quiet = false,
  audit?: CliAudit,
): Promise<void> {
  if (!task) {
    console.error('usage: xezar run "<task>" [--workflow name] [--model model]');
    process.exitCode = 1;
    await audit?.refused('missing_task');
    return;
  }
  await initWorkspace(repoRoot);
  const { workflows, issues } = await loadWorkflows(repoRoot);
  for (const issue of issues) console.error(`! skipped ${issue.path}: ${issue.message}`);
  const name = workflowName ?? 'quick-task';
  const workflow = workflows.find((w) => w.name === name);
  if (!workflow) {
    console.error(`unknown workflow: ${name} (available: ${workflows.map((w) => w.name).join(', ')})`);
    process.exitCode = 1;
    await audit?.refused('unknown_workflow');
    return;
  }

  const providerAuth = new ProviderAuthService();
  const requiredProviders = providersRequiredByWorkflow(
    workflow,
    (await loadConfig(repoRoot)).defaultRunner,
  );
  if (requiredProviders.length > 0 && !providerAuthChecksDisabled()) {
    const [discovered, workspace] = await Promise.all([
      providerAuth.status(),
      loadWorkspaceConfig(),
    ]);
    const blocked = unavailableProviderMessage(
      requiredProviders,
      applyProviderEnablement(discovered, workspace.disabledProviders),
    );
    if (blocked) {
      console.error(blocked);
      process.exitCode = 1;
      await audit?.refused('provider_unavailable');
      return;
    }
  }

  const store = openStore(repoRoot);
  // Headless tasks still appear in the cockpit later, so persist the same
  // task-local recovery event when a credential expires after the preflight.
  const providerRuntimeAuth = new ProviderRuntimeAuthObserver(providerAuth, () => {});
  providerRuntimeAuth.watch(store);
  // Headless runs enforce the same workspace-level cap/memory limit (step
  // 2.5) — one refreshed semaphore, even with just one manager in play.
  const semaphore = new WorkspaceSemaphore();
  await semaphore.refresh();
  const manager = new RunManager(store, repoRoot, { semaphore });

  // The stdout transcript is the DEFAULT and is unchanged (BACKWARD_COMPATIBILITY.md § 1).
  // `--quiet` — a flag that did not exist before this release, so nothing that works today
  // changes — prints only the final status line, and keeps the agent's own errors on stderr
  // (`designs/cli-terminal/quiet.txt` scene 2).
  store.on('event', ({ event }) => {
    if (quiet) {
      if (event.type === 'error') console.error(`  ✗ ${String(event.message ?? '')}`);
      return;
    }
    switch (event.type) {
      case 'text':
        console.log(String(event.text ?? ''));
        break;
      case 'tool-call':
        console.log(`  → ${String(event.tool)} ${previewJson(event.input)}`);
        break;
      case 'tool-result':
        console.log(`  ← ${firstLine(String(event.result ?? ''))}`);
        break;
      case 'check-output':
        console.log(String(event.text ?? ''));
        break;
      case 'step-start':
        console.log(`\n── step: ${String(event.name)} ${Number(event.iteration) > 1 ? `(attempt ${event.iteration})` : ''}`);
        break;
      case 'note':
      case 'lifecycle':
        console.log(`  · ${String(event.message ?? '')}`);
        break;
      case 'error':
        console.error(`  ✗ ${String(event.message ?? '')}`);
        break;
    }
  });

  const run = manager.startRun(workflow, { task, model });
  await audit?.applied({ resource: { kind: 'run', id: run.id } });
  // `review` is terminal here too (spec 009) — headless runs must not hang on
  // the GUI's review gate; the diff waits on the task branch/cockpit instead.
  const final = await new Promise<string>((resolveStatus) => {
    store.on('run', (r) => {
      if (r.id === run.id && ['done', 'review', 'failed', 'cancelled'].includes(r.status)) resolveStatus(r.status);
    });
  });
  store.flush();
  const record = store.getRun(run.id);
  if (quiet) {
    // One line, the final status, on stdout. Exit codes are UNCHANGED: 0 for done and review,
    // 1 for failed and cancelled — a script that reads `$?` sees exactly what it always did.
    const glyphs = glyphsFor();
    const from = record ? Date.parse(record.startedAt ?? record.createdAt) : Number.NaN;
    const facts: string[] = [];
    if (!Number.isNaN(from)) facts.push(formatDuration(Date.now() - from));
    if (record && record.tokensUsed > 0) facts.push(`${formatTokens(record.tokensUsed)} tokens`);
    const state = final === 'review' ? 'needs review' : final;
    console.log(`  ${state}${facts.length > 0 ? ` ${glyphs.dash} ${facts.join(` ${glyphs.dot} `)}` : ''}`);
    process.exitCode = final === 'done' || final === 'review' ? 0 : 1;
    return;
  }
  const cockpit = npxCommand();
  if (final === 'review') {
    console.log(`\n  changes ready for review on branch ${record?.branch ?? '?'} — inspect them in the cockpit: ${cockpit}`);
  }
  console.log(`\nrun ${final} — ${record?.tokensUsed ?? 0} tokens — details in the cockpit: ${cockpit}`);
  process.exitCode = final === 'done' || final === 'review' ? 0 : 1;
}

// ---- server-install / server-uninstall --------------------------------------
// The whole server-install module (and its @clack/prompts dependency) is loaded
// lazily here so it never enters the `serve`/`run`/`init` import graph — the
// runtime server stack stays tiny (AGENTS.md).

/**
 * Prepend the operator's login-shell PATH to this process's PATH so tool
 * detection and installs find things in ~/.local/bin, nvm, and other
 * profile-added dirs even when the installer was launched non-interactively.
 * Best-effort: a shell that errors or hangs leaves PATH untouched.
 */
function augmentPathFromLoginShell(): void {
  try {
    const out = execFileSync('bash', ['-lc', 'printf %s "$PATH"'], { timeout: 5000, encoding: 'utf8' });
    const loginPath = out.split('\n').map((s) => s.trim()).filter(Boolean).pop() ?? '';
    if (!loginPath) return;
    const seen = new Set<string>();
    process.env.PATH = [...loginPath.split(':'), ...(process.env.PATH ?? '').split(':')]
      .filter((d) => d && !seen.has(d) && seen.add(d))
      .join(':');
  } catch {
    // best effort — keep the existing PATH
  }
}

async function serverCommand(
  mode: 'install' | 'uninstall' | 'deploy',
  repoRoot: string,
  platform: string | undefined,
  audit: CliAudit,
  flags: {
    yes: boolean;
    reconfigure?: string;
    reinstall?: boolean;
    domain?: string;
    port?: number;
    externalProxy?: boolean;
    bindHost?: string;
  },
): Promise<void> {
  // Detection (claude/gh/codex) and tool installs resolve executables off the
  // process PATH. When the installer is launched from a non-login shell (an
  // `ssh host cmd`, a script, a fresh service context), ~/.local/bin and nvm's
  // bin are absent, so tools the user actually has look "not installed". Merge
  // the login shell's PATH first so we see exactly what the operator sees.
  augmentPathFromLoginShell();

  const { getStrategy, availablePlatformIds } = await import('./server-install/strategies.ts');
  const { runInstall, runUninstall, runDeploy } = await import('./server-install/engine.ts');
  const { loadServerState, listServerInstances, nextFreeInstancePort } = await import('./server-install/state.ts');
  const { instanceSlug, DEFAULT_SERVER_INSTANCE } = await import('./paths.ts');

  const ids = availablePlatformIds();

  // Resolve the instance from --domain (domain-keyed multi-instance). An
  // interactive install with an existing cockpit and no --domain also offers to
  // stand up a second instance — the exact "it asks me to reinstall" case.
  let domain = (flags.domain ?? '').trim() || undefined;
  if (mode === 'install' && !domain && !flags.yes && process.stdin.isTTY && loadServerState(DEFAULT_SERVER_INSTANCE).installed) {
    try {
      const { createClackUi } = await import('./server-install/ui.ts');
      const answer = await createClackUi().text({
        message:
          'This host already runs a xezar cockpit. Enter a NEW domain to host a second, independent instance — ' +
          'or leave blank to manage/redeploy the existing one.',
        placeholder: 'shop.example.com',
      });
      if (typeof answer === 'string' && answer.trim()) domain = answer.trim();
    } catch {
      // any prompt failure → fall back to managing the default instance
    }
  }
  const instance = domain ? instanceSlug(domain) : DEFAULT_SERVER_INSTANCE;

  // Uninstall and deploy can read the platform from THIS instance's record when omitted.
  let chosen = platform;
  if ((mode === 'uninstall' || mode === 'deploy') && !chosen) {
    chosen = loadServerState(instance).platform;
  }
  if (!chosen) {
    console.error(`--platform is required. Valid platforms: ${ids.join(', ')}`);
    process.exitCode = 1;
    await audit.refused('missing_platform');
    return;
  }
  const strategy = getStrategy(chosen);
  if (!strategy) {
    console.error(`unknown platform: ${chosen} (valid: ${ids.join(', ')})`);
    process.exitCode = 1;
    await audit.refused('unknown_platform');
    return;
  }
  // Domain-keyed multi-instance is an ubuntu-vps feature (shared nginx front).
  if (instance !== DEFAULT_SERVER_INSTANCE && chosen !== 'ubuntu-vps') {
    console.error(`--domain (multi-instance) is only supported on ubuntu-vps, not ${chosen}.`);
    process.exitCode = 1;
    await audit.refused('domain_not_supported');
    return;
  }

  // Port: an explicit --port always wins; a brand-new named instance otherwise
  // auto-picks the next free loopback port so it can't collide with the first.
  let port = flags.port;
  if (mode === 'install' && instance !== DEFAULT_SERVER_INSTANCE && port === undefined) {
    const known = listServerInstances().some((i) => i.instance === instance);
    if (!known) {
      port = nextFreeInstancePort();
      console.log(`\n  New instance "${instance}" (${domain}) → loopback port ${port} (override with --port).`);
    }
  }

  // The installer's selected plan beginning is this command's effect boundary (#306 part 2, spec § 5).
  let planRecorded: Promise<void> | undefined;
  const runOpts = {
    onPlanStart: () => {
      planRecorded ??= audit.applied();
    },
    dryRun: process.env.XEZ_DRY_RUN === '1',
    assumeYes: flags.yes,
    reconfigure: new Set((flags.reconfigure ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    reinstall: Boolean(flags.reinstall),
    repoRoot,
    now: new Date().toISOString(),
    instance,
    domain,
    port,
    // Only an install decides proxy mode; deploy/uninstall read it back from
    // the recorded state. Preserve an omitted flag as `undefined`: a flag-less
    // resume must keep an external-proxy install external instead of flipping
    // it back to xezar-managed nginx/SSL.
    ...(mode === 'install'
      ? { externalProxy: flags.externalProxy || undefined, bindHost: flags.bindHost }
      : {}),
  };

  // e.g. "ubuntu-vps" or "ubuntu-vps, shop.example.com" for a named instance.
  const label = instance === DEFAULT_SERVER_INSTANCE ? chosen : `${chosen}, ${domain}`;
  const domainFlag = instance === DEFAULT_SERVER_INSTANCE ? '' : ` --domain ${domain}`;

  try {
    const result =
      mode === 'install'
        ? await runInstall(strategy, runOpts)
        : mode === 'deploy'
          ? await runDeploy(strategy, runOpts)
          : await runUninstall(strategy, runOpts);
    if (mode === 'install' && result.status === 'complete') {
      console.log(`\n  xezar server-install (${label}) complete.`);
      console.log(`  Redeploy a new version any time with: xezar server-deploy --platform ${chosen}${domainFlag}\n`);
    } else if (mode === 'deploy' && result.status === 'complete') {
      console.log(`\n  xezar server-deploy (${label}) complete — the service was reloaded and verified.\n`);
    } else if (mode === 'uninstall' && result.status === 'complete') {
      console.log(`\n  xezar server-uninstall (${label}) complete — the changes it made were reversed.\n`);
    }
    // complete + cancelled (resumable) exit 0; failed exits 1.
    process.exitCode = result.status === 'failed' ? 1 : 0;
    await (planRecorded ?? audit.refused(result.status === 'cancelled' ? 'cancelled' : 'refused_before_plan'));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    await (planRecorded ?? audit.refused('refused_before_plan'));
  }
}

// ---- init --------------------------------------------------------------------

/**
 * The lines `init` ends with (#819 item 9b).
 *
 * `npx <name>` names the SCOPED package, always, and that is a security property rather than
 * tidiness: the unscoped name this line used to print is not published by us, so anyone could
 * publish it and a person following our own closing line would run their code. The name is read
 * from the running package rather than spelled here, so it cannot drift from what npm installs.
 *
 * The accounts line exists because `init` scaffolds a project and people reasonably assume it
 * brought their agent accounts with it. It did not — accounts are copied by their own command,
 * which is the one that asks the person's consent to read their global setup. That line's whole
 * job is to say the import has NOT happened, so a launch that imported the accounts itself (the
 * first-run prompt answered yes, or `--import-global`) leaves it out (#825): printing it beside
 * the `imported N file(s)` line above would contradict the run and send the person to a command
 * they just ran. `accountsImported` is this launch's own outcome, never a remembered one.
 *
 * The single-project line is only printed in a repository: outside one there is no folder for a
 * team to carry, so the recommendation would name a choice that does not apply.
 */
function initClosingLines(gitRepository: boolean, accountsImported: boolean): string[] {
  const npx = npxCommand();
  return [
    ...(accountsImported
      ? []
      : [
          '',
          `Agent accounts are not imported by init. To copy your global accounts into this project, run: ${npx} accounts import-global`,
        ]),
    '',
    `Done. Start the cockpit with: ${npx}`,
    ...(gitRepository
      ? [`To keep this project's xezar setup inside the project folder: ${npx} --single-project`]
      : []),
  ];
}

function initCommand(repoRoot: string, accountsImported: boolean): void {
  const workflowsDir = join(projectKitDir(repoRoot), 'workflows');
  const skillsDir = join(projectKitDir(repoRoot), 'skills');
  mkdirSync(workflowsDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });

  const check = discoverProjectCheck(repoRoot);
  const examples: Array<{ path: string; content: string }> = [
    { path: join(workflowsDir, 'fix-and-verify.yaml'), content: fixAndVerifyWorkflow(check) },
    { path: join(skillsDir, 'project-conventions.md'), content: PROJECT_CONVENTIONS_SKILL },
  ];

  let wroteWorkflow = false;
  for (const example of examples) {
    if (existsSync(example.path)) {
      console.log(`  = ${example.path} (exists, left untouched)`);
    } else {
      writeFileSync(example.path, example.content, 'utf8');
      console.log(`  + ${example.path}`);
      if (example === examples[0]) wroteWorkflow = true;
    }
  }
  ensureDataGitignore(repoRoot);
  if (wroteWorkflow) {
    console.log(
      check
        ? `\nVerification: fix-and-verify runs \`${check.command}\`, found in ${check.source}.`
        : '\nVerification: no verification command is configured, so fix-and-verify ends with a review step that reports what it could not verify.',
    );
  }
  // `.git` rather than a git call: a folder someone has just `git init`-ed has no commit yet,
  // and a repository is exactly what makes the project-owned setup worth naming.
  for (const line of initClosingLines(existsSync(join(repoRoot, '.git')), accountsImported)) console.log(line);
}

// ---- helpers -----------------------------------------------------------------

function openStore(repoRoot: string, opts?: { keepLive?: boolean }): RunStore {
  const dataDir = projectDataDir(repoRoot);
  ownProjectData(dataDir);
  const store = RunStore.open(dataDir, opts);
  // Repo-scope the referenced tier (#945) — see `armRepoHandle`. Background, never awaited: a
  // `gh`-less or offline machine keeps working exactly as it did, just unscoped.
  armRepoHandle(store, repoRoot);
  // A finished setup task stamps "last successfully checked" (#464 P2) — here as well as in
  // `createApp`, because `xezar run` executes a workflow with no server at all, and a check that
  // ran headlessly is still a check that finished.
  watchSetupCompletion(store, readOwnVersion());
  ensureDataGitignore(repoRoot);
  return store;
}

/** Keep run data out of the user's repo history; the kit in `.xezar/` stays committable. */
function ensureDataGitignore(repoRoot: string): void {
  // A nested ignore protects local state even in repositories without a root ignore rule.
  // Everything the engine writes lives under `.local/`, so one blanket rule covers it all.
  try {
    mkdirSync(join(repoRoot, '.local'), { recursive: true });
    const ignore = join(repoRoot, '.local', '.gitignore');
    const content = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
    if (!content.split('\n').includes('*')) writeFileSync(ignore, `${content}\n*\n`, 'utf8');
  } catch { /* read-only repositories retain the normal degradation policy */ }
}

function readOwnVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function openUrl(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    // A missing opener (e.g. no `xdg-open` on a headless Linux VPS) surfaces
    // asynchronously as an 'error' event, NOT a synchronous throw — without a
    // listener Node promotes it to an unhandled error and hard-crashes the whole
    // process, even though the cockpit is already serving. Swallow it: the URL is
    // printed above, so a browser-less host just doesn't auto-open.
    child.on('error', () => {});
    child.unref();
  } catch {
    // the printed URL is enough
  }
}

function previewJson(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 120 ? `${s.slice(0, 117)}…` : s;
  } catch {
    return '';
  }
}

function firstLine(s: string): string {
  const line = s.split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
