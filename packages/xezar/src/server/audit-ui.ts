import { existsSync, mkdirSync } from 'node:fs';
import type { Context, MiddlewareHandler, Next } from 'hono';
import type { AuditProxyUser } from '@qodeca/xezar-contract';
import { answerRefusal, auditAction } from '../mcp/audit-inventory.ts';
import { proxyUserOf } from '../mcp/audit-redaction.ts';
import { AuditTrail, doorAuditWarning, settlementForStatus, type AuditChannel, type AuditScope } from '../mcp/audit-trail.ts';
import { staleRejectionIn } from '../mcp/stale-write.ts';
import { ensureProjectDataIgnored, projectDataDir } from '../project-data-paths.ts';

/**
 * The cockpit door of the audit trail (#306, part 2) — spec
 * `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 4 (`ui` row), § 6 and § 9.
 *
 * WHAT IT IS. A route DECORATOR: `ui.route('run.cancel', …)` is a middleware placed in a route's
 * own chain, after its Zod validators and before its handler. It lets the handler run, then writes
 * one `ui` record from the route's answer. It is not a global `app.use`: only the routes of the
 * shared inventory (`mcp/audit-inventory.ts`) carry it, and `audit-inventory.test.ts` reads the
 * built route table to prove every inventoried route does and no other route does.
 *
 * THE DOOR IS THE CONNECTION, NEVER A HEADER. The MCP tools call these same routes in process
 * (`service.request(…)`, no socket), and those calls are already recorded once, as `mcp`, by the
 * MCP door. A request is the `ui` door only when it arrived over a real HTTP connection — the
 * Node adapter's `env.incoming`, which no client can send. Without that, the decorator passes
 * straight through and writes nothing.
 *
 * WHAT IS RECORDED. The action id from the inventory; `applied` for a 2xx; `refused` for a 4xx
 * (the routes validate and refuse before any effect), with `stale_version` when the 409 is the
 * stale-version rejection and `http_<status>` otherwise; nothing for a 5xx or a throw, which may
 * have come after the effect started (spec § 3.2) — the trail's one warning says so. Never a
 * GET: no read route carries the decorator.
 *
 * WHERE IT IS RECORDED. A project-scoped route writes to its resolved project's trail. A
 * workspace-level route writes to the project it names — a `:projectId` param, a `projectId` body
 * field, or the project a registration answered with — and otherwise to the boot project (§ 4).
 *
 * THE PROXY USER (§ 9 "Proxy user trust rule"). `X-Xezar-User` is read only in hosted mode AND only
 * when the immediate TCP peer is loopback, which is where the bundled nginx sits; it is trimmed,
 * stripped of control characters, capped at 128 UTF-16 code units and stored only as
 * `{ value, trust: 'asserted-by-proxy' }`. Local mode ignores it, and so does any other peer.
 *
 * NEVER FAILS THE REQUEST. Everything after the handler is inside one `try`; the response the
 * handler produced is returned unchanged whatever happens here.
 */

/** The one header a hosted cockpit may take a user name from. Read case-insensitively. */
export const PROXY_USER_HEADER = 'x-xezar-user';

/** Symbol a decorated handler carries, so the route table says which routes are audited. */
export const AUDIT_ROUTE: unique symbol = Symbol.for('xezar.audit.route');

export interface AuditRouteDescriptor {
  /** Every action id this route can record — more than one when the body selects (`archive`/`restore`). */
  readonly ids: readonly string[];
}

type Body = Record<string, unknown> | undefined;

export interface UiAuditRouteOptions {
  /** Picks the action from the validated body. Required with more than one id; `undefined` = a preview, no record. */
  readonly select?: (body: Body) => string | undefined;
  /** The resource a path param names, e.g. `{ kind: 'run', param: 'id' }`. */
  readonly resource?: { readonly kind: string; readonly param: string };
  /** Keep the body's top-level key names (a configuration write). */
  readonly fieldNames?: boolean;
  /**
   * Workspace-level routes only — which project's trail. `param`/`body` name the field holding a
   * project id, `registered` takes the project from a 2xx registration answer. Absent on a
   * workspace route: the boot project. Absent on a project-scoped route: the resolved scope.
   */
  readonly project?: { readonly param: string } | { readonly body: string } | 'registered';
}

