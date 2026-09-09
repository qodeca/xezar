#!/usr/bin/env bash
# First workflow step: make this local, uncommitted project kit available in a task worktree.
# Does not seed source code, personal config, runtime or credentials.
set -euo pipefail
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec node "$KIT_DIR/checks/lib/bootstrap.mjs" "$KIT_DIR"
