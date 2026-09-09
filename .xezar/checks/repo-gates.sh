#!/usr/bin/env bash
# Xezar project gates: the AGENTS/SDLC/.xezar/agentic.config.json sequence,
# with dependency freshness and isolated kit fixture checks. UI smoke is separate.
# Usage:  .xezar/checks/repo-gates.sh [--fast] [--list]
#   --fast  skip `npm ci` ONLY when the installed dependencies
#           still match the manifests. `--fast` is a request, not a promise: freshness is
#           verified against a fingerprint of package-lock.json, npm-shrinkwrap.json and
#           every workspace package.json, and a stale or missing stamp installs anyway.
#           "node_modules exists" is deliberately NOT the test — an agent that touched the
#           lockfile mid-run leaves node_modules stale, and judging that tree would be a
#           false green.
#   --list  print the canonical gate list and its command-list id, and exit. Nothing runs.
#           The id is what binds a sealed result to the list it was produced by, so a gate
#           added or removed later cannot be quietly back-dated onto an older attempt.
#
# Exit 0 only when every gate ran AND passed. A gate that could not run counts as a
# failure, never as a pass.
#
# EVIDENCE. Every run records a gate attempt under the PRIMARY checkout at
# `.local/xezar-tasks/<runId>/gates/<headSha>/<attemptId>/`: one complete log per gate plus a
# versioned result record carrying each command's status, exit code, timing and log digest.
# The complete output goes to those logs; only a bounded excerpt reaches stdout, so a long
# gate can no longer push the summary out of a truncated cockpit view. The `evidence` step
# then READS that record. It does not assert a pass — see `lib/gate-results.mjs`.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/gate-record.sh
. "$SCRIPT_DIR/lib/gate-record.sh"

# --- The canonical list ------------------------------------------------------------------
#
# Data, not control flow, so one place answers "which gates are required" for the runner, for
# `--list`, for the command-list id and for the sealing check. Commands are written
# repo-relative on purpose: an absolute path would make the id differ between checkouts and
# no two machines could ever agree that they ran the same list.
GATE_NAMES=(
  "npm ci"
  "npm run typecheck"
  "npm test"
  "npm run test:unit"
  "npm run build"
  "npm run test:package"
  ".xezar/checks/infra-tests.sh"
)
GATE_COMMANDS=(
  "npm ci"
  "npm run typecheck"
  "npm test"
  "npm run test:unit"
  "npm run build"
  "npm run test:package"
  ".xezar/checks/infra-tests.sh"
)

# The list as JSON, and its digest. Both derived from the arrays above, so they cannot drift
# from what actually runs.
gate_list_json() {
  local i args=()
  for i in "${!GATE_NAMES[@]}"; do args+=("${GATE_NAMES[$i]}" "${GATE_COMMANDS[$i]}"); done
  node -e '
    const argv = process.argv.slice(1);
    const list = [];
    for (let i = 0; i < argv.length; i += 2) list.push({ name: argv[i], command: argv[i + 1] });
    process.stdout.write(JSON.stringify(list));
  ' "${args[@]}"
}
gate_names_json() {
  node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "${GATE_NAMES[@]}"
}
gate_list_id() {
  gate_list_json | shasum -a 256 | cut -d' ' -f1
}

FAST=0
LIST=0
AS_JSON=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    --list) LIST=1 ;;
    --json) AS_JSON=1 ;;
    *)
      printf 'repo-gates: unknown argument "%s"\n' "$arg" >&2
      exit 2
      ;;
  esac
done

if [ "$LIST" -eq 1 ]; then
  if [ "$AS_JSON" -eq 1 ]; then
    node -e '
      process.stdout.write(JSON.stringify({ commandListId: process.argv[1], gates: JSON.parse(process.argv[2]) }));
    ' "$(gate_list_id)" "$(gate_list_json)"
    printf '\n'
  else
    printf 'required gates, in CI order:\n'
    for i in "${!GATE_NAMES[@]}"; do
      printf '  %-32s %s\n' "${GATE_NAMES[$i]}" "${GATE_COMMANDS[$i]}"
    done
    printf '\ncommandListId  %s\n' "$(gate_list_id)"
  fi
  exit 0
fi

resolve_task_paths || exit 1
cd "$TASK_CWD" || exit 1

if [ "$FAST" -eq 1 ] && ! deps_are_fresh; then
  printf '=== --fast declined ===\n'
  printf 'The installed dependencies do not match package-lock.json / the workspace package.json files.\n'
  printf 'Installing anyway: a gate run against a stale node_modules is not evidence.\n'
  FAST=0
fi

# Base identity for the record. Resolved the same way `worktree-setup.sh` does it.
GATE_BASE_REF="origin/$BASE_BRANCH"
git rev-parse --verify --quiet "refs/remotes/origin/$BASE_BRANCH" >/dev/null 2>&1 || GATE_BASE_REF="$BASE_BRANCH"
GATE_BASE_SHA="$(git merge-base HEAD "$GATE_BASE_REF" 2>/dev/null || printf '')"
export GATE_BASE_REF GATE_BASE_SHA

printf '=== repo gates ===\n'
if ! gate_attempt_begin "$(gate_names_json)" "$(gate_list_id)"; then
  printf '\nGATES ABORTED: the attempt could not be recorded, so nothing here could become evidence.\n' >&2
  exit 1
fi

failed=()

for i in "${!GATE_NAMES[@]}"; do
  name="${GATE_NAMES[$i]}"
  gate_cmd="${GATE_COMMANDS[$i]}"

  # The one permitted skip, and the one place it is decided.
  if [ "$name" = "npm ci" ] && [ "$FAST" -eq 1 ]; then
    gate_note_skip "$name" "deps-verified-current"
    continue
  fi

  if gate_run "$name" bash -c "$gate_cmd"; then
    # Only a SUCCESSFUL install may claim the tree is current; stamping a failed one would
    # let the next `--fast` run skip the install it still needs.
    [ "$name" = "npm ci" ] && write_deps_stamp
  else
    failed+=("$name")
  fi
done

printf '\n==================== SUMMARY ====================\n'
result="$(gate_attempt_complete)"
complete_rc=$?
printf 'attempt        %s\n' "$GATE_ATTEMPT_ID"
printf 'record         %s/result.json\n' "$GATE_ATTEMPT_DIR"
printf 'recorded       %s\n' "$result"

if [ ${#failed[@]} -eq 0 ] && [ "$complete_rc" -eq 0 ]; then
  printf 'ALL GATES PASSED\n'
  exit 0
fi
if [ ${#failed[@]} -gt 0 ]; then
  printf 'FAILED OR NOT RUN (%d):\n' "${#failed[@]}"
  printf '  - %s\n' "${failed[@]}"
fi
# The record can refuse an attempt the loop above thought was clean — a broken log, or a gate
# with no recorded outcome at all. That disagreement is itself the failure.
[ "$complete_rc" -eq 0 ] || printf 'The recorded result is "%s" — this attempt cannot be sealed.\n' "$result"
exit 1
