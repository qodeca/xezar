#!/usr/bin/env bash
# Xezar project gates: the AGENTS/SDLC/.xezar/pipeline/config.json sequence,
# with dependency freshness and actual repository checks. UI smoke is separate.
# Usage:  .xezar/checks/repo-gates.sh [--fast] [--list] [--producer <author|gates>]
#   --producer <author|gates>
#           WHO ran the gates. The workflow's own `gates` step passes `gates`; an invocation
#           without the flag is the AUTHOR's, and `lib/gate-results.mjs` refuses to seal an
#           author's attempt. It is deliberately NOT part of the command-list id: the id names
#           the LIST of gates, and who invoked it is not a gate.
#   --fast  skip `npm ci` ONLY when the installed dependencies
#           still match the manifests. `--fast` is a request, not a promise: freshness is
#           verified against a fingerprint of package-lock.json, npm-shrinkwrap.json, root/workspace package.json,
#           .npmrc, patches/ and the Node/npm versions, and a stale or missing stamp installs anyway.
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
# `.local/xezar/tasks/<runId>/gates/<headSha>/<attemptId>/`: one complete log per gate plus a
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
#
# The security stage sits at position TWO, immediately after the install and before every gate
# that produces a quality signal. That placement is the contract, not a preference: SDLC.md
# § Security before the quality verdict requires the security result to be resolved before
# anyone gives a quality verdict, and putting it in the list's order is what makes the runner
# execute the rule rather than ask people to remember it. It is a kit check, like
# `repository-checks.sh`, so `.xezar/pipeline/config.json`'s `validation.commands` — the five npm
# commands a person runs by hand — is unchanged and still matches this list in order.
GATE_NAMES=(
  "npm ci"
  ".xezar/checks/security-scan.sh"
  "npm run typecheck"
  "npm test"
  "npm run test:unit"
  "npm run build"
  "npm run test:package"
  ".xezar/checks/repository-checks.sh"
)
GATE_COMMANDS=(
  "npm ci"
  ".xezar/checks/security-scan.sh"
  "npm run typecheck"
  "npm test"
  "npm run test:unit"
  "npm run build"
  "npm run test:package"
  ".xezar/checks/repository-checks.sh"
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
PRODUCER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fast) FAST=1 ;;
    --list) LIST=1 ;;
    --json) AS_JSON=1 ;;
    --producer)
      shift
      [ $# -gt 0 ] || { printf 'repo-gates: --producer needs a value (author or gates)\n' >&2; exit 2; }
      PRODUCER="$1"
      ;;
    *)
      printf 'repo-gates: unknown argument "%s"\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done
case "$PRODUCER" in
  "" | author | gates) ;;
  *)
    printf 'repo-gates: --producer must be "author" or "gates", got "%s"\n' "$PRODUCER" >&2
    exit 2
    ;;
esac

if [ "$LIST" -eq 1 ]; then
  if [ "$AS_JSON" -eq 1 ]; then
    node -e '
      process.stdout.write(JSON.stringify({ commandListId: process.argv[1], gates: JSON.parse(process.argv[2]) }));
    ' "$(gate_list_id)" "$(gate_list_json)"
    printf '\n'
  else
    printf 'required gates, in canonical reporting order:\n'
    for i in "${!GATE_NAMES[@]}"; do
      printf '  %-32s %s\n' "${GATE_NAMES[$i]}" "${GATE_COMMANDS[$i]}"
    done
    printf '\ncommandListId  %s\n' "$(gate_list_id)"
  fi
  exit 0
fi

resolve_task_paths || exit 1
cd "$TASK_CWD" || exit 1

# Who produced this attempt (#676 PR 2). The flag is the workflow's own declaration; without it
# the producer is the AUTHOR, and `lib/gate-results.mjs` refuses to seal an author's attempt.
# `gate_resolve_producer` (lib/gate-record.sh) owns the resolution, including the one-release
# migration for a run whose persisted definition predates the flag.
GATE_PRODUCER="$(gate_resolve_producer "$PRODUCER")"
export GATE_PRODUCER

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
printf 'producer       %s\n' "$GATE_PRODUCER"
if ! gate_attempt_begin "$(gate_names_json)" "$(gate_list_id)"; then
  printf '\nGATES ABORTED: the attempt could not be recorded, so nothing here could become evidence.\n' >&2
  exit 1
fi

# Only this shell reduces results; workers own separate files and process groups.
# All command phases use the same supervisor, including install and the repository-check tail.
export GATE_RESULTS_MJS GATE_ATTEMPT_ID GATE_ATTEMPT_DIR GATE_LOG_DIR
GATE_SCHEDULER_PID=""
gate_cancel() {
  trap '' INT TERM
  if [ -n "$GATE_SCHEDULER_PID" ]; then
    kill -TERM "$GATE_SCHEDULER_PID" 2>/dev/null || true
    wait "$GATE_SCHEDULER_PID" 2>/dev/null || true
  fi
  if [ -f "$GATE_ATTEMPT_DIR/result.json" ]; then
    printf '\nGATES INTERRUPTED: finalization produced a completed record; retained at %s/result.json.\n' "$GATE_ATTEMPT_DIR" >&2
  else
    printf '\nGATES INTERRUPTED: retained attempt is incomplete.\n' >&2
  fi
  exit 130
}
trap gate_cancel INT TERM

