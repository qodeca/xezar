/**
 * Safe diagnostics for HTTP failures (#467, PR 3; analysis § 6(d),
 * `designs/cli-terminal/README.md` § 10.2, `error-cases.txt` E).
 *
 * Until now a request the cockpit REFUSED left no trace at all: a handler that returns a 409 is
 * not an exception, nothing logged it, and the only evidence a person had was a cockpit that did
 * not do what they asked. That is the `returned-error-invisible` break AC-07 names.
 *
 * What one line carries, and nothing more:
 *
 *   `<status> <METHOD> <route template>` + the server's own message on a continuation line.
 *
 * **The route TEMPLATE, never the path.** `/api/v1/p/:projectId/runs/:id/finish`, not
 * `/api/v1/p/oko/runs/8f3a…/finish`. A real path carries a project id and a task id; a query
 * string carries whatever a caller put in it. Neither belongs in a terminal a person screenshots
 * into an issue. Request bodies and headers are never read here at all.
 *
 * **A message is the server's own words**, sanitized like every other untrusted string: the
 * refusal texts are ours, but nothing guarantees a future one does not interpolate a path or a
 * name that came in over the wire.
 *
 * **Each failure is logged once.** A thrown error and the 500 it becomes are the same event; so
 * are a returned 403 and the response that carries it. Logging both is `double-error-log`.
 *
 * **Repeats are folded, never dropped.** A cockpit tab retrying a refused call twenty times in
 * ten seconds is one fact, so the first is printed and the rest become a count. The count line
 * always arrives — a fold that can lose the last repeats is a fold that hides a failure.
 *
 * Levels follow the design's table: 5xx is an error; the refusals a person can act on
 * (400, 401, 403, 409, 413, 422) are warnings; every other 4xx, 404 included, is debug, because
 * a cockpit asking for a task that has been deleted is routine.
 */

import { randomBytes } from 'node:crypto';

import { sanitizeText } from './sanitize.ts';

import type { ActivityEntry, ActivityLevel } from './activity.ts';
import type { Glyphs } from './format.ts';

/** How long repeats of the same failure are counted before the fold line is printed. */
export const FOLD_WINDOW_MS = 10_000;

/** The 4xx statuses a person is meant to see without turning on debug. */
const ACTIONABLE_4XX = new Set([400, 401, 403, 409, 413, 422]);

export function levelForStatus(status: number): ActivityLevel {
  if (status >= 500) return 'error';
  if (ACTIONABLE_4XX.has(status)) return 'warn';
  return 'debug';
}

/** A segment that is plainly an identifier rather than part of a route. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEXISH = /^[0-9a-f]{8,}$/i;
const NUMERIC = /^\d+$/;

/**
 * Turn a real request path into a route template, for the cases where the router has none.
 *
 * Two of them exist and both matter. A request the ORIGIN GUARD refused never reached a route,
 * so hono has nothing to report; and a 404 is by definition a path that matched no route. In
 * both, `c.req.routePath` reads `/api/*` — useless in a diagnostic line — and the real path is
 * the only thing left.
 *
 * So the path is masked rather than printed: the segment after `/p/` becomes `:projectId`, a
 * uuid, a long hex string or a bare number becomes `:id`, and anything with a dot or over 32
 * characters becomes `:value`. The query string never reaches this function at all.
 *
 * This is a heuristic and is documented as one. It is used ONLY as a fallback; a request that
 * matched a route reports the router's own template, exactly.
 */
export function maskPath(path: string): string {
  const segments = path.split('/');
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? '';
    if (segment === '') {
      out.push(segment);
      continue;
    }
    if (out[out.length - 1] === 'p' && out.includes('v1')) {
      out.push(':projectId');
      continue;
    }
    if (UUID.test(segment) || HEXISH.test(segment) || NUMERIC.test(segment)) {
      out.push(':id');
      continue;
    }
    if (segment.includes('.') || segment.length > 32) {
      out.push(':value');
      continue;
    }
    out.push(segment);
  }
  return out.join('/') || '/';
}

/** The template for one request: the router's own when it has one, a masked path otherwise. */
export function routeTemplateFor(routePath: string | undefined, path: string): string {
  if (routePath && !routePath.endsWith('*')) return routePath;
  return maskPath(path);
}

/** The bit of a hono context this middleware reads. Narrow, so a test needs no server. */
interface DiagnosticContext {
  req: { method: string; path: string; routePath?: string };
  res: Response | undefined;
}

/**
 * The observe-only middleware that turns a failed request into one `HttpFailure`.
 *
 * It is a factory here rather than an inline closure in `server.ts` for one reason: the THROW
 * path and the RETURNED path behave completely differently inside hono, and the throw path is
 * unreachable from a test that can only add routes after the app is built (hono dispatches in
 * registration order, and the app ends in an SPA catch-all).
 *
 * What it promises:
 *
 * - `next()` runs untouched and the response object is never replaced or re-statused;
 * - the server's message is read from a CLONE and **not awaited**, so nothing here can delay a
 *   byte reaching the client;
 * - a throw is reported as a 500 and RE-THROWN, so hono's own error handling is unchanged — and
 *   because the throw leaves through the catch, the status check never sees it, which is what
 *   stops one failure becoming two lines (`double-error-log`);
 * - a reporter that throws cannot turn a handled error into an unhandled one.
 */
