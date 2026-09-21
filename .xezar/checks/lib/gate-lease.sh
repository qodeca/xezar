#!/usr/bin/env bash
# The machine-wide gate lease, as `repo-gates.sh` takes it (#672 G3).
#
# Sourced (never executed) by `repo-gates.sh`, and driven directly by the behaviour cases in
# `infra-tests.sh` — the tests exercise THIS code, not a copy of it. That is the whole reason it
# is a lib file rather than three functions inside `repo-gates.sh`: the alternative was proving
# the acquire/release path only by running the full canonical gate list, which is both the most
# expensive thing this repository does and the one thing an author may not run.
#
# Expects `resolve_task_paths` (lib/common.sh) to have run, and a begun attempt
# (`GATE_ATTEMPT_DIR`, lib/gate-record.sh) to exist.
#
# API:
#   gate_lease_argv            print the verb invocation, one argument per line; non-zero if none
#   gate_lease_take            take a slot (or report why not) and keep it; sets GATE_LEASE_WAIT_MS
#   gate_lease_drop            let the holder go; safe on any path and more than once

# WHY. Several full gate runs on ONE machine do not merely go slower, they FAIL: attempt failure was
# measured at 20 % with one concurrent run, 37 % at three, 90 % at four to five and 100 % at six
# or more, in suites the change under test never touched. The lease puts a bound on that, and the
# engine owns the bound rather than this script: `xezar lease gates -- <command>` reads
# `resources.gateSlots` through the same resolver everything else does, takes one of N named
# machine-wide slot locks and releases it when the command ends.
#
# WHERE it is taken is deliberate. After `--list` (which runs nothing and must stay instant) and
# after `gate_attempt_begin`, so the wait is inside a recorded attempt and lands in the record as
# `leaseWaitMs`; before `npm ci`, because the install is one of the phases that contends.
#
# THE HOLD. The verb releases when ITS command ends, so the command it is given is a holder that
# waits for this shell to say go: a `read` on a FIFO this shell keeps open read-write, which never
# blocks a writer and never reaches EOF on its own. Everything else runs HERE, in this shell, with
# its traps, its scheduler pid and its reducer exactly as before.
#
# EVERY failure runs the gates anyway. An unresolvable verb, a holder that died, a lease that
# timed out, an unwritable slot directory: one loud line, and on with the run. A lease that cannot
# be taken must not turn a working gate into a failure (AGENTS.md § Zero config).
GATE_LEASE_PID=""
GATE_LEASE_FIFO=""
GATE_LEASE_WAIT_MS=""
GATE_LEASE_TMPDIR=""

# The verb's own bound, mirrored here in SECONDS: `GATE_LEASE_WAIT_MS` in
# `packages/xezar/src/core/gate-lease.ts` is `20 * 60_000`. This shell needs a number of its own
# because it cannot import a TypeScript constant, and the two are kept in step by an
# `infra-tests.sh` case that reads the constant out of that file and compares it with this line —
# a backstop that drifts longer than the bound it backs up is the gap this feature must not hide.
GATE_LEASE_BOUND_SECONDS=1200
# One minute of slack over the bound: enough for the verb to resolve, write its status and be
# seen, and short enough that "the verb never answered" is still a bounded wait.
GATE_LEASE_BACKSTOP_SECONDS=$((GATE_LEASE_BOUND_SECONDS + 60))
# How long `gate_lease_drop` waits for the holder to go before it kills the pid it saved.
GATE_LEASE_DROP_GRACE_SECONDS=20

# How the verb is invoked, one argument per line, or non-zero when there is no way to run it.
# NEVER `npx`: that would fetch some other xezar from the registry and lease against a different
# build's idea of the slots (AGENTS.md § Validation).
gate_lease_argv() {
  if [ -f "$TASK_CWD/packages/xezar/dist/index.js" ]; then
    printf '%s\n%s\n' "node" "$TASK_CWD/packages/xezar/dist/index.js"
    return 0
  fi
  if [ -x "$TASK_CWD/node_modules/.bin/tsx" ] && [ -f "$TASK_CWD/packages/xezar/src/index.ts" ]; then
    printf '%s\n%s\n' "$TASK_CWD/node_modules/.bin/tsx" "$TASK_CWD/packages/xezar/src/index.ts"
    return 0
  fi
  return 1
}

