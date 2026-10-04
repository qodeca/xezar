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

# The `.local/xezar/` working area keeps its six named subfolders and nothing loose at the top.
# Like drift below, a failure here does not stop the later checks: a missing per-machine folder
# must not hide a real failure further down. Its status is applied at the end.
local_tree_rc=0
bash "$SCRIPT_DIR/local-tree.sh" "$REPO_ROOT" || local_tree_rc=$?

node "$SCRIPT_DIR/catalog-check.mjs" "$REPO_ROOT"

# Installed files still match `.xezar/onboarding.json`, or their change is in `.xezar/LOCAL-PATCHES.md`.
# A drift failure does not stop the checks after it: an upgrade expects `unconfirmed-patch` here
# until the owner confirms, and a real failure further down must still be printed. Its status is
# the script's exit status at the end, once every later check has passed.
drift_rc=0
node "$SCRIPT_DIR/manifest-drift.mjs" "$REPO_ROOT" || drift_rc=$?

# The routing file is checked as the working tree holds it, so a pull request that breaks it fails.
if [ -f "$REPO_ROOT/.xezar/routing.json" ]; then
  node "$SCRIPT_DIR/route.mjs" --check "$REPO_ROOT/.xezar/routing.json"
else
  skip route-check "no .xezar/routing.json in this project"
fi

# The ad-hoc browser's MCP entry changes only through a security review, never through this gate.
bash "$SCRIPT_DIR/config-guard.sh" browser --from-base

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
node "$SCRIPT_DIR/fenced-quotes.mjs" "$REPO_ROOT"

# Documented JSON keys are verified only by fixed scripts named in the reviewed allowlist; marker
# text can never select a path or command to execute. This is also where the leader-context
# loader's own fixture case runs - it is built in here, not shipped as a separate test file.
node "$SCRIPT_DIR/documented-output.mjs" "$REPO_ROOT"

# Offline relative-link and anchor check. Present only where the project keeps its own copy.
if [ -f "$REPO_ROOT/scripts/check-links.mjs" ]; then
  node "$REPO_ROOT/scripts/check-links.mjs"
else
  skip check-links "no scripts/check-links.mjs in this project"
fi

if [ -f "$SCRIPT_DIR/xezar-contract.test.mjs" ]; then
  node --test "$SCRIPT_DIR/xezar-contract.test.mjs"
else
  skip xezar-contract "no contract test installed beside these checks"
fi

if [ "$local_tree_rc" -ne 0 ] || [ "$drift_rc" -ne 0 ]; then
  if [ "$local_tree_rc" -ne 0 ]; then
    printf 'repository-checks: local-tree failed (exit %s)\n' "$local_tree_rc" >&2
  fi
  if [ "$drift_rc" -ne 0 ]; then
    printf 'repository-checks: manifest-drift failed (exit %s)\n' "$drift_rc" >&2
  fi
  printf 'repository-checks: every other check passed\n' >&2
  if [ "$local_tree_rc" -ne 0 ]; then exit "$local_tree_rc"; fi
  exit "$drift_rc"
fi
