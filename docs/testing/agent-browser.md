# Browser provider: agent-browser

This document defines the local, self-provisioning `agent-browser` provider
used by the UI test environment. It uses native release binaries and
Chrome for Testing. It never requires Node, a project package manager, a
preinstalled browser, or a cloud-browser account.

## Prerequisites

- Network access to GitHub Releases and the Chrome-for-Testing download host on
  first install. Warm runs reuse the cached binary and browser.
- Supported release targets: macOS x64/arm64; Linux glibc or musl x64/arm64;
  Windows x64. WSL2 uses the matching Linux target. Windows on ARM may use the
  x64 binary only when the operating system's x64 compatibility layer is active.
- Linux Chrome libraries may require root. The operation below performs the
  install itself when already root or passwordless elevation is available; it
  never delegates commands to the operator.
- Two caches, two locations: the CLI binary lives at
  `$XDG_CACHE_HOME/agent-tools/agent-browser`, the browser itself at
  `~/.agent-browser/browsers`. Only `browsers/` is safe to restore from a cache —
  the rest of `~/.agent-browser` is sockets and per-session state, and CI caches
  exactly those two paths for that reason.

## Operations

### ensure-installed

Use an existing healthy `agent-browser` from `PATH`; otherwise install the
official native release in a per-user cache. Do not add binary files to the
repository.

POSIX shell (macOS, Linux, WSL2, Git Bash/MSYS):

```bash
if command -v agent-browser >/dev/null 2>&1; then
  AGENT_BROWSER_BIN=$(command -v agent-browser)
else
  CACHE_ROOT=${XDG_CACHE_HOME:-"$HOME/.cache"}
  TOOL_DIR="$CACHE_ROOT/agent-tools/agent-browser"
  mkdir -p "$TOOL_DIR"
  OS=$(uname -s 2>/dev/null || echo unknown)
  ARCH=$(uname -m 2>/dev/null || echo unknown)
  case "$ARCH" in x86_64|amd64) ARCH=x64 ;; arm64|aarch64) ARCH=arm64 ;; *) ARCH=unsupported ;; esac
  case "$OS" in
    Darwin) ASSET="agent-browser-darwin-$ARCH" ;;
    Linux)
      LIBC=linux
      (ldd --version 2>&1 || true) | grep -qi musl && LIBC=linux-musl
      ASSET="agent-browser-$LIBC-$ARCH"
      ;;
    MINGW*|MSYS*|CYGWIN*) ASSET=agent-browser-win32-x64.exe ;;
    *) ASSET=unsupported ;;
  esac
  case "$ASSET" in *unsupported*) echo "Unsupported agent-browser target: $OS/$ARCH" >&2; exit 1 ;; esac
  AGENT_BROWSER_BIN="$TOOL_DIR/$ASSET"
  if [ ! -x "$AGENT_BROWSER_BIN" ]; then
    URL="https://github.com/vercel-labs/agent-browser/releases/latest/download/$ASSET"
    TMP="$AGENT_BROWSER_BIN.tmp.$$"
    if command -v curl >/dev/null 2>&1; then curl -fL --retry 3 --connect-timeout 30 --max-time 600 -o "$TMP" "$URL"
    elif command -v wget >/dev/null 2>&1; then wget -T 30 -t 3 -O "$TMP" "$URL"
    else echo "No built-in HTTP downloader is available" >&2; exit 1
    fi
    chmod 755 "$TMP"
    mv "$TMP" "$AGENT_BROWSER_BIN"
  fi
fi

"$AGENT_BROWSER_BIN" install
if ! "$AGENT_BROWSER_BIN" doctor --json >/dev/null 2>&1; then
  if [ "$(uname -s 2>/dev/null || true)" = Linux ]; then
    if [ "$(id -u)" = 0 ]; then
      "$AGENT_BROWSER_BIN" install --with-deps
    elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      sudo -n "$AGENT_BROWSER_BIN" install --with-deps
    fi
  fi
fi
if "$AGENT_BROWSER_BIN" doctor --json >/dev/null; then
  printf 'BROWSER_PROVIDER=agent-browser\nBROWSER_INSTALLED=1\nBROWSER_COMMAND=%s\nBROWSER_VERSION=%s\nBROWSER_NOTES=\n' \
    "$AGENT_BROWSER_BIN" "$("$AGENT_BROWSER_BIN" --version 2>/dev/null || echo unknown)"
else
  printf 'BROWSER_PROVIDER=agent-browser\nBROWSER_INSTALLED=0\nBROWSER_COMMAND=%s\nBROWSER_VERSION=unknown\nBROWSER_NOTES=live browser launch failed after autonomous install\n' "$AGENT_BROWSER_BIN"
  exit 1
fi
```

Native Windows PowerShell:

