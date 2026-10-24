// FIRST import on purpose: the home pin is a module-load side effect and must run before anything
// that reaches `skills.ts` (#671).
import './mcp-test-home.testkit.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_FILES } from '../../agent-config/catalog.ts';
import { createApp } from '../../server/server.ts';
import { projectStateLayout, setActiveStateLayout } from '../../state-layout.ts';
import type { ServiceDispatch } from '../service-adapter.ts';
import { toolListing } from '../tool.ts';
import { REFUSED_ACTIONS, projectConfigTool } from './project-config.ts';
import {
  useProjectConfigWorkspace,
  COCKPIT_HOST,
  INCIDENT_ID,
  ws,
  cockpit,
  spyService,
  invoke,
  value,
  hotCockpit,
  IncidentProviderAuth,
  incidentCockpit,
} from './project-config.testkit.ts';

/**
 * Project configuration tools (#97): the provider switch (#677 B4) and where it says it wrote
 * (#819 item 7).
 * The fixture — a real app over a real two-project registry in a sandboxed `XEZ_HOME`, with agent
 * homes seeded with an account identity — and its helpers live in `project-config.testkit.ts`.
 */

useProjectConfigWorkspace();

// ---- the provider switch -------------------------------------------------------------------------

/**
 * #677 wave 2 slice B4 — `set_provider_enabled` and `retry_provider`.
 *
 * The same owner rule of 2026-09-20 ("every key"), scoped at 07:41 to "on/off and retry only",
 * reverses D-03-2: a leader turns an agent backend off and on, and clears an authentication
 * incident, through the cockpit's own two routes. `connect_provider` stays refused, and the
 * difference is the boundary rather than the setting — it starts a login terminal on the host.
 *
 * The division of labour is B1–B3's: the DOOR decides the key set (a provider id from the
 * contract's own enum, plus a boolean), the ROUTE decides everything else — its param validator,
 * its body validator, its merge-write, its `provider-status` event and its 409 on a stale
 * incident.
 */
