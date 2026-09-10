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
`agentHomePaths()` has a fourth slot, pi, which has no vendor variable and therefore cannot
be pinned at all. A fifth agent home that does have one needs adding to `test-env-up.sh`
too.

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

### Two rules the suite learned the hard way

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
