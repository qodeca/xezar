import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import type { InferRequestType } from 'hono/client';
import { hc } from 'hono/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setConfigInputSchema, setWorkspaceConfigInputSchema, updateProjectInputSchema } from '@qodeca/xezar-contract';
import type { AppType } from '../../server/app-type.ts';
import { apiRequest } from '../../server/loopback-request.testkit.ts';
import { createApp } from '../../server/server.ts';
import { RunStore } from '../../runs/store.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import type { RunManager } from '../../workflows/run.ts';
import { ACTION_FIELDS, PROJECT_CONFIG_ACTIONS, projectConfigInputSchema } from './project-config.ts';

/**
 * MCP ↔ route REQUEST parity, per key (#677 wave 1, slice A3).
 *
 * `project_config` dispatches through the cockpit's own routes in process, so a leader and the
 * cockpit are supposed to be able to send the same body. They are not the same schema, though:
 * the MCP narrows deliberately (`maxParallel` is inert in the repo config, § 4.14), and a
 * deliberate omission is indistinguishable from an accident once it is buried in an `.omit()`
 * chain. So the inventory is DATA here — the accepted keys written out, and the omitted ones
 * named with the reason they are omitted.
 *
 * Three things fail, which is the whole point:
 *   - the route's schema gains a key and nobody decided whether the MCP accepts it (the key list
 *     below is literal, so a key that flows through `.omit()` into both sides still stops here);
 *   - an omission goes stale — the key it names is no longer one the route accepts;
 *   - a new WRITE action appears and is neither paired nor given a reason.
 *
 * "Write action" is not a judgement call: `ACTION_FIELDS` requires `operationId` from every action
 * that changes something and refuses it from every action that only reads (D-06 § 5.2).
 */
