import { runIdParamSchema, openTargetSchema } from '@qodeca/xezar-contract';
import { hc } from 'hono/client';
import { z } from 'zod';
import { collectSecretValues, redactDeep } from '../../core/secret-redaction.ts';
import type { AppType } from '../../server/app-type.ts';
import { MCP_ORIGIN, type ServiceDispatch } from '../service-adapter.ts';
import { defineTool, errorResult, textResult, type McpToolContext, type McpToolResult } from '../tool.ts';

/**
 * `local_handoff` (#98): the cockpit's "Open in…" family — a task in a terminal, a task's
 * worktree or one of its image files in a local app, the project folder in a local app, and the
 * list of apps that can do it (I-044, I-114).
 *
 * M-19 is the trap this module exists for. Every one of these routes launches an application on
 * the machine that runs the xezar SERVICE. An MCP client is a separate process, possibly on
 * another machine and possibly with no display at all, so nothing here may promise a window on
 * the client's screen. Two rules follow, and the tests pin both:
 *
 *  - With `capabilities.localHandoff` false (hosted mode: `XEZ_REMOTE=1` or a non-loopback bind),
 *    every action answers `unavailable` WITH A REASON and dispatches nothing — the same gate that
 *    hides the menu in the cockpit. The routes 409 on their own as well; this tool does not rely
 *    on that, because "the route refused" and "we never asked" must not read the same.
 *  - With it true, every answer names the machine it affects: the xezar host, not the client's.
 *
 * The capability is read from the service's own `GET /health`, through the same in-process entry
 * every other call uses, so this tool and the cockpit read ONE answer (N-02) — including the
 * `--bind-host` half, which this process cannot see from anywhere else.
 *
 * `open-in-cli` answers 409 with `error.command` when the host has no terminal emulator. The
 * cockpit copies that command to the clipboard; a leader has no clipboard on the host, so the
 * command is RETURNED as data (`fallbackCommand`), labelled as something to run on the host.
 *
 * D-08 / F-09 / F-22: opening an app is a project operation inside the approved goal, so there is
 * no per-operation confirmation parameter. Goal and definition-of-done decisions stay with the
 * human and are not offered here, and no parameter can waive a quality gate or an acceptance
 * criterion — the strict schema turns an invented key into an argument error. The registry-wide
 * test in `local-handoff.test.ts` asserts the last point for EVERY registered tool (A-22).
 */

export const LOCAL_HANDOFF_ACTIONS = ['list_apps', 'open_task_in_terminal', 'open_task_in_app', 'open_project_in_app'] as const;
export type LocalHandoffAction = (typeof LOCAL_HANDOFF_ACTIONS)[number];

/** Where an answer's effect lands. There is deliberately no value for the client's machine. */
export const HANDOFF_MACHINE = 'xezar-host' as const;

/** Said on every answer from a host that can hand off — the M-19 sentence. */
export const XEZAR_HOST_NOTICE =
  'This acts on the xezar host machine – the computer running the xezar service – not on the machine your MCP client runs on. Nothing opens on the client’s screen.';

/** Said on every answer from a host that cannot. */
export const HOSTED_MODE_REASON =
  'desktop handoff is unavailable: this xezar runs in hosted mode (XEZ_REMOTE=1 or a non-loopback bind), so there is no desktop on the xezar host to open anything on, and xezar never opens anything on the MCP client’s machine';

/** The next legitimate action when the capability is missing (UX-M05). */
const UNAVAILABLE_NEXT_ACTION =
  'Ask the human to open it from a machine that has the checkout, or read the task, its diff and its files through the tools that return data.';

/** D-08 in the tool's own words, so a leader reads the boundary before it calls. */
export const DECISION_BOUNDARY =
  'No per-operation confirmation is needed: opening an app is a project operation inside the approved goal. Goal and definition-of-done decisions stay with the human and are not offered here, and no parameter can waive a quality gate or an acceptance criterion.';

const NOT_CONNECTED = 'local_handoff is not connected to the xezar service in this process yet; nothing was opened.';

/** The context this tool reads beyond `McpToolContext`: the running service's in-process entry. */
export type LocalHandoffContext = McpToolContext & { readonly service?: ServiceDispatch };

