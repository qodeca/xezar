import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  MCP_PROJECT_OCCUPIED_CODE,
  MCP_PROJECT_OCCUPIED_REASON,
  MCP_SESSION_EXPIRED_CODE,
  MCP_SESSION_EXPIRED_REASON,
  type McpProjectOccupiedError,
  type McpSessionExpiredError,
  type ProjectOwnerState,
} from '@qodeca/xezar-contract';

/**
 * Exclusive per-project MCP ownership (#99), implementing decision D-02
 * (`docs/features/mcp-server/mcp-d02-session-binding-decision.md`). Every number and rule below
 * was fixed there, or adopted by D-09 as B-13 to B-15; none is a knob.
 *
 * One logical MCP session owns a project. The xezar SERVICE holds the owner record on that
 * session's behalf (D-02.1), because the service is where every write is gated — a claim held by
 * something that does not check it before a mutation is decoration. Cross-process exclusion of the
 * service itself is already `ownProjectData`'s job (`runs/project-writer.ts`); this module decides
 * which session INSIDE the owning service may write, and what a returning client is told.
 *
 * Mechanism, in the order a session meets it:
 *
 * - **Acquire** (D-02.2): publish a uniquely named claim with `openSync(path, 'wx', 0o600)`, THEN
 *   scan for peers. A live peer means "not the owner", always; dead or expired peers are reaped,
 *   which is safe only because the reaper has already published its own claim. Two simultaneous
 *   contenders may both refuse, never both succeed, so a refusal retries: 5 attempts, full-jitter
 *   backoff over a doubling window capped at 200 ms. Exhaustion answers *project-occupied*.
 *   NOT the `mergeWriteWorkspaceConfig` read-modify-write shape, and NOT the unlink-and-retry
 *   stale reclaim of `AutomationStore.acquireLease`: D-02 measured both admitting two owners.
 * - **Fence** (D-02.3): acquisition MINTS a token, `<wall-clock ms>-<UUIDv4>`, and every mutation
 *   is checked for EQUALITY against the current live owner's token (`checkMutation`). Never
 *   derived from what is on disk — reaping deletes exactly what a `max + 1` counter would read, so
 *   a derived generation hands the next owner the number the previous owner still holds. The
 *   wall-clock prefix is for humans reading logs; nothing fences on it.
 * - **Renew** (D-02.5): a background timer rewrites the claim every 5 s; the lease is 30 s. The
 *   timer consumes no model turn, so MODEL SILENCE IS NOT SESSION DEATH — an owner that says
 *   nothing for an hour is still the owner.
 * - **Resumed owner** (D-02.5): a renewal that finds the lease already lapsed — a frozen process,
 *   a suspended laptop, a claim that vanished — must NOT renew. Renewing a lease that may already
 *   have been reclaimed is how two owners are made. It drops its claim and re-runs acquisition
 *   from scratch under a NEW token; if it loses, its session is expired.
 * - **Release** (D-02.4, D-02.7): only on confirmed termination (`release`, fired by the transport
 *   when the bridge's connection closes — never by one request ending or one stream closing) or
 *   expiry. Releasing touches the claim file and this object's own memory, and NOTHING else: this
 *   module imports nothing that can reach a run, so a started task keeps running across every
 *   handover (N-05). The inverse holds too — a task ending or parking at `waiting` releases
 *   nothing.
 *
 * There is no manual disconnect and no forced takeover (F-18): nothing here lets one session evict
 * another. `occupied` is left only by the real owner ending or expiring.
 *
 * ## Every state, and who fires each exit
 *
 * No exit below is a human action, so no state is a dead end.
 *
 * | State | Exit | Who fires it | If nobody fires it |
 * | --- | --- | --- | --- |
 * | unowned | → owned | a client's `initialize`, via `acquire` | stays unowned — the correct resting state; nothing is blocked |
 * | acquiring | → owned / → occupied | the acquiring call itself | bounded: 5 attempts, ≤ 200 ms per backoff |
 * | owned | → unowned | the transport, on connection close (`release`) | falls through to expiry |
 * | owned | → expired | lease arithmetic at every read (`checkMutation`, `state`, the next `acquire`) | no timer is needed: expiry is derived, not stored |
 * | owned, process frozen | → expired | nothing but the lease | the lease IS the exit — the reason it exists |
 * | owner resumed after lost time | → owned (new token) / → expired | the owner's own renewal tick | mandatory, not best-effort: skipping it renews a lost lease |
 * | expired | → unowned / → owned by another | the next `acquire`, which reaps the claim | nothing waits on an expired claim except a would-be owner, whose arrival is the trigger |
 * | fenced session | → a fresh session | the bridge, automatically, on the session-expired error | not a dead end: reconnecting is the client's own protocol obligation |
 * | occupied (a refused second client) | → owned by it, later | that client retrying | the real owner and the cockpit keep working |
 *
 * What reaches a terminal state BECAUSE of this lease: an MCP session (fenced or expired), and
 * nothing else. No run, queue, worktree or executor does.
 *
 * ## Known limits, named rather than hidden
 *
 * - **The wall clock, on purpose.** Leases compare `Date.now()` values, because a monotonic clock
 *   stops while a laptop sleeps and would hide exactly the suspension the resumed-owner rule
 *   exists for. The cost: a clock set BACKWARDS makes a claim read as fresh until the clock
 *   catches up. A dead holder is still freed by the pid probe; only a frozen-but-alive holder
 *   waits longer.
 * - **Check, then act.** The fence runs before a mutation starts. A mutation that passed it is not
 *   re-checked part-way through its own asynchronous work.
 * - **The lease boundary between processes.** A peer that reads a claim a microsecond after its
 *   lease lapsed may reap it while the owner is mid-renewal. The owner detects an unlinked claim
 *   after writing (`nlink === 0`) and re-acquires; a reap landing after that check is caught on
 *   the next tick. Two services cannot both hold a project's data anyway (`ownProjectData`).
 * - **A connected but wedged bridge** keeps ownership until its transport closes: D-02.4 leaves an
 *   application-level `ping` Open, and this module implements the three signals D-02 decided.
 *
 * ## Where the claim lives (D-02.8)
 *
 * `<dataDir>/mcp-owner-claims/<pid>-<uuid>.json`, `0600`, in the bound project's own `.local/xezar`
 * — gitignored, per project, deletable at any moment (the next acquisition rebuilds it, and the
 * minted token keeps a pre-deletion owner fenced). Not in `~/.xezar/config.json`: that file merges
 * additively, and mutual exclusion is not additive. D-02 left the exact directory name open and
 * D-04 did not claim it; `mcp-owner-claims` is the smallest name that says what it holds.
 */