export interface UiAuditDeps {
  /** Hosted mode — `!capabilities().localHandoff`. Read per request. */
  readonly hosted: () => boolean;
  /** The trail scope of a project-scoped request (`c.get('project')`), or `undefined` for a workspace route. */
  readonly requestScope: (c: Context) => Promise<AuditScope | undefined>;
  /** The boot project's scope. */
  readonly bootScope: () => Promise<AuditScope | undefined>;
  /** A registered project's scope by id, `undefined` when it is not registered. */
  readonly projectScope: (projectId: string) => Promise<AuditScope | undefined>;
  readonly warn?: (message: string) => void;
}

export interface UiAuditDoor {
  route(ids: string | readonly string[], options?: UiAuditRouteOptions): MiddlewareHandler;
}

/** The request arrived over a socket (the Node adapter's `env.incoming`), not through `app.request`. */
function connectionOf(c: Context): { socket?: { remoteAddress?: unknown } } | undefined {
  const incoming = (c.env as { incoming?: unknown } | undefined)?.incoming;
  return incoming !== null && typeof incoming === 'object' ? (incoming as { socket?: { remoteAddress?: unknown } }) : undefined;
}

/** 127.0.0.0/8, `::1`, or an IPv4-mapped loopback — the address forms a Node socket reports. */
export function isLoopbackPeer(address: unknown): boolean {
  if (typeof address !== 'string') return false;
  const v4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4) || address === '::1';
}

/**
 * § 9: trim, strip C0/C1 controls and DEL, cap at 128 code units, omit an empty result. The door
 * itself does not call it: it hands the trusted raw header to the audit seam, which applies this
 * same rule (`proxyUserOf` in `mcp/audit-redaction.ts`) for every record.
 */
export function sanitizeProxyUser(raw: string | undefined): AuditProxyUser | undefined {
  return proxyUserOf(raw);
}

/**
 * The credentials a request carries in `Authorization` — the ui door's own secrets. They are never
 * recorded; the seam masks them wherever the body repeats them, before hashing.
 */
export function requestCredentials(header: string | undefined): string[] {
  const match = header === undefined ? null : /^\s*(\S+)\s+(\S+)\s*$/.exec(header);
  if (!match) return header?.trim() ? [header.trim()] : [];
  const [, scheme, token] = match as unknown as [string, string, string];
  const out = [token];
  if (scheme.toLowerCase() === 'basic') {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon >= 0) out.push(decoded.slice(colon + 1));
  }
  return out.filter((value) => value !== '');
}

