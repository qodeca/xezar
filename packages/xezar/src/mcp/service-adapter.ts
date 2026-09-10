import { runIdParamSchema } from '@qodeca/xezar-contract';
import { hc, type InferRequestType, type InferResponseType } from 'hono/client';
import type { AppType } from '../server/app-type.ts';
import { PROJECT_ID_RE } from '../workspace/config.ts';

/**
 * The one seam every MCP operation reaches xezar's services through (#89, epic #67).
 *
 * N-02 is the rule this module exists for: UI and MCP share business rules, authorization,
 * resource limits, locks and state transitions, and MCP never writes JSON or NDJSON around the
 * services. A-08 is how it shows: a human and a leader act on the SAME task and configuration,
 * and no MCP-only history or configuration exists.
 *
 * HOW. An operation is dispatched IN-PROCESS into the service's own chained route table — the
 * Hono app's `request()` entry, typed by `hc<AppType>` — under `/api/v1/p/<bound project>/…`.
 * No socket, no port, no TCP: the call never leaves the process (the transport is D-01's unix
 * socket, which lands in front of this seam, not inside it). That is the smallest shape that keeps
 * every invariant, because several of the rules a start must obey live ONLY in route handlers
 * today — the models-lock 409, `stepsIssue`, the provider-availability re-probe, the account
 * check, the follow-ups capability ceiling (`POST /runs` in `server/server.ts`). Calling
 * `RunManager.startRun` directly would copy those checks into a second place, which is the drift
 * this seam exists to prevent. Going through the route runs the SAME validator middleware, the
 * same 400/404/409 answers, the same `ProjectContext` (so the same `RunStore`, `RunManager`,
 * `AutomationStore`) and therefore the same workspace-wide `WorkspaceSemaphore` as the cockpit.
 * MCP adds no queue, no agent-process controller, no store and no runner; it opens no file.
 *
 * NARROWING. This is not a proxy to every route (requirements § 8 says that is insufficient):
 *   - the project is bound ONCE, at construction, from the connection (D-01/D-02: identity is a
 *     property of the connection, never of anything the client says). No operation accepts a
 *     project id, a path or a URL;
 *   - the operation table is closed — each method is one named route, and there is no raw
 *     `request(path)` escape hatch;
 *   - a path parameter is checked against `runIdParamSchema` AND refused when it is a dot segment
 *     (`.`/`..`), because the URL parser would resolve one and the call would land on a different
 *     route than the one named. A refused id is answered without any dispatch.
 *
 * ORIGIN. Every result carries `origin: 'mcp'`. Where that marker is PERSISTED (history, audit)
 * is D-06's decision and is not made here, so nothing is written for it: the record, the event
 * log and the files an MCP operation produces are the cockpit's, apart from this marker.
 *
 * NOT READ HERE. Nothing private to `RunManager` — in particular no `ActiveRun` field, which is
 * built at two sites (`execute`, `runContinuation`). An operation sees exactly what the route
 * sends, so there is no second construction site for this seam to keep in step with.
 */

/** The origin marker every adapter result carries (N-04). */
export const MCP_ORIGIN = 'mcp' as const;

/** The running service's in-process entry: the Hono app `createApp` returns satisfies it. */
export interface ServiceDispatch {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

/** Any absolute origin works — the request never leaves the process. The `host` is what the
 *  request-origin guard (#426) checks, and an in-process call genuinely is this machine. No
 *  `Origin` header is sent, which is how every non-browser local caller already reaches the API. */
const IN_PROCESS_BASE = 'http://127.0.0.1';
const IN_PROCESS_HOST = '127.0.0.1';

const buildClient = (service: ServiceDispatch) =>
  hc<AppType>(IN_PROCESS_BASE, {
    fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set('host', IN_PROCESS_HOST);
      headers.delete('origin');
      const url = input instanceof Request ? input.url : String(input);
      return service.request(url, { ...init, headers });
    },
  });

type ScopedApi = ReturnType<typeof buildClient>['api']['v1']['p'][':projectId'];
type RunsApi = ScopedApi['runs'];
type RunApi = RunsApi[':id'];

/** Request bodies are inferred from the route's own validator — never declared here. */
export type StartRunRequest = InferRequestType<RunsApi['$post']>['json'];
export type PatchRunRequest = InferRequestType<RunApi['$patch']>['json'];

/** Success values are inferred from the route's own `c.json(...)` — never declared here. */
export type ListRunsValue = InferResponseType<RunsApi['$get'], 200>;
export type GetRunValue = InferResponseType<RunApi['$get'], 200>;
export type StartRunValue = InferResponseType<RunsApi['$post'], 201>;
export type PatchRunValue = InferResponseType<RunApi['$patch'], 200>;
export type CancelRunValue = InferResponseType<RunApi['cancel']['$post'], 200>;
export type ArchiveRunValue = InferResponseType<RunApi['archive']['$post'], 200>;
export type PinRunValue = InferResponseType<RunApi['pin']['$post'], 200>;

