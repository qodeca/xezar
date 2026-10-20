#!/usr/bin/env bash
# Fast checks against the actual repository, run as the last gate command.
#
# Each check below is SKIPPED, loudly, when the thing it inspects is not part of this project.
# That matters because this file is vendored into projects that do not all carry a changelog, a
# link checker or a contract test. Under `set -e` an unconditional call to a missing file aborts
# the whole gate on the first one, and every check after it silently never runs - which reads as
# "the gate passed" to anyone watching the exit code.
#
# Usage: repository-checks.sh [repository-root]. The root defaults to the project this copy is
# installed in (two folders up). The upgrade tool passes the project it verifies, because it runs
# these checks from its own clone, where two folders up is the clone's skill folder.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [ "$#" -gt 1 ]; then
  printf 'repository-checks: usage: repository-checks.sh [repository-root]\n' >&2
  exit 2
fi
REPO_ROOT="$(cd "${1:-$SCRIPT_DIR/../..}" && pwd -P)"

skip() { printf 'repository-checks: skipped %s (%s)\n' "$1" "$2"; }

# Most checks below only read the project and do not depend on each other, so they start together,
# in the background, and each one's output is printed at its own place in the order listed. Each
# starts a node or a bash, about half a second on Windows; one after another they were most of a
# Windows gate's last command (#132 speed bar). The verdict is still the one a run in order gives:
# the first failing check, in the listed order, ends the script with its own exit status, and
# nothing listed after it runs in the foreground or is printed – except local-tree, drift and the
# config guard, whose failures are applied at the end so the later checks still print. The drift check and the changelog
# check run in the foreground, in their place. The config guard starts with the others, because its
# fetch of the base branch is most of its time and none of them reads a remote-tracking ref (the
# route check reads the routing file in the working tree); its output and exit status still come
# at its own place, after drift, and the changelog check, which reads the base the guard fetched,
# still runs only after the guard has finished. On any exit the script first waits for the
# background checks, so none of them outlives it.
CHECK_TMP="$(mktemp -d "${TMPDIR:-/tmp}/repository-checks.XXXXXX")"
trap 'wait; rm -rf "$CHECK_TMP"' EXIT
started() {
  local id="$1"
  shift
  { rc=0; "$@" >"$CHECK_TMP/$id.out" 2>"$CHECK_TMP/$id.err" || rc=$?; printf '%s' "$rc" >"$CHECK_TMP/$id.rc"; } &
}
# Waits for a started check, prints what it printed and returns its exit status. A check with no
# recorded status did not finish, which is a failure.
finished() {
  local id="$1" rc
  while [ ! -f "$CHECK_TMP/$id.rc" ] && jobs -r | grep -q .; do wait -n 2>/dev/null || sleep 0.1; done
  cat "$CHECK_TMP/$id.out" 2>/dev/null
  cat "$CHECK_TMP/$id.err" >&2 2>/dev/null
  rc="$(cat "$CHECK_TMP/$id.rc" 2>/dev/null)" || rc=1
  return "$rc"
}

started local-tree bash "$SCRIPT_DIR/local-tree.sh" "$REPO_ROOT"
started catalog node "$SCRIPT_DIR/catalog-check.mjs" "$REPO_ROOT"
[ ! -f "$REPO_ROOT/.xezar/routing.json" ] || started route node "$SCRIPT_DIR/route.mjs" --check "$REPO_ROOT/.xezar/routing.json"
started fenced-quotes node "$SCRIPT_DIR/fenced-quotes.mjs" "$REPO_ROOT"
started documented-output node "$SCRIPT_DIR/documented-output.mjs" "$REPO_ROOT"
[ ! -f "$REPO_ROOT/scripts/check-links.mjs" ] || started check-links node "$REPO_ROOT/scripts/check-links.mjs"
[ ! -f "$SCRIPT_DIR/xezar-contract.test.mjs" ] || started xezar-contract node --test "$SCRIPT_DIR/xezar-contract.test.mjs"
# The ad-hoc browser's MCP entry changes only through a security review, never through this gate.
started config-guard bash "$SCRIPT_DIR/config-guard.sh" browser --from-base

