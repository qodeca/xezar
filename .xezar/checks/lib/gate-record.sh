#!/usr/bin/env bash
# The recording half of the gate evidence contract: run a gate, keep its whole output, and
# write down what actually happened.
#
# Sourced (never executed) by `repo-gates.sh`, and driven directly by the behaviour tests in
# `infra-tests.sh` with synthetic commands — the tests exercise THIS code, not a copy of it,
# and they never call repo-gates.sh back, so there is no recursion.
#
# TWO PROBLEMS IT SOLVES, both observed in production:
#
# 1. Truncation. The gates used to write every command's full output to stdout, and the
#    cockpit truncates a long step's output. On the P1 run the summary at the end was cut off
#    and the whole gate pass had to be re-run to find out what it had said. Here the COMPLETE
#    output goes to a file under the primary checkout's `.local/`, and only a bounded excerpt
#    reaches stdout — so the verdict is always the part that survives.
#
# 2. Unevidenced passes. A gate's exit status used to exist only in a shell variable that died
#    with the process. Here every command's status, exit code, timing and log digest is written
#    to a record that the sealing step reads instead of assuming.
#
# Logging failure is a gate failure. If the log cannot be opened, the command is not run at all
# and is recorded as `not-run`; if the log is unreadable or its header is gone afterwards, the
# command is recorded with `logOk:false`. Either one makes the whole attempt uncertifiable,
# even where the command itself exited zero — an outcome nobody can read is not evidence.
#
# Expects `resolve_task_paths` (lib/common.sh) to have run.
#
# API:
#   gate_attempt_begin <requiredNamesJson> <commandListId>
#   gate_run <name> <command> [args…]
#   gate_note_skip <name> <reason>
#   gate_attempt_complete            # prints "passed" or "failed", exits non-zero on failed

GATE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
GATE_STDOUT_TAIL_PASS=3
GATE_STDOUT_TAIL_FAIL=60

_gate_iso_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
_gate_epoch_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

# Build a JSON object from key=value arguments. Suffix a key with `:n` for a number or `:j` for
# a raw JSON value. Doing this in node rather than by hand keeps a log path with a quote in it
# from producing a record nobody can parse.
_gate_json() {
  node -e '
    const out = {};
    for (const arg of process.argv.slice(1)) {
      const at = arg.indexOf("=");
      let key = arg.slice(0, at);
      const raw = arg.slice(at + 1);
      if (key.endsWith(":n")) out[key.slice(0, -2)] = raw === "" ? null : Number(raw);
      else if (key.endsWith(":j")) out[key.slice(0, -2)] = JSON.parse(raw);
      else out[key] = raw === "" ? null : raw;
    }
    process.stdout.write(JSON.stringify(out));
  ' "$@"
}

# Start an attempt. Fails closed: without a run id there is no evidence directory to write to,
# and a gate run nobody can record is not a gate run anyone may seal.
_gate_claim_field() {
  printf '%s' "$1" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      try { process.stdout.write(String(JSON.parse(raw)[process.argv[1]] ?? "")); } catch { process.exit(1); }
    });' "$2"
}

