#!/usr/bin/env bash
# Fast checks against the actual repository. Synthetic machinery fixtures run in CI
# and must also be run locally whenever the kit checks or workflows change.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
node "$SCRIPT_DIR/catalog-check.mjs" "$REPO_ROOT"
bash "$SCRIPT_DIR/changelog-check.sh" --file "$REPO_ROOT/CHANGELOG.md"
# #663: offline relative-link and anchor check over docs/, README.md, .xezar/docs/ and
# designs/**/README.md. No network, no build, ~50 ms. It resolves the repository root from its
# own location, so it always checks THIS checkout whichever directory the gate started in.
node "$REPO_ROOT/scripts/check-links.mjs"
node --test "$SCRIPT_DIR/xezar-contract.test.mjs"
