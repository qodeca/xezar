#!/usr/bin/env bash
# Fast checks against the actual repository. Synthetic machinery fixtures run in CI
# and must also be run locally whenever the kit checks or workflows change.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
node "$SCRIPT_DIR/catalog-check.mjs" "$REPO_ROOT"
bash "$SCRIPT_DIR/changelog-check.sh" --file "$REPO_ROOT/CHANGELOG.md"
node --test "$SCRIPT_DIR/xezar-contract.test.mjs"