/** One operation's outcome. A refusal keeps the service's own status and message. */
export type McpServiceResult<T> =
  | { ok: true; origin: typeof MCP_ORIGIN; status: number; value: T }
  | { ok: false; origin: typeof MCP_ORIGIN; status: number; error: string };

/** Thrown only by the constructor: an adapter bound to no valid project must not exist at all. */
export class McpServiceAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpServiceAdapterError';
  }
}

export interface McpServiceAdapterOptions {
  /** The project the connection is bound to — a registry id, or the boot alias `default`. */
  projectId: string;
  /** The running service's in-process entry (the app `createApp` returns). */
  service: ServiceDispatch;
}

export class McpServiceAdapter {
  readonly origin = MCP_ORIGIN;
  readonly projectId: string;
  private readonly api: ScopedApi;

  constructor(options: McpServiceAdapterOptions) {
    const { projectId } = options;
    // The same rule the scope resolver applies (`projectIdSchema` in server.ts), checked here so
    // a bad binding fails at connect time instead of answering a plausible 404 on every call.
    if (projectId !== 'default' && !PROJECT_ID_RE.test(projectId)) {
      throw new McpServiceAdapterError(`not a project id: ${JSON.stringify(projectId)}`);
    }
    this.projectId = projectId;
    this.api = buildClient(options.service).api.v1.p[':projectId'];
  }

  listRuns(): Promise<McpServiceResult<ListRunsValue>> {
    return this.settle(this.api.runs.$get({ param: this.scope() }), [200]);
  }

  getRun(runId: string): Promise<McpServiceResult<GetRunValue>> {
    return this.withRunId(runId, (param) => this.api.runs[':id'].$get({ param }), [200]);
  }

  startRun(input: StartRunRequest): Promise<McpServiceResult<StartRunValue>> {
    return this.settle(this.api.runs.$post({ param: this.scope(), json: input }), [201]);
  }

  patchRun(runId: string, input: PatchRunRequest): Promise<McpServiceResult<PatchRunValue>> {
    return this.withRunId(runId, (param) => this.api.runs[':id'].$patch({ param, json: input }), [200]);
  }

  cancelRun(runId: string): Promise<McpServiceResult<CancelRunValue>> {
    return this.withRunId(runId, (param) => this.api.runs[':id'].cancel.$post({ param }), [200]);
  }

  archiveRun(runId: string, archived = true): Promise<McpServiceResult<ArchiveRunValue>> {
    return this.withRunId(
      runId,
      (param) => this.api.runs[':id'].archive.$post({ param, json: { archived } }),
      [200],
    );
  }

  pinRun(runId: string, pinned = true): Promise<McpServiceResult<PinRunValue>> {
    return this.withRunId(runId, (param) => this.api.runs[':id'].pin.$post({ param, json: { pinned } }), [200]);
  }

  private scope(): { projectId: string } {
    return { projectId: this.projectId };
  }

  /** Validate a run id BEFORE anything is dispatched, then call with the bound scope. */
  private withRunId<T>(
    runId: string,
    call: (param: { projectId: string; id: string }) => Promise<Response>,
    success: readonly number[],
  ): Promise<McpServiceResult<T>> {
    const refusal = runIdRefusal(runId);
    if (refusal) return Promise.resolve({ ok: false, origin: MCP_ORIGIN, status: 400, error: refusal });
    return this.settle<T>(call({ ...this.scope(), id: runId }), success);
  }

  /**
   * Map the service's answer onto a result. A success status WITHOUT a JSON body is an error,
   * not an `undefined` value: "the service said nothing" and "the service said []" must never
   * read the same to the leader.
   */
  private async settle<T>(pending: Promise<Response>, success: readonly number[]): Promise<McpServiceResult<T>> {
    const res = await pending;
    const body: unknown = await res.json().catch(() => undefined);
    if (success.includes(res.status)) {
      if (body === undefined) {
        return { ok: false, origin: MCP_ORIGIN, status: 502, error: `service answered ${res.status} without a body` };
      }
      return { ok: true, origin: MCP_ORIGIN, status: res.status, value: body as T };
    }
    return { ok: false, origin: MCP_ORIGIN, status: res.status, error: errorMessage(body, res.status) };
  }
}

function runIdRefusal(runId: string): string | null {
  if (runId === '.' || runId === '..' || !runIdParamSchema.safeParse({ id: runId }).success) {
    return `not a run id: ${JSON.stringify(runId)}`;
  }
  return null;
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return `service answered ${status}`;
}