/** Renewal interval. D-02.5; D-09 B-13. */
export const OWNER_RENEW_INTERVAL_MS = 5_000;
/** Owner lease. D-02.5; D-09 B-14. */
export const OWNER_LEASE_MS = 30_000;
/** Acquisition attempts before answering project-occupied. D-02.2; D-09 B-15. */
export const OWNER_ACQUIRE_ATTEMPTS = 5;
/** Cap on the doubling full-jitter backoff window. D-02.2; D-09 B-15. */
export const OWNER_BACKOFF_CAP_MS = 200;
/**
 * The window the doubling starts from. D-02 fixed the attempts and the cap but not the start;
 * 25 ms doubles to the cap at the last retry (25, 50, 100, 200), so the whole budget waits at most
 * 375 ms — inside the same order as the 98 ms worst case D-02 measured at eight contenders.
 */
const OWNER_BACKOFF_BASE_MS = 25;

/** The claim directory's name inside the project's data directory. */
export const OWNER_CLAIM_DIR = 'mcp-owner-claims';

const CLAIM_NAME = /^([1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

/** The on-disk claim — local runtime state, never an API shape, so it lives here. It holds no
 *  session key: the file identifies a holder process and a lease, not a client. */
const claimSchema = z.object({
  v: z.literal(1),
  token: z.string(),
  pid: z.number().int().positive(),
  host: z.string(),
  acquiredAt: z.number(),
  renewedAt: z.number(),
});
type Claim = z.infer<typeof claimSchema>;

/** What `acquire` answers. `closed` means the session's transport closed while it was acquiring,
 *  so nothing was kept on its behalf. */
export type AcquireResult =
  | { outcome: 'owner'; token: string }
  | { outcome: 'occupied'; error: McpProjectOccupiedError }
  | { outcome: 'closed' };

/** What `checkMutation` answers. A mutation proceeds only on `ok: true`. */
export type MutationCheck = { ok: true } | { ok: false; error: McpSessionExpiredError };

export interface ProjectOwnershipOptions {
  /** The bound project's data directory (`ProjectContext.dataDir`). */
  dataDir: string;
  /** The project's own id — the only identifier either error carries. */
  projectId: string;
  /** Seams for tests. Production uses the defaults. */
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pid?: number;
  host?: string;
  isAlive?: (pid: number) => boolean;
  /** `false` leaves the renewal timer off so a test drives `renewalTick()` by hand. */
  autoRenew?: boolean;
}

/** The project-occupied error. Carries the project's own id and nothing about the owner (N-01). */
export function projectOccupiedError(projectId: string): McpProjectOccupiedError {
  return {
    code: MCP_PROJECT_OCCUPIED_CODE,
    message:
      'This project is already connected to another MCP client. It becomes available when that client disconnects or its session expires; try again then.',
    data: { reason: MCP_PROJECT_OCCUPIED_REASON, projectId, retryable: true },
  };
}

/** The session-expired error a fenced or expired owner receives on any later call. */
export function sessionExpiredError(projectId: string): McpSessionExpiredError {
  return {
    code: MCP_SESSION_EXPIRED_CODE,
    message: 'This MCP session no longer owns the project. Reconnect to start a new session.',
    data: { reason: MCP_SESSION_EXPIRED_REASON, projectId, retryable: true },
  };
}

/** `process.kill(pid, 0)`: only `ESRCH` confirms death. `EPERM` is a live process we may not
 *  signal, and anything else is not proof of death either. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

type Verdict = 'live' | 'dead' | 'expired' | 'gone';

interface Holding {
  sessionKey: string;
  token: string;
  claimPath: string;
  acquiredAt: number;
  renewedAt: number;
}

interface Ticket {
  sessionKey: string;
  closed: boolean;
}

/** One project's owner slot. The service keeps one per bound project. */
export class ProjectOwnership {
  readonly projectId: string;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pid: number;
  private readonly host: string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly autoRenew: boolean;

  private holding: Holding | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Serialises this object's acquisitions, so two sessions in one process never interleave an
   *  attempt. Cross-process exclusion is the claim file's job, not this chain's. */
  private tail: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<Ticket>();
  private warnedRenewal = false;
  private disposed = false;

  constructor(options: ProjectOwnershipOptions) {
    this.projectId = options.projectId;
    this.dir = join(options.dataDir, OWNER_CLAIM_DIR);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pid = options.pid ?? process.pid;
    this.host = options.host ?? hostname();
    this.isAlive = options.isAlive ?? processAlive;
    this.autoRenew = options.autoRenew ?? true;
  }

  /**
   * Make `sessionKey` the owner, or say why not. Idempotent for the owner: every request and
   * stream of the SAME logical session gets the same token back, because they are not additional
   * clients. A different session is refused with the project-occupied error.
   */
  acquire(sessionKey: string): Promise<AcquireResult> {
    // After `dispose` the service is going away: nothing may claim on its behalf any more.
    const ticket: Ticket = { sessionKey, closed: this.disposed };
    this.pending.add(ticket);
    const run = this.tail.then(() => this.acquireSerial(ticket));
    this.tail = run.catch(() => undefined);
    return run.finally(() => this.pending.delete(ticket));
  }

  /**
   * The fence. Call it before EVERY mutation with the token the request was bound to; proceed
   * only on `ok: true`. Equality with the current live owner's token, and nothing weaker: a stale
   * token is refused even when its process is alive and even when its lease has not lapsed in its
   * own memory.
   */
  checkMutation(token: string): MutationCheck {
    const holding = this.liveHolding();
    if (!holding || holding.token !== token) return { ok: false, error: sessionExpiredError(this.projectId) };
    return { ok: true };
  }

  /** The token a new request from `sessionKey` binds to, or `undefined` when that session does not
   *  own the project (never did, released, fenced or expired) — the transport answers
   *  session-expired then. */
  sessionToken(sessionKey: string): string | undefined {
    const holding = this.liveHolding();
    return holding?.sessionKey === sessionKey ? holding.token : undefined;
  }

  /**
   * Confirmed termination of `sessionKey`: the transport observed its connection close. Frees the
   * project at once. Touches the claim file and this object's memory only — never a run (N-05).
   * Not to be called when one request completes or one stream closes; those are not session death.
   */
  release(sessionKey: string): void {
    for (const ticket of this.pending) if (ticket.sessionKey === sessionKey) ticket.closed = true;
    if (this.holding?.sessionKey === sessionKey) this.dropHolding();
  }

  /**
   * Occupancy as the cockpit renders it, derived at read time by the same classifier acquisition
   * uses — a dead owner's claim reads `expired` the moment it is true, never a stale `owned`.
   * Reads only; reaping stays with the next acquirer, who has published its own claim first.
   */
  state(): ProjectOwnerState {
    if (this.holding) return this.liveHolding() ? 'owned' : 'expired';
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (error) {
      if (isNotFound(error)) return 'unowned';
      throw error;
    }
    let sawStale = false;
    for (const name of names) {
      const match = CLAIM_NAME.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      // Our own process's only real ownership is `holding`; any other claim of ours is an
      // acquisition in flight, which must not flicker the display to `owned`.
      if (pid === this.pid) continue;
      const verdict = this.classify(join(this.dir, name), pid);
      if (verdict === 'live') return 'owned';
      if (verdict === 'dead' || verdict === 'expired') sawStale = true;
    }
    return sawStale ? 'expired' : 'unowned';
  }

  /**
   * One renewal. The timer fires it every `OWNER_RENEW_INTERVAL_MS`; tests call it directly.
   * The resumed-owner rule lives here: a lease that has already lapsed is NEVER renewed.
   */
  renewalTick(): void {
    const holding = this.holding;
    if (!holding) {
      this.stopTimer();
      return;
    }
    const at = this.now();
    if (at - holding.renewedAt > OWNER_LEASE_MS) {
      this.reacquire(holding.sessionKey);
      return;
    }
    let descriptor: number;
    try {
      // `r+`, never a create: a claim that was reaped while we were away must not be resurrected
      // beside the owner that reaped it.
      descriptor = openSync(holding.claimPath, 'r+');
    } catch (error) {
      if (isNotFound(error)) {
        this.reacquire(holding.sessionKey);
        return;
      }
      this.warnRenewal(error);
      return;
    }
    let reaped = false;
    try {
      const bytes = Buffer.from(JSON.stringify(this.claimBody(holding.token, holding.acquiredAt, at)));
      writeSync(descriptor, bytes, 0, bytes.length, 0);
      ftruncateSync(descriptor, bytes.length);
      // A peer may have unlinked the claim between our open and our write; the write then landed
      // on an inode nobody can see, and extending our lease on it would be a lie.
      reaped = fstatSync(descriptor).nlink === 0;
      if (!reaped) holding.renewedAt = at;
    } catch (error) {
      // The on-disk lease was not extended, so neither is ours: we fence ourselves at the same
      // moment a peer may reap us, instead of writing on a lease nobody else can see.
      this.warnRenewal(error);
    } finally {
      closeSync(descriptor);
    }
    if (reaped) this.reacquire(holding.sessionKey);
  }

  /** Service shutdown: every session ends (D-02 § 5), and the claim goes with it. */
  dispose(): void {
    this.disposed = true;
    for (const ticket of this.pending) ticket.closed = true;
    this.dropHolding();
  }

  private async acquireSerial(ticket: Ticket): Promise<AcquireResult> {
    for (let attempt = 0; attempt < OWNER_ACQUIRE_ATTEMPTS; attempt += 1) {
      if (ticket.closed) return { outcome: 'closed' };
      const live = this.liveHolding();
      if (live) {
        if (live.sessionKey === ticket.sessionKey) return { outcome: 'owner', token: live.token };
        return { outcome: 'occupied', error: projectOccupiedError(this.projectId) };
      }
      // Whoever notices first ends an expired holding; its claim is ours to remove.
      if (this.holding) this.dropHolding();
      const won = this.attemptOnce();
      if (won) {
        this.holding = { sessionKey: ticket.sessionKey, ...won };
        this.startTimer();
        return { outcome: 'owner', token: won.token };
      }
      if (attempt < OWNER_ACQUIRE_ATTEMPTS - 1) {
        const window = Math.min(OWNER_BACKOFF_CAP_MS, OWNER_BACKOFF_BASE_MS * 2 ** attempt);
        await this.sleep(this.random() * window);
      }
    }
    return { outcome: 'occupied', error: projectOccupiedError(this.projectId) };
  }

  /** Publish, then scan. Synchronous from the create to the verdict, so nothing in this process
   *  can interleave with one attempt. */
  private attemptOnce(): Omit<Holding, 'sessionKey'> | undefined {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const at = this.now();
    const token = `${at}-${randomUUID()}`;
    const claimPath = join(this.dir, `${this.pid}-${randomUUID()}.json`);
    let published = false;
    try {
      const descriptor = openSync(claimPath, 'wx', 0o600);
      published = true; // The exclusive create is the publication, even if the write below fails.
      try {
        writeSync(descriptor, JSON.stringify(this.claimBody(token, at, at)));
      } finally {
        closeSync(descriptor);
      }
      for (const name of readdirSync(this.dir)) {
        const path = join(this.dir, name);
        if (path === claimPath) continue;
        const match = CLAIM_NAME.exec(name);
        if (!match) continue; // Every claim carries this name; anything else is not a claim.
        const verdict = this.classify(path, Number(match[1]));
        if (verdict === 'live') {
          unlinkIfPresent(claimPath);
          published = false;
          return undefined;
        }
        // Safe to reap only because our own claim is already published: a contender arriving now
        // sees us and stands down. Names are unique, so this can never remove a replacement's claim.
        // The verdict is what admits us, not the unlink: a dead or expired claim we cannot remove
        // (a read-only entry) blocks nobody, and every other contender reads the same verdict.
        if (verdict === 'dead' || verdict === 'expired') {
          try {
            unlinkIfPresent(path);
          } catch {
            /* Left for the next acquirer; it is not an owner either way. */
          }
        }
      }
      return { token, claimPath, acquiredAt: at, renewedAt: at };
    } catch (error) {
      if (published) {
        try {
          unlinkSync(claimPath);
        } catch {
          /* Never remove anything but our own claim. */
        }
      }
      throw error;
    }
  }

  /**
   * The one classifier acquisition and `state` share. Fails closed: an unreadable or half-written
   * claim is live until its pid is confirmed dead or its file outlives the lease.
   */
  private classify(path: string, pid: number): Verdict {
    let raw: string | undefined;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return 'gone'; // A refused contender removed its own claim.
      // Unreadable (EACCES, EISDIR, …): judged like a half-written claim, by pid and age, so one
      // odd entry can neither block the project forever nor be mistaken for a free slot.
    }
    let claim: Claim | undefined;
    try {
      const parsed = raw === undefined ? undefined : claimSchema.safeParse(JSON.parse(raw));
      if (parsed?.success) claim = parsed.data;
    } catch {
      /* A contender mid-write, or a torn renewal. Judged by pid and mtime below. */
    }
    // A pid is only meaningful on the host that issued it.
    if ((!claim || claim.host === this.host) && !this.isAlive(pid)) return 'dead';
    let renewedAt = claim?.renewedAt;
    if (renewedAt === undefined) {
      try {
        renewedAt = statSync(path).mtimeMs;
      } catch (error) {
        if (isNotFound(error)) return 'gone';
        throw error;
      }
    }
    return this.now() - renewedAt > OWNER_LEASE_MS ? 'expired' : 'live';
  }

  /** The holding, if its lease has not lapsed. Expiry is arithmetic, not an event: a frozen
   *  process that wakes up reads itself expired before any timer has had a chance to run. */
  private liveHolding(): Holding | undefined {
    const holding = this.holding;
    if (!holding || this.now() - holding.renewedAt > OWNER_LEASE_MS) return undefined;
    return holding;
  }

  /** Lost time or a lost claim: drop what we held and run acquisition from scratch. The old token
   *  is fenced whatever happens next, because a win mints a new one. */
  private reacquire(sessionKey: string): void {
    this.dropHolding();
    void this.acquire(sessionKey).catch((error: unknown) => {
      console.warn(`[xezar] MCP owner re-acquisition failed for project ${this.projectId}: ${String(error)}`);
    });
  }

  private dropHolding(): void {
    const holding = this.holding;
    this.holding = undefined;
    this.stopTimer();
    if (!holding) return;
    try {
      unlinkIfPresent(holding.claimPath);
    } catch (error) {
      // The claim outlives us on disk; its lease ages out and the next acquirer reaps it.
      console.warn(`[xezar] could not remove MCP owner claim for project ${this.projectId}: ${String(error)}`);
    }
  }

  private claimBody(token: string, acquiredAt: number, renewedAt: number): Claim {
    return { v: 1, token, pid: this.pid, host: this.host, acquiredAt, renewedAt };
  }

  private startTimer(): void {
    if (!this.autoRenew || this.timer) return;
    // A throw here would be an uncaught exception in the service. A failed tick leaves the lease
    // un-renewed, which expires on its own: the fail-closed outcome.
    this.timer = setInterval(() => {
      try {
        this.renewalTick();
      } catch (error) {
        this.warnRenewal(error);
      }
    }, OWNER_RENEW_INTERVAL_MS);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private warnRenewal(error: unknown): void {
    if (this.warnedRenewal) return;
    this.warnedRenewal = true;
    console.warn(`[xezar] MCP owner lease renewal failed for project ${this.projectId}: ${String(error)}`);
  }
}
