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
#    output goes to a file under the primary checkout's `.local/xezar/`, and only a bounded excerpt
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
#     Records `producer` from `GATE_PRODUCER` (set by `repo-gates.sh --producer`), defaulting to
#     `author`. An author-produced attempt is refused at sealing (#676 PR 2).
#     With no run id the attempt is STANDALONE: it records under
#     `.local/xezar/scratch/standalone-gates/` with `runId: null`, prints a real verdict, and can
#     never be sealed or certified. That is the owner running the gates by hand.
#   gate_run <name> <command> [args…]
#   gate_note_skip <name> <reason>
#   gate_attempt_complete            # prints "passed" or "failed", exits non-zero on failed

GATE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
GATE_STDOUT_TAIL_PASS=3
GATE_STDOUT_TAIL_FAIL=60

_gate_iso_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# Bash 5 has the clock built in (`EPOCHREALTIME`, seconds and six digits of microseconds, with the
# locale's decimal mark); a node start costs about half a second on Windows. Older bash (macOS's
# 3.2) has no such variable and asks node, as before.
# The commit HEAD points at now, or nothing: the after-record's headSha.
_gate_head_sha() {
  ( cd "$TASK_CWD" && git rev-parse HEAD 2>/dev/null )
}

# gate_facts_capture VAR FUNCTION [VAR FUNCTION ...]
# Runs each FUNCTION at the same time, in the background, and sets each VAR (in the caller's scope)
# to what that function printed, trailing newlines removed – exactly what `VAR="$(FUNCTION)"`
# gives, failures included: a function that fails or prints nothing leaves its VAR empty, as
# the `$(…)` it replaces did. Every call it replaces only reads, so the order they run in cannot
# change an answer. With no temporary folder they run one after another, as they used to.
gate_facts_capture() {
  local _gfc_dir _gfc_i _gfc_pids=() _gfc_args=("$@")
  _gfc_dir="$(mktemp -d "${TMPDIR:-/tmp}/gate-facts.XXXXXX" 2>/dev/null)" || _gfc_dir=""
  if [ -z "$_gfc_dir" ]; then
    for ((_gfc_i = 0; _gfc_i < ${#_gfc_args[@]}; _gfc_i += 2)); do
      printf -v "${_gfc_args[_gfc_i]}" '%s' "$("${_gfc_args[_gfc_i + 1]}")"
    done
    return 0
  fi
  for ((_gfc_i = 0; _gfc_i < ${#_gfc_args[@]}; _gfc_i += 2)); do
    "${_gfc_args[_gfc_i + 1]}" >"$_gfc_dir/$_gfc_i" &
    _gfc_pids+=("$!")
  done
  wait "${_gfc_pids[@]}" 2>/dev/null
  for ((_gfc_i = 0; _gfc_i < ${#_gfc_args[@]}; _gfc_i += 2)); do
    # `$(<file)` is bash's own read: no `cat` to start. The file always exists – the background
    # redirection above created it before its function ran.
    printf -v "${_gfc_args[_gfc_i]}" '%s' "$(<"$_gfc_dir/$_gfc_i")"
  done
  rm -rf "$_gfc_dir"
}

_gate_epoch_ms() {
  local now="${EPOCHREALTIME:-}"
  case "$now" in
    [0-9]*[.,][0-9][0-9][0-9][0-9][0-9][0-9]) now="${now//[.,]/}"; printf '%s' "${now%???}" ;;
    *) node -e 'process.stdout.write(String(Date.now()))' ;;
  esac
}

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

# --- who produced an attempt (#676 PR 2) ---------------------------------------------------
#
# An attempt records WHO ran the gates, because only the workflow's own `gates` step may
# certify the tree: an author's attempt is the same tree proved to itself, and
# `lib/gate-results.mjs` refuses to seal one. `repo-gates.sh --producer gates` is that
# declaration; without it the producer is the AUTHOR.
#
# ONE migration exception, for the release that introduces the flag. A run created before this
# change holds the OLD `gates` command in its PERSISTED workflow definition — the engine freezes
# that definition at run creation — so its gates step cannot declare itself and would be refused
# as an author run. The engine's runs index names the definition and its workflow; when that
# definition does NOT declare the flag and the workflow FILE does, this producer-less invocation
# from a workflow CHECK step (an agent step carries XEZ_TASK_ID; a check step never does —
# lib/common.sh) is that frozen gates step. Every absent or unreadable input is the AUTHOR, so
# the exception fails closed, and it disappears one release after the flag ships.
#
# `$1` is the value of `repo-gates.sh --producer`, or empty when the flag was absent.
gate_resolve_producer() {
  local requested="${1:-}" probe workflow command file
  [ -n "$requested" ] && { printf '%s' "$requested"; return 0; }
  [ -n "${XEZ_TASK_ID:-}" ] && { printf 'author'; return 0; }
  probe="$(node -e '
    const fs = require("node:fs");
    const [index, id] = process.argv.slice(1);
    try {
      const raw = JSON.parse(fs.readFileSync(index, "utf8"));
      const runs = Array.isArray(raw) ? raw : (raw.runs ?? []);
      const run = runs.find((r) => r.id === id);
      const gates = (run?.workflowDef?.steps ?? []).find((s) => s.id === "gates");
      process.stdout.write(`${run?.workflow ?? ""}\t${gates?.command ?? ""}`);
    } catch {}
  ' "${MAIN_ROOT:-}/.local/xezar/runs.json" "${TASK_ID:-}" 2>/dev/null)" || probe=""
  workflow="${probe%%$'\t'*}"
  command="${probe#*$'\t'}"
  if [ -n "$workflow" ] && [ -n "$command" ]; then
    case "$command" in
      *"--producer gates"*) printf 'author'; return 0 ;;
    esac
    file="${TASK_CWD:-.}/.xezar/workflows/$workflow.yaml"
    [ -f "$file" ] || file="${TASK_CWD:-.}/.xezar/workflows/$workflow.yml"
    [ -f "$file" ] && grep -q -- '--producer gates' "$file" && { printf 'gates'; return 0; }
  fi
  printf 'author'
}

# Start an attempt. A run id gives the attempt an evidence directory; WITHOUT one the attempt is
# standalone — the owner running the gates by hand, or an onboarding smoke test in the primary
# checkout — and it records to `standalone_gates_dir` instead, with `runId: null`. It still fails
# closed on the things that make a record readable at all: a HEAD to bind to, and a writable log.
# A standalone attempt is uncertifiable by construction, twice over: its producer is `author`,
# which sealing refuses, and it does not live under an evidence root, which verification refuses.
# So the owner gets a verdict they can act on and nobody gets evidence they did not earn.
gate_attempt_begin() {
  local required_json="$1" command_list_id="$2"
  local gates_root seq stamp claim

  GATE_RESULTS_MJS="$GATE_LIB_DIR/gate-results.mjs"

  [ -n "${HEAD_SHA:-}" ] || { printf 'gate-record: no HEAD — cannot bind evidence to a revision\n' >&2; return 1; }
  case "$HEAD_SHA" in
    *[!0-9a-f]* | "") printf 'gate-record: HEAD "%s" is not a plain SHA\n' "$HEAD_SHA" >&2; return 1 ;;
  esac

  if [ -n "${TASK_ID:-}" ]; then
    GATE_STANDALONE=0
    gates_root="$(task_gates_dir)" || return 1
  else
    GATE_STANDALONE=1
    gates_root="$(standalone_gates_dir)" || return 1
  fi
  # The workflow name, if anything ever recorded it. A check step is spawned with the manager's
  # own environment, which carries no workflow identity, so this is normally null — and a
  # recorded null is worth more than a guessed name. A standalone attempt has no manifest at all,
  # so it does not go looking for one.
  if [ "$GATE_STANDALONE" -eq 1 ]; then
    GATE_WORKFLOW="${KIT_TEST_WORKFLOW:-}"
  else
    GATE_WORKFLOW="${KIT_TEST_WORKFLOW:-$(node "$GATE_LIB_DIR/manifest.mjs" "$(task_manifest_path)" --get workflow 2>/dev/null)}"
  fi
  # Reserve the sequence and the attempt directory in ONE atomic step. Asking for the next free
  # number and then writing the attempt is a race: two gate runs sharing this run id that cross
  # that window both get the same number, the selector ties, and directory order decides which
  # one speaks for the head — so a concurrent FAILING attempt could hide behind a passing one.
  # `reserve` claims `.sequences/<n>` with mkdir, which exactly one process can win.
  stamp="$(_gate_epoch_ms)"
  claim="$(node "$GATE_RESULTS_MJS" reserve --gates-root "$gates_root" --head "$HEAD_SHA" --stamp "$stamp" --pid "$$")" || return 1
  # One node for the three fields (#132 speed bar), one per line. A field holding a line break is
  # refused, so a field never spans or merges lines; the empty fields then stop the attempt below.
  seq="" GATE_ATTEMPT_ID="" GATE_ATTEMPT_DIR=""
  {
    IFS= read -r seq && IFS= read -r GATE_ATTEMPT_ID && IFS= read -r GATE_ATTEMPT_DIR
  } < <(printf '%s' "$claim" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      let c;
      try { c = JSON.parse(raw); } catch { process.exit(1); }
      const fields = ["sequence", "attemptId", "attemptDir"].map((k) => String(c[k] ?? ""));
      if (fields.some((f) => /[\r\n]/.test(f))) process.exit(1);
      process.stdout.write(fields.map((f) => `${f}\n`).join(""));
    });' 2>/dev/null)
  [ -n "$GATE_ATTEMPT_ID" ] && [ -n "$GATE_ATTEMPT_DIR" ] || {
    printf 'gate-record: the attempt sequence could not be reserved\n' >&2; return 1;
  }
  GATE_LOG_DIR="$GATE_ATTEMPT_DIR/logs"
  GATE_INDEX=0
  GATE_STARTED_AT="$(_gate_iso_now)"
  GATE_STARTED_MS="$stamp"

  # The five before-facts only read the checkout, so they are taken at the same time instead of
  # one after another (#132 speed bar: together they start about thirty processes, and on Windows
  # each start is about 0.1 s). Each value is exactly what its own `$(…)` gave before.
  local tree_sha repo_json env_json tree_fp deps_fp
  gate_facts_capture \
    tree_sha head_tree_sha \
    repo_json repo_identity \
    env_json env_profile \
    tree_fp tree_fingerprint \
    deps_fp deps_fingerprint

  node "$GATE_RESULTS_MJS" begin --dir "$GATE_ATTEMPT_DIR" --json "$(_gate_json \
    "attemptId=$GATE_ATTEMPT_ID" \
    "sequence:n=$seq" \
    "runId=${TASK_ID:-}" \
    "runIdSource=${TASK_ID_SOURCE:-}" \
    "workflow=$GATE_WORKFLOW" \
    "producer=${GATE_PRODUCER:-author}" \
    "cwd=$TASK_CWD" \
    "isWorktree:n=$IS_WORKTREE" \
    "branch=$BRANCH" \
    "baseRef=${GATE_BASE_REF:-$BASE_BRANCH}" \
    "baseSha=${GATE_BASE_SHA:-}" \
    "headSha=$HEAD_SHA" \
    "treeSha=$tree_sha" \
    "commandListId=$command_list_id" \
    "leaseWaitMs:n=${GATE_LEASE_WAIT_MS:-}" \
    "required:j=$required_json" \
    "repo:j=$repo_json" \
    "environment:j=$env_json" \
    "before:j=$(_gate_json "headSha=$HEAD_SHA" "treeFingerprint=$tree_fp" "depsFingerprint=$deps_fp")" \
    "startedAt=$GATE_STARTED_AT")" || return 1

  printf 'gate attempt   %s\n' "$GATE_ATTEMPT_ID"
  if [ "${GATE_STANDALONE:-0}" -eq 1 ]; then
    printf 'run id         none — standalone attempt, a verdict only, never sealable evidence\n'
  fi
  printf 'evidence to    %s\n' "$GATE_ATTEMPT_DIR"
  printf 'full logs      %s/\n' "$GATE_LOG_DIR"
}

_gate_slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-//; s/-$//'
}

# _gate_slug_into VAR NAME: sets VAR to `_gate_slug NAME` without starting a process when NAME is
# printable ASCII only (every gate name a project writes): the same lower case, each run of other
# characters one `-`, one `-` off each end. Anything else – a tab, a newline, a non-ASCII letter,
# where tr, sed and the locale decide – takes `_gate_slug` itself. Three processes a call, six
# calls a gate run, about 0.1 s each on Windows (#132 speed bar). The character sets are spelled
# out, never ranges: a range in a pattern follows the locale's collation.
_gate_slug_into() {
  local _gsi_name="$2" _gsi_out="" _gsi_c _gsi_i _gsi_dash=0
  local _gsi_upper=ABCDEFGHIJKLMNOPQRSTUVWXYZ _gsi_lower=abcdefghijklmnopqrstuvwxyz _gsi_before _gsi_code
  for ((_gsi_i = 0; _gsi_i < ${#_gsi_name}; _gsi_i++)); do
    _gsi_c="${_gsi_name:_gsi_i:1}"
    case "$_gsi_c" in
      [abcdefghijklmnopqrstuvwxyz0123456789]) _gsi_out+="$_gsi_c"; _gsi_dash=0 ;;
      [ABCDEFGHIJKLMNOPQRSTUVWXYZ])
        _gsi_before="${_gsi_upper%%"$_gsi_c"*}"
        _gsi_out+="${_gsi_lower:${#_gsi_before}:1}"; _gsi_dash=0 ;;
      *)
        # Any other printable ASCII character (codes 32 to 126) joins a run of `-`.
        printf -v _gsi_code '%d' "'$_gsi_c"
        if [ "$_gsi_code" -lt 32 ] || [ "$_gsi_code" -gt 126 ]; then
          printf -v "$1" '%s' "$(_gate_slug "$_gsi_name")"
          return
        fi
        [ "$_gsi_dash" -eq 1 ] || _gsi_out+="-"
        _gsi_dash=1 ;;
    esac
  done
  _gsi_out="${_gsi_out#-}"
  printf -v "$1" '%s' "${_gsi_out%-}"
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
  local index="$1" name="$2" command="$3" entry expected_log slug
  _gate_slug_into slug "$name"
  printf -v expected_log '%02d-%s.log' "$index" "$slug"
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
    process.stdout.write(`${e.status}\n${JSON.stringify(e)}`);
  ' "$GATE_ATTEMPT_DIR/workers/$index.json" "$name" "bash -c $command" "$expected_log" "#xezar-gate-log $GATE_ATTEMPT_ID $name")" || return 1
  # The validated status comes first, on its own line (JSON.stringify never writes a raw newline),
  # and stays in GATE_WORKER_STATUS for repo-gates.sh: the stage checks after the install and the
  # security gate read it there instead of starting node to read the same file again (#132).
  GATE_WORKER_STATUS[index]="${entry%%$'\n'*}"
  entry="${entry#*$'\n'}"
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
  _gate_slug_into slug "$name"
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
    { KIT_TEST_GATE_LOG="$log_path" "$@"; status=$?; ran=1; } >> "$log_path" 2>&1
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
# `gate-results.mjs` (`permittedSkipNames`: the install gate, named by the caller) can still
# satisfy a required gate; every other reason leaves the attempt uncertifiable, which is the point.
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
  local ended duration_ms result after_head after_tree after_deps
  ended="$(_gate_iso_now)"
  # Measured before the after-facts, as it always was: the duration is the gates', not the record's.
  duration_ms=$(( $(_gate_epoch_ms) - GATE_STARTED_MS ))
  # The three after-facts are taken at the same time, as the before-facts are (gate_facts_capture).
  gate_facts_capture \
    after_head _gate_head_sha \
    after_tree tree_fingerprint \
    after_deps deps_fingerprint
  # The install gate's name comes from the list that ran (repo-gates.sh's GATE_NAMES), never from
  # the record: it is the one gate a verified-current skip may satisfy.
  result="$(node "$GATE_RESULTS_MJS" complete --dir "$GATE_ATTEMPT_DIR" --install-gate "${GATE_NAMES[0]:-}" --json "$(_gate_json \
    "endedAt=$ended" \
    "durationMs:n=$duration_ms" \
    "after:j=$(_gate_json "headSha=$after_head" \
                          "treeFingerprint=$after_tree" \
                          "depsFingerprint=$after_deps")")")" || return 1
  printf '%s' "$result"
  [ "$result" = "passed" ]
}
