#!/usr/bin/env bash
# Fast checks against the actual repository. Synthetic machinery fixtures run in CI
# and must also be run locally whenever the kit checks or workflows change.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
node "$SCRIPT_DIR/catalog-check.mjs" "$REPO_ROOT"
# `--diff-base auto` refuses a direct `# Unreleased` edit (issue #668): inside the gate run it
# resolves the attempt's own base; run bare it falls back to origin/main then main, and says so
# when neither exists. `--fragments` parses the per-pull-request changelog.d files.
bash "$SCRIPT_DIR/changelog-check.sh" --file "$REPO_ROOT/CHANGELOG.md" --diff-base auto \
  --fragments "$REPO_ROOT/changelog.d"
# The dogfooding ledger has the same fragment shape, and a malformed entry would only surface at
# the next release fold. Catch it here.
node "$SCRIPT_DIR/dogfooding-fragments.mjs" --check "$REPO_ROOT/.xezar/docs/dogfooding.d"
# Marked fenced quotes are exact copies of maintained repository files. A missing source is a
# failure, not a skip: a document can otherwise keep quoting a file from a different branch.
node "$SCRIPT_DIR/fenced-quotes.mjs" "$REPO_ROOT"
# Documented JSON keys are verified only by fixed scripts named in the reviewed allowlist; marker
# text can never select a path or command to execute.
node "$SCRIPT_DIR/documented-output.mjs" "$REPO_ROOT"
# #663: offline relative-link and anchor check over docs/, README.md, .xezar/docs/ and
# designs/**/README.md. No network, no build, ~50 ms. It resolves the repository root from its
# own location, so it always checks THIS checkout whichever directory the gate started in.
node "$REPO_ROOT/scripts/check-links.mjs"
node --test "$SCRIPT_DIR/xezar-contract.test.mjs"
