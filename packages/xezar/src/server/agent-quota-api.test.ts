import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { AgentQuotaStore, normalizeClaudeUsage } from '../workspace/agent-quota.ts';
import type { SocketHub, TopicPublisher } from './ws.ts';
import { createApp, WorkspaceEventBus } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

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
    quota = new AgentQuotaStore({ path: join(home, 'agent-quota', 'quota.json'), now: () => Date.parse('2026-09-22T14:24:00Z') });
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
    const body = await response.json() as { accounts: Array<{ runner: string; accountId: string; status: string }> };
    expect(body.accounts).toEqual([
      expect.objectContaining({ runner: 'claude', accountId: 'default', status: 'unknown' }),
      expect.objectContaining({ runner: 'codex', accountId: 'default', status: 'unknown' }),
    ]);
  });

  it('validates and applies provider/account filters and returns 404 for an unknown account', async () => {
    expect((await apiRequest(app(), '/api/v1/workspace/agent-quota?provider=pi')).status).toBe(400);
    const filtered = await apiRequest(app(), '/api/v1/workspace/agent-quota?provider=claude&accountId=default');
    expect(filtered.status).toBe(200);
    expect((await filtered.json() as { accounts: unknown[] }).accounts).toHaveLength(1);
    expect((await apiRequest(app(), '/api/v1/workspace/agent-quota?accountId=missing')).status).toBe(404);
  });

  it('remains readable in hosted mode without exposing a home path', async () => {
    const response = await app({ bindHost: '0.0.0.0' }).request('http://server/api/v1/workspace/agent-quota', {
      headers: { host: 'server' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(home);
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
    app({ socketHub: hub, workspaceEvents: bus });
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
    expect(publish).toHaveBeenCalledTimes(1);
    expect(hints).toEqual(['agent-quota']);
    stop();
    await quota.put({ ...row, checkedAt: '2026-09-22T14:21:00Z' });
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
