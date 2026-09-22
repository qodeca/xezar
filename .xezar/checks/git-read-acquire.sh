#!/usr/bin/env bash
# Trusted acquisition for read-only kit roles (#863). This script is a workflow check, never a
# bashAllowlist entry: the agent can read the resulting origin/<base> and origin/pr/<n> refs but
# cannot control fetch argv or invoke fetch itself.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

if [ "$#" -ne 0 ]; then
  printf 'usage: git-read-acquire.sh\n' >&2
  exit 2
fi
if ! resolve_task_paths; then
  printf 'git-read-acquire: could not resolve the project and configured base branch\n' >&2
  exit 1
fi
git_bin="$(command -v git 2>/dev/null || true)"
case "$git_bin" in /*) ;; *) printf 'git-read-acquire: git is unavailable as an absolute path\n' >&2; exit 1 ;; esac
if ! "$git_bin" check-ref-format --branch "$BASE_BRANCH" >/dev/null 2>&1; then
  printf 'git-read-acquire: configured base branch is not a valid branch name\n' >&2
  exit 1
fi

printf 'Acquiring read-only git refs: origin/%s and origin/pr/<n>\n' "$BASE_BRANCH"
exec "$git_bin" -C "$TASK_CWD" fetch --quiet -- origin "$BASE_BRANCH" \
  '+refs/pull/*/head:refs/remotes/origin/pr/*'