type Field = 'runId' | 'target' | 'path';
const FIELDS: readonly Field[] = ['runId', 'target', 'path'];

/** Which arguments each action takes. Anything else is refused rather than silently dropped. */
const ACTION_FIELDS: Record<LocalHandoffAction, { required: readonly Field[]; optional: readonly Field[] }> = {
  list_apps: { required: [], optional: [] },
  open_task_in_terminal: { required: ['runId'], optional: [] },
  open_task_in_app: { required: ['runId', 'target'], optional: ['path'] },
  open_project_in_app: { required: ['target'], optional: [] },
};

export const localHandoffInputSchema = z
  .object({
    action: z
      .enum(LOCAL_HANDOFF_ACTIONS)
      .describe(
        'list_apps: the apps installed on the xezar host. open_task_in_terminal: resume the task’s agent session in a terminal on the xezar host. ' +
          'open_task_in_app: open the task’s worktree (or, with target "default" and a path, one image file) in an app on the xezar host. ' +
          'open_project_in_app: open the project folder in an app on the xezar host.',
      ),
    runId: z.string().min(1).max(128).optional().describe("The task's run id, in the project this connection is bound to."),
    target: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('An app id from list_apps (for example "finder", "terminal", "vscode", "cli:claude"), or "default" with a path.'),
    path: z
      .string()
      .min(1)
      .max(1_000)
      .optional()
      .describe('open_task_in_app with target "default": a worktree-relative image file. It is re-checked against the worktree.'),
  })
  .strict()
  .superRefine((args, ctx) => {
    const allowed = ACTION_FIELDS[args.action];
    for (const field of FIELDS) {
      const present = args[field] !== undefined;
      if (allowed.required.includes(field) && !present) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${args.action} needs ${field}` });
      }
      if (present && !allowed.required.includes(field) && !allowed.optional.includes(field)) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} does not apply to ${args.action}` });
      }
    }
  });
export type LocalHandoffInput = z.output<typeof localHandoffInputSchema>;

/** The result, text block and `structuredContent` alike (D-05: the text is authoritative). */
export const localHandoffResultSchema = z.object({
  action: z.enum(LOCAL_HANDOFF_ACTIONS),
  /** D-05's closed set (§ 6.8), narrowed to what a handoff can report. A 409 is a `conflict`. */
  status: z.enum(['done', 'failed', 'conflict']),
  /** What happened, in handoff terms. `unavailable`: the capability is missing and nothing was
   *  dispatched. `fallback`: nothing opened — run `fallbackCommand` on the xezar host instead. */
  outcome: z.enum(['opened', 'listed', 'unavailable', 'fallback', 'refused']),
  /** True only when the service reports it launched something. */
  performed: z.boolean(),
  /** Where the effect lands — the xezar host, or nowhere. Never the MCP client's machine. */
  affects: z.enum([HANDOFF_MACHINE, 'nothing']),
  notice: z.string(),
  reason: z.string().optional(),
  nextAction: z.string().optional(),
  targets: z.array(openTargetSchema).optional(),
  /** The host path that was opened. */
  path: z.string().optional(),
  /** The command the host terminal runs. */
  command: z.string().optional(),
  /** Run this in a terminal ON THE XEZAR HOST: the route found no terminal emulator to open. */
  fallbackCommand: z.string().optional(),
  httpStatus: z.number().int().optional(),
  origin: z.literal(MCP_ORIGIN),
});
export type LocalHandoffResult = z.infer<typeof localHandoffResultSchema>;

// ---- the service entry -------------------------------------------------------------------------

const IN_PROCESS_BASE = 'http://127.0.0.1';
const IN_PROCESS_HOST = '127.0.0.1';

/** The same in-process client the adapter builds (`service-adapter.ts`): loopback host, no Origin. */
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

interface Answer {
  status: number;
  body: Record<string, unknown> | undefined;
}

