#!/usr/bin/env bash
# Trusted acquisition for read-only kit roles (#863). This script is a workflow check, never a
# bashAllowlist entry: the agent can read the resulting origin/<base> and, when its engine-owned
# run record supplies a PR number, origin/pr/<n>. Model output never controls fetch argv.
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

pr_number=""
run_index="$MAIN_ROOT/.local/xezar/runs.json"
if [ -n "$TASK_ID" ] && [ -r "$run_index" ]; then
  pr_number="$(node -e '
    const fs = require("node:fs");
    const rows = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const run = Array.isArray(rows) ? rows.find((row) => row?.id === process.argv[2]) : undefined;
    if (Number.isSafeInteger(run?.prNumber) && run.prNumber > 0) process.stdout.write(String(run.prNumber));
  ' "$run_index" "$TASK_ID" 2>/dev/null || true)"
fi
case "$pr_number" in '' | *[!0-9]*) pr_number="" ;; esac

if [ -n "$pr_number" ]; then
  printf 'Acquiring read-only git refs: origin/%s and origin/pr/%s\n' "$BASE_BRANCH" "$pr_number"
  if "$git_bin" -C "$TASK_CWD" fetch --quiet -- origin "$BASE_BRANCH" \
    "refs/pull/$pr_number/head:refs/remotes/origin/pr/$pr_number" >/dev/null 2>&1; then
    exit 0
  fi
else
  printf 'Acquiring read-only git refs: origin/%s (no engine-supplied PR number)\n' "$BASE_BRANCH"
  if "$git_bin" -C "$TASK_CWD" fetch --quiet -- origin "$BASE_BRANCH" >/dev/null 2>&1; then
    exit 0
  fi
fi

printf 'WARNING: git-read-acquire: fetch failed; continuing with local refs only.\n' >&2
exit 0