```powershell
$onPath = Get-Command agent-browser -ErrorAction SilentlyContinue
if ($onPath) { $AgentBrowser = $onPath.Source }
else {
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  if ($arch -notin 'X64','Arm64') { throw "Unsupported agent-browser Windows architecture: $arch" }
  $toolDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'agent-tools/agent-browser'
  New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
  $AgentBrowser = Join-Path $toolDir 'agent-browser-win32-x64.exe'
  if (-not (Test-Path $AgentBrowser)) {
    $url = 'https://github.com/vercel-labs/agent-browser/releases/latest/download/agent-browser-win32-x64.exe'
    $tmp = "$AgentBrowser.tmp.$PID"
    if ($PSVersionTable.PSVersion.Major -lt 7) {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    }
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 -Uri $url -OutFile $tmp
    Move-Item -Force $tmp $AgentBrowser
  }
}
& $AgentBrowser install
& $AgentBrowser doctor --json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'agent-browser live browser launch failed after autonomous install' }
$version = (& $AgentBrowser --version 2>$null)
"BROWSER_PROVIDER=agent-browser"
"BROWSER_INSTALLED=1"
"BROWSER_COMMAND=$AgentBrowser"
"BROWSER_VERSION=$version"
"BROWSER_NOTES="
```

### doctor

```bash
"$AGENT_BROWSER_BIN" doctor --json
```

PowerShell: `& $AgentBrowser doctor --json`.

### open

Use a unique, validated session id such as `qa-<runId>`:

```bash
"$AGENT_BROWSER_BIN" --session "$BROWSER_SESSION" open "$BASE_URL" --json
```

### snapshot

```bash
"$AGENT_BROWSER_BIN" --session "$BROWSER_SESSION" snapshot -i --json
```

### interact

Use only a ref returned by the latest snapshot:

```bash
"$AGENT_BROWSER_BIN" --session "$BROWSER_SESSION" click "$ELEMENT_REF" --json
"$AGENT_BROWSER_BIN" --session "$BROWSER_SESSION" fill "$ELEMENT_REF" "$VALUE" --json
```

Other actions use the matching CLI command shown by
`"$AGENT_BROWSER_BIN" --help`; never interpolate untrusted shell fragments.

### assert

Use JSON output and compare the observed value in the current shell. Examples:

```bash
"$AGENT_BROWSER_BIN" --session "$BROWSER_SESSION" get text "$ELEMENT_REF" --json
"$AGENT_BROWSER_BIN" --session "$BROWSER_SESSION" get url --json
"$AGENT_BROWSER_BIN" --session "$BROWSER_SESSION" is visible "$ELEMENT_REF" --json
```

### screenshot

```bash
SCREENSHOT_DIR=$(dirname "$SCREENSHOT_PATH")
mkdir -p "$SCREENSHOT_DIR"
ABS_SCREENSHOT_PATH=$(cd "$SCREENSHOT_DIR" && pwd)/$(basename "$SCREENSHOT_PATH")
"$AGENT_BROWSER_BIN" --session "$BROWSER_SESSION" screenshot --full "$ABS_SCREENSHOT_PATH" --json
test -s "$ABS_SCREENSHOT_PATH"
```

The absolute path avoids the CLI treating a relative multi-segment path as a
selector. PowerShell resolves it with
`[IO.Path]::GetFullPath($ScreenshotPath)`, creates the parent directory, then
checks `Test-Path` and a non-zero file length.

### close

```bash
"$AGENT_BROWSER_BIN" --session "$BROWSER_SESSION" close --json 2>/dev/null || true
```

In PowerShell, run the same arguments with `& $AgentBrowser` in `finally` and
ignore only an already-closed-session error.

## Rules

- Run `agent-browser skills get core` when available before a complex scenario
  so interaction guidance matches the installed CLI version.
- Use a unique session per QA/test run. Never attach to a user's normal browser
  profile unless the operator explicitly requested that profile.
- Keep all operation targets local to the application under test. Do not enable
  a cloud provider or send credentials to a remote browser service.

## Running this repository's suite

`AGENTS.md` § Validation owns the command, the exit contract and the four limits a spec
must not assume past. What follows is the operating detail that lived there until it grew
too long for a file every session loads.

### What the boot pins, and why

`XEZ_HOME` pins what xezar *writes* (`.local/qa/xez-home`). `CLAUDE_CONFIG_DIR`,
`CODEX_HOME` and `OPENCODE_CONFIG_DIR` pin the user-scope files it *reads*
(`.local/qa/agent-home/*`, mode 0700, wiped on every cold boot). `ANTHROPIC_MODEL` is
unset because it outranks every settings file.

That last one matters because the cockpit seeds each runner's model from that agent's own
settings file by design. Without the unset, a developer with opencode configured boots the
suite with their own model pre-filled, and a spec asserting an unset model fails on their
machine while passing in CI.