describe('every MCP write action accepts what its route accepts', () => {
  /** A `z.optional(z.object(…))` argument of the tool's input schema, as its object shape. */
  const mcpArgumentKeys = (field: 'config' | 'project' | 'workspaceConfig'): string[] =>
    Object.keys(projectConfigInputSchema.shape[field].unwrap().shape).sort();

  /**
   * The paired write actions: the ones whose ROUTE validates with a schema from
   * `packages/contract`, which is what makes "the schema the route accepts" a fact rather than a
   * guess. `set_config`'s route joined that list in this PR; `set_project`'s was already there.
   */
  const PAIRS = [
    {
      action: 'set_config',
      argument: 'config',
      route: 'PUT /api/v1/config',
      schema: setConfigInputSchema,
      /** Literal on purpose: a key added to the contract schema fails here until someone decides. */
      routeKeys: [
        'baseBranch',
        'defaultModels',
        'defaultRunner',
        'liveTitleUpdates',
        'maxParallel',
        'memoryLimitMb',
        'namerModel',
        'plannerModel',
        'reviewGate',
        'skillsRepos',
        'systemPrompt',
        'worktreeRetention',
      ],
      omittedFromMcp: {
        maxParallel:
          "inert in the repo config (§ 4.14): the scheduler reads the registry entry, which is `set_project`. Accepting it here would report a change that never happens.",
      },
    },
    {
      action: 'set_workspace_config',
      argument: 'workspaceConfig',
      route: 'PUT /api/v1/workspace/config',
      schema: setWorkspaceConfigInputSchema,
      routeKeys: [
        'agentDefaults',
        'agentEnvPassthrough',
        'browseRoot',
        'composerDefaults',
        'followups',
        'projectsDir',
        'resources',
        'skillsAutoUpdate',
      ],
      // NOTHING is omitted since slice B2 (#677): `browseRoot` and `projectsDir` were the last two,
      // held back by B1 as the security-relevant half of the reversal, and the owner's rule of
      // 2026-09-20 ("every key") covers them. The two doors now accept the identical key inventory,
      // which is the state this guard exists to notice a drift away from.
      omittedFromMcp: {},
    },
    {
      action: 'set_project',
      argument: 'project',
      route: 'PATCH /api/v1/projects/:projectId',
      schema: updateProjectInputSchema,
      routeKeys: ['maxParallel', 'tags'],
      omittedFromMcp: {},
    },
  ] as const;

  /**
   * The write actions with no contract-backed body to compare against, each with the reason.
   * Every one of them is a candidate for a later wave; none may sit here without a sentence.
   */
  const UNPAIRED: Record<string, string> = {
    set_prompt_templates:
      'sends one KEY of the ui-state body (`promptTemplates`), not a keyed request object of its own; the schema it reuses IS the contract one (`uiStateSchema.shape.promptTemplates`), so there are no two copies to drift.',
    write_agent_config:
      'the route still declares its own body schema in `server.ts`; the MCP reuses the contract `setAgentConfigInputSchema` shape. Pair it when that route moves to the contract.',
    save_workflow:
      'the route still declares its own body schema in `server.ts`; the MCP narrows the contract `saveWorkflowInputSchema` to agent steps on purpose. Pair it when that route moves to the contract.',
    create_automation:
      'deliberately NOT the route body: the MCP offers the cockpit form only (D-97, matched never widened), so key-for-key equality would be the wrong assertion.',
    update_automation: 'the same cockpit-form narrowing as `create_automation` (D-97).',
    // The rest take ids and flags rather than a body: there is no request shape to compare.
    delete_workflow: 'takes a name, not a body.',
    refresh_skills: 'takes no argument beyond the operation key.',
    delete_automation: 'takes an id, not a body.',
    enable_automation: 'takes an id, not a body.',
    pause_automation: 'takes an id, not a body.',
    check_automation: 'takes an id and a mode, not a body.',
    retry_automation_receipt: 'takes a receipt id, not a body.',
    reclaim_worktrees: 'takes no argument beyond the operation key.',
    remove_worktree: 'takes a run id and the expected version, not a body.',
    dismiss_onboarding_offer: 'takes an optional identity pair, not a body.',
  };

  const writeActions = PROJECT_CONFIG_ACTIONS.filter((action) =>
    ACTION_FIELDS[action].required.includes('operationId'),
  );

  it('classifies every write action — a new one is paired or carries a reason', () => {
    const classified = [...PAIRS.map((pair) => pair.action), ...Object.keys(UNPAIRED)].sort();

    expect([...writeActions].sort()).toEqual(classified);
    for (const [action, reason] of Object.entries(UNPAIRED)) {
      expect(reason.length, `${action} needs a real reason`).toBeGreaterThan(20);
    }
  });

  for (const pair of PAIRS) {
    describe(`${pair.action} → ${pair.route}`, () => {
      it('accepts exactly the declared key inventory', () => {
        expect(Object.keys(pair.schema.shape).sort()).toEqual([...pair.routeKeys].sort());
      });

      it('accepts every route key except the ones it declares as omitted', () => {
        const omitted = Object.keys(pair.omittedFromMcp);
        expect(mcpArgumentKeys(pair.argument)).toEqual(
          pair.routeKeys.filter((key) => !omitted.includes(key)).sort(),
        );
      });

      it('omits only keys the route really has, each with a reason', () => {
        for (const [key, reason] of Object.entries(pair.omittedFromMcp)) {
          expect(pair.routeKeys, `${key} is omitted from a route that does not accept it`).toContain(key);
          expect(reason.length, `${key} needs a real reason`).toBeGreaterThan(20);
        }
      });
    });
  }

  /**
   * The compile-time half: read from the ROUTE, not from the contract. Hono records a request
   * shape in the route type only when validation is middleware, so this fails if `PUT /config`
   * goes back to a locally declared schema, or parses inside its handler instead.
   */
  const client = hc<AppType>('http://127.0.0.1');
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Assert<T extends true> = T;
  type SetConfigRouteKeys = keyof InferRequestType<typeof client.api.v1.config.$put>['json'];
  type DeclaredSetConfigKeys = (typeof PAIRS)[0]['routeKeys'][number];
  type _RouteKeysMatchTheInventory = Assert<Mutual<SetConfigRouteKeys, DeclaredSetConfigKeys>>;

  /**
   * And the run-time half of the same question, for the one key the MCP omits: an omission is
   * only honest while the route still accepts the key. Sent through the real app, then read back
   * — a route whose schema dropped `maxParallel` would strip it and answer 200 with nothing
   * changed, which no type-level check can see.
   */
  describe('the omitted key is one the route really applies', () => {
    const savedHome = process.env.XEZ_HOME;
    let home: string;
    let repoRoot: string;
    let app: Hono;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'xez-mcp-parity-'));
      process.env.XEZ_HOME = home;
      repoRoot = mkdtempSync(join(tmpdir(), 'xez-mcp-parity-repo-'));
      mkdirSync(join(repoRoot, '.local/xezar'), { recursive: true });
      app = createApp({
        repoRoot,
        store: RunStore.open(join(repoRoot, '.local/xezar')),
        manager: {} as RunManager,
        version: '0.0.0-test',
        semaphore: new WorkspaceSemaphore(),
      });
    });

    afterEach(() => {
      if (savedHome === undefined) delete process.env.XEZ_HOME;
      else process.env.XEZ_HOME = savedHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    });

    it('applies maxParallel on PUT /config, the key set_config declares as omitted', async () => {
      const put = await apiRequest(app, '/api/v1/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxParallel: 4 }),
      });
      expect(put.status).toBe(200);

      const answer = (await (await apiRequest(app, '/api/v1/config')).json()) as { maxParallel: number };
      expect(answer.maxParallel).toBe(4);
    });

    it('applies browseRoot and projectsDir on PUT /workspace/config, the keys set_workspace_config declares as omitted', async () => {
      const put = await apiRequest(app, '/api/v1/workspace/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ browseRoot: repoRoot, projectsDir: join(repoRoot, 'checkouts') }),
      });
      expect(put.status, await put.clone().text()).toBe(200);

      const answer = (await (await apiRequest(app, '/api/v1/workspace/config')).json()) as { browseRoot: string; projectsDir: string };
      expect(answer.browseRoot).toBe(repoRoot);
      expect(answer.projectsDir).toBe(join(repoRoot, 'checkouts'));
    });
  });
});
