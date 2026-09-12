import { describe, expect, it } from 'vitest';

import { toolListing, type McpTool } from '../tool.ts';
import { tools } from './index.ts';
import { refusesOperationId, requiresOperationId } from './operation-id.testkit.ts';
import { REFUSED_ACTIONS } from './project-config.ts';

/**
 * #264 — D-06 § 5.2 HELD TO THE WHOLE REGISTRY: every mutating MCP tool takes a required
 * `operationId`, so a leader that loses the answer to a call can replay it and learn what happened
 * instead of doing it twice (N-10).
 *
 * The rule is checked against the registry rather than against a list of six tool names, because the
 * failure this guards against is the seventh tool: a new mutating action shipped without a key is
 * invisible in review and only shows up as a duplicated task months later. A tool declares its own
 * requirement in its own per-action argument table; this file is what makes forgetting one fail.
 *
 * THE ONLY EXEMPTIONS ARE BELOW, EACH WITH A REASON. An exemption that is not written down does not
 * exist: `NO_OPERATION_ID` is checked in both directions, so an entry that stops matching the code
 * fails just as loudly as a missing one.
 */

/** The argument that selects what a tool does, when it has one (`api-reference.ts` uses the same). */
const DISCRIMINATORS = ['action', 'view', 'read'] as const;

function actionsOf(tool: McpTool): (string | undefined)[] {
  const properties = (toolListing(tool).inputSchema as { properties?: Record<string, { enum?: unknown }> }).properties ?? {};
  for (const name of DISCRIMINATORS) {
    const values = properties[name]?.enum;
    if (Array.isArray(values)) return values.filter((value): value is string => typeof value === 'string');
  }
  return [undefined];
}

const isMutatingTool = (tool: McpTool): boolean => tool.annotations?.readOnlyHint !== true;

/**
 * Actions of a MUTATING tool that take no operation id, each with why replaying it needs no receipt.
 * Two kinds:
 *
 *  - a READ that happens to live on a tool whose other actions write. It refuses a key rather than
 *    accepting one, because a receipt filed over a read would answer the next identical read with
 *    the receipt instead of with the data — `leader_events read` is the sharp case, where returning
 *    the same rows again until they are acked IS the contract;
 *  - a REFUSAL-ONLY action (`project_config`'s `REFUSED_ACTIONS`), which names a boundary and
 *    dispatches nothing at all.
 *
 * "Needs no receipt" is NOT the same claim as "writes nothing", and two entries below are exempt
 * while genuinely writing. The test that matters for N-10 is narrower: could a leader that LOST the
 * answer, and repeated the call, end up with a different or a doubled outcome? Where the write is
 * monotonic bookkeeping no user-visible answer reads back, the repeat is a no-op and a receipt would
 * only get in the way. Say what the action really does; do not flatten it to "reads".
 */
const NO_OPERATION_ID: Readonly<Record<string, string>> = {
  'organise_work:list_queue': 'reads the queue; it starts, edits and deletes nothing',
  'handoff_git:repo': 'reads the main checkout',
  'handoff_git:merge_state': 'reads one pull request and its blockers',
  'local_handoff:list_apps': 'reads which apps the host has; it opens none of them',
  'leader_events:read':
    'at-least-once delivery: a repeated read is MEANT to return the same rows again, until an ack moves the position. It does write — `markDelivered` persists `deliveredSeq` to `<dataDir>/mcp/leader-cursors.json` (`leader-events.ts` → `reconnect.ts`) — but that write is monotonic non-model bookkeeping a repeat cannot move further, and every consumer of the position (`owedAfter`, the `GET /api/v1/mcp/leader` blocker) reads the ACKED seq and never `deliveredSeq`. A receipt over the read would answer the replay with the receipt instead of the rows, which is exactly the break at-least-once delivery exists to prevent',
  'project_config:get_config': 'reads the project settings',
  'project_config:get_project': 'reads the registry entry',
  'project_config:get_prompt_templates': 'reads the follow-up prompt templates',
  'project_config:get_limits': 'reads the effective limits',
  'project_config:get_capabilities':
    'reads capabilities and provider status. `refresh: true` is not free — `startFreshProbe` (`core/provider-auth.ts`) spawns the vendor CLI probes and replaces `completed`, the process-wide provider-status cache every other reader consults — but it refreshes a CACHE of an external fact, so a repeat re-reads the world rather than doing anything a second time. A receipt is the wrong tool here twice over: it would serve the replay a stale snapshot, which is the one thing `refresh` exists to avoid',
  'project_config:get_account': 'reads the effective account selection',
  'project_config:list_agent_config': 'lists the agent config files',
  'project_config:read_agent_config': 'reads one agent config file',
  'project_config:list_workflows': 'lists the project workflows',
  'project_config:parse_workflow': 'validates YAML and writes nothing',
  'project_config:list_skills': 'lists the skills',
  'project_config:get_skill': 'reads one skill',
  'project_config:list_importable_skills': 'lists what could be imported; importing is refused',
  'project_config:check_skill_updates': 'reports which skill updates are pending; applying them is `refresh_skills`',
  'project_config:list_automations': 'lists the automations',
  'project_config:get_automation': 'reads one automation',
  'project_config:get_automation_check': 'reads the result of a check that already ran',
  'project_config:get_automation_log': 'reads the automation log',
  'project_config:list_worktrees': 'lists the worktrees',
};