describe('project_config: the provider switch (#677 B4)', () => {
  /** The workspace file the enable/disable really writes: `<XEZ_HOME>/config.json`. */
  const workspaceFile = (): string => join(process.env.XEZ_HOME!, 'config.json');

  /** A request against a cockpit other than the fixture's own. */
  async function via(app: ReturnType<typeof createApp>, path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
    const res = await app.request(path, {
      method,
      headers: {
        host: COCKPIT_HOST,
        origin: `http://${COCKPIT_HOST}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  }

  it('writes the switch through the cockpit’s own route, once, and answers in the get_capabilities vocabulary', async () => {
    const before = value(await invoke({ action: 'get_capabilities' })).providers;
    expect(before.find((row: { provider: string }) => row.provider === 'claude')).toMatchObject({ provider: 'claude', status: 'connected', enabled: true });

    const spy = spyService();
    const called = await invoke({ action: 'set_provider_enabled', provider: 'claude', enabled: false }, { service: spy });
    const written = value(called).providers;
    expect(spy.requests, 'the cockpit’s own route, once, and nothing else').toEqual(['PUT /api/v1/providers/claude/enabled']);
    expect(written.find((row: { provider: string }) => row.provider === 'claude')).toMatchObject({ provider: 'claude', enabled: false });
    // Every other provider is untouched: the route rewrites one entry of `disabledProviders`.
    expect(written.filter((row: { enabled?: boolean }) => row.enabled === false)).toHaveLength(1);
    // The answer is the SAME vocabulary the leader read the status in, so a write can be read.
    expect(value(await invoke({ action: 'get_capabilities' })).providers).toEqual(written);
    // The cockpit's own Providers card sees it, through the route it reads.
    const card = await cockpit('/api/v1/providers/status');
    expect(card.body.providers.find((row: { provider: string }) => row.provider === 'claude')).toMatchObject({ enabled: false });
    // And it really is the workspace file — machine-wide, which is the risk the argument names.
    expect(JSON.parse(readFileSync(workspaceFile(), 'utf8')).disabledProviders).toEqual(['claude']);

    // On again, and the file is empty of it rather than carrying a `false`.
    const back = value(await invoke({ action: 'set_provider_enabled', provider: 'claude', enabled: true })).providers;
    expect(back.find((row: { provider: string }) => row.provider === 'claude')).toMatchObject({ enabled: true });
    expect(JSON.parse(readFileSync(workspaceFile(), 'utf8')).disabledProviders).toEqual([]);
  });

  /**
   * THE NARROWING (named break 4). `GET /providers/status` carries an `authFailureId` for a
   * provider with a runtime incident, and `profileId` for a per-account row. Return the ROUTE's
   * answer instead of `providerRows(…)` and this case goes RED: the incident id a leader must
   * never learn — the one that would let it clear an incident it never observed — is in the
   * answer of a write it just made.
   */
  it('never hands back an incident id, through either provider action or the capabilities read', async () => {
    const { app, auth } = incidentCockpit();
    // The route really does carry it, so the assertions below are about something that is there.
    const raw = await via(app, '/api/v1/providers/status');
    expect(JSON.stringify(raw.body)).toContain(INCIDENT_ID);

    for (const args of [
      { action: 'get_capabilities' },
      { action: 'set_provider_enabled', provider: 'claude', enabled: false },
      { action: 'retry_provider', provider: 'claude' },
    ]) {
      const called = await invoke(args, { service: app });
      expect(called.result.isError, called.text).toBeFalsy();
      expect(called.json, JSON.stringify(args)).not.toContain(INCIDENT_ID);
      expect(called.json, JSON.stringify(args)).not.toMatch(/authFailureId/);
      auth.incident = INCIDENT_ID; // put it back for the next action
    }
  });

  /**
   * THE EFFECT, WITHOUT A RESTART, through the route a new task really goes through. The route's
   * own `mergeWrite` + `providerStatus` pair is what makes this true; dispatch anywhere else and
   * the switch would be a line in a file nobody re-reads.
   */
  it('a provider the leader switched off stops being offered for the next task at once', async () => {
    const start = async () => cockpit('/api/v1/p/proj-a/runs', 'POST', { workflow: 'quick-task', task: 'do the thing', runner: 'claude' });
    // The control: with the provider enabled, the task is really created.
    expect((await start()).status, 'a claude task starts while claude is enabled').toBe(201);

    value(await invoke({ action: 'set_provider_enabled', provider: 'claude', enabled: false }));
    const blocked = await start();
    expect(blocked.status, 'the run gate’s own refusal').toBe(409);
    expect(blocked.body.error).toMatch(/is disabled\./);

    // And back on, at once again: the gate reads the switch, not a snapshot of it.
    value(await invoke({ action: 'set_provider_enabled', provider: 'claude', enabled: true }));
    expect((await start()).status).toBe(201);
  });

  it('clears the authentication incident the cockpit’s own card would clear, and nothing else', async () => {
    const { app, auth } = incidentCockpit();
    const spy: ServiceDispatch & { requests: string[] } = {
      requests: [],
      request(url: string, init?: RequestInit) {
        this.requests.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
        return app.request(url, init);
      },
    };
    const called = await invoke({ action: 'retry_provider', provider: 'claude' }, { service: spy });
    const answer = value(called).providers;
    // The id the leader never saw is the id the route was asked to clear: the door reads the
    // CURRENT one from the same status route the cockpit's card reads, and hands it straight on.
    expect(auth.cleared, 'the observed incident, not an invented one').toEqual([INCIDENT_ID]);
    expect(spy.requests).toEqual(['GET /api/v1/providers/status', 'POST /api/v1/providers/claude/retry']);
    expect(answer.find((row: { provider: string }) => row.provider === 'claude')).toMatchObject({ provider: 'claude', status: 'connected' });
  });

  it('refuses a retry when there is no incident, and writes nothing', async () => {
    const spy = spyService();
    const called = await invoke({ action: 'retry_provider', provider: 'claude' }, { service: spy });
    expect(called.result.isError).toBe(true);
    expect(called.text).toContain('no authentication incident to clear');
    expect(spy.requests, 'it read the status and stopped there').toEqual(['GET /api/v1/providers/status']);
  });

  /**
   * THE ROUTE'S OWN REFUSAL, CARRIED UNREWRITTEN (named break 2). `clearRuntimeAuthFailure`
   * accepts only the incident the caller observed, so a rejection arriving between the door's
   * read and its write is answered by the ROUTE with its own 409. Build the body anywhere but
   * that route — clear the incident at this door, or send a remembered id — and this case goes
   * RED with a stale retry erasing a rejection the person never saw.
   */
  it('passes the route’s own stale-incident 409 through, with the route’s own words', async () => {
    const { app, auth } = incidentCockpit();
    // What the cockpit is told for a stale id, from the same route.
    const viaUi = await via(app, '/api/v1/providers/claude/retry', 'POST', { authFailureId: 'incident-the-card-remembered' });
    expect(viaUi.status).toBe(409);

    // The same race through the leader's door: the incident changes between the read and the write.
    const racing: ServiceDispatch = {
      request(url: string, init?: RequestInit) {
        const path = new URL(url).pathname;
        if (path.endsWith('/retry')) auth.incident = 'incident-that-arrived-after';
        return app.request(url, init);
      },
    };
    const called = await invoke({ action: 'retry_provider', provider: 'claude' }, { service: racing });
    expect(called.result.isError).toBe(true);
    expect(called.structured.status, 'the route’s own 409, not an argument refusal').toBe(409);
    expect(called.text, 'the route’s own reason, not a message invented here').toContain(viaUi.body.error);
    // The newer incident survives: nothing was cleared.
    expect(auth.incident).toBe('incident-that-arrived-after');
    expect(auth.cleared).toEqual([]);
  });

  it('accepts only a real provider id, and refuses an unknown one as an argument', async () => {
    const spy = spyService();
    for (const args of [
      { action: 'set_provider_enabled', provider: 'gemini', enabled: false },
      { action: 'retry_provider', provider: 'gemini' },
    ]) {
      const called = await invoke(args, { service: spy });
      expect(called.result.isError, JSON.stringify(args)).toBe(true);
      expect(called.text, JSON.stringify(args)).toMatch(/Invalid arguments|Invalid option/);
    }
    // The cockpit's own route refuses the same id, so neither door reaches a merge-write with it.
    expect((await cockpit('/api/v1/providers/gemini/enabled', 'PUT', { enabled: false })).status).toBe(400);
    expect(spy.requests, 'refused as arguments: nothing was dispatched').toEqual([]);
  });

  it('needs an operation key, and takes no argument the other action owns', async () => {
    const withoutKey = await invoke({ action: 'set_provider_enabled', provider: 'claude', enabled: false, operationId: undefined });
    expect(withoutKey.result.isError).toBe(true);
    expect(withoutKey.text).toMatch(/set_provider_enabled needs operationId/);
    const retryWithoutKey = await invoke({ action: 'retry_provider', provider: 'claude', operationId: undefined });
    expect(retryWithoutKey.result.isError).toBe(true);
    expect(retryWithoutKey.text).toMatch(/retry_provider needs operationId/);
    // `enabled` belongs to the switch alone: a retry that carries one is refused, never ignored.
    const mixed = await invoke({ action: 'retry_provider', provider: 'claude', enabled: true });
    expect(mixed.result.isError).toBe(true);
    expect(mixed.text).toMatch(/enabled is not used by retry_provider/);
    // And there is no `authFailureId` argument at all: a leader cannot name an incident.
    const named = await invoke({ action: 'retry_provider', provider: 'claude', authFailureId: INCIDENT_ID });
    expect(named.result.isError).toBe(true);
    expect(named.text).toMatch(/Unrecognized key/);
    // The switch needs both halves: a provider without a state is refused before any dispatch.
    const halfOpen = await invoke({ action: 'set_provider_enabled', provider: 'claude' });
    expect(halfOpen.result.isError).toBe(true);
    expect(halfOpen.text).toMatch(/set_provider_enabled needs enabled/);
  });

  /**
   * CONNECTING STAYS REFUSED (named break 5), and its boundary is the host process rather than
   * the workspace setting: `POST /providers/connect` opens a login terminal on the person's
   * machine (owner, 2026-09-20 07:41; spec § 4 Q2). Take it out of `REFUSED_ACTIONS` and this
   * goes RED.
   */
  it('still refuses connect_provider, naming the host process and dispatching nothing', async () => {
    const spy = spyService();
    const called = await invoke({ action: 'connect_provider' }, { service: spy });
    expect(called.result.isError).toBe(true);
    expect(called.structured).toMatchObject({ refused: true, boundary: 'host-process' });
    expect(called.text).toMatch(/^Refused \(host process\)/);
    expect(spy.requests).toEqual([]);
    expect(REFUSED_ACTIONS.connect_provider.boundary).toBe('host-process');
  });

  /**
   * HOSTED MODE ALLOWS BOTH WRITES, by the same owner decision of 2026-09-20 recorded for the
   * settings and preference writes: both provider routes are permitted in hosted mode. Pinned as
   * ALLOWED so a later 409 is a visible break; the agent-config
   * contrast on the same app proves hosted mode really is on.
   */
  it('is ALLOWED in hosted mode through both doors, while a local-handoff route on the same app still refuses', async () => {
    const { app } = hotCockpit('0.0.0.0');
    const health = (await via(app, '/api/v1/health')).body as { capabilities: { localHandoff: boolean } };
    expect(health.capabilities.localHandoff, 'the fixture really is hosted').toBe(false);

    expect((await via(app, '/api/v1/providers/codex/enabled', 'PUT', { enabled: false })).status).toBe(200);
    const called = await invoke({ action: 'set_provider_enabled', provider: 'claude', enabled: false }, { service: app });
    expect(called.result.isError, called.text).toBeFalsy();
    expect(value(called).providers.find((row: { provider: string }) => row.provider === 'claude')).toMatchObject({ enabled: false });

    // BOTH provider writes, because the backward-compatibility promise claims hosted mode for both and one
    // of them was all this case exercised (#760 review, Nit 2). The retry needs an incident to
    // clear, so it runs against a hosted cockpit that has one.
    const auth = new IncidentProviderAuth();
    const { app: hostedIncident } = hotCockpit('0.0.0.0', auth);
    expect((await via(hostedIncident, '/api/v1/providers/claude/retry', 'POST', { authFailureId: INCIDENT_ID })).status).toBe(200);
    auth.incident = INCIDENT_ID;
    const retried = await invoke({ action: 'retry_provider', provider: 'claude' }, { service: hostedIncident });
    expect(retried.result.isError, retried.text).toBeFalsy();
    expect(auth.cleared, 'the hosted route really cleared it, through both doors').toEqual([INCIDENT_ID, INCIDENT_ID]);

    expect((await via(app, `/api/v1/agent-config/${CONFIG_FILES[0]!.id}`, 'PUT', { content: '{}', version: null })).status).toBe(409);
  });
});

/**
 * #819 item 7 — `set_provider_enabled` says WHERE it wrote. The switch always followed the state
 * layout (#677 B4); the answer and the argument text said "machine-wide" in every layout, which in
 * single-project mode sent a leader to hand-edit a home file that was never read.
 */
describe('project_config: the provider switch answers scope and live (#819 item 7)', () => {
  afterEach(() => setActiveStateLayout(null));
  const homeConfig = (): string => join(process.env.XEZ_HOME!, 'config.json');

  // Break: `scope` missing, or hard-coded to machine; the file half pins the write that already worked.
  it('single-project mode: writes this project’s own settings file, not the home one, and answers scope project', async () => {
    const homeBefore = existsSync(homeConfig()) ? readFileSync(homeConfig(), 'utf8') : null;
    setActiveStateLayout(projectStateLayout(ws.roots.a));
    const answer = value(await invoke({ action: 'set_provider_enabled', provider: 'claude', enabled: false }));
    expect(answer.scope).toBe('project');
    expect(answer.live).toBe(true);
    expect(JSON.parse(readFileSync(join(ws.roots.a, '.xezar', 'workspace.json'), 'utf8')).disabledProviders).toEqual(['claude']);
    expect(existsSync(homeConfig()) ? readFileSync(homeConfig(), 'utf8') : null).toBe(homeBefore);
  });

  // Guard: the global layout keeps its machine-wide meaning, and says so.
  it('global layout: answers scope machine', async () => {
    const answer = value(await invoke({ action: 'set_provider_enabled', provider: 'claude', enabled: false }));
    expect(answer).toMatchObject({ scope: 'machine', live: true });
  });

  // Break: the argument text claiming a machine-wide switch in every layout.
  it('describes the reach by layout, not as machine-wide everywhere', () => {
    const listing = JSON.stringify(toolListing(projectConfigTool));
    expect(listing).not.toMatch(/apply to EVERY project on this machine/);
    expect(listing).not.toMatch(/it is a machine-wide switch/);
    expect(listing).toContain('when this project keeps its own setup (single-project mode)');
  });
});
