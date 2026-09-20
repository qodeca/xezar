import { parsePortValue } from '../cli-settings.ts';
import { projectDataDir } from '../project-data-paths.ts';
import { foreignWriterClaimIsLive } from '../runs/project-writer.ts';
import type { ProjectInstance } from '@qodeca/xezar-contract';

/**
 * Which registered projects are served by another xezar right now, and where (#467, PR 3;
 * `designs/cli-terminal/multi-instance.md` § 6)?
 *
 * The answer is the `instance?` field of `GET /api/v1/projects`, and it is DERIVED on every
 * request from two live facts and never from a stored one:
 *
 * 1. **A health probe** of the address that project's cockpit last really listened on
 *    (`projects[].lastListen`), accepted ONLY when the answer names that project as its
 *    `bootProject`.
 * 2. **A writer claim** in the project's own data directory, which says a process is up even
 *    when no address can be reached.
 *
 * `lastListen` alone is never enough and that is the whole point of this module:
 * `BACKWARD_COMPATIBILITY.md` § 9 records it as a hint carrying "no pid, lease or socket path"
 * and "never to be rendered as running without a liveness check of its own". A remembered port
 * is stale the moment the process exits and can be taken by a completely different program the
 * moment after that, so this module treats it strictly as an ADDRESS TO ASK, never as evidence.
 *
 * Three properties are load-bearing and each has a named break in the test file beside this one:
 *
 * - **The identity check.** Another project's cockpit sitting on the remembered port answers
 *   health perfectly well. Only an answer naming THIS project reaches `running`
 *   (`wrong-project-accepted`).
 * - **No address is not "stopped".** A cockpit started with `--port 0` deliberately remembers
 *   nothing (`cli-settings.ts`, Q-4), so a live claim with no address is
 *   `running-unknown-address` — the process is up and this cockpit simply cannot link to it
 *   (`port-zero-reads-as-stopped`).
 * - **The probe never blocks the registry.** `GET /api/v1/projects` renders the sidebar; it does
 *   not wait on a socket. A project whose address has not been asked yet answers `checking` and
 *   the answer is cached for ten seconds (`designs/cli-terminal/multi-instance.md` § 6).
 *
 * It never runs in hosted mode at all. That guard lives at the route, because the decision is
 * "may this server reach out to another port on this machine" and the route is where
 * `capabilities()` is known; this module is then simply never consulted and the field is absent.
 *
 * **Where the probe may reach.** It asks the bind address that project RECORDED, not loopback by
 * definition: `lastListen.host` is written as the `--bind-host` the operator chose, so a sibling
 * cockpit on `192.168.x.y` is a legitimate answer and is asked at that address. `~/.xezar/config.json`
 * is hand-editable, so a host put there by hand — `10.1.2.3`, `evil.example.com` — is likewise asked
 * as written; `HOST_SHAPE` below narrows only the SHAPE of the value, never its range (#766, review
 * finding 2). Two things bound that reach and both are load-bearing: the request is a plain GET
 * carrying nothing but `accept: application/json` — no credential, no cookie, no project id — and it
 * refuses redirects (`redirect: 'error'`), so the one address asked is the only address reached.
 */

/** The bound on one probe. A cockpit answering health on loopback answers in single-digit
 *  milliseconds; anything slower is, for a list render, indistinguishable from absent. */
export const HEALTH_PROBE_TIMEOUT_MS = 300;

/** How long one project's answer is reused. The design's number (§ 6): the value is only needed
 *  while a person looks at the switcher, so it is refreshed on the open and not on a timer. */
export const LIVENESS_CACHE_MS = 10_000;

/** Where a project's cockpit last really listened — the `lastListen` hint, already narrowed to
 *  the two fields that make an address. */
export interface InstanceAddress {
  host: string;
  port: number;
}

/** What asking one address answered. `no-answer` covers every way a probe can fail to prove
 *  anything — refused, timed out, not JSON, or JSON without a `bootProject` — because a list
 *  render has the same thing to say about all of them. */
export type ProbeAnswer = { kind: 'named'; bootProject: string } | { kind: 'no-answer' };

export type HealthProbe = (address: InstanceAddress) => Promise<ProbeAnswer>;

/** Is a live writer claim held on this project's data by some OTHER process? */
export type ClaimCheck = (root: string) => boolean;

/** The registry facts one row needs. A structural type, not the registry's own: this module has
 *  no business with the rest of a `WorkspaceProject`, and `lastListen` arrives through a
 *  `.passthrough()` schema, so its two fields are `unknown` until parsed here. */
export interface LivenessProject {
  id: string;
  root: string;
  lastListen?: { port?: unknown; host?: unknown } | undefined;
}