const REFUSAL_ONLY = new Set(Object.keys(REFUSED_ACTIONS).map((action) => `project_config:${action}`));

/**
 * The other arguments an action needs before its "this argument does not apply" refusal is even
 * reachable. Only `handoff_git` needs any: it reports missing arguments first and looks for
 * arguments the action does not take only once nothing is missing.
 */
const PROBE_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  'handoff_git:merge_state': { number: 7 },
};

const key = (tool: McpTool, action: string | undefined): string => (action === undefined ? tool.name : `${tool.name}:${action}`);

describe('#264 — every mutating tool action takes a required operationId (D-06 § 5.2)', () => {
  const mutatingTools = tools.filter(isMutatingTool);

  it('the registry still has mutating tools to check', () => {
    expect(mutatingTools.map((tool) => tool.name)).toEqual([
      'execution_control',
      'organise_work',
      'task_create',
      'handoff_git',
      'project_config',
      'local_handoff',
      'leader_events',
    ]);
  });

  for (const tool of tools.filter(isMutatingTool)) {
    for (const action of actionsOf(tool)) {
      const id = key(tool, action);
      if (REFUSAL_ONLY.has(id)) {
        it(`${id} names a boundary and dispatches nothing, so it needs no operation id`, () => {
          expect(requiresOperationId(tool, action)).toBe(false);
          expect(NO_OPERATION_ID[id], `${id} is a refusal-only action and is exempt by that alone`).toBeUndefined();
        });
        continue;
      }
      const exempt = NO_OPERATION_ID[id];
      if (exempt) {
        const probe = PROBE_ARGS[id] ?? {};
        it(`${id} takes no operation id — ${exempt}`, () => {
          expect(requiresOperationId(tool, action, probe), `${id} is listed as exempt but demands an operationId`).toBe(false);
          expect(
            refusesOperationId(tool, action, probe),
            `${id} is exempt but accepts an operationId, so a receipt could be filed over a read`,
          ).toBe(true);
        });
        continue;
      }
      it(`${id} refuses a call with no operation id`, () => {
        expect(requiresOperationId(tool, action)).toBe(true);
      });
    }
  }

  it('every exemption named above is a real action of a real mutating tool', () => {
    const real = new Set(tools.filter(isMutatingTool).flatMap((tool) => actionsOf(tool).map((action) => key(tool, action))));
    expect(Object.keys(NO_OPERATION_ID).filter((id) => !real.has(id)), 'exemptions for actions that do not exist').toEqual([]);
  });

  it('a read-only tool is out of scope: it declares no operationId at all', () => {
    for (const tool of tools.filter((t) => !isMutatingTool(t))) {
      const properties = (toolListing(tool).inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.hasOwn(properties, 'operationId'), `${tool.name} is read-only and should not take an operationId`).toBe(false);
    }
  });
});