# The `.local/xezar/` working area keeps its six named subfolders and nothing loose at the top.
# Like drift below, a failure here does not stop the later checks: a missing per-machine folder
# must not hide a real failure further down. Its status is applied at the end.
local_tree_rc=0
finished local-tree || local_tree_rc=$?

finished catalog

# Installed files still match `.xezar/onboarding.json`, or their change is in `.xezar/LOCAL-PATCHES.md`.
# A drift failure does not stop the checks after it: an upgrade expects `unconfirmed-patch` here
# until the owner confirms, and a real failure further down must still be printed. Its status is
# the script's exit status at the end, once every later check has passed.
drift_rc=0
node "$SCRIPT_DIR/manifest-drift.mjs" "$REPO_ROOT" || drift_rc=$?

# The routing file is checked as the working tree holds it, so a pull request that breaks it fails.
if [ -f "$REPO_ROOT/.xezar/routing.json" ]; then
  finished route
else
  skip route-check "no .xezar/routing.json in this project"
fi

# The browser entry guard, started above: its output, here, in its place. Like drift, a failure
# does not stop the later checks (#214): an upgrade that changes the browser entry fails it until
# its pull request merges, and the checks after it must still be printed. Applied at the end.
config_guard_rc=0
finished config-guard || config_guard_rc=$?

# `--diff-base auto` refuses a direct Unreleased edit (`# Unreleased`, or `## [Unreleased]` in a
# Keep a Changelog file): inside the gate run it resolves the attempt's own base; run bare it uses
# the configured baseBranch, else the remote's default branch, and says so when it resolves none.
# `--fragments` parses the per-pull-request changelog fragments.
# The fragment flow needs BOTH the changelog and a `changelog.d/` folder. A project that edits its
# changelog directly has no fragments to check, so the check is skipped, loudly, until the owner
# adopts fragments (create `changelog.d/` to turn it on).
if [ -f "$REPO_ROOT/CHANGELOG.md" ] && [ ! -d "$REPO_ROOT/changelog.d" ]; then
  skip changelog-check "CHANGELOG.md exists but this project has no changelog.d/ fragment folder"
elif [ -f "$REPO_ROOT/CHANGELOG.md" ]; then
  bash "$SCRIPT_DIR/changelog-check.sh" --file "$REPO_ROOT/CHANGELOG.md" --diff-base auto \
    --fragments "$REPO_ROOT/changelog.d"
else
  skip changelog-check "no CHANGELOG.md in this project"
fi

# Marked fenced quotes are exact copies of maintained repository files. A missing source is a
# failure, not a skip: a document can otherwise keep quoting a file from a different branch.
finished fenced-quotes

# Documented JSON keys are verified only by fixed scripts named in the reviewed allowlist; marker
# text can never select a path or command to execute. This is also where the leader-context
# loader's own fixture case runs - it is built in here, not shipped as a separate test file.
finished documented-output

# Offline relative-link and anchor check. Present only where the project keeps its own copy.
if [ -f "$REPO_ROOT/scripts/check-links.mjs" ]; then
  finished check-links
else
  skip check-links "no scripts/check-links.mjs in this project"
fi

if [ -f "$SCRIPT_DIR/xezar-contract.test.mjs" ]; then
  finished xezar-contract
else
  skip xezar-contract "no contract test installed beside these checks"
fi

if [ "$local_tree_rc" -ne 0 ] || [ "$drift_rc" -ne 0 ] || [ "$config_guard_rc" -ne 0 ]; then
  if [ "$local_tree_rc" -ne 0 ]; then
    printf 'repository-checks: local-tree failed (exit %s)\n' "$local_tree_rc" >&2
  fi
  if [ "$drift_rc" -ne 0 ]; then
    printf 'repository-checks: manifest-drift failed (exit %s)\n' "$drift_rc" >&2
  fi
  if [ "$config_guard_rc" -ne 0 ]; then
    printf 'repository-checks: config-guard failed (exit %s)\n' "$config_guard_rc" >&2
  fi
  printf 'repository-checks: every other check passed\n' >&2
  if [ "$local_tree_rc" -ne 0 ]; then exit "$local_tree_rc"; fi
  if [ "$drift_rc" -ne 0 ]; then exit "$drift_rc"; fi
  exit "$config_guard_rc"
fi