/**
 * The remembered address, or `null` when there is none to ask.
 *
 * Port `0` is `null` on purpose and is not a defensive check: `--port 0` never writes
 * `lastListen` at all, so a stored `0` could only come from a hand-edited file — and "any port"
 * still names no address. An absent or unusable host falls back to loopback rather than to
 * `null`: every xezar binds loopback unless someone passed `--bind-host`, and refusing to ask
 * would report a running cockpit as stopped over a missing field.
 *
 * A host that is not a plain hostname or IP literal also falls back to loopback. xezar only ever
 * writes a bind address here, but this file is hand-editable and the value becomes BOTH a URL
 * this server fetches and a URL the cockpit renders — so a `host` carrying a path, a userinfo or
 * a query is not a host, and it is treated as an absent one rather than pasted into either.
 */
const HOST_SHAPE = /^[A-Za-z0-9._-]+$|^\[?[0-9A-Fa-f:.]+\]?$/;

export function parseInstanceAddress(hint: LivenessProject['lastListen']): InstanceAddress | null {
  const port = parsePortValue(hint?.port);
  if (port === null || port <= 0) return null;
  const raw = typeof hint?.host === 'string' ? hint.host.trim() : '';
  const host = raw !== '' && HOST_SHAPE.test(raw) ? raw : '127.0.0.1';
  return { host, port };
}

/**
 * The address a BROWSER should follow, from the address this server probed.
 *
 * A wildcard bind (`0.0.0.0`, `::`) is an address to listen on, never one to navigate to, so it
 * becomes `localhost`; an IPv6 literal is bracketed. The path is the project's own scoped route
 * on ITS cockpit, which is what makes the row a link out rather than a link in place.
 */
export function instanceOrigin(address: InstanceAddress): string {
  const wildcard = address.host === '0.0.0.0' || address.host === '::' || address.host === '[::]';
  const literalV6 = !wildcard && address.host.includes(':') && !address.host.startsWith('[');
  const host = wildcard ? 'localhost' : literalV6 ? `[${address.host}]` : address.host;
  return `http://${host}:${address.port}`;
}

export function instanceUrl(address: InstanceAddress, projectId: string): string {
  return `${instanceOrigin(address)}/p/${encodeURIComponent(projectId)}/`;
}

/**
 * The state machine, as one pure function: two checked facts in, one answer out.
 *
 * Pure and exported so the five states can be tested without a socket, a clock or a cache — the
 * cache below decides WHEN this runs and never WHAT it decides. `this` is not here: it is
 * answered by identity before any check, and mixing "who am I" into "did anyone answer" is how a
 * probe result would get a chance to overrule it.
 */
export function instanceStateOf(input: {
  projectId: string;
  /** `null` when nothing was remembered — the `--port 0` shape. */
  address: InstanceAddress | null;
  /** `null` when no address was asked. */
  answer: ProbeAnswer | null;
  claimLive: boolean;
}): ProjectInstance {
  const { projectId, address, answer, claimLive } = input;
  if (address !== null && answer?.kind === 'named' && answer.bootProject === projectId) {
    // The identity check is also what keeps a `url` from ever pointing at THIS instance: this
    // process's health names the project IT boots, so its own address can never satisfy another
    // project's row.
    return { state: 'running', url: instanceUrl(address, projectId) };
  }
  // No answer, or an answer from something else on that port. The claim is the second opinion:
  // it is a fact on this machine's filesystem rather than a remembered number, so a process with
  // no reachable address is still honestly "running" — just not linkable.
  return claimLive ? { state: 'running-unknown-address' } : { state: 'stopped' };
}

/** `GET /api/v1/health` at one address, bounded. Everything that is not a JSON body carrying a
 *  string `bootProject` is `no-answer`: this is a probe of an unknown listener, so it trusts the
 *  shape only far enough to read the one field the identity check needs.
 *
 *  `redirect: 'error'` is pinned by the named break `BREAK-467-3-REDIRECT-FOLLOWED` — remove it and
 *  that case goes red (#766, review finding 1).
 *  `fetch` defaults to `follow`, and following would mean the answer that proves "it is that
 *  project" can come from a server that is NOT at the address the row then links to — whatever
 *  holds the remembered port could steer this server's one outbound request at an arbitrary URL,
 *  off-machine included. A 3xx therefore throws here and lands in the catch below as `no-answer`,
 *  exactly like a refused connection. Exported for its own tests; the class injects it by default. */