The pins are part of the reuse fingerprint (`environment.agentHome` in the descriptor), so
an instance booted with different pins is never reused — the same rule
`environment.singleProject` already follows. Three of those vars are what
`agentHomePaths()` honours (`packages/xezar/src/paths.ts`, precedence pinned by
`paths.test.ts`); `XEZ_HOME` is separate and pins only what xezar itself writes.
`agentHomePaths()` has a fourth slot, pi, and it CAN be pinned — pi documents
`PI_CODING_AGENT_DIR` and reads it, and `agentHomePaths().pi` resolves through it
(re-verified against pi 0.85.1 on 2026-09-12, #329). The boot does not set it yet, so today the suite still starts pi from
the developer's own `~/.pi/agent`. Pinning it is a deliberate follow-up, not a one-line
addition, and takes three coordinated changes:

1. `export PI_CODING_AGENT_DIR="$QA_DIR/agent-home/pi"` alongside the other three in
   `scripts/test-env-up.sh`, plus the matching `mkdir -p` / `chmod 700`.
2. `AGENT_HOME_FINGERPRINT` gains it, so an instance booted without the pin is not reused
   by a run that expects it — the same rule the other three already follow.
3. A decision on seeding. The other three sandboxes are empty on purpose, because empty is
   what makes "no model default leaks in" true. pi is not symmetric there: it resolves its
   model list through `packages/xezar/src/core/pi-model-catalog.ts`, reading `models.json`
   (and `settings.json` for ordering) out of that same home, so an empty pin does not give pi
   a blank config — a missing `models.json` is the documented "no providers configured" path
   and returns `[]`, i.e. the picker shows `auto` alone. That is a different starting state
   than any spec currently assumes. Whether the pinned dir ships a fixture catalog or the
   specs assert the empty case is the open question, and it needs its own test surface.

A fifth agent home that does have a variable needs adding to `test-env-up.sh` too.

**A repository that runs in single-project mode is booted in the pinned global layout anyway.**
Once `.xezar/workspace.json` is committed, a plain clone of this repository is a single-project
root — the folder decides, with no flag — and the mode never opens `XEZ_HOME`
(`docs/guide/11-configuration-reference.md`). The shared suite is written against the global layout:
the multi-project shell, the shipped defaults rather than the repository's own committed
`workspace.json`, and state a test run is allowed to rewrite. So `scripts/test-env-up.sh` starts the
app with the explicit `--global-layout` input (`#657`), which outranks the marker: the app is TOLD
which layout to resolve instead of the marker being moved out from under it, so the launcher renames,
moves and writes **nothing** in the repository root, and a crash cannot leave the checkout in the
wrong layout. `environment.singleProjectRoot` and `environment.stateLayout` record both halves in the
descriptor — the marker the checkout carried, and the layout the launcher asked for — so an instance
booted under the other condition is never reused. Task worktrees are unaffected: a linked worktree is
never a single-project root.

**Team skills are the other thing the boot does not isolate.** The shared instance and every
fixture server boot with the default `skillsRepos`, so they clone `qodeca/xezar-skills` into
`~/.cache/xez/skills/` in the background and the 37 `xez-*` skills appear in the catalog whenever
the clone has finished – which depends on network timing, not on the spec. Two rules follow:

- `fixtureServeEnv` sets `XEZ_SKILLS_AUTO_UPDATE=0` (`packages/web/e2e/agent-browser.ts`), so a
  boot inside the six-hour update window never installs the collection into the fixture repo.
- A spec that asserts on the skill list (the picker, the composer autocomplete, a search ranking)
  writes `.xezar/config.json` with `{ "skillsRepos": [] }` into its fixture repo, as
  `skill-search-ranking.e2e.ts` does. The picker's subsequence matcher lets a long team-skill
  description satisfy almost any query, so "no team skills" is the only deterministic state.

**Multi-project registry specs.** The shared env's registry is pinned to the single-project
shape for the whole run (`workspace-registry.ts`'s `globalSetup`), so a spec that wants the
grouped multi-project sidebar seeds its own throwaway registry and restores it in `afterAll`
through that module's `snapshotSharedHome` / `writeSharedProjects` helpers. Two specs do this
today: `project-groups.e2e.ts` (the sidebar's own grouping, ordering and collapse behaviour) and
`project-switching.e2e.ts` (clicking from one registered project into another, a cross-project
task opening at its own project from All tasks, and a registered-but-missing project's inert
row). Because `fileParallelism: false` runs every spec in this suite one at a time, neither needs
to know the other seeds the same file — but a THIRD spec doing the same must still restore the
registry it found, not the single-project default, or it silently undoes whichever of the two
ran first.

### Runtime ceilings

The suite's two runtime ceilings are anchored to one measured run and rounded up from it, not to a
target. Both use the same run: CI run 35512713688 (head `ce02630c`, 2026-09-20), the whole suite at
**66 `*.e2e.ts` files**, reporting `Test Files 66 passed (66)`,
`Tests 453 passed | 6 skipped (459)` and `Duration 996.22s` — 17 min 26 s of its job's 30-minute
budget.

- **Whole suite: 1 200 s.** 996.22 s measured on the GitHub-hosted x64 runner times 1.2 —
  996.22 × 1.2 = 1 195.5, rounded up to 1 200. The 20 % is a chosen margin, not a measured spread:
  the second recorded whole-suite measurement, 433.71 s at 53 files locally on Apple silicon, is
  context for the 2.3× local-versus-CI gap, not the derivation, and it is exactly why this number
  must never be read as a runner-speed allowance. It is headroom for a slower runner, never a
  target. `npm run test:e2e` is the command it bounds.
- **Any single `*.e2e.ts` file: 60 s.** Roughly 2× the worst real file, `screenshot-states.e2e.ts`
  at 30.9 s (the worst guide file is `guide-02-running-a-task.e2e.ts` at 14.0 s). It coincides
  with the per-test `testTimeout: 60_000` in `packages/web/e2e/vitest.config.ts`, which bounds one
  test and one hook — never a whole file, which is why the per-file ceiling is stated separately.
- **The CI job: 30 min, unchanged.** `.github/workflows/ci.yml`'s `ui-e2e` job
  (`timeout-minutes: 30`) is a ceiling rather than a target: a suite that needs more is a
  regression worth failing on.

**The suite's stability rule (AC-5 of #549, as amended 2026-09-20).** A flaky browser spec is
**rebuilt**, never quarantined: rebuild the wait on real state. Never a retry, a `.retry`, a
sleep, a widened timeout, or a register. A red `ui-e2e` job that names a spec is evidence rather
than noise — two reds a re-run appeared to clear in this suite turned out to be deterministic
failures.

One pre-existing exception predates this rule and the rule does not reach it: `guide-browser.ts`'s
`clickRoleWhenStable` (`packages/web/e2e/guide-browser.ts:279`) retries a covered click in a loop
(40 attempts, 250 ms apart, default) as a bounded stability poll on real geometry — not a re-run of
a failed test — and `packages/web/src/e2e-guide-browser-retry.test.ts` pins that retry. It is named
here rather than changed: this rule governs the waits the suite adds, and that helper is older than
it.

`packages/web/src/e2e-runtime-ceiling.test.ts` holds both ceiling lines and every documented
`*.e2e.ts` file count to the directory: it goes red when a ceiling line disappears, and when any
document that states the count disagrees with `readdirSync` over `packages/web/e2e/`. It fails on
an empty directory rather than passing vacuously, so a glob that stops matching is a failure and
not a silent green.

### Recorded runs

AC-5 of #549 (as amended 2026-09-20, see the ceiling paragraph above) asks for three green local
runs plus the CI run. The table below is the honest result of the PR-549-D re-measurement at one
head, run one after another on the same machine, `npm run test:e2e` never invoked twice at once
and the harness stopped with `scripts/test-env-down.sh` between runs: **two of the three default-order
runs came back red**, on two different files, neither of them repeated verbatim — the three-green
criterion is not met by this measurement. Both red files are pre-existing, order-independent specs
outside the guide-flow package (`skills-update.e2e.ts`, `guide-03-worktrees-and-git.e2e.ts`); per the
owner's 2026-09-20 21:02 rule, a red file that names itself is evidence for #671 and is neither
retried nor fixed here.

| Head SHA | Date | Order / seed | Files | Tests passed / skipped / failed | Seconds | Marker |
| --- | --- | --- | --- | --- | --- | --- |
| `fee89d0c`¹ | 2026-09-20 | default | 66 (1 failed) | 452 / 6 / 1 | 637.79 | `TEST_E2E_STATUS=failed` |
| `fee89d0c` | 2026-09-20 | default | 66 (2 failed) | 451 / 6 / 2 | 634.79 | `TEST_E2E_STATUS=failed` |
| `fee89d0c` | 2026-09-20 | default | 66 (0 failed) | 453 / 6 / 0 | 603.43 | `TEST_E2E_STATUS=passed` |
| `fee89d0c` | 2026-09-20 | shuffled, seed `482917365` | 66 (23 failed) | 407 / 6 / 46 | 938.97 | n/a — direct `vitest run --sequence.shuffle`, not through `scripts/e2e.sh`, so no `TEST_E2E_STATUS` marker |

¹ Run 1's own log records both: `head=fee89d0c… (origin/main; worktree HEAD 5af6644f… differs
only in the unrelated register-test fix)`. The `Head SHA` column above states the `origin/main`
head every row anchors to for comparability; run 1's own worktree was actually one commit ahead of
it, at `5af6644f`, a style-only fix to `packages/web/src/e2e-dry-run-register.test.ts` (see the
Regression/control note in the dogfooding fragment for this task) that touches no browser-suite
file. Runs 2–4 ran with no worktree diff from `fee89d0c` — their own `START` lines record one head,
not two.

All four runs are well inside the 1 200 s whole-suite ceiling above. The two default-order failures:
run 1 failed only `skills-update.e2e.ts` ("shows the inherited global preference and persists an
explicit override"); run 2 failed the same test at a different assertion line plus
`guide-03-worktrees-and-git.e2e.ts` ("Settings → Worktrees starts empty and Reclaim now opens the
AlertDialog confirm") — the same spec failing at two different points across two runs is itself
evidence of a race rather than a deterministic break, consistent with #671's own framing. The
shuffled run's 23 failing files and their first failing assertion each are below, read from
`.local/xezar/tasks/700f23bf-97bd-4913-88b8-b4a18f1f6e39/runs/shuffled-1.log` (primary checkout);
`docs/testing/coverage-gaps.md` row P names the same 23 files and this measurement's summary, and
points back here for the assertions rather than duplicating them. They are pre-existing files
outside the guide-flow package's authority, evidence for #671, not retried or fixed here.

| File | First failing test | First failing assertion |
| --- | --- | --- |
| `settings-bookmarklets.e2e.ts` | "the generic launcher bakes the protected /new grammar with the server real launch key" | `wait --fn` timed out: `[data-slot="bm-generic"] [data-slot="bm-link"]` never appeared (0 nodes) |
| `queued-stack.e2e.ts` | "removes the stacked message" | `click [aria-label="Remove message"]` failed |
| `plan-mode.e2e.ts` | "Plan first selects visibly (#383) and submit produces the review overlay, not a run" | `click [data-slot="sidebar"] a[href="/p/xezar-e2e-plan-l1hxav/new"]` failed |
| `task-files.e2e.ts` | "a directory expands lazily and its TypeScript file previews with Shiki tokens" | `eval` of `[data-slot="files-dir"][data-path="src"]`'s `.dataset.state` failed |
| `settings-appearance.e2e.ts` | "compact density measurably tightens the spacing scale" | `AssertionError: expected 70 to be 56` |
| `thread-scroll.e2e.ts` | "auto mode virtualizes past the threshold and keeps the DOM bounded" | `AssertionError: expected 19 to be less than 0` |
| `task-thread.e2e.ts` | "the plan dock shows the LATEST snapshot (2/4), expanded on desktop, mirrored in the header" | `AssertionError: expected 'collapsed' to be 'open'` |
| `variants-compare.e2e.ts` | "expanding a full diff shows the review gate's per-file cards for THAT variant" | `wait --fn` timed out: `[data-slot="variant-diff"]` count never reached 2 |
| `mcp-collaboration.e2e.ts` | "B-03 (A-08, A-06) [I-019] a pin the human sets is the pin the leader reads, and the leader's unpin shows live in the human's header" | `wait --fn` timed out: `[data-slot="run-actions"] [data-slot="pin-run"]`'s `aria-pressed` never reached `'false'` |
| `tools-menu.e2e.ts` | "routes the cog row to Settings → Agents and closes the menu" | `eval` of `[data-slot="tools-menu-content"] [data-slot="tools-settings"]`'s `href` failed |
| `settings-agents.e2e.ts` | "a cold load renders the persisted knobs — the form is a view of config.json" | `AssertionError: expected +0 to be 1` |
| `guide-02-running-a-task.e2e.ts` | "thread output: the running turn is visible as agent text and real tool activity" | `Error: Test timed out in 30000ms.` |
| `composer.e2e.ts` | "waiting state: paused hint pulses above an enabled composer with the reply placeholder" | `is visible [aria-label="Start dictation"]` failed |
| `progressive-history.e2e.ts` | "paints the current tail and docks without requesting an earlier page" | `AssertionError: expected 2 to be +0` |
| `commit-list.e2e.ts` | "mounts rows that cover the viewport after scrolling (startMargin is real)" | `wait --fn` timed out: the scroll-`[data-slot="main"]`-to-1500-then-look-for-`[data-slot="commit-row"]` predicate never turned true |
| `review-gate.e2e.ts` | "shows the banner and the real worktree diff as per-file sections" | `get text [data-slot="review-banner"]` failed |
| `new-task.e2e.ts` | "the pill row resolves: no source picked, runner pill by the choice rule, base: main, ×1" | `AssertionError: expected 'skill' to be 'none'` |
| `single-project.e2e.ts` | "boots in the mode because the folder carries its state — no flag, no host setup (SP-5.4)" | `AssertionError: expected 4 to be 3` |
| `workflows.e2e.ts` | "reorders steps with the keyboard (dnd-kit defaults: Space lifts, arrows move, Space drops)" | `eval`'s `.focus()` on `[data-slot="wb-step"][data-id="e2e-wb-alpha"] [data-slot="wb-step-grip"]` failed |
| `guide-01-getting-started.e2e.ts` | "Settings → Project setup names the same never-checked state with its own identities" | role "heading" named "Not set up yet" never appeared |
| `diff-scroll.e2e.ts` | "force-virtual holds a viewport window instead of the whole changeset" | `AssertionError: expected 64 to be less than 0` |
| `skills-update.e2e.ts` | "shows the inherited global preference and persists an explicit override" | `AssertionError: expected 'Skill catalog\n\nThe team skills this…' to contain 'On (default)'` |
| `task-changes.e2e.ts` | "Commit: the dialog prefills the auto-summary, commits for real in the worktree" | `click [data-slot="git-toolbar"] [data-action="commit"]` failed |

One default-order attempt at this same head is deliberately not a row above: it was contaminated
by an unrelated `npm test` invocation sharing this task's `$TMPDIR` while the browser suite was
mid-run, which deleted a live SSR transform-cache directory out from under the running suite and
produced 62 spurious file failures with only 99 of the expected ~459 tests even collected. That is
measurement contamination, not suite evidence, so it is recorded as a dogfooding observation
instead of a table row, and the affected run was discarded and re-run cleanly.

**Adding the next row:** run `npm run test:e2e` (or the shuffled invocation above) to completion,
record the head SHA, the file/test counts and `Duration` from vitest's own summary, and the
`TEST_E2E_STATUS` marker (or `n/a` for a direct `vitest` invocation), then append — never edit —
a new row with that data.

### The user-guide flow package

`packages/web/e2e/guide-*.e2e.ts` — one file per `docs/guide/` part, plus the shared
`guide-browser.ts` helper — walk the flows each guide describes as a first-time reader would
follow them, asserting only role, accessible-label or visible-text facts (never a class, id,
`data-*` attribute or other selector coupled to implementation markup). `guide-01-getting-started.e2e.ts`,
`guide-03-worktrees-and-git.e2e.ts`, `guide-05-workflows.e2e.ts`, `guide-06-skills.e2e.ts`,
`guide-07-github-automations.e2e.ts` and `guide-08-inbox-notifications.e2e.ts` each boot their own
spec-owned fixture server rather than the shared instance, so a feature flag one guide needs
(`XEZ_AUTOMATIONS=1`, `XEZ_FOLLOWUPS=1`) never changes what another guide's test observes. Guide 09
has no `guide-09-*.e2e.ts` file: `project-switching.e2e.ts` already proves its one browser-only
journey (switching between registered projects, a cross-project task opening at its own project
from All tasks, and a registered-but-missing project's inert row), and the remaining guide-09
flows (tags, Max parallel, the Add-project dialog) are settings-only mutations already covered at
jsdom level (`projects-section.test.tsx`, `clone-project-dialog.test.tsx`, `global-tasks.test.tsx`)
with no additional browser-only risk to prove. Each file's own header names the flows that cannot
honestly cross a real boundary in dry-run and the lower-level or manual evidence that covers them
instead. `guide-browser.ts` wraps `agent-browser find <locator> <value> [action]` — the CLI's own
semantic-locator command — rather than the CSS-selector methods on `AgentBrowser`; it is the one
new interaction helper this package adds, and existing specs are not retrofitted to it.

**The locator rule has a guard.** `packages/web/src/e2e-locator-rule.test.ts` reads the source of
every file in this package — the 15 `guide-*.e2e.ts` files and `screenshot-states.e2e.ts` — and
fails on `querySelector`, `getElementById`, `data-testid` or a `data-slot` string outside a
comment, plus a CSS-selector-shaped string (`#id`, `.class`, `[aria-label=…]`, `[data-state=…]`,
`:nth-child(…)`) handed to one of `AgentBrowser`'s selector methods (`click`, `fill`, `hover`,
`text`, `isVisible`, `count`) — the four tokens alone would let every one of those through. It
distinguishes a comment from code with a small scanner that blanks `//` and `/* … */` comments
while keeping string literals (a CSS selector is usually a string) and template-literal `${…}`
interpolation, so the four prose mentions of `data-slot` in the package's own headers stay legal
while a `click('[data-slot="…"]')` does not; it pins the empty-input branch, so a glob that
matches no files fails the test rather than passing vacuously. What it still cannot see: a locator
assembled at runtime from pieces no single source line contains; a `data-slot` reached through an
imported helper; a selector passed to a method it does not know (`evaluate`, a helper); and a
regex literal whose trailing `//` blinds the rest of its own line. `capture/scenario-state.ts`'s
61 `data-slot` occurrences are disclosed at `screenshot-states.e2e.ts:26-29` as DOM-ready steps
relocated from the 0.15.0 capture plan rather than new locators, and the guard records that file
as an explicit exclusion with its reason and an upper bound on its `data-slot` count, so a new
locator there goes red instead of hiding behind the exclusion — an auditable exclusion list, never
a silent skip. The 50 pre-existing specs outside this package predate the rule and are out of its
scope, which is why the guard scans the package's 16 files and not every `*.e2e.ts`.