gate_attempt_begin() {
  local required_json="$1" command_list_id="$2"
  local gates_root seq stamp claim

  GATE_RESULTS_MJS="$GATE_LIB_DIR/gate-results.mjs"

  [ -n "${TASK_ID:-}" ] || { printf 'gate-record: no run id — cannot locate the evidence directory\n' >&2; return 1; }
  [ -n "${HEAD_SHA:-}" ] || { printf 'gate-record: no HEAD — cannot bind evidence to a revision\n' >&2; return 1; }
  case "$HEAD_SHA" in
    *[!0-9a-f]* | "") printf 'gate-record: HEAD "%s" is not a plain SHA\n' "$HEAD_SHA" >&2; return 1 ;;
  esac

  gates_root="$(task_gates_dir)" || return 1
  # The workflow name, if anything ever recorded it. A check step is spawned with the manager's
  # own environment, which carries no workflow identity, so this is normally null — and a
  # recorded null is worth more than a guessed name.
  GATE_WORKFLOW="${DOGFOOD_WORKFLOW:-$(node "$GATE_LIB_DIR/manifest.mjs" "$(task_manifest_path)" --get workflow 2>/dev/null)}"
  # Reserve the sequence and the attempt directory in ONE atomic step. Asking for the next free
  # number and then writing the attempt is a race: two gate runs sharing this run id that cross
  # that window both get the same number, the selector ties, and directory order decides which
  # one speaks for the head — so a concurrent FAILING attempt could hide behind a passing one.
  # `reserve` claims `.sequences/<n>` with mkdir, which exactly one process can win.
  stamp="$(_gate_epoch_ms)"
  claim="$(node "$GATE_RESULTS_MJS" reserve --gates-root "$gates_root" --head "$HEAD_SHA" --stamp "$stamp" --pid "$$")" || return 1
  seq="$(_gate_claim_field "$claim" sequence)"
  GATE_ATTEMPT_ID="$(_gate_claim_field "$claim" attemptId)"
  GATE_ATTEMPT_DIR="$(_gate_claim_field "$claim" attemptDir)"
  [ -n "$GATE_ATTEMPT_ID" ] && [ -n "$GATE_ATTEMPT_DIR" ] || {
    printf 'gate-record: the attempt sequence could not be reserved\n' >&2; return 1;
  }
  GATE_LOG_DIR="$GATE_ATTEMPT_DIR/logs"
  GATE_INDEX=0
  GATE_STARTED_AT="$(_gate_iso_now)"
  GATE_STARTED_MS="$stamp"

  node "$GATE_RESULTS_MJS" begin --dir "$GATE_ATTEMPT_DIR" --json "$(_gate_json \
    "attemptId=$GATE_ATTEMPT_ID" \
    "sequence:n=$seq" \
    "runId=$TASK_ID" \
    "runIdSource=${TASK_ID_SOURCE:-}" \
    "workflow=$GATE_WORKFLOW" \
    "cwd=$TASK_CWD" \
    "isWorktree:n=$IS_WORKTREE" \
    "branch=$BRANCH" \
    "baseRef=${GATE_BASE_REF:-$BASE_BRANCH}" \
    "baseSha=${GATE_BASE_SHA:-}" \
    "headSha=$HEAD_SHA" \
    "treeSha=$(head_tree_sha)" \
    "commandListId=$command_list_id" \
    "required:j=$required_json" \
    "repo:j=$(repo_identity)" \
    "environment:j=$(env_profile)" \
    "before:j=$(_gate_json "headSha=$HEAD_SHA" "treeFingerprint=$(tree_fingerprint)" "depsFingerprint=$(deps_fingerprint)")" \
    "startedAt=$GATE_STARTED_AT")" || return 1

  printf 'gate attempt   %s\n' "$GATE_ATTEMPT_ID"
  printf 'evidence to    %s\n' "$GATE_ATTEMPT_DIR"
  printf 'full logs      %s/\n' "$GATE_LOG_DIR"
}

_gate_slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-//; s/-$//'
}

# Workers publish only their unique result. The parent is the sole aggregate writer.
_gate_record_result() {
  if [ -n "${GATE_WORKER_RESULT:-}" ]; then
    node -e 'require("node:fs").writeFileSync(process.argv[1], process.argv[2], {flag:"wx", mode:0o600})' "$GATE_WORKER_RESULT" "$1"
  else
    node "$GATE_RESULTS_MJS" record --dir "$GATE_ATTEMPT_DIR" --json "$1"
  fi
}

# Reduce only after the scheduler has joined. Missing/malformed results are orchestration
# failure: the caller must leave the attempt incomplete, not merely return a failed shell code.
gate_collect_worker() {
  local index="$1" name="$2" command="$3" entry expected_log
  expected_log="$(printf '%02d-%s.log' "$index" "$(_gate_slug "$name")")"
  entry="$(node -e '
    const fs = require("node:fs");
    const [file, name, command, log, header] = process.argv.slice(1);
    if (!fs.lstatSync(file).isFile()) throw Error("worker result is not a regular file");
    const e = JSON.parse(fs.readFileSync(file, "utf8"));
    const validStatus = e.status === "passed" && e.exitCode === 0 ||
      e.status === "failed" && Number.isInteger(e.exitCode) && e.exitCode > 0 && e.exitCode <= 255 ||
      e.status === "not-run" && e.exitCode === null;
    if (e.name !== name || e.command !== command || e.log !== log || e.logHeader !== header ||
        !validStatus || !Number.isFinite(Date.parse(e.startedAt)) ||
        !Number.isFinite(Date.parse(e.endedAt)) || Date.parse(e.endedAt) < Date.parse(e.startedAt)) {
      throw Error("worker result identity/status/timing mismatch");
    }
    process.stdout.write(JSON.stringify(e));
  ' "$GATE_ATTEMPT_DIR/workers/$index.json" "$name" "bash -c $command" "$expected_log" "#xezar-gate-log $GATE_ATTEMPT_ID $name")" || return 1
  # Render from validated durable evidence, not interleaved worker stdout. A broken
  # output sink is orchestration failure even when the underlying command passed.
  printf '\n=== %s ===\n%s\n--- log: %s/%s\n' "$name" "$entry" "$GATE_LOG_DIR" "$expected_log" || return 1
  if [ -f "$GATE_LOG_DIR/$expected_log" ]; then
    tail -n "$GATE_STDOUT_TAIL_FAIL" "$GATE_LOG_DIR/$expected_log" || return 1
  fi
  node "$GATE_RESULTS_MJS" record --dir "$GATE_ATTEMPT_DIR" --json "$entry"
}

