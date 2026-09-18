#!/usr/bin/env bash
# SessionStart hook for the project leader session: load the leader guide and the live campaign
# notes into the session at start and after every context compaction.
#
# Prints exactly one JSON hook payload, or nothing at all. The hook is for the LEADER session in
# the primary checkout; a xezar task agent must never receive it, because the guide is irrelevant
# to the work a task was given. It therefore stays silent:
#   - in a linked worktree (`--git-dir` differs from `--git-common-dir`), which is where every
#     task runs by default;
#   - when the path itself is a task worktree (`/.local/xezar/worktrees/`);
#   - whenever xezar set `XEZ_HANDOFF_FILE`, `XEZ_TODOS_FILE` or `XEZ_TASK_ID` for this process,
#     which covers a Worktree-OFF task running in the primary checkout. `XEZ_TASK_ID` is the one
#     that is unconditional and always non-empty; `XEZ_TODOS_FILE` is set to an EMPTY string when
#     follow-ups are off (`run.ts` `agentEnv`), and an empty value reads as absent here, so it is
#     not a signal on its own;
#   - when the guide file is missing, so an older checkout degrades to no output rather than an
#     error.
#
# Exit status is always 0: a hook that fails must not break session start. The escaping is done
# by node, so no guide or note text can produce malformed JSON.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
GUIDE="$REPO_ROOT/.xezar/docs/leader-guide.md"
CAMPAIGNS="$REPO_ROOT/.local/xezar/campaigns"

silent() { exit 0; }

# A xezar task agent, even one running in the primary checkout with Worktree off.
[ -z "${XEZ_HANDOFF_FILE:-}" ] || silent
[ -z "${XEZ_TODOS_FILE:-}" ] || silent
[ -z "${XEZ_TASK_ID:-}" ] || silent

# A task worktree, by path or by git registration.
case "$PWD" in */.local/xezar/worktrees/*) silent ;; esac
case "$REPO_ROOT" in */.local/xezar/worktrees/*) silent ;; esac
git_dir="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
common_dir="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
[ -n "$git_dir" ] && [ "$git_dir" = "$common_dir" ] || silent

# Without the guide there is nothing to load.
[ -f "$GUIDE" ] || silent

# The newest campaign folder under .local/xezar/campaigns, if one exists. Chosen by NAME, not by
# modification time: a restore or a `cp -r` can make an old folder look newest, while the slugs
# (`release-<version>`, dated names) sort stably in reverse.
campaign=""
if [ -d "$CAMPAIGNS" ]; then
  campaign="$(ls -1d "$CAMPAIGNS"/*/ 2>/dev/null | LC_ALL=C sort -r | head -n 1 || true)"
fi

# A campaign note grows for the life of a campaign — `decisions.md` is append-only by contract
# (`.xezar/docs/campaign-notes.md`) — so the two note files, unlike the guide, are bounded to their
# LAST bytes. The leader reads the tail anyway, and a note that was cut is labelled with its own
# path so a partial note is never mistaken for the whole.
NOTE_TAIL_BYTES=8000
note_tail() {
  local file="$1" heading="$2" size
  size="$(wc -c < "$file" 2>/dev/null | tr -d '[:space:]')"
  printf '\n\n=== %s ===\n\n' "$heading"
  if [ "${size:-0}" -gt "$NOTE_TAIL_BYTES" ]; then
    printf '[note truncated: %s is %s bytes; showing only its last %s bytes]\n\n' "$file" "$size" "$NOTE_TAIL_BYTES"
    tail -c "$NOTE_TAIL_BYTES" "$file"
  else
    cat "$file"
  fi
}

{
  printf '%s\n\n' '=== .xezar/docs/leader-guide.md (project leader guide) ==='
  cat "$GUIDE"
  if [ -n "$campaign" ] && [ -d "$campaign" ]; then
    [ -f "${campaign}README.md" ] && note_tail "${campaign}README.md" "${campaign}README.md (campaign live state)"
    [ -f "${campaign}decisions.md" ] && note_tail "${campaign}decisions.md" "${campaign}decisions.md (owner decisions, exact words)"
  fi
} | node -e 'const fs=require("node:fs");const text=fs.readFileSync(0,"utf8");process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:text}})+"\n")'

exit 0
