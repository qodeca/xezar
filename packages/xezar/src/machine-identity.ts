import { createHash } from 'node:crypto';
import { readlinkSync } from 'node:fs';
import { readPlatformMachineId } from './platform/machine-id.ts';

/**
 * "Is a PID written into a file here comparable to a PID here?" is the one question the
 * writer-claim guard (`runs/project-writer.ts`) actually needs an answer to, and the one
 * `os.hostname()` cannot answer.
 *
 * A hostname was standing in for machine identity, and a laptop breaks that stand-in: the same
 * machine answers to `Marcins-MacBook-Pro-2.local` on one network and `Marcins-MBP-2.lan` on the
 * next, so its own dead claim became unreapable and the cockpit locked itself out of its own
 * `.local/xezar` until the file was deleted by hand (#199).
 *
 * ## Why a platform id and not a UUID this repo generates
 *
 * A generated `~/.xezar/machine-id` would be state a user can delete, and, decisively, it is
 * scoped by `XEZ_HOME`, which the writer claim is explicitly independent of ("independent of port
 * and XEZ_HOME", `ownProjectData`). The browser suite boots with `XEZ_HOME` pinned into
 * `.local/qa/` while writing claims into the repo's real `.local/xezar`, so a per-home UUID would
 * make that boot's claims foreign to an ordinary `npx @qodeca/xezar` in the same checkout: the very
 * failure #199 reports, re-created under a new trigger. The claim that triggered #199 was written
 * by exactly that test environment.
 *
 * The platform's own id is instead a FACT about the host: nothing to create, nothing to migrate,
 * nothing whose deletion is a lockout. Zero config in the strongest available sense, because it
 * adds no file at all.
 *
 * ## What goes into it
 *
 * - The platform machine id: `IOPlatformUUID` on macOS, `/etc/machine-id` (then the older D-Bus
 *   one) on Linux, `MachineGuid` on Windows. Required, because without it there is no identity.
 * - On Linux, the PID namespace as an extra component. Two containers started from one image
 *   share that image's baked `/etc/machine-id` while their PID numbers mean nothing to each
 *   other, so without it the NEW identity would say `same` about two mutually unreapable hosts.
 *
 * Be precise about what that second component buys, because the guard is one-way. It keeps the
 * new identity from WIDENING the unsafe reap; it does not narrow the old one. Two same-image
 * containers that also share a hostname are exactly as mutually reapable as they were before
 * #199 — the hostname fallback still says "same host", and no identity comparison is consulted
 * once that fallback matches. And because a container's PID-namespace inode changes every time
 * it is re-created, #199's fix does not reach containers at all: a restarted container computes a
 * different id, `machineRelation` answers `different`, and the guard degrades to today's hostname
 * rule. Safe, but not a fix there. Pinning a hostname remains the container answer.
 *
 * The parts are hashed rather than stored raw: the claim file lives in a project directory that
 * may be synced or shared, so it should carry an opaque stable token, not the machine's hardware
 * UUID.
 *
 * Every probe degrades to `null`: a missing `ioreg`, an unreadable `/proc`, a container with no
 * `/etc/machine-id`. `null` means "this host cannot identify itself", which the caller must treat
 * as unknown and never as a match (see `machineRelation`).
 */
export type MachineRelation = 'same' | 'different' | 'unknown';

/** Memoized for the process: one `ioreg` spawn at most, and a failed probe is never retried. */
let cached: string | null | undefined;

/**
 * A stable, opaque id for THIS machine, or `null` when the platform will not name itself.
 * Never throws, never retries, and never depends on `XEZ_HOME` or on any file xezar writes.
 */
export function localMachineId(): string | null {
  // Synchronous, and on the boot path (`openStore` → `ownProjectData` → here), so on macOS this
  // blocks the event loop for one `ioreg` spawn — measured at ~21 ms, capped at
  // `PROBE_TIMEOUT_MS` (platform/machine-id.ts), and memoized to at most one spawn per process. That is a deliberate
  // trade against AGENTS.md's never-block-the-boot rule rather than an oversight: the answer is
  // needed BEFORE the first claim is written, an async probe would mean either an unclaimed
  // window or an awaited boot, and every other outcome here is a plain file read. If the cap ever
  // becomes visible, move the probe off the claim path — not the timeout.
  if (cached !== undefined) return cached;
  let platform: string | null = null;
  try { platform = readPlatformMachineId(); } catch { platform = null; }
  if (!platform) {
    cached = null;
    return cached;
  }
  const parts = [platform];
  const namespace = readPidNamespace();
  if (namespace) parts.push(namespace);
  cached = createHash('sha256').update(`xezar-machine-id ${parts.join(' ')}`).digest('hex').slice(0, 32);
  return cached;
}

/**
 * How a claim's recorded identity relates to this machine's.
 *
 * `unknown` is a real answer and must never collapse into `same`: it is what an absent identity
 * (a claim written before #199), an empty one, and a host that cannot identify itself all
 * produce, and in each of those cases there is no evidence about the machine at all, only the
 * hostname it had at the time.
 */
export function machineRelation(claimed: unknown, local: string | null): MachineRelation {
  if (local === null || typeof claimed !== 'string' || claimed === '') return 'unknown';
  return claimed === local ? 'same' : 'different';
}

/** Test seam only: drop the memo so a case can exercise a different probe outcome. */
export function __clearMachineIdCacheForTests(): void {
  cached = undefined;
}

/** `pid:[4026531836]`, or `null` off Linux and wherever `/proc` is not readable. */
function readPidNamespace(): string | null {
  try { return readlinkSync('/proc/self/ns/pid').trim() || null; }
  catch { return null; }
}
