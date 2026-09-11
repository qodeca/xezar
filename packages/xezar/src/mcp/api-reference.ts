import { mcpToolListingSchema, type McpApiReference, type McpNotExposed } from '@qodeca/xezar-contract';
import { HEALTH_TOOL } from './bridge.ts';
import { SERVER_CAPABILITIES, SUPPORTED_PROTOCOL_VERSIONS } from './protocol.ts';
import { toolListing } from './tool.ts';
import { tools } from './tools/index.ts';
import { REFUSED_ACTIONS } from './tools/project-config.ts';

/**
 * #284 — what the cockpit's MCP API page shows, built from the RUNNING code (spec
 * `mcp-api-reference-spec.md` § 11, R-06). Shipped, not a testkit: the route loads it lazily.
 *
 * `tools` is exactly what `tools/list` answers, produced by the same `toolListing()` the bridge
 * calls (`bridge.ts`), so the page cannot disagree with the wire or with the committed
 * `docs/features/mcp-server/mcp-api.json`. The registry is static code: nothing here needs the MCP
 * service to be running, which is the point — a reader can review the API on a machine where MCP
 * did not start (N-07).
 *
 * Reads only. No socket, no process, no network, no disk, no audit entry, no journal event. There
 * is deliberately nothing here that could run a tool (spec § 13).
 */

/**
 * Listed arguments that are never accepted. The listing cannot say so — `project_config` lists
 * `projectId` with an empty schema, which reads as "optional, any type" — so it is named here and
 * its reason is its OWN description from the live listing. A test holds each entry to the listing.
 */
export const REFUSED_ARGUMENTS: readonly { readonly tool: string; readonly argument: string }[] = [
  { tool: 'project_config', argument: 'projectId' },
];

/** What the server deliberately does not expose (J-4), each with the requirements that forbid it. */
export const NOT_EXPOSED: readonly McpNotExposed[] = [
  {
    what: 'Resources, prompts and logging',
    detail: 'The server advertises the tools capability only. Any other method is answered with "method not found".',
    forbiddenBy: ['D-05'],
  },
  {
    what: 'Account identity',
    detail: 'No email, login, organisation, plan or credential appears in a tool answer. Account administration is refused.',
    forbiddenBy: ['F-12', 'N-01'],
  },
  {
    what: 'Secrets',
    detail: 'No launch key, credential, token or environment value appears in any tool answer.',
    forbiddenBy: ['F-15', 'A-12'],
  },
  {
    what: 'Host-process control',
    detail: 'No argument takes a process id, a signal, a command or a host path.',
    forbiddenBy: ['F-08', 'M-04'],
  },
  {
    what: 'Other projects',
    detail: 'A session is bound to one project. No workspace setting, project registry or other project’s data is reachable.',
    forbiddenBy: ['F-01', 'N-01'],
  },
];

/** Refusal-only actions, per tool. Today only `project_config` has them (`REFUSED_ACTIONS`). */
const REFUSED_ACTIONS_BY_TOOL: Readonly<Record<string, Readonly<Record<string, { boundary: string; reason: string }>>>> = {
  project_config: REFUSED_ACTIONS,
};

const DISCRIMINATORS = ['action', 'view', 'read'] as const;

/** The values of a listed schema's discriminator argument, or `[]` when it has none. */
function discriminatorValues(inputSchema: Record<string, unknown>): string[] {
  const properties = (inputSchema.properties ?? {}) as Record<string, { enum?: unknown }>;
  for (const key of DISCRIMINATORS) {
    const values = properties[key]?.enum;
    if (Array.isArray(values)) return values.filter((v): v is string => typeof v === 'string');
  }
  return [];
}

export function buildMcpApiReference(xezarVersion: string): McpApiReference {
  // Parsed through the contract's STRICT schema: a key `toolListing()` gains that the contract
  // does not describe throws here, instead of being stripped from the page without a word.
  const listing = mcpToolListingSchema.array().parse([HEALTH_TOOL, ...tools.map(toolListing)]);
  const byName = new Map(listing.map((tool) => [tool.name, tool]));

  const refusedActions = listing.flatMap((tool) => {
    const refused = REFUSED_ACTIONS_BY_TOOL[tool.name] ?? {};
    return discriminatorValues(tool.inputSchema)
      .filter((action) => Object.hasOwn(refused, action))
      .map((action) => ({
        tool: tool.name,
        action,
        boundary: refused[action]!.boundary.replaceAll('-', ' '),
        reason: refused[action]!.reason,
      }));
  });

  const refusedArguments = REFUSED_ARGUMENTS.flatMap(({ tool, argument }) => {
    const properties = (byName.get(tool)?.inputSchema.properties ?? {}) as Record<string, { description?: unknown }>;
    const description = properties[argument]?.description;
    return typeof description === 'string' ? [{ tool, argument, reason: description }] : [];
  });

  return {
    available: true,
    xezarVersion,
    protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: { tools: { listChanged: SERVER_CAPABILITIES.tools.listChanged } },
    tools: listing,
    refusedActions,
    refusedArguments,
    notExposed: NOT_EXPOSED.map((item) => ({ ...item, forbiddenBy: [...item.forbiddenBy] })),
  };
}