export function createUiAuditDoor(deps: UiAuditDeps): UiAuditDoor {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const channels = new Map<string, AuditChannel<'ui'> | null>();
  /**
   * The door's own setup failures share the project's one audit warning (spec A7, #573 m3): the same
   * latch every trail of that project uses, and the same bounded code, never an error message.
   */
  const doorWarning = doorAuditWarning(warn);
  const warnOnce = (scope: AuditScope | undefined, err: unknown): void => doorWarning(scope?.dataDir, err);

  /** One trail per project per process, so its one warning is per project as § 7.2 asks. */
  const channelFor = (scope: AuditScope): AuditChannel<'ui'> | undefined => {
    const key = JSON.stringify([scope.projectId, scope.dataDir]);
    if (!channels.has(key)) {
      try {
        channels.set(key, new AuditTrail(scope, { warn }).channel('ui'));
      } catch (err) {
        channels.set(key, null);
        warnOnce(scope, err);
      }
    }
    return channels.get(key) ?? undefined;
  };

  /** The TRUST decision only: whether this request may assert a user at all. The seam sanitizes the value. */
  const assertedUserOf = (c: Context, connection: { socket?: { remoteAddress?: unknown } }): AuditProxyUser | undefined => {
    if (!deps.hosted() || !isLoopbackPeer(connection.socket?.remoteAddress)) return undefined;
    const raw = c.req.header(PROXY_USER_HEADER);
    return raw === undefined ? undefined : { value: raw, trust: 'asserted-by-proxy' };
  };

  function route(ids: string | readonly string[], options: UiAuditRouteOptions = {}): MiddlewareHandler {
    const list = typeof ids === 'string' ? [ids] : [...ids];
    for (const id of list) if (!auditAction(id)) throw new Error(`audit route names an action outside the inventory: ${id}`);
    if (list.length > 1 && !options.select) throw new Error(`audit route with several actions needs a selector: ${list.join(', ')}`);

    const handler = async (c: Context, next: Next): Promise<void> => {
      const connection = connectionOf(c);
      if (!connection) return next();
      // A named project is resolved BEFORE the effect: removing a project deletes the row that says where it lives.
      let named: Promise<AuditScope | undefined> | undefined;
      try {
        if (options.project && options.project !== 'registered') {
          const field = options.project;
          const id = 'param' in field ? c.req.param(field.param) : bodyOf(c)?.[field.body];
          if (typeof id === 'string') named = deps.projectScope(id).catch(() => undefined);
        }
      } catch {
        named = undefined;
      }
      await next();
      let scope: AuditScope | undefined;
      try {
        const status = c.res.status;
        const body = bodyOf(c);
        const action = options.select ? options.select(body) : list[0];
        if (action === undefined || !list.includes(action)) return;
        const settlement = settlementForStatus(status);
        scope =
          (options.project === 'registered' && status >= 200 && status < 300 ? await registeredScope(c) : undefined) ??
          (named ? await named : undefined) ??
          (await deps.requestScope(c)) ??
          (await deps.bootScope());
        if (!scope) return;
        // Every scope here is a registered project (or this server's own), so a project that has
        // never been served — one the request just registered — gets its data folder the way a
        // first `serve` would create it.
        if (!existsSync(scope.dataDir)) {
          ensureProjectDataIgnored(scope.dataDir);
          mkdirSync(scope.dataDir, { recursive: true, mode: 0o700 });
        }
        const channel = channelFor(scope);
        if (!channel) return;
        const param = options.resource ? c.req.param(options.resource.param) : undefined;
        const proxyUser = assertedUserOf(c, connection);
        const secrets = requestCredentials(c.req.header('authorization'));
        const op = {
          action,
          ...(options.resource && param ? { resource: { kind: options.resource.kind, id: param } } : {}),
          ...(body !== undefined ? { payload: body } : {}),
          ...(options.fieldNames && body !== undefined ? { fieldNames: Object.keys(body) } : {}),
          actor: proxyUser ? { proxyUser } : {},
          ...(secrets.length > 0 ? { secrets } : {}),
        };
        if (!settlement) {
          channel.skip(`http_${status}`);
          return;
        }
        if (settlement.outcome === 'refused' && status === 409 && staleRejectionIn(await jsonOf(c))) {
          await channel.record(op, { outcome: 'refused', reason: 'stale_version' });
          return;
        }
        const answered = settlement.outcome === 'applied' ? answerRefusal(action, await jsonOf(c)) : undefined;
        if (answered) {
          await channel.record(op, { outcome: 'refused', reason: answered });
          return;
        }
        await channel.record(op, settlement);
      } catch (err) {
        warnOnce(scope, err);
      }
    };
    Object.defineProperty(handler, AUDIT_ROUTE, { value: { ids: list } satisfies AuditRouteDescriptor });
    return handler;
  }

  const registeredScope = async (c: Context): Promise<AuditScope | undefined> => {
    const answer = (await jsonOf(c)) as { project?: { id?: unknown; root?: unknown } } | undefined;
    const id = answer?.project?.id;
    const root = answer?.project?.root;
    return typeof id === 'string' && typeof root === 'string' ? { projectId: id, dataDir: projectDataDir(root) } : undefined;
  };

  return { route };
}

/** The route's validated JSON body, when it has one. */
function bodyOf(c: Context): Body {
  try {
    const value = (c.req.valid as (target: 'json') => unknown)('json');
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The handler's JSON answer, read from a clone so the client still receives every byte. */
async function jsonOf(c: Context): Promise<unknown> {
  if (!c.res.headers.get('content-type')?.includes('application/json')) return undefined;
  try {
    return await c.res.clone().json();
  } catch {
    return undefined;
  }
}

/** The descriptor a decorated handler carries, or `undefined` for any other handler. */
export function auditRouteDescriptor(handler: unknown): AuditRouteDescriptor | undefined {
  return typeof handler === 'function' ? (handler as { [AUDIT_ROUTE]?: AuditRouteDescriptor })[AUDIT_ROUTE] : undefined;
}