gate_phase() {
  local mode="$1"; shift
  local index entries args=()
  for index in "$@"; do
    args+=("$index" "${GATE_NAMES[$((index - 1))]}" "${GATE_COMMANDS[$((index - 1))]}")
  done
  entries="$(node -e '
    const args = process.argv.slice(1), entries = [];
    for (let i = 0; i < args.length; i += 3) entries.push({index: Number(args[i]), name: args[i+1], command: args[i+2]});
    process.stdout.write(JSON.stringify(entries));
  ' "${args[@]}")" || return 1
  node "$SCRIPT_DIR/lib/gate-parallel.mjs" "$SCRIPT_DIR/lib/gate-record.sh" "$mode" "$entries" &
  GATE_SCHEDULER_PID=$!
  wait "$GATE_SCHEDULER_PID"
  local scheduler_rc=$?
  GATE_SCHEDULER_PID=""
  # A failed supervisor/reducer leaves no result.json, even if every tool exited zero.
  [ "$scheduler_rc" -eq 0 ] || return 1
  for index in "$@"; do
    gate_collect_worker "$index" "${GATE_NAMES[$((index - 1))]}" "${GATE_COMMANDS[$((index - 1))]}" || return 1
  done
}

# Publish the attempt and end the run with its verdict. Extracted so the security stage's early
# stop goes through the SAME completion path as a full run: an attempt is never left green and
# never left half-written, whatever ended it.
#
# `expected` is the outcome THIS caller already knows the run must end with — `passed` at the end
# of a full run, `failed` from the security stop. The completer's return code can only CONFIRM
# that outcome: a completer that returned 0 for an attempt this caller knows was refused must not
# print a pass or exit 0. The argument is therefore REQUIRED and has no default, so a future
# caller that forgets it fails closed — an empty outcome never equals `passed` (#691).
gate_finish() {
  local expected="$1"
  printf '\n==================== SUMMARY ====================\n'
  # Publishing result.json is the completion commit point. Bash may defer a signal
  # during finalization; the trap then reports the completed record instead of denying it.
  result="$(gate_attempt_complete)"
  complete_rc=$?
  printf 'attempt        %s\n' "$GATE_ATTEMPT_ID"
  printf 'record         %s/result.json\n' "$GATE_ATTEMPT_DIR"
  printf 'recorded       %s\n' "$result"

  if [ "$complete_rc" -eq 0 ] && [ "$expected" = passed ]; then
    printf 'ALL GATES PASSED\n'
    exit 0
  fi
  # The record can refuse an attempt the loop above thought was clean — a broken log, or a gate
  # with no recorded outcome at all. That disagreement is itself the failure.
  [ "$complete_rc" -eq 0 ] || printf 'The recorded result is "%s" — this attempt cannot be sealed.\n' "$result"
  exit 1
}

if [ "$FAST" -eq 1 ]; then
  gate_note_skip "npm ci" "deps-verified-current" || exit 1
else
  gate_phase serial 1 || exit 1
  if node -e 'process.exit(JSON.parse(require("node:fs").readFileSync(process.argv[1])).status === "passed" ? 0 : 1)' "$GATE_ATTEMPT_DIR/workers/1.json"; then
    # A passed install whose workspace packages still load from another checkout would have
    # every later gate judge that checkout's source (#286). No command after this point could
    # produce evidence for this branch, so the attempt stops here and is left incomplete.
    # (--fast reaches this line only through deps_are_fresh, which applies the same check.)
    if ! deps_resolve_in_task; then
      printf '\nGATES ABORTED: workspace packages resolve outside this task; nothing here could be evidence for it.\n' >&2
      exit 1
    fi
    write_deps_stamp || exit 1
  fi
fi
# Security first, alone, and before any quality gate. A failing security stage stops the run
# here: there is no point paying for a build to find out what the scan already refused, and a
# quality verdict given ahead of the security result is the order this exists to prevent.
#
# `gate_phase` returns non-zero only for an INFRASTRUCTURE failure — a non-zero scheduler, or a
# worker whose result could not be collected. A security gate that RAN and refused the candidate
# exits 1 and records `failed`, and the phase still returns 0, so this stage used to fall
# straight through to the five quality gates (#680). The stage's own recorded outcome is the
# boundary that was missing.
#
# This arm reads the GATE-WORKER vocabulary, which is all `workers/2.json` ever carries:
# `gate_collect_worker` validates that file to exactly `passed` / `failed` / `not-run`, so `passed`
# is the only value that continues and `failed` and `not-run` both stop. The security-result
# vocabulary (`pass` / `findings` / `unknown` / `not-applicable`) lives in `security.json` and must
# never be read here: `pass` is one letter from `passed`, so a "more accurate" re-point would stop
# every clean run. `unknown` deliberately does not stop the run — it is a resolved security
# outcome, not a refusal, and `security-scan.sh` exits 0 for it (#691).
gate_phase serial 2 || exit 1
security_status="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).status)' "$GATE_ATTEMPT_DIR/workers/2.json" 2>/dev/null)" || security_status="unreadable"
case "$security_status" in
  passed) ;;
  *)
    printf '\nGATES STOPPED AT THE SECURITY STAGE: the security gate recorded "%s", so no quality gate ran.\n' "$security_status"
    printf 'Security is resolved before any quality verdict, and the attempt is completed as failed.\n'
    gate_finish failed
    ;;
esac
gate_phase application 3 4 5 6 7 || exit 1
gate_phase serial 8 || exit 1
gate_finish passed