**A `role="status"` loading line needs an `aria-label`, or the wait on it is silently vacuous.**
`status` is not a name-from-content role, so a `<p role="status">Loading …</p>` computes an EMPTY
accessible name and `agent-browser find role status … --name "Loading …"` matches nothing:
`2 elements have role "status", but none match name "Loading …". Names seen: ""`. A
`waitForRoleGone('status', …)` against that region therefore returns on its first attempt, while
the indicator is still on screen — a wait that reads as a wait and is not one. Measured on #671's
`worktrees-panel.tsx` fix: with the label the redesigned assertion is green against a component
holding its query back 3 s, without it the same spec is red at the same line. Give any pending
region a guide spec waits on its own `aria-label`, and prove the wait red without it.

### Iterating on one spec

The `npm run test:e2e` wrapper takes no file filter, so iterating on ONE spec means booting
the environment once and then running vitest against it directly — still through `npm`,
never `npx`:

```bash
sh scripts/test-env-up.sh                                    # boot once, reuse
npm test -- --config packages/web/e2e/vitest.config.ts thread-scroll
npm test -- --config packages/web/e2e/vitest.config.ts github -t "opens an issue"
sh scripts/test-env-down.sh                                  # always, when finished
```

`XEZ_DRY_RUN=1 npm run dev` still exercises the whole cockpit offline for manual
verification.