gate_lease_take() {
  local argv=() line status deadline
  while IFS= read -r line; do argv+=("$line"); done < <(gate_lease_argv)
  if [ "${#argv[@]}" -eq 0 ]; then
    printf 'gate lease    UNAVAILABLE: no xezar CLI in this checkout (no dist build, no tsx) — running unleased\n'
    return 0
  fi

  status="$GATE_ATTEMPT_DIR/lease.json"
  GATE_LEASE_FIFO="$GATE_ATTEMPT_DIR/lease.fifo"
  rm -f "$GATE_LEASE_FIFO"
  if ! mkfifo "$GATE_LEASE_FIFO" 2>/dev/null; then
    printf 'gate lease    UNAVAILABLE: could not create %s — running unleased\n' "$GATE_LEASE_FIFO"
    GATE_LEASE_FIFO=""
    return 0
  fi
  # Opened READ-WRITE and kept open by this shell. A write to a FIFO with no reader blocks, and a
  # reader on a FIFO with no writer sees EOF — `<>` avoids both, so the holder blocks on an empty
  # pipe until `gate_lease_drop` writes, and a holder that died early cannot wedge this shell.
  #
  # Bash does NOT exit on a failed `exec` redirection, even under `set -e`: it prints the error and
  # carries on with fd 9 unopened, after which the drop would write into a closed descriptor and
  # then wait on a holder nobody can release. Fail open explicitly instead.
  if ! exec 9<>"$GATE_LEASE_FIFO"; then
    printf 'gate lease    UNAVAILABLE: could not open %s — running unleased\n' "$GATE_LEASE_FIFO"
    rm -f "$GATE_LEASE_FIFO" 2>/dev/null
    GATE_LEASE_FIFO=""
    return 0
  fi

  # `tsx` opens a unix domain socket under TMPDIR for its own IPC, and a unix socket path is
  # capped at 104 bytes on macOS. A task worktree's TMPDIR is
  # `<primary>/.local/xezar/tmp/<runId>` — 89 characters here — so tsx dies with EINVAL before it
  # reaches any of this repository's code. `node` on a dist build does not care, so only the tsx
  # arm needs the shorter directory, and the lease has no use for TMPDIR itself.
  #
  # It is a PRIVATE short directory, not bare `/tmp`: tsx keeps its IPC socket and its transform
  # cache under `$TMPDIR/tsx-<uid>`, and on a shared host a pre-created folder at a predictable
  # world-writable path is a way into a gate run. `mktemp -d` creates it 0700 under this user, and
  # `gate_lease_drop` removes it. If even that cannot be created, `/tmp` is still better than a
  # tsx that cannot start — the lease would otherwise fail open on every run in this repository.
  local lease_tmp="${TMPDIR:-/tmp}"
  case "${argv[0]}" in
    *"/tsx")
      if [ "${#lease_tmp}" -gt 64 ]; then
        GATE_LEASE_TMPDIR="$(mktemp -d /tmp/xez-lease.XXXXXX 2>/dev/null)" || GATE_LEASE_TMPDIR=""
        if [ -n "$GATE_LEASE_TMPDIR" ] && [ -d "$GATE_LEASE_TMPDIR" ]; then
          chmod 700 "$GATE_LEASE_TMPDIR" 2>/dev/null
          lease_tmp="$GATE_LEASE_TMPDIR"
        else
          GATE_LEASE_TMPDIR=""
          lease_tmp="/tmp"
        fi
      fi
      ;;
  esac

  # `9>&-` closes fd 9 FOR THE CHILD ONLY. Without it the verb inherits this shell's read-write
  # descriptor on the FIFO and is therefore itself a writer on it, so a `repo-gates.sh` that dies
  # without running its EXIT trap — a SIGKILL, an OOM kill, a supervisor escalation — leaves the
  # holder's `read` with a writer that never goes away. The verb then never exits, its pid stays
  # alive and its heartbeat keeps the slot fresh, so NEITHER pid liveness NOR the stale bound can
  # reclaim it and every later gate run on the machine waits the whole bound. The holder command
  # opens the FIFO by PATH for reading, so closing the inherited descriptor costs it nothing.
  TMPDIR="$lease_tmp" "${argv[@]}" lease gates --status-file "$status" -- \
    bash -c 'read -r _ < "$1"' gate-lease-holder "$GATE_LEASE_FIFO" 9>&- &
  GATE_LEASE_PID=$!

  # The verb writes its status file the moment the lease RESOLVES — held, timed out or
  # unavailable — so this waits on the lease's own signal rather than on a duration. The backstop
  # is only for a verb that is alive and never resolves: it is a WALL CLOCK derived from the same
  # 20-minute number the verb bounds itself by, not a poll count. A poll count multiplied by a
  # `sleep` that sleeps *at least* its argument is a floor, not a bound, and on the loaded machine
  # this feature exists for it drifts open-endedly past every surface that promises 20 minutes.
  deadline=$(( $(date +%s) + GATE_LEASE_BACKSTOP_SECONDS ))
  while :; do
    [ -s "$status" ] && break
    kill -0 "$GATE_LEASE_PID" 2>/dev/null || break
    [ "$(date +%s)" -ge "$deadline" ] && break
    sleep 0.2
  done

  if [ ! -s "$status" ]; then
    printf 'gate lease    UNAVAILABLE: the lease helper produced no status — running unleased\n'
    gate_lease_drop
    return 0
  fi
  # Only a run that really LEASED records a number. `unavailable` carries `waitedMs: 0`, which is
  # byte-identical to "took a slot with no queue" — and that is the one outcome an operator most
  # needs to see in the evidence. Empty becomes `null` in the record, which is what the record's
  # own contract already spells "this run did not lease". The loud line below says which it was.
  GATE_LEASE_WAIT_MS="$(node -e '
    const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(s.held === true ? String(s.waitedMs ?? "") : "");
  ' "$status" 2>/dev/null)" || GATE_LEASE_WAIT_MS=""
  # TWO lines narrate one lease, on purpose. The verb writes its own (`xezar lease: gate slot 1 of
  # 1 taken`) to stderr because it is a CLI a person may run directly; this one is derived from
  # the status file, is the same fact this shell just recorded as `leaseWaitMs`, and is the one
  # that keeps the gate log and the attempt record readable as one story. Deleting either loses a
  # different reader, so if they ever have to become one line, the verb's is the one to silence.
  printf 'gate lease    %s\n' "$(node -e '
    const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const waited = Math.round((s.waitedMs ?? 0) / 1000);
    process.stdout.write(s.held
      ? `slot ${s.slot} of ${s.slots}, queued ${waited}s`
      : `NOT HELD (${s.outcome}) after ${waited}s — running unleased`);
  ' "$status" 2>/dev/null || printf 'status unreadable — running unleased')"
}