export const fetchHealth: HealthProbe = async (address) => {
  try {
    const response = await fetch(`${instanceOrigin(address)}/api/v1/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      headers: { accept: 'application/json' },
      redirect: 'error',
    });
    if (!response.ok) return { kind: 'no-answer' };
    const body: unknown = await response.json();
    const bootProject = (body as { bootProject?: unknown } | null)?.bootProject;
    return typeof bootProject === 'string' ? { kind: 'named', bootProject } : { kind: 'no-answer' };
  } catch {
    return { kind: 'no-answer' };
  }
};

const claimOnDisk: ClaimCheck = (root) => foreignWriterClaimIsLive(projectDataDir(root));

/**
 * The per-request reader the projects route calls, with the ten-second cache in front of it.
 *
 * Deliberately NOT one method per state: a caller asks "what is this project doing" and gets
 * whichever of the five answers is true, so a new state can never be a new call site to
 * remember. The two halves differ only in whether a socket is involved:
 *
 * - **Nothing to ask** (no remembered address) — answered SYNCHRONOUSLY from the claim, so the
 *   common case (a project no cockpit is running) never renders `checking` and never flickers
 *   from one list render to the next.
 * - **Something to ask** — answered from the cache while a bounded probe refreshes it in the
 *   background. The first read says `checking`; a stale read keeps saying what it last knew
 *   rather than reverting to `checking`, because a row that blinks back to "checking…" every ten
 *   seconds is worse than one that is briefly ten seconds old.
 */
export class InstanceLiveness {
  readonly #probe: HealthProbe;
  readonly #claimLive: ClaimCheck;
  readonly #now: () => number;
  readonly #cacheMs: number;
  readonly #cache = new Map<string, { at: number; value: ProjectInstance; projectId: string }>();
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(deps: {
    probe?: HealthProbe;
    claimLive?: ClaimCheck;
    now?: () => number;
    cacheMs?: number;
  } = {}) {
    this.#probe = deps.probe ?? fetchHealth;
    this.#claimLive = deps.claimLive ?? claimOnDisk;
    this.#now = deps.now ?? (() => Date.now());
    this.#cacheMs = deps.cacheMs ?? LIVENESS_CACHE_MS;
  }

  /** What `project` is doing. `bootProjectId` is this process's own project — the one row that
   *  is answered by identity rather than by a check. */
  answer(project: LivenessProject, bootProjectId: string | undefined): ProjectInstance {
    if (bootProjectId !== undefined && bootProjectId !== '' && project.id === bootProjectId) {
      return { state: 'this' };
    }
    const address = parseInstanceAddress(project.lastListen);
    // Keyed by the ADDRESS as well as the id: a project that moved port has a different question
    // to answer, and reusing the previous port's verdict for it would be the stale-hint bug in a
    // different coat.
    const key = address === null ? `${project.id}@-` : `${project.id}@${address.host}:${address.port}`;
    const cached = this.#cache.get(key);
    const fresh = cached !== undefined && this.#now() - cached.at < this.#cacheMs;
    if (fresh) return cached.value;
    if (address === null) {
      const value = instanceStateOf({
        projectId: project.id,
        address: null,
        answer: null,
        claimLive: this.#safeClaim(project.root),
      });
      this.#cache.set(key, { at: this.#now(), value, projectId: project.id });
      return value;
    }
    this.#refresh(key, project, address);
    return cached?.value ?? { state: 'checking' };
  }

  /**
   * Drop every cached answer for a project that is no longer in the registry (#766, review nit 4).
   *
   * Called by the route in the same pass that fills the cache, with the ids it just answered.
   * Keys are `<projectId>@<host>:<port>` on purpose — a project that moved port must be a new
   * question — so without this every address a project was ever seen at, and every project since
   * removed from the registry, would keep a row for the life of the process. A project still
   * registered keeps its other-address rows: they age out of the window on their own, and their
   * question can come back when it moves back.
   */
  retainOnly(projectIds: Iterable<string>): void {
    const live = new Set(projectIds);
    for (const [key, entry] of this.#cache) {
      if (!live.has(entry.projectId)) this.#cache.delete(key);
    }
  }

  /** Every probe started so far has finished. For tests and for nothing else: production reads
   *  the cache and lets the next request see the newer answer. */
  async settled(): Promise<void> {
    // A loop rather than one `Promise.all`: a refresh can only be started by `answer`, but an
    // awaiting test may well call `answer` again between two ticks.
    while (this.#inFlight.size > 0) await Promise.all([...this.#inFlight.values()]);
  }

  #refresh(key: string, project: LivenessProject, address: InstanceAddress): void {
    if (this.#inFlight.has(key)) return;
    const task = (async () => {
      const answer = await this.#probe(address).catch((): ProbeAnswer => ({ kind: 'no-answer' }));
      const value = instanceStateOf({
        projectId: project.id,
        address,
        answer,
        claimLive: this.#safeClaim(project.root),
      });
      this.#cache.set(key, { at: this.#now(), value, projectId: project.id });
    })().finally(() => {
      this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, task);
  }

  /** A claim check that cannot fail a list render. `foreignWriterClaimIsLive` already swallows
   *  its own I/O, so this guards an injected one — and "we could not look" is "no live claim",
   *  the direction that only ever widens `stopped`. */
  #safeClaim(root: string): boolean {
    try {
      return this.#claimLive(root);
    } catch {
      return false;
    }
  }
}
