import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { AgentQuotaStore, normalizeClaudeUsage } from '../workspace/agent-quota.ts';
import { AgentQuotaChecker } from '../workspace/agent-quota-checker.ts';
import type { SocketHub, TopicPublisher } from './ws.ts';
import { createApp, WorkspaceEventBus } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
// @ts-expect-error Vitest supplies raw asset imports in tests.
import frozenText from '../../../contract/src/__fixtures__/agent-quota.expected.json?raw';

describe('agent quota read surface', () => {
  let root: string;
  let home: string;
  let runs: RunStore;
  let quota: AgentQuotaStore;
  const savedHome = process.env.XEZ_HOME;

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'xez-quota-api-'));
    home = mkdtempSync(join(realpathSync(tmpdir()), 'xez-quota-home-'));
    process.env.XEZ_HOME = home;
    runs = RunStore.open(join(root, '.local/xezar'));
    quota = new AgentQuotaStore({ now: () => Date.parse('2026-09-22T14:24:00Z') });
  });

  afterEach(() => {
    runs.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = savedHome;
  });

  const app = (extra: Record<string, unknown> = {}) => createApp({
    repoRoot: root,
    store: runs,
    manager: {} as RunManager,
    version: '0.0.0-test',
    agentQuotaStore: quota,
    ...extra,
  });

  it('answers unknown rows for every known Claude/Codex login when no observation is stored', async () => {
    const response = await apiRequest(app(), '/api/v1/workspace/agent-quota');
    expect(response.status).toBe(200);
    const body = await response.json() as { accounts: Array<{ runner: string; accountId: string; status: string; source: string }> };
    expect(body.accounts).toEqual([
      expect.objectContaining({ runner: 'claude', accountId: 'default', status: 'unknown', source: 'none' }),
      expect.objectContaining({ runner: 'codex', accountId: 'default', status: 'unknown', source: 'none' }),
    ]);
  });

  it('validates and applies provider/account filters and returns 404 for an unknown account', async () => {
    expect((await apiRequest(app(), '/api/v1/workspace/agent-quota?provider=pi')).status).toBe(400);
    const filtered = await apiRequest(app(), '/api/v1/workspace/agent-quota?provider=claude&accountId=default');
    expect(filtered.status).toBe(200);
    expect((await filtered.json() as { accounts: unknown[] }).accounts).toHaveLength(1);
    expect((await apiRequest(app(), '/api/v1/workspace/agent-quota?accountId=missing')).status).toBe(404);
  });

  it('honours the documented wait=true query', async () => {
    const checker = new AgentQuotaChecker({ store: quota, profiles: async () => [], dryRun: () => true });
    const refresh = vi.spyOn(checker, 'refreshStale');
    const response = await apiRequest(app({ agentQuotaChecker: checker }), '/api/v1/workspace/agent-quota?wait=true');
    expect(response.status).toBe(200);
    expect(refresh).toHaveBeenCalledWith({}, true);
  });

  it('remains readable in hosted mode without exposing a home path', async () => {
    const response = await app({ bindHost: '0.0.0.0' }).request('http://server/api/v1/workspace/agent-quota', {
      headers: { host: 'server' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(home);
  });

  it('refreshes through POST in hosted mode, validates the body, and exposes no identity or path', async () => {
    const checker = new AgentQuotaChecker({
      store: quota,
      now: () => Date.parse('2026-09-22T14:24:00Z'),
      profiles: async () => [{
        provider: 'claude', id: 'work', label: 'person@example.test', configDir: home,
        path: home, isDefault: false,
      }],
      dryRun: () => true,
    });
    const hosted = app({ bindHost: '0.0.0.0', agentQuotaChecker: checker });
    const response = await hosted.request('http://server/api/v1/workspace/agent-quota/refresh', {
      method: 'POST',
      headers: { host: 'server', origin: 'http://server', 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude', accountId: 'work' }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(home);
    expect(text).not.toContain('person@example.test');
    expect((await hosted.request('http://server/api/v1/workspace/agent-quota/refresh', {
      method: 'POST', headers: { host: 'server', origin: 'http://server', 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'pi' }),
    })).status).toBe(400);
    expect((await hosted.request('http://server/api/v1/workspace/agent-quota/refresh', {
      method: 'POST', headers: { host: 'server', origin: 'http://server', 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'missing' }),
    })).status).toBe(404);
  });

  it('rejects a cross-origin refresh through the existing origin guard', async () => {
    const response = await app().request('http://127.0.0.1/api/v1/workspace/agent-quota/refresh', {
      method: 'POST',
      headers: { host: '127.0.0.1', origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });

  it('registers a demand-driven agent-quota topic and emits WS + SSE only after a change', async () => {
    const topics = new Map<string, TopicPublisher>();
    const hub: SocketHub = {
      registerTopic: (name, publisher) => { topics.set(name, publisher); },
      attach: () => undefined,
      close: () => undefined,
    };
    const bus = new WorkspaceEventBus();
    const hints: string[] = [];
    bus.on((event) => hints.push(event));
    const service = app({
      socketHub: hub,
      workspaceEvents: bus,
      agentQuotaChecker: new AgentQuotaChecker({ store: quota, profiles: async () => [] }),
    });
    const topic = topics.get('agent-quota');
    expect(topic).toBeDefined();
    const publish = vi.fn();
    const stop = topic!.start(publish);
    const row = normalizeClaudeUsage(
      { result: 'Current session: 25% used · resets Sep 22 at 5:10pm (Europe/Warsaw)' },
      'default',
      new Date('2026-09-22T14:20:00Z'),
    );
    await quota.put(row);
    await expect.poll(() => publish.mock.calls.length).toBe(1);
    const getBody = await (await apiRequest(service, '/api/v1/workspace/agent-quota')).json();
    expect(publish).toHaveBeenLastCalledWith(getBody);
    expect(hints).toEqual(['agent-quota']);
    stop();
    await quota.put({ ...row, observedAt: '2026-09-22T14:21:00Z' });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  // #867 AC-4 / AC-27: with XEZ_DRY_RUN=1, a pinned clock and TZ=Europe/Warsaw, the GET answer
  // is the approved fixture byte for byte (same method as the fixture's own contract test), and
  // neither the GET, its waited form nor the POST refresh starts a process.
  describe('in dry run', () => {
    const saved = { dryRun: process.env.XEZ_DRY_RUN, tz: process.env.TZ };
    beforeEach(() => {
      process.env.XEZ_DRY_RUN = '1';
      process.env.TZ = 'Europe/Warsaw';
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-22T14:24:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
      for (const [key, value] of [['XEZ_DRY_RUN', saved.dryRun], ['TZ', saved.tz]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('answers GET with the approved fixture byte for byte and starts no process', async () => {
      expect(new Date('2026-09-22T14:24:00Z').getTimezoneOffset()).toBe(-120);
      const runProcess = vi.fn();
      const checker = new AgentQuotaChecker({ store: quota, runProcess });
      const service = app({ agentQuotaChecker: checker });
      const response = await apiRequest(service, '/api/v1/workspace/agent-quota');
      expect(response.status).toBe(200);
      expect(`${JSON.stringify(await response.json(), null, 2)}\n`).toBe(frozenText);
      const waited = await apiRequest(service, '/api/v1/workspace/agent-quota?wait=true');
      expect(`${JSON.stringify(await waited.json(), null, 2)}\n`).toBe(frozenText);
      const refreshed = await apiRequest(service, '/api/v1/workspace/agent-quota/refresh', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(`${JSON.stringify(await refreshed.json(), null, 2)}\n`).toBe(frozenText);
      await Promise.resolve();
      expect(runProcess).not.toHaveBeenCalled();
      checker.close();
    });

    it('serves the fixture from the app default checker as well', async () => {
      const response = await apiRequest(app(), '/api/v1/workspace/agent-quota');
      expect(`${JSON.stringify(await response.json(), null, 2)}\n`).toBe(frozenText);
    });
  });
});