# Let the holder go. Safe to call more than once and on any exit path, which is why it is an EXIT
# trap rather than a line at the end: `gate_finish` exits from inside a function, and the security
# stage exits earlier still.
gate_lease_drop() {
  local waited=0
  if [ -n "$GATE_LEASE_PID" ]; then
    printf 'release\n' >&9 2>/dev/null
    # BOUNDED. `wait` with no bound is the wrong tool here: a verb that never exits — one wedged
    # before it resolved, one whose holder lost the FIFO — would block this script's own exit, and
    # a check step has no wall clock at all to end it. Wait for the holder to go, then kill the
    # pid this function SAVED when it started it. Never a command-line pattern: `pkill -f` would
    # match every peer agent on this machine carrying the same skill text.
    while [ "$waited" -lt $((GATE_LEASE_DROP_GRACE_SECONDS * 5)) ]; do
      kill -0 "$GATE_LEASE_PID" 2>/dev/null || break
      sleep 0.2
      waited=$((waited + 1))
    done
    if kill -0 "$GATE_LEASE_PID" 2>/dev/null; then
      printf 'gate lease    the holder did not exit within %ss — ending pid %s\n' \
        "$GATE_LEASE_DROP_GRACE_SECONDS" "$GATE_LEASE_PID"
      kill "$GATE_LEASE_PID" 2>/dev/null
      waited=0
      while [ "$waited" -lt 25 ]; do
        kill -0 "$GATE_LEASE_PID" 2>/dev/null || break
        sleep 0.2
        waited=$((waited + 1))
      done
      kill -0 "$GATE_LEASE_PID" 2>/dev/null && kill -9 "$GATE_LEASE_PID" 2>/dev/null
    fi
    wait "$GATE_LEASE_PID" 2>/dev/null
    GATE_LEASE_PID=""
  fi
  # BRACES, not a bare `exec`. `exec` with no command makes EVERY redirection on the line
  # PERMANENT, so `exec 9>&- 2>/dev/null` also sent this script's stderr to /dev/null for the rest
  # of the run — and `gate_lease_take` calls this function on its own fail-open path, which is the
  # path every checkout with a pre-#672 `dist/index.js` takes. The gates then ran with
  # `GATES ABORTED`, `GATES INTERRUPTED` and the scheduler's own stderr discarded.
  if [ -n "$GATE_LEASE_FIFO" ]; then
    { exec 9>&-; } 2>/dev/null
    rm -f "$GATE_LEASE_FIFO" 2>/dev/null
    GATE_LEASE_FIFO=""
  fi
  # The private tsx temp folder, if this run made one. Named prefix, checked before removal.
  case "$GATE_LEASE_TMPDIR" in
    /tmp/xez-lease.*) rm -rf "$GATE_LEASE_TMPDIR" 2>/dev/null ;;
  esac
  GATE_LEASE_TMPDIR=""
}

