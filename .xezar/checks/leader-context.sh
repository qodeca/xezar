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
#   - whenever xezar set `XEZ_HANDOFF_FILE` or `XEZ_TODOS_FILE` for this process, which covers a
#     Worktree-OFF task running in the primary checkout;
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

# A task worktree, by path or by git registration.
case "$PWD" in */.local/xezar/worktrees/*) silent ;; esac
case "$REPO_ROOT" in */.local/xezar/worktrees/*) silent ;; esac
git_dir="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
common_dir="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
[ -n "$git_dir" ] && [ "$git_dir" = "$common_dir" ] || silent

# Without the guide there is nothing to load.
[ -f "$GUIDE" ] || silent

# The newest campaign folder under .local/xezar/campaigns, if one exists.
campaign=""
if [ -d "$CAMPAIGNS" ]; then
  campaign="$(ls -1dt "$CAMPAIGNS"/*/ 2>/dev/null | head -n 1 || true)"
fi

{
  printf '%s\n\n' '=== .xezar/docs/leader-guide.md (project leader guide) ==='
  cat "$GUIDE"
  if [ -n "$campaign" ] && [ -d "$campaign" ]; then
    if [ -f "$campaign/README.md" ]; then
      printf '\n\n=== %sREADME.md (campaign live state) ===\n\n' "$campaign"
      cat "$campaign/README.md"
    fi
    if [ -f "$campaign/decisions.md" ]; then
      printf '\n\n=== %sdecisions.md (owner decisions, exact words) ===\n\n' "$campaign"
      cat "$campaign/decisions.md"
    fi
  fi
} | node -e 'const fs=require("node:fs");const text=fs.readFileSync(0,"utf8");process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:text}})+"\n")'

exit 0