### Three rules the suite learned the hard way

- **Never edit a spec — or anything it imports — while a run is in flight.** Files are
  loaded as the run reaches them, so an edit part-way through leaves the specs that have
  already started holding the old module and the ones that have not seen the new one. The
  result is a wave of failures that have nothing to do with the change, in files the change
  never touched.
- **Tear a fixture server down through the shared helpers** (`stopFixtureServer` /
  `removeDataRoot` in `packages/web/e2e/agent-browser.ts`). `kill()` only delivers the
  signal: a server still flushing its NDJSON races `rmSync` and throws `ENOTEMPTY` in a
  suite whose every test passed. The helpers await the exit and retry the removal, and
  still report a directory that genuinely cannot be deleted.
- **A spec's own HTTP never reuses a connection.** `packages/web/e2e/fresh-connections.setup.ts`
  (loaded through `setupFiles`) installs an undici `Agent({ pipelining: 0 })` as the spec
  process's fetch dispatcher, so every `fetch` opens its own socket and sends
  `connection: close`. A spec blocks its event loop in synchronous agent-browser calls, often
  past the server's 5 s keep-alive window; with pooled sockets, whether the next request went
  out on one the server had already closed was a race, lost as `fetch failed` →
  `other side closed` (`UND_ERR_SOCKET`) once CI runners moved to Node 24.21.0 (#671). Do
  not pass a keep-alive `dispatcher` to a spec's `fetch`.

### The user-guide flow package

`packages/web/e2e/guide-*.e2e.ts` — one file per `docs/guide/` part, plus the shared
`guide-browser.ts` helper — walk the flows each guide describes as a first-time reader would
follow them, asserting only role, accessible-label or visible-text facts (never a class, id,
`data-*` attribute or other selector coupled to implementation markup). `guide-browser.ts` wraps
`agent-browser find <locator> <value> [action]` — the CLI's own semantic-locator command — rather
than the CSS-selector methods on `AgentBrowser`; it is the one new interaction helper this package
adds, and existing specs are not retrofitted to it.

`guide-02-running-a-task.e2e.ts` (browser-test pull request 2 of 4, #549) covers guide 02 —
Tasks and runs — as one continuous scripted journey against its own dry-run fixture: compose
through the real `/new` composer, the Worktree/Autonomous/Plan-first mode controls, a run
queueing behind another while the workspace's one agent slot is held, the running turn's thread
output (agent text and a real tool call), a reply round trip, Finish parking the run at review,
the Changes/Files/Commits tabs against the resulting real diff and commit, and the review panel's
Draft PR/Accept hand-off — Draft PR is asserted present, never clicked, because opening a real
pull request is out of honest dry-run scope (see its own header comment for the exact lower-test
citations). Finish runs before the git tabs in this file, not after: Finish is what actually
commits the worktree (`autosaveCommit(dir, 'run finalize')`), so the Commits tab has nothing to
show before it runs, even though the guide documents the two as independent capabilities.

`guide-browser.ts`'s `clickRoleWhenStable(role, name, opts?)` (added in review-response round 3 of
#590) clicks a role/name target only once its own live bounding box has read the same value on two
consecutive polls, retrying past a transient "covered by" click-interception error within the same
bounded attempt budget. Use it — instead of a bare `clickRole` — for any click on a control that
sits in a row where a SIBLING can mount or unmount just beforehand (a right-anchored flex row with
no reserved width shifts every button after the one that (dis)appears, in one synchronous frame);
guide-02's own run-header actions row is the first real example. It needs no coverer named in
advance, unlike a plain geometric overlap check, because a bounded retry on the click itself
already covers an unanticipated coverer too.

`guide-04-providers-models-tools.e2e.ts`,
`guide-10-settings.e2e.ts`, `guide-11-configuration.e2e.ts`, `guide-12-cli-reference.e2e.ts`,
`guide-13-mcp-leader-control.e2e.ts`, `guide-14-local-hosted.e2e.ts`, `guide-15-project-kit.e2e.ts`
and `guide-16-troubleshooting.e2e.ts` cover the guides Batch 5's cockpit restyle does not touch;
`guide-14-local-hosted.e2e.ts` boots its own `XEZ_REMOTE=1` fixture (the shared suite server always
runs local) and the rest reuse the shared instance. Each file's own header names the flows that
cannot honestly cross a real boundary in dry-run and the lower-level or manual evidence that covers
them instead. `guide-browser.ts` wraps `agent-browser find <locator> <value> [action]` — the CLI's
own semantic-locator command — rather than the CSS-selector methods on `AgentBrowser`; it is the
one new interaction helper this package adds, and existing specs are not retrofitted to it.

A **nested-host class** applies to any fixture server that is itself booted by a task this repo's
own xezar is running (every QA, gate and UI-lane task dogfooding this repo): its MCP socket
reliably never opens, so `guide-13-mcp-leader-control.e2e.ts`'s unattached-state case sees the
degraded "service not running" branch rather than the real first-boot reading a bare CI runner
shows — the spec asserts an honest reading in either branch instead of hard-requiring one (#579).

`packages/web/e2e/screenshot-states.e2e.ts` is the package's last file (browser-test-spec.md "PR
4 — screenshot-state contract", Refs #549): one thin consumer of `capture/scenario-state.ts`'s
`SCENARIOS` (see below), asserting every manifest state's visible facts by role, accessible label
or visible text — never a screenshot, never `SCREENSHOT_DIR`. Unlike the guide files above it
does not reuse the shared instance: it boots its own fixture through `capture/cockpit.ts`'s
`bootCockpit()`, the same one the capture harness boots, because the screenshot states need the
Inbox/Automations/review-gate/second-project fixture the shared suite server runs with those
opt-ins off.

### The docs capture harness

`packages/web/e2e/capture/` drives the same provider to produce the README and user-guide
screenshots and the tour GIF in `docs/screenshots/<version>/`. It is **not** a test suite and runs
in no gate: its files end in `.capture.ts`, which the browser suite's `**/*.e2e.ts` include never
collects, and `packages/web/src/e2e-capture-include.test.ts` fails if that stops being true.

```bash
npm run build
npm run capture:screenshots -w @qodeca/xezar-web              # every still, the GIF, the README
npm run capture:screenshots -w @qodeca/xezar-web -- -t inbox  # one state
```

It boots its own dry-run server over a throwaway workspace (with the Inbox, Automations and the
review gate switched on, and a sandboxed `HOME`), seeds it through the API, and writes straight
into the docs folder. The server does not run the bundled test mocks: `XEZ_CLAUDE_BIN`,
`XEZ_CODEX_BIN` and `XEZ_PI_BIN` point at the harness's own scripted agents in `capture/agents/`,
which play each seeded task its own turn through that backend's protocol (`agents/scenarios.mjs`),
so the pictures carry no mock text and no cloned rows. A new seeded task needs a scenario there. The list of states is `packages/web/e2e/capture/manifest.ts`;
`packages/web/src/docs-screenshots.test.ts` holds every listed file to its size budget. No image
tool is required: PNG decoding, palette re-encoding and GIF assembly are `node:zlib` code in
`image-codec.ts`. What it normalises before each capture, and why, is in the generated
`docs/screenshots/<version>/README.md`.

**The seeded workspace and the per-state preparation live in `capture/scenario-state.ts`, not in
`docs-screenshots.capture.ts` itself.** `seedScenario()` is the whole fixture (every task status, a
variant pair, the review-gate run, the second project, the inbox, the automation, the second agent
account) and `SCENARIOS` is one `Scenario` per manifest state — the same `data-slot` navigation and
wait steps the 0.15.0 capture plan always used, now followed, immediately before a state would be
captured, by `expect(...)` assertions that name the state's visible facts using only an ARIA role
with an accessible name, an associated accessible label, or literal visible text (never a class,
id, `data-*` attribute or other selector coupled to markup — the same locator rule the guide
package above follows). `docs-screenshots.capture.ts` calls `SCENARIOS` immediately before
`shoot()`; `screenshot-states.e2e.ts` calls the identical `SCENARIOS` and shoots nothing. One
scenario, two callers, so a preparation change can never leave a picture and its own visible-fact
test disagreeing about what the state shows.
