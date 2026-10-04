#!/usr/bin/env bash
# Start the project leader: a Claude Code session attached to this project's xezar engine.
#
# The flag below is `--dangerously-load-development-channels`. It lets the xezar MCP server push
# events straight into the leader session. Without it the leader falls back to polling. The vendor
# put the word "dangerously" in the name on purpose, and Claude Code shows a warning on every
# launch: only run this against a server you trust. The server here is the `xezar` entry in
# `.mcp.json`.
#
# This script starts nothing but the session. It never starts the engine and never installs a
# skill: it says what is missing and stops, or warns and carries on.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# The engine names its socket after the project id, not the folder: lower-cased, with other
# characters turned into '-', sometimes a '-2' suffix, or a hash for a long path. So accept any
# socket in the ipc folder, which in single-project mode belongs to this project alone.
socket=""
for candidate in .local/xezar/ipc/*.sock; do
  if [ -S "$candidate" ]; then
    socket="$candidate"
    break
  fi
done

# Native Windows (Git Bash): the engine listens on a named pipe, which is not a file here. It
# names the pipe, alone on one line, in `.local/xezar/ipc/<id>.pipe` (the engine's Windows contract
# is still a draft). A marker is data: node reads it, takes only a pipe name of the engine's shape
# and never runs it. A pipe that does not answer within a second is stale and skipped; a marker is
# never deleted, because the engine replaces its own on the next start. Two live pipes mean two
# engines: the newest marker is taken, with a warning.
pipe_probe='
const fs = require("node:fs");
const net = require("node:net");
const PIPE_NAME = /^\\\\\.\\pipe\\xezar-mcp-[0-9a-f]{32}$/;
const MARKER_MAX_BYTES = 256;
const ANSWER_MS = 1000;
function marker(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MARKER_MAX_BYTES) return null;
    const name = fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
    return PIPE_NAME.test(name) ? { file, name, mtime: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}
function answers(pipe) {
  return new Promise((resolve) => {
    const client = net.connect(pipe.name);
    const settle = (live) => { clearTimeout(timer); client.destroy(); resolve(live ? pipe : null); };
    const timer = setTimeout(() => settle(false), ANSWER_MS);
    client.once("connect", () => settle(true));
    client.once("error", () => settle(false));
  });
}
Promise.all(process.argv.slice(1).map(marker).filter(Boolean).map(answers)).then((found) => {
  const live = found.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  if (live.length > 1)
    console.error(`xezar-leader: warning: ${live.length} engine pipes answer in .local/xezar/ipc/; taking the newest, ${live[0].file}. Stop the engine you did not mean to run.`);
  if (live.length) console.log(live[0].file);
});
'
if [ -z "$socket" ]; then
  # Git Bash (MSYS) or Cygwin: the same test as the kit's checks/lib/common.sh and repo-gates.sh.
  case "${OSTYPE:-}" in
    msys* | cygwin*)
      for candidate in .local/xezar/ipc/*.pipe; do
        [ -f "$candidate" ] || continue
        if ! command -v node >/dev/null 2>&1; then
          echo "xezar-leader: node is not on PATH, so the engine's pipe cannot be checked." >&2
          exit 1
        fi
        socket="$(node -e "$pipe_probe" .local/xezar/ipc/*.pipe)" || socket=""
        break
      done
      ;;
  esac
fi

if [ -z "$socket" ]; then
  echo "xezar-leader: the engine is not running here (no socket in .local/xezar/ipc/)." >&2
  echo "  Start it in its own terminal, in this folder, and leave it open:" >&2
  echo "    xezar --single-project --no-open" >&2
  exit 1
fi

# The xez-* skills are installed per machine, not committed. Warn, never install.
if [ ! -e ".claude/skills/xez-add-rule" ]; then
  echo "xezar-leader: the xez-* skills are missing in this clone. AGENTS.md says how to get them." >&2
fi

# One leader per project, and the engine has no takeover. If the session reports that the project
# is occupied, close the other Claude Code session in this folder and start this script again.

# XEZAR_LEADER=1 is what tells the SessionStart hook that THIS session is the leader. Any other
# session in the checkout gets no leader guide.
export XEZAR_LEADER=1
# --settings loads the leader's own permission to merge a PR. A project .claude/settings.json rule
# would reach every agent, read-only reviewers included, and Claude Code reads auto mode's allow
# list only from user settings or this flag, never from the project's own settings.
exec claude --dangerously-load-development-channels server:xezar --settings scripts/xezar-leader-settings.json "$@"
