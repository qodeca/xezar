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
  local argv=() line status deadline polls=0
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
  exec 9<>"$GATE_LEASE_FIFO"

  # `tsx` opens a unix domain socket under TMPDIR for its own IPC, and a unix socket path is
  # capped at 104 bytes on macOS. A task worktree's TMPDIR is
  # `<primary>/.local/xezar/tmp/<runId>` — 89 characters here — so tsx dies with EINVAL before it
  # reaches any of this repository's code. `node` on a dist build does not care, so only the tsx
  # arm needs the shorter directory, and the lease has no use for TMPDIR itself.
  local lease_tmp="${TMPDIR:-/tmp}"
  case "${argv[0]}" in
    *"/tsx") [ "${#lease_tmp}" -gt 64 ] && lease_tmp="/tmp" ;;
  esac

  TMPDIR="$lease_tmp" "${argv[@]}" lease gates --status-file "$status" -- \
    bash -c 'read -r _ < "$1"' gate-lease-holder "$GATE_LEASE_FIFO" &
  GATE_LEASE_PID=$!

  # The verb writes its status file the moment the lease RESOLVES — held, timed out or
  # unavailable — so this waits on the lease's own signal rather than on a duration. The poll
  # ceiling is only a backstop for a holder that vanished without writing anything: at 0.2 s a
  # poll, 6600 polls is 22 minutes, comfortably past the verb's own 20-minute bound.
  deadline=6600
  while [ "$polls" -lt "$deadline" ]; do
    [ -s "$status" ] && break
    kill -0 "$GATE_LEASE_PID" 2>/dev/null || break
    sleep 0.2
    polls=$((polls + 1))
  done

  if [ ! -s "$status" ]; then
    printf 'gate lease    UNAVAILABLE: the lease helper produced no status — running unleased\n'
    gate_lease_drop
    return 0
  fi
  GATE_LEASE_WAIT_MS="$(node -e '
    const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(s.waitedMs ?? ""));
  ' "$status" 2>/dev/null)" || GATE_LEASE_WAIT_MS=""
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
  [ -n "$GATE_LEASE_PID" ] || { [ -n "$GATE_LEASE_FIFO" ] && exec 9>&- 2>/dev/null; GATE_LEASE_FIFO=""; return 0; }
  printf 'release\n' >&9 2>/dev/null
  wait "$GATE_LEASE_PID" 2>/dev/null
  GATE_LEASE_PID=""
  exec 9>&- 2>/dev/null
  rm -f "$GATE_LEASE_FIFO" 2>/dev/null
  GATE_LEASE_FIFO=""
}

