#!/bin/sh
# xez-prepare-test-env: generated entrypoint (contract v2)
# regenerate with: xez-prepare-test-env --regenerate
# history:
#   2026-07-14 generated — mirrors test-env-up.sh; no services to remove, so this
#             only stops the app PID this repo started and marks the descriptor stopped.
#   2026-10-10 Git Bash on Windows: the recorded pid is node's Windows pid, stopped with taskkill
#             (that exact pid and its tree); POSIX behaviour is unchanged.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
QA_DIR="$REPO_ROOT/.local/qa"
# Compatibility: an old-path process must still be stoppable before migration.
if [ ! -f "$QA_DIR/test-env.json" ] && [ -f "$REPO_ROOT/.ai/qa/test-env.json" ]; then
  QA_DIR="$REPO_ROOT/.ai/qa"
fi
ENV_DESCRIPTOR="$QA_DIR/test-env.json"

log() { echo "[test-env] $*" >&2; }

[ -f "$ENV_DESCRIPTOR" ] || { log "no descriptor — nothing to stop"; exit 0; }

pid=$(node -e '
  const fs = require("fs");
  try {
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (d.startedByThisRepo && d.app && d.app.pid) process.stdout.write(String(d.app.pid));
  } catch { /* corrupt descriptor → nothing safe to stop */ }
' "$ENV_DESCRIPTOR" 2>/dev/null || true)

# Git Bash (MSYS) on Windows: the descriptor holds node's WINDOWS pid, which the shell's own
# `kill` does not know, and a native program gets no catchable stop signal.
case "$(uname -s 2>/dev/null || true)" in
  MINGW*|MSYS*) ON_WINDOWS=1 ;;
  *) ON_WINDOWS=0 ;;
esac
win_alive() {
  node -e 'try { process.kill(Number(process.argv[1]), 0) } catch (e) { process.exit(e.code === "EPERM" ? 0 : 1) }' "$1" 2>/dev/null
}

# Only ever stop what this repo started; safe to run twice.
if [ "$ON_WINDOWS" = 1 ]; then
  if [ -n "$pid" ] && win_alive "$pid"; then
    log "stopping xezar (pid $pid)"
    # Exactly the recorded pid and the processes it started, by taskkill's full System32 path —
    # never by image name or pattern.
    if [ -n "${SYSTEMROOT:-}" ]; then
      "$SYSTEMROOT/System32/taskkill.exe" //PID "$pid" //T //F >/dev/null 2>&1 || true
    else
      log "SYSTEMROOT is not set — cannot reach taskkill to stop pid $pid"
    fi
    waited=0
    while win_alive "$pid" && [ "$waited" -lt 10 ]; do
      sleep 1
      waited=$((waited + 1))
    done
  else
    log "app is already stopped"
  fi
elif [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  log "stopping xezar (pid $pid)"
  kill "$pid" 2>/dev/null || true
  waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -9 "$pid" 2>/dev/null || true
else
  log "app is already stopped"
fi

node -e '
  const fs = require("fs");
  const f = process.argv[1];
  try {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    d.status = "stopped";
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
  } catch { /* leave a corrupt descriptor alone — up will treat it as stale */ }
' "$ENV_DESCRIPTOR"

rm -rf "$QA_DIR/test-env.lock" 2>/dev/null || true
echo "TEST_ENV_STATUS=stopped"