async function settle(pending: Promise<Response>): Promise<Answer> {
  const res = await pending;
  const body: unknown = await res.json().catch(() => undefined);
  return { status: res.status, body: body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined };
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

// ---- identity and secrets ----------------------------------------------------------------------

/** F-12: an account folder is user-named, and a folder named after an email address would put
 *  that address in a terminal command. Such a command is withheld rather than altered, because
 *  an edited command would resume the wrong account. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ACCOUNT_PLACEHOLDER = '[account]';
const hasEmail = (text: string): boolean => new RegExp(EMAIL_RE.source).test(text);
const scrubEmail = (text: string): string => text.replace(EMAIL_RE, ACCOUNT_PLACEHOLDER);

// ---- the tool ----------------------------------------------------------------------------------

export const localHandoffTool = defineTool({
  name: 'local_handoff',
  title: 'Open a task or the project in an app on the xezar host',
  description:
    'Hand a task or the project off to a desktop app — a terminal resuming the task’s agent session, an editor, the file manager. ' +
    'Every app opens on the XEZAR HOST MACHINE (the computer running the xezar service), never on the machine your MCP client runs on. ' +
    'When the xezar host has no desktop to hand off to (hosted mode), every action answers "unavailable" with the reason and opens nothing. ' +
    'When no terminal emulator is found, the answer carries fallbackCommand to run in a terminal on the xezar host. ' +
    DECISION_BOUNDARY,
  inputSchema: localHandoffInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async call(args, ctx) {
    const service = (ctx as LocalHandoffContext).service;
    if (!service) return errorResult(NOT_CONNECTED);
    return render(await runLocalHandoff(args, ctx.project.id, service));
  },
});

/** One action against the bound project. Exported for tests; the tool is the only production caller. */
export async function runLocalHandoff(
  args: LocalHandoffInput,
  projectId: string,
  service: ServiceDispatch,
): Promise<LocalHandoffResult> {
  const client = buildClient(service);

  // The capability first, and nothing else until it says yes. An unreadable answer fails CLOSED:
  // "we could not tell" must never read as "go ahead".
  const health = await settle(client.api.v1.health.$get()).catch(() => undefined);
  const capabilities = health?.body?.capabilities;
  const localHandoff =
    health?.status === 200 && capabilities && typeof capabilities === 'object'
      ? (capabilities as { localHandoff?: unknown }).localHandoff
      : undefined;
  if (localHandoff !== true) {
    return unavailable(
      args.action,
      localHandoff === false ? HOSTED_MODE_REASON : 'xezar could not confirm that its host has a desktop to hand off to, so nothing was opened',
    );
  }

  const scoped = client.api.v1.p[':projectId'];
  const scope = { projectId };

  if (args.action === 'list_apps') {
    const answer = await settle(scoped['open-targets'].$get({ param: scope }));
    if (answer.status !== 200) return failed(args.action, answer);
    const parsed = z.array(openTargetSchema).safeParse(answer.body?.targets);
    if (!parsed.success) return failed(args.action, { status: 502, body: { error: 'the service answered without a target list' } });
    return { ...hostBase(args.action), status: 'done', outcome: 'listed', performed: false, targets: parsed.data };
  }

  if (args.action === 'open_project_in_app') {
    const answer = await settle(scoped['open-in'].$post({ param: scope, json: { target: args.target! } }));
    if (answer.status !== 200) return failed(args.action, answer);
    return opened(args.action, answer);
  }

  const runId = args.runId!;
  // A dot segment would be resolved by the URL parser onto another route; refuse it undispatched.
  if (runId === '.' || runId === '..' || !runIdParamSchema.safeParse({ id: runId }).success) {
    return failed(args.action, { status: 400, body: { error: 'not a run id' } });
  }
  const param = { ...scope, id: runId };

  if (args.action === 'open_task_in_terminal') {
    const answer = await settle(scoped.runs[':id']['open-in-cli'].$post({ param }));
    if (answer.status === 200) return opened(args.action, answer);
    return fallbackOrFailed(args.action, answer);
  }

  const json = { target: args.target!, ...(args.path !== undefined ? { path: args.path } : {}) };
  const answer = await settle(scoped.runs[':id']['open-in'].$post({ param, json }));
  if (answer.status === 200) return opened(args.action, answer);
  return fallbackOrFailed(args.action, answer);
}

function hostBase(action: LocalHandoffAction): Pick<LocalHandoffResult, 'action' | 'affects' | 'notice' | 'origin'> {
  return { action, affects: HANDOFF_MACHINE, notice: XEZAR_HOST_NOTICE, origin: MCP_ORIGIN };
}

function unavailable(action: LocalHandoffAction, reason: string): LocalHandoffResult {
  return {
    action,
    status: 'failed',
    outcome: 'unavailable',
    performed: false,
    affects: 'nothing',
    notice: 'Nothing was opened – not on the xezar host and not on the machine your MCP client runs on.',
    reason,
    nextAction: UNAVAILABLE_NEXT_ACTION,
    origin: MCP_ORIGIN,
  };
}

function opened(action: LocalHandoffAction, answer: Answer): LocalHandoffResult {
  const path = str(answer.body?.path);
  const command = str(answer.body?.command);
  return {
    ...hostBase(action),
    status: 'done',
    outcome: 'opened',
    performed: true,
    ...(path !== undefined ? { path } : {}),
    ...(command !== undefined ? { command } : {}),
  };
}

/** A 409 carrying `command` is the no-terminal fallback; every other refusal keeps the service's words. */
function fallbackOrFailed(action: LocalHandoffAction, answer: Answer): LocalHandoffResult {
  const fallback = answer.status === 409 ? str(answer.body?.command) : undefined;
  if (fallback === undefined) return failed(action, answer);
  if (hasEmail(fallback)) {
    return {
      ...hostBase(action),
      status: 'conflict',
      outcome: 'refused',
      performed: false,
      httpStatus: answer.status,
      reason:
        'no terminal emulator was found on the xezar host, and the manual command names an account folder that looks like an email address, so it is not returned here',
      nextAction: 'Ask the human to open the task from the cockpit on the xezar host, which copies the command there.',
    };
  }
  return {
    ...hostBase(action),
    status: 'failed',
    outcome: 'fallback',
    performed: false,
    httpStatus: answer.status,
    reason: scrubEmail(str(answer.body?.error) ?? 'no terminal emulator found'),
    fallbackCommand: fallback,
    nextAction: 'Run fallbackCommand in a terminal on the xezar host. It will not work on the MCP client’s machine.',
  };
}

function failed(action: LocalHandoffAction, answer: Answer): LocalHandoffResult {
  // The route re-checks hosted mode per request, so a capability that flipped between the two
  // calls still reads as unavailable rather than as an ordinary failure.
  const error = str(answer.body?.error) ?? `service answered ${answer.status}`;
  if (answer.status === 409 && error.startsWith('local handoff is disabled')) return unavailable(action, HOSTED_MODE_REASON);
  return {
    ...hostBase(action),
    // D-05: a refusal the task or host state caused (409) is a business conflict, not a failure.
    status: answer.status === 409 ? 'conflict' : 'failed',
    outcome: 'refused',
    performed: false,
    httpStatus: answer.status,
    reason: scrubEmail(error),
  };
}

/** The text block says everything `structuredContent` says (D-05); secrets never leave (F-15). */
function render(result: LocalHandoffResult): McpToolResult {
  const safe = redactDeep(result, collectSecretValues(process.env));
  const lines = [`local_handoff ${safe.action}: ${safe.outcome} (status ${safe.status}).`, safe.notice];
  if (safe.reason) lines.push(`Reason: ${safe.reason}.`);
  if (safe.targets) {
    lines.push(
      safe.targets.length
        ? `Apps on the xezar host: ${safe.targets.map((t) => `${t.id} (${t.label})`).join(', ')}.`
        : 'No apps were detected on the xezar host.',
    );
  }
  if (safe.path) lines.push(`Opened on the xezar host: ${safe.path}`);
  if (safe.command) lines.push(`The xezar host terminal runs: ${safe.command}`);
  if (safe.fallbackCommand) lines.push(`Fallback command for a terminal on the xezar host: ${safe.fallbackCommand}`);
  if (safe.nextAction) lines.push(`Next: ${safe.nextAction}`);
  const text = lines.join('\n');
  const structured = safe as unknown as Record<string, unknown>;
  // `unavailable` and `fallback` are degraded answers, not errors (AGENTS.md § Zero config), and a
  // conflict is something to reason about (D-05). Only a refused call that failed outright is one.
  const isError = safe.outcome === 'refused' && safe.status === 'failed';
  return isError ? errorResult(text, structured) : textResult(text, structured);
}
