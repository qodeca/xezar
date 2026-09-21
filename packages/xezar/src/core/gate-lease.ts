import { spawn } from 'node:child_process';
import { open, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { acquireFileLock } from './file-lock.ts';
import { DEFAULT_GATE_SLOTS } from '../workspace/config.ts';

/**
 * The gate lease (#672): a machine-wide, bounded, FAIL-OPEN queue in front of a full gate run.
 *
 * ## Why it exists
 *
 * A gate run is the most expensive thing this repository does — `npm ci`, a build, four vitest
 * projects and a packed-tarball install — and several of them on one machine do not merely go
 * slower, they FAIL. The measured series is attempt failure at 20 % with one concurrent gate run,
 * 37 % at three, 90 % at four to five and 100 % at six or more, in suites the change under test
 * never touched. Until now the only control was a hand rule ("at most two at once") that the
 * leader had to apply from outside, and a task agent running its own gates could not see.
 *
 * ## What it is NOT
 *
 * It is not a scheduler and it holds nothing across a process death. It is N named lock files and
 * a wait, and every one of the three ways it can go wrong runs the gates anyway:
 *
 *   - the lock directory is unwritable  → run, loudly
 *   - the wait bound expires            → run, loudly
 *   - the verb cannot be resolved at all → the caller runs, loudly (`repo-gates.sh`)
 *
 * That is the policy `file-lock.ts` says each caller owns, and it is § Zero config: a lease that
 * cannot be taken must not turn a working gate into a failure. The cost of failing open is that
 * two gate runs occasionally overlap, which is what happens today on every run.
 *
 * ## The wall clock, stated honestly
 *
 * The bound is 20 minutes and it is a source constant, not a knob (#672 Q7, option (a)). A check
 * step has no wall clock at all — `runCheckStep` arms no timer — so the kit's `gates` step can
 * wait the whole bound safely. An AGENT step is different: it falls through to the runner's
 * 30-minute `DEFAULT_RUN_TIMEOUT_MS` unless its workflow sets `timeout`, and 20 minutes of
 * waiting plus a real gate run exceeds that. The bound alone therefore is NOT sufficient, and the
 * second half is a rule rather than code: the canonical gate list runs in the `gates` CHECK step,
 * never inside an authoring step. The residual — an author who runs the full list inside their own
 * 30-minute step can still be killed while waiting — is not hidden: the elapsed wait is printed
 * into the output and recorded as `leaseWaitMs` on the gate attempt, so that death is diagnosable
 * instead of mysterious. Pausing an agent step's clock was the alternative, and it was rejected
 * because it would couple the engine to a kit convention.
 */

/** How long a gate run waits for a slot before it gives up and runs anyway. */
export const GATE_LEASE_WAIT_MS = 20 * 60_000;

/**
 * How often the holder re-stamps its lock file.
 *
 * Without this, `file-lock.ts`'s freshness judgement is a guess about a caller whose hold is
 * measured in tens of minutes: the stamp is written once, at creation, and every bound this
 * module could pick would either be shorter than a slow gate run (a waiter takes over a slot a
 * live gate still holds — two holders, which is the one thing the lock promises not to do) or so
 * long that a machine that lost power keeps a slot blocked for an hour. A heartbeat removes the
 * choice: freshness becomes evidence of a process that is still running, and the stale bound only
 * has to outlast a few missed beats.
 */
export const GATE_LEASE_HEARTBEAT_MS = 10_000;

/**
 * The stale bound this caller names, replacing `FILE_LOCK_STALE_MS`'s 30 seconds.
 *
 * Six heartbeats. The machine this runs on is, by construction, the busiest it ever gets — that is
 * when the lease binds at all — and a timer on a host at load 39 does not fire on the second. Two
 * beats of slack would reclaim a live gate's slot on a bad afternoon; six will not.
 *
 * It does not delay reclaiming a killed holder, which is what the number looks like it costs.
 * `acquireFileLock` checks pid liveness first, so a `kill -9`ed holder is gone the moment the next
 * waiter looks, whatever this bound says. The bound only decides how long a lock whose pid was
 * REUSED, or whose process is alive but wedged, keeps a slot.
 */
export const GATE_LEASE_STALE_MS = 6 * GATE_LEASE_HEARTBEAT_MS;

/** How often a waiter re-sweeps the slots. Long compared with a file lock's 20 ms: the thing being
 *  waited for takes minutes, and a tight sweep on a loaded machine is itself load. */
export const GATE_LEASE_SWEEP_MS = 2_000;

/** How often the waiter says out loud that it is still waiting. */
export const GATE_LEASE_NOTICE_MS = 30_000;

/** The ceiling the stored `resources.gateSlots` is already bounded by; repeated here so a value
 *  that reached this module another way cannot ask for a hundred lock files. */
export const GATE_LEASE_MAX_SLOTS = 16;

export type GateLeaseEvent =
  | { readonly type: 'acquired'; readonly slot: number; readonly slots: number; readonly waitedMs: number }
  | { readonly type: 'waiting'; readonly slots: number; readonly waitedMs: number }
  | { readonly type: 'timeout'; readonly slots: number; readonly waitedMs: number }
  | { readonly type: 'unavailable'; readonly slots: number; readonly waitedMs: number; readonly reason: string }
  | { readonly type: 'heartbeat'; readonly slot: number; readonly at: number }
  | { readonly type: 'released'; readonly slot: number };

export interface GateLeaseOptions {
  /** Concurrent gate runs allowed. Clamped to [1, `GATE_LEASE_MAX_SLOTS`]. */
  slots?: number;
  /** Where the slot files live. Defaults to `gateLeaseDir()`; a test points it at its own
   *  directory, which is also the ONLY way to point it anywhere — there is deliberately no env
   *  var, because a new `XEZ_*` var is a `.env.example` contract change for a value nobody needs
   *  to set (§ Zero config). */
  lockDir?: string;
  waitMs?: number;
  heartbeatMs?: number;
  staleMs?: number;
  sweepMs?: number;
  noticeMs?: number;
  now?: () => number;
  /**
   * The lease's own signals. Every observable moment is emitted here — acquisition, each wait
   * notice, the timeout, an unwritable directory, each heartbeat, the release — so a test can
   * await what the lease DID instead of sleeping for how long it might take.
   */
  onEvent?: (event: GateLeaseEvent) => void;
}

export interface GateLease {
  /** Whether a slot was taken. `false` is a normal, expected outcome: run the gates anyway. */
  readonly held: boolean;
  /** 1-based slot number, or null when nothing was taken. */
  readonly slot: number | null;
  /** How long the caller queued. Recorded on the gate attempt as `leaseWaitMs`. */
  readonly waitedMs: number;
  readonly outcome: 'acquired' | 'timeout' | 'unavailable';
  /** Set for `unavailable` — the reason the lock directory could not be used. */
  readonly reason?: string;
  /** Always safe to call, exactly once, in a `finally`. A no-op when nothing was held. */
  release(): Promise<void>;
}

/**
 * Where the slot files live: a FIXED machine-wide path that does not move with the state layout
 * (#672 Q6).
 *
 * This is the one decision in the lease that could quietly undo it. `xezCacheDir()` — the obvious
 * home — answers `~/.cache/xez` in the global layout and `<project>/.local/xezar/cache` in
 * single-project mode, so two single-project folders on one machine would each get their own set
 * of slots and NOT contend. The failures this exists to prevent were machine-wide: one disk, one
 * page cache, one pool of vitest workers. A per-project lease would render, would test green, and
 * would prevent nothing.
 *
 * The precedent is the skills updater's machine-wide half at `~/.agents/.xez-skills-update.lock`,
 * "taken in every layout because that mirror never moves with the project"
 * (BACKWARD_COMPATIBILITY.md § 9). Unlike that one, this directory IS created on demand: a slot
 * file is xezar's own working state, not a third-party mirror whose absence means something.
 */
export function gateLeaseDir(): string {
  return join(homedir(), '.cache', 'xez', 'gate-slots');
}

function clampSlots(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_GATE_SLOTS;
  return Math.min(GATE_LEASE_MAX_SLOTS, Math.max(1, Math.floor(requested)));
}

export function slotLockPath(lockDir: string, slot: number): string {
  return join(lockDir, `gate-slot-${slot}.lock`);
}

/** `4m12s`, `18s` — the shape the wait line and the timeout line both print. */
export function formatWait(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

const noLease = (
  outcome: 'timeout' | 'unavailable',
  waitedMs: number,
  reason?: string,
): GateLease => ({
  held: false,
  slot: null,
  waitedMs,
  outcome,
  ...(reason !== undefined ? { reason } : {}),
  release: async () => undefined,
});

/**
 * Take one of `slots` machine-wide gate slots, or report why not. NEVER rejects and never blocks
 * past `waitMs`: every failure path is a value the caller runs the gates on anyway.
 */
export async function acquireGateLease(options: GateLeaseOptions = {}): Promise<GateLease> {
  const now = options.now ?? Date.now;
  const emit = options.onEvent ?? (() => undefined);
  const slots = clampSlots(options.slots);
  const lockDir = options.lockDir ?? gateLeaseDir();
  const heartbeatMs = options.heartbeatMs ?? GATE_LEASE_HEARTBEAT_MS;
  const staleMs = options.staleMs ?? GATE_LEASE_STALE_MS;
  const sweepMs = options.sweepMs ?? GATE_LEASE_SWEEP_MS;
  const noticeMs = options.noticeMs ?? GATE_LEASE_NOTICE_MS;
  const started = now();
  const deadline = started + (options.waitMs ?? GATE_LEASE_WAIT_MS);

  try {
    await mkdir(lockDir, { recursive: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    emit({ type: 'unavailable', slots, waitedMs: 0, reason });
    return noLease('unavailable', 0, reason);
  }

  let lastNotice = started;
  for (;;) {
    // Swept in order, so a machine with capacity to spare concentrates its runs on the low slots
    // and a `pgrep`-free look at the directory says how many are busy.
    let firstError: unknown = null;
    let errors = 0;
    for (let slot = 1; slot <= slots; slot += 1) {
      const lockPath = slotLockPath(lockDir, slot);
      // `waitMs: 0` is one attempt plus one takeover chance, not a wait: waiting per FILE would
      // spend the whole bound on slot 1 while slot 2 sat free. The wait belongs to the SWEEP.
      const attempt = await acquireFileLock(lockPath, { waitMs: 0, staleMs, now });
      if (attempt.acquired) {
        const waitedMs = now() - started;
        const heartbeat = startHeartbeat(lockPath, heartbeatMs, now, emit, slot);
        emit({ type: 'acquired', slot, slots, waitedMs });
        return {
          held: true,
          slot,
          waitedMs,
          outcome: 'acquired',
          release: async () => {
            clearInterval(heartbeat);
            await attempt.release();
            emit({ type: 'released', slot });
          },
        };
      }
      if (attempt.reason === 'error') {
        errors += 1;
        firstError ??= attempt.error;
      }
    }

    // EVERY slot answered `error` — a read-only or missing directory, not contention. Waiting out
    // twenty minutes for a permission problem to change its mind helps nobody.
    //
    // Every slot, not any: one slot failing while another is merely busy is a transient (the
    // directory removed under us between two sweeps, say), and giving up the whole lease for it
    // would drop the queueing this feature exists for on a machine that is otherwise fine. The
    // condition that is really being tested here is "this directory is unusable", and that one is
    // true of all N or of none.
    if (errors === slots && firstError !== null) {
      const reason = firstError instanceof Error ? firstError.message : String(firstError);
      const waitedMs = now() - started;
      emit({ type: 'unavailable', slots, waitedMs, reason });
      return noLease('unavailable', waitedMs, reason);
    }

    if (now() >= deadline) {
      const waitedMs = now() - started;
      emit({ type: 'timeout', slots, waitedMs });
      return noLease('timeout', waitedMs);
    }
    if (now() - lastNotice >= noticeMs) {
      lastNotice = now();
      emit({ type: 'waiting', slots, waitedMs: now() - started });
    }
    await sleep(sweepMs);
  }
}

/**
 * Re-stamp our own lock file so a waiter can tell a long gate run from an abandoned one.
 *
 * Opened `r+` ONCE per beat and written through that handle. The descriptor is bound to the inode
 * it opened, so if a takeover removed the file and another process created a new one in between,
 * this writes into an unlinked inode and harms nothing — where a `writeFile` by path would
 * overwrite the successor's lock with our token. The pid check is the second half: a lock whose
 * pid is not ours is not ours to stamp, and the beat stops.
 *
 * Every failure is silent on purpose. A heartbeat that cannot be written costs this run its slot
 * one stale window later; a heartbeat that throws would take down the gate run it is protecting.
 */
function startHeartbeat(
  lockPath: string,
  heartbeatMs: number,
  now: () => number,
  emit: (event: GateLeaseEvent) => void,
  slot: number,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void (async () => {
      let handle;
      try {
        handle = await open(lockPath, 'r+');
        const [pidText, , tokenText] = (await handle.readFile('utf8')).trim().split(/\s+/);
        if (Number(pidText) !== process.pid || !tokenText) return;
        const stamped = `${process.pid}\n${now()}\n${tokenText}\n`;
        await handle.truncate(0);
        await handle.write(stamped, 0);
        emit({ type: 'heartbeat', slot, at: now() });
      } catch {
        // Gone, unreadable, or read-only now. The stale bound answers it.
      } finally {
        await handle?.close().catch(() => undefined);
      }
    })();
  }, heartbeatMs);
  // Unref'd: the work that holds this process open is the gate run, never the timer. A caller that
  // leaked a lease must not also leak a process that never exits.
  timer.unref?.();
  return timer;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

export interface RunUnderGateLeaseOptions extends GateLeaseOptions {
  /** Where the loud lines go. Never stdout: stdout belongs to the command being run. */
  stderr?: { write(chunk: string): unknown };
  /** Injected for tests; defaults to `child_process.spawn` with inherited stdio. */
  run?: (argv: readonly string[]) => Promise<number>;
}

/** The human-readable line for one lease event, or null for the ones nobody needs narrated. */
export function gateLeaseLine(event: GateLeaseEvent): string | null {
  switch (event.type) {
    case 'waiting':
      return `xezar lease: waiting for a gate slot (${event.slots} of ${event.slots} busy, waited ${formatWait(event.waitedMs)})`;
    case 'acquired':
      return event.waitedMs >= 1000
        ? `xezar lease: gate slot ${event.slot} of ${event.slots} taken after ${formatWait(event.waitedMs)}`
        : `xezar lease: gate slot ${event.slot} of ${event.slots} taken`;
    case 'timeout':
      return (
        `xezar lease: NO GATE SLOT after ${formatWait(event.waitedMs)} — running anyway, unleased. ` +
        `All ${event.slots} slots stayed busy for the whole bound; this run and the others are now sharing the machine.`
      );
    case 'unavailable':
      return (
        `xezar lease: the gate slot directory is unusable (${event.reason}) — running anyway, unleased. ` +
        `Nothing is queued on this machine until it is writable again.`
      );
    default:
      return null;
  }
}

/**
 * Take a gate slot, run `argv`, release it, and answer the command's exit code.
 *
 * The lease is released in `finally`, including on the signal paths: a SIGINT or SIGTERM is
 * forwarded to the child and the slot goes back when the child is gone, rather than being left
 * for the stale bound to reclaim.
 */
export async function runUnderGateLease(
  argv: readonly string[],
  options: RunUnderGateLeaseOptions = {},
): Promise<number> {
  const stderr = options.stderr ?? process.stderr;
  const narrate = (event: GateLeaseEvent): void => {
    const line = gateLeaseLine(event);
    if (line !== null) stderr.write(`${line}\n`);
    options.onEvent?.(event);
  };
  const lease = await acquireGateLease({ ...options, onEvent: narrate });
  try {
    return await (options.run ?? spawnInherited)(argv);
  } finally {
    await lease.release();
  }
}

function spawnInherited(argv: readonly string[]): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(argv[0] as string, argv.slice(1), { stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals) => (): void => {
      child.kill(signal);
    };
    const onInt = forward('SIGINT');
    const onTerm = forward('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    const detach = (): void => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
    };
    child.on('error', (error) => {
      detach();
      fail(error);
    });
    child.on('close', (code, signal) => {
      detach();
      // The conventional shell encoding, so a killed gate reads as killed rather than as exit 0.
      done(signal !== null ? 128 + signalNumber(signal) : (code ?? 1));
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  const known: Record<string, number> = { SIGINT: 2, SIGKILL: 9, SIGTERM: 15, SIGHUP: 1 };
  return known[signal] ?? 0;
}
