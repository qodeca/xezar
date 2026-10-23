# Guidance for `packages/xezar/src/platform/`

Cross-repository rules and the task-routing index are in the root `AGENTS.md`.

## Platform layer (`platform/`)

Where a path, a file replacement, a program search or a process start or stop differs between
Windows and Linux/macOS, the answer lives in this folder (#963), never in a fresh
`process.platform` test at a call site.

- **Absolute paths.** `isAbsolutePath` for stored values and Git output (lenient),
  `isFullyQualifiedPath` for a folder a person typed (Windows also refuses `\x`, `/x`, a UNC path
  without a share and device paths). `posix-literal-scan.test.ts` fails on a new `.startsWith('/')`
  absolute test or a runtime `/tmp` literal.
- **Identity.** `path-identity.ts` (`samePath`, `isInsideByIdentity`, `containsPathSegments`,
  `lookupSamePath`, `isInsideDotGit`) answers "same project / same folder" and is case-insensitive
  on Windows only. It may WIDEN a refusal and must never GRANT access, so a containment guard never
  relies on it to let a path through.
- **Writes.** New and migrated write-then-rename sites go through `writeFileAtomic` /
  `writeFileAtomicSync` (or `renameReplacing*`): one rename on Linux/macOS with the original error,
  a bounded retry (about three seconds) and read-only clearing on Windows only, and the temp removed
  on failure.
  - **A writer of a file that the same process also reads asynchronously uses the async
    `writeFileAtomic`, never the sync twin** (#1132; `atomicWriteJson` beside `atomicWriteJsonSync`
    in `workspace/config.ts`). On Windows a rename cannot replace a file another handle still
    holds open, and the sync retry waits with `Atomics.wait`, which blocks the event loop the async
    read needs to close its handle – so every retry meets the same `EPERM` and the write fails.
  - One deliberate exception: `agent-config/files.ts` keeps its plain `rename`, because it
    re-checks containment right before the rename and a retry would widen that check-to-use
    window. Known exceptions that still use a plain rename are listed in `docs/STATUS.md`; they
    are not a pattern to copy.
- **Program search.** `exe-search.ts` stays the FIRST import of `src/index.ts`, so Windows never
  runs a program found in a child's working folder.
- **Long paths.** `long-paths.ts` only reports whether Windows `LongPathsEnabled` and Git's
  `core.longpaths` are known to be off; it never changes either. The skills cache's own Git
  commands pass `-c core.longpaths=true` themselves (#1134, `skills-remote.ts`).
- **Rules for the folder.** `platform/` imports only `node:*` and its own siblings. Each POSIX
  branch is byte-for-byte the expression it replaced. Every Windows branch is tested on every OS
  through the trailing `platform` parameter of the pure helpers; domain functions keep their
  signatures and follow the host – their call-site tests run the Windows branch on every OS with
  `withPlatform` (`packages/xezar/test/helpers/platform.ts`), storing the other spelling rather than
  expecting it on disk. Where a Windows syntax rule would reject a POSIX host's path first, force
  only the identity rule (`platform/identity-platform.testkit.ts`).

## Processes

- **Start every program through `process-launch.ts`** (`launch`, `launchFile`, `launchFileAsync`,
  `launchFileSync`, `launchDetached`, `launchCmd`) **and stop every child through
  `process-tree.ts`** (`stopChildTree`, `signalProcessGroup`, `stopProcessGroup`, and
  `stopChildWithDescendants` for a child that is only a launcher – Qwen Code's `qwen` runs the real
  program as its own child, so on Linux and macOS the stop also signals the descendants it finds in
  one process-table read).
- **Linux and macOS behave exactly as before.** A launch wrapper calls the matching
  `node:child_process` function with the very `file`, `args` and `options` references it was given
  – a test pins them with `toBe` – and a stop sends exactly the signal its call site sent before.
- **Windows launch rules.** A launch never finds a program through the working folder or a
  relative PATH entry, runs an explicit `.js`/`.mjs`/`.cjs` path through Node, unwraps npm's
  command shims (and `npm.cmd`/`npx.cmd`) so no cmd.exe runs, sends every other `.cmd`/`.bat`
  through the strict rule of `batch-line.ts`, and hides the console only for background work
  (`launchFile*`, `{ hide: true }`) – never for an agent session, a check step or the gate lease's
  command.
- **Refusals.** A refusal is a synchronous `CommandRefusedError` (`XEZ_CMD_*`, `XEZ_SHELL_REFUSED` –
  error codes, not environment variables) whose message names the file and the argument's
  position, never its value. A truthy `shell` or a caller's `windowsVerbatimArguments` is refused
  on every OS.
- **cmd.exe starts only through `launchCmd`**, which checks every token; `resolveCommand` refuses
  any other route to it (`XEZ_CMD_DIRECT`).
- **A check step on Windows runs in Git Bash** (`check-step-shell.ts` → `launchMsys`: Git's own
  `usr\bin\bash.exe -c`, found by `git-bash.ts`, never WSL's). `MSYS=noglob` is for that shell
  alone – the step's command starts by putting the caller's `MSYS` back, because a program that
  inherits `noglob` makes Git's `sh` split a quoted path such as gh's credential helper under
  `C:\Program Files` (#1023). Its script first writes the shell's MSYS pid to a temp file, so a
  stop also reaches the shell's MSYS process group through Git's `ps` (`msys-process-tree.ts`) – a
  program whose MSYS parent exited is out of the Windows walk's reach.
- **A Windows stop** kills the child through its handle at once, then ONE PowerShell
  (`table-then-kill.ts`, above-normal priority, so a busy machine does not starve it) reads the
  process table and kills the child's creation-filtered descendants by start time – never
  `taskkill /T`, which follows stale parent pids.
- **Process groups** (`detached: true`, `kill(-pid)`) are only for short, bounded probes: the agent
  quota checker (#892) and the provider sign-in check (#894, a group on POSIX only, through
  `ownProcessGroup`). Sessions, check steps and every other child stay in xezar's group, because a
  group loses the terminal's Ctrl+C.
- **Shutdown.** Windows has no SIGTERM a handler can catch – a kill from another process ends xezar
  on the spot, with no cleanup – so `serve` stops only from its console. `shutdownSignals` adds
  SIGBREAK (Ctrl+Break) and SIGHUP (the window closing, which leaves about 5 seconds – 5000 ms by
  default) to SIGINT and SIGTERM. `exitAfterStoppingTrees` first holds every `RunManager`
  (`holdForExit`: no further run-state writes, no new spawn), then stops the tracked trees for at
  most 8 s while the rest of the shutdown runs, so running tasks resume on the next start as they
  do on POSIX. Closing the window leaves only about 5 s, so on a busy machine it can end xezar
  before every started program is stopped; Ctrl+C or Ctrl+Break waits for the full cleanup. The
  gate lease forwards the same signals to its command through `stopChildTree`. On Linux and macOS
  the exit stays immediate: stopping what `serve`'s children started at shutdown is Windows-only
  (status: `docs/STATUS.md`).
- **The guard.** `process-spawn-scan.test.ts` fails on a `child_process` reference outside
  `platform/` (a type-only import excepted), a raw `.kill(` outside `platform/` (the liveness probe
  `process.kill(pid, 0)` excepted), a `shell` option that is not literally `false`, an import
  inside `platform/` other than `node:*` or a sibling, and a `process.platform` test outside
  `platform/` (`platform-test`: a comparison either way round, `switch`, `.includes`, or a copy
  into a variable; reading it as a pure helper's trailing default, a `??` fallback or an argument
  stays allowed – the per-OS answer is a `platform/` helper such as `desktop-open.ts` or
  `machine-id.ts`). `platform-test` has no allowance. Its only other allowances are `server/wsl.ts`
  (WSL only) and `server-install/steps.ts` (Linux only), one `child-process-ref` each, and
  `core/qwen-run-config.ts`, two `shell-option` matches that are one key of the Qwen Code settings
  file, not a process option (#1076), all counted in both directions. Route a new call through the
  layer instead of adding an allowance.