export function httpDiagnosticsMiddleware(report: (failure: HttpFailure) => void) {
  const safely = (failure: HttpFailure): void => {
    try {
      report(failure);
    } catch {
      // A broken reporter is never allowed to break a request.
    }
  };
  return async (c: DiagnosticContext, next: () => Promise<void>): Promise<void> => {
    const method = c.req.method;
    const path = c.req.path;
    try {
      await next();
    } catch (err) {
      safely({
        method,
        route: routeTemplateFor(c.req.routePath, path),
        status: 500,
        message: err instanceof Error ? err.message : 'internal error',
      });
      throw err;
    }
    const res = c.res;
    if (!res || res.status < 400) return;
    const route = routeTemplateFor(c.req.routePath, path);
    // `{ error }` is the one rejection shape every route in this server uses. Anything else (a
    // static asset's 404, a streamed body) reports no message rather than a guess.
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    if (!isJson) {
      safely({ method, route, status: res.status });
      return;
    }
    void res
      .clone()
      .json()
      .then((body: unknown) => {
        const message =
          body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
            ? (body as { error: string }).error
            : undefined;
        safely({
          method,
          route,
          status: res.status,
          ...(message ? { message } : {}),
          // The origin guard is the one refusal whose reason is not in its own words.
          ...(message?.startsWith('forbidden: cross-') ? { reason: 'origin' as const } : {}),
        });
      })
      .catch(() => {
        safely({ method, route, status: res.status });
      });
  };
}

export interface HttpFailure {
  method: string;
  /** The matched route template. `/*` when nothing matched (a 404 on an unknown path). */
  route: string;
  status: number;
  /** The server's own message, if the response carried one. */
  message?: string;
  /** A short machine reason — `origin` for a request the origin guard refused. */
  reason?: string;
}

export interface HttpDiagnosticsOptions {
  emit(entry: ActivityEntry): void;
  glyphs: Glyphs;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface FoldState {
  windowStart: number;
  repeats: number;
  timer: unknown;
  sample: HttpFailure;
}

export class HttpDiagnostics {
  private readonly emit: (entry: ActivityEntry) => void;
  private readonly glyphs: Glyphs;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly folds = new Map<string, FoldState>();
  private stopped = false;

  constructor(options: HttpDiagnosticsOptions) {
    this.emit = options.emit;
    this.glyphs = options.glyphs;
    this.now = options.now ?? (() => Date.now());
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        // A pending fold line must never hold the process open past its work.
        handle.unref?.();
        return handle;
      });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** Record one failed request. Never throws — it runs inside a request's own middleware. */
  record(failure: HttpFailure): void {
    if (this.stopped) return;
    const key = `${failure.method} ${failure.route} ${failure.status}`;
    const at = this.now();
    const existing = this.folds.get(key);

    if (existing && at - existing.windowStart < FOLD_WINDOW_MS) {
      existing.repeats++;
      existing.sample = failure;
      return;
    }
    if (existing) {
      this.flush(key, existing);
    }
    this.folds.set(key, {
      windowStart: at,
      repeats: 0,
      sample: failure,
      timer: this.setTimer(() => {
        const state = this.folds.get(key);
        if (state) this.flush(key, state);
      }, FOLD_WINDOW_MS),
    });
    this.emit(this.entryFor(failure));
  }

  private flush(key: string, state: FoldState): void {
    this.clearTimer(state.timer);
    this.folds.delete(key);
    if (state.repeats === 0) return;
    const { method, route, status } = state.sample;
    this.emit({
      at: new Date(this.now()),
      level: levelForStatus(status),
      subject: 'http',
      message: `${status} ${method} ${route}`,
      continuation: [`repeated ${state.repeats} times in ${FOLD_WINDOW_MS / 1000}s`],
      event: 'http.repeated',
      fields: [
        ['method', method],
        ['route', route],
        ['status', status],
        ['count', state.repeats],
        ['window_ms', FOLD_WINDOW_MS],
      ],
    });
  }

  private entryFor(failure: HttpFailure): ActivityEntry {
    const message = failure.message ? sanitizeText(failure.message, { maxWidth: 200 }) : '';
    const level = levelForStatus(failure.status);
    // A correlation id for the plain output only. The human line has no room for it and the
    // design's mockups do not carry one; a machine reader merging several instances' logs does
    // need something to tie a repeat to its first sighting.
    const requestId = randomBytes(4).toString('hex');
    return {
      at: new Date(this.now()),
      level,
      subject: 'http',
      message: `${failure.status} ${failure.method} ${failure.route}`,
      ...(message
        ? { continuation: [`${this.glyphs.quoteOpen}${message}${this.glyphs.quoteClose}`] }
        : {}),
      event: failure.status >= 500 ? 'http.error' : 'http.refused',
      fields: [
        ['method', failure.method],
        ['route', failure.route],
        ['status', failure.status],
        ['request_id', requestId],
        ...(failure.reason ? ([['reason', failure.reason]] as const) : []),
        ...(message ? ([['message', message]] as const) : []),
      ],
    };
  }

  /** Print every pending fold line and release the timers. Called at shutdown. */
  stop(): void {
    if (this.stopped) return;
    for (const [key, state] of [...this.folds]) this.flush(key, state);
    this.stopped = true;
    this.folds.clear();
  }
}