# Run one gate. Returns the command's own exit status so callers can still branch on it.
gate_run() {
  local name="$1"; shift
  local slug log log_path header started ended status ran rc

  GATE_INDEX=$((GATE_INDEX + 1))
  slug="$(_gate_slug "$name")"
  log="$(printf '%02d-%s.log' "$GATE_INDEX" "$slug")"
  log_path="$GATE_LOG_DIR/$log"
  header="#xezar-gate-log $GATE_ATTEMPT_ID $name"
  started="$(_gate_iso_now)"

  printf '\n=== %s ===\n' "$name"

  status=0
  ran=0
  # `{ …; } >> file` redirects a group that still runs in THIS shell, so the assignments
  # survive it. When the redirect cannot be opened the group never runs at all and `ran` keeps
  # its 0 — which is exactly the difference between "the gate failed" and "the gate never ran
  # because we could not record it".
  # The gate is told where its own log is, so a tool that wants to point at it can. It is also
  # what makes the log-integrity rule testable with a real gate rather than a hand-built
  # record: a command that exits 0 while destroying its log must NOT be certifiable.
  if printf '%s\n' "$header" > "$log_path" 2>/dev/null; then
    { DOGFOOD_GATE_LOG="$log_path" "$@"; status=$?; ran=1; } >> "$log_path" 2>&1
  fi
  ended="$(_gate_iso_now)"

  local outcome
  if [ "$ran" -eq 0 ]; then
    outcome="not-run"
    printf -- '--- NOT RUN: %s (its log could not be written to %s)\n' "$name" "$log_path"
    printf -- '--- A gate whose outcome cannot be recorded is not a gate that passed.\n'
  elif [ "$status" -eq 0 ]; then
    outcome="passed"
    printf -- '--- PASS: %s\n' "$name"
    tail -n "$GATE_STDOUT_TAIL_PASS" "$log_path" 2>/dev/null | sed 's/^/    /'
  else
    outcome="failed"
    printf -- '--- FAIL: %s (exit %d)\n' "$name" "$status"
    printf -- '--- last %d lines; the complete output is in %s\n' "$GATE_STDOUT_TAIL_FAIL" "$log_path"
    tail -n "$GATE_STDOUT_TAIL_FAIL" "$log_path" 2>/dev/null | sed 's/^/    /'
  fi
  printf -- '--- log: %s\n' "$log_path"

  _gate_record_result "$(_gate_json \
    "name=$name" \
    "command=$*" \
    "status=$outcome" \
    "exitCode:n=$([ "$ran" -eq 1 ] && printf '%s' "$status")" \
    "startedAt=$started" \
    "endedAt=$ended" \
    "log=$log" \
    "logHeader=$header")" || {
    printf -- '--- RECORD FAILED for %s — this attempt cannot be sealed\n' "$name"
    return 1
  }

  rc=$status
  [ "$ran" -eq 1 ] || rc=1
  return "$rc"
}

# Record a gate that was deliberately not executed. Only the allowance encoded in
# `gate-results.mjs` (`PERMITTED_SKIPS`) can still satisfy a required gate; every other reason
# leaves the attempt uncertifiable, which is the point.
gate_note_skip() {
  local name="$1" reason="$2" now
  now="$(_gate_iso_now)"
  GATE_INDEX=$((GATE_INDEX + 1))
  printf '\n=== %s ===\n' "$name"
  printf -- '--- SKIPPED: %s (%s)\n' "$name" "$reason"
  _gate_record_result "$(_gate_json \
    "name=$name" \
    "command=" \
    "status=skipped" \
    "skipReason=$reason" \
    "startedAt=$now" \
    "endedAt=$now")"
}

# Publish the attempt. The result is derived inside `gate-results.mjs` from the recorded
# outcomes — this function cannot declare a pass, it can only ask what the record adds up to.
gate_attempt_complete() {
  local ended result
  ended="$(_gate_iso_now)"
  result="$(node "$GATE_RESULTS_MJS" complete --dir "$GATE_ATTEMPT_DIR" --json "$(_gate_json \
    "endedAt=$ended" \
    "durationMs:n=$(( $(_gate_epoch_ms) - GATE_STARTED_MS ))" \
    "after:j=$(_gate_json "headSha=$( cd "$TASK_CWD" && git rev-parse HEAD 2>/dev/null )" \
                          "treeFingerprint=$(tree_fingerprint)" \
                          "depsFingerprint=$(deps_fingerprint)")")")" || return 1
  printf '%s' "$result"
  [ "$result" = "passed" ]
}
