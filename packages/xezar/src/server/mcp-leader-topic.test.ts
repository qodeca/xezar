import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { McpLeaderStatus } from '@qodeca/xezar-contract';
import { projectLeaderChanged, projectLeaderIds, registerProjectLeader, watchProjectLeaders, type ProjectLeaderPort } from '../mcp/project-leaders.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { mcpLeaderTopic } from './mcp-leader-topic.ts';
import { createApp } from './server.ts';
import { createSocketHub, WS_PATH, type SocketHub, type TopicPublisher } from './ws.ts';

/**
 * The `mcp-leader` topic (#374, round 5 on #403, review major 2): the leader status of Settings → MCP
 * connection, live. A cockpit that stayed open used to keep saying "Codex connected" after the daemon,
 * the owner or the approval state changed, because only a Refresh or a focus re-read it. These cases
 * pin the topic's whole contract: demand-driven (a publisher only while someone holds it), published
 * only when the status really changed, and built from the same answer `GET /mcp/leader` gives.
 */

const idle = (over: Partial<Extract<McpLeaderStatus, { available: true }>> = {}): McpLeaderStatus => ({
  available: true,
  owner: null,
  leader: null,
  delivery: null,
  blocker: null,
  ...over,
});

/** The registry and the status function a topic reads, as plain maps a case steers by hand. */
function fakeRegistry() {
  const statuses = new Map<string, McpLeaderStatus>();
  const listeners = new Set<(projectId: string) => void>();
  let watches = 0;
  return {
    statuses,
    get watching() {
      return listeners.size;
    },
    get watches() {
      return watches;
    },
    announce: (projectId: string) => {
      for (const listener of [...listeners]) listener(projectId);
    },
    deps: {
      ids: () => [...statuses.keys()],
      status: (projectId: string): McpLeaderStatus => statuses.get(projectId) ?? { available: false, reason: 'not running' },
      watch: (listener: (projectId: string) => void) => {
        watches += 1;
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('the mcp-leader topic publisher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers a new subscriber with every running project’s status, keyed by project id', async () => {
    const registry = fakeRegistry();
    registry.statuses.set('beta', idle({ owner: { client: 'codex' } }));
    registry.statuses.set('alpha', idle());
    const topic = mcpLeaderTopic(registry.deps);
    expect(await topic.snapshot()).toEqual({ projects: { alpha: idle(), beta: idle({ owner: { client: 'codex' } }) } });
  });

  it('publishes an announced change once, and nothing for an announcement that changed nothing', async () => {
    const registry = fakeRegistry();
    registry.statuses.set('alpha', idle());
    const published: unknown[] = [];
    const stop = mcpLeaderTopic({ ...registry.deps, recheckMs: 60_000 }).start((data) => published.push(data));
    try {
      registry.announce('alpha');
      await flush();
      expect(published).toEqual([]);

      const attached = idle({ owner: { client: 'codex' }, leader: { client: 'codex', state: 'attached' } });
      registry.statuses.set('alpha', attached);
      // A burst of announcements for one change is one frame, not three.
      registry.announce('alpha');
      registry.announce('alpha');
      registry.announce('alpha');
      await flush();
      expect(published).toEqual([{ projects: { alpha: attached } }]);
    } finally {
      stop();
    }
  });

  it('a project whose MCP service stops while the topic is held is published as the unavailable answer', async () => {
    const registry = fakeRegistry();
    registry.statuses.set('alpha', idle());
    const published: unknown[] = [];
    const stop = mcpLeaderTopic({ ...registry.deps, recheckMs: 60_000 }).start((data) => published.push(data));
    try {
      registry.statuses.delete('alpha');
      registry.announce('alpha');
      await flush();
      expect(published).toEqual([{ projects: { alpha: { available: false, reason: 'not running' } } }]);
    } finally {
      stop();
    }
  });

  it('a service that starts while the topic is held joins the next frame', async () => {
    const registry = fakeRegistry();
    const published: unknown[] = [];
    const stop = mcpLeaderTopic({ ...registry.deps, recheckMs: 60_000 }).start((data) => published.push(data));
    try {
      registry.statuses.set('gamma', idle());
      registry.announce('gamma');
      await flush();
      expect(published).toEqual([{ projects: { gamma: idle() } }]);
    } finally {
      stop();
    }
  });

  // A change nothing announced — an app-server daemon that went away between two hand-offs is read
  // only when the adapter next looks — still reaches the cockpit, through the re-derive backstop.
  it('re-derives on the backstop interval, and publishes only what changed', () => {
    vi.useFakeTimers();
    const registry = fakeRegistry();
    registry.statuses.set('alpha', idle());
    const published: unknown[] = [];
    const stop = mcpLeaderTopic({ ...registry.deps, recheckMs: 5_000 }).start((data) => published.push(data));
    try {
      vi.advanceTimersByTime(15_000);
      expect(published).toEqual([]);
      const lost = idle({ blocker: { code: 'codex-app-server-unreachable', message: 'gone', fix: 'start it' } });
      registry.statuses.set('alpha', lost);
      vi.advanceTimersByTime(5_000);
      expect(published).toEqual([{ projects: { alpha: lost } }]);
      vi.advanceTimersByTime(20_000);
      expect(published).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('stops watching and re-deriving at 1→0: nothing is published after stop', async () => {
    vi.useFakeTimers();
    const registry = fakeRegistry();
    registry.statuses.set('alpha', idle());
    const published: unknown[] = [];
    const stop = mcpLeaderTopic({ ...registry.deps, recheckMs: 5_000 }).start((data) => published.push(data));
    expect(registry.watching).toBe(1);
    // An announcement queued just before the stop must not publish after it.
    registry.statuses.set('alpha', idle({ owner: { client: null } }));
    registry.announce('alpha');
    stop();
    expect(registry.watching).toBe(0);
    await vi.runAllTimersAsync();
    vi.advanceTimersByTime(60_000);
    expect(published).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** Over REAL sockets, as `ws.test.ts` does: the hub starts the publisher at 0→1 and stops it at 1→0. */
describe('the mcp-leader topic on the WebSocket hub', () => {
  const servers: Server[] = [];
  const hubs: SocketHub[] = [];
  afterEach(async () => {
    for (const hub of hubs.splice(0)) hub.close();
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  async function boot(publisher: TopicPublisher): Promise<string> {
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const hub = createSocketHub();
    hub.registerTopic('mcp-leader', publisher);
    hub.attach(server, () => ({ trusted: true }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    hubs.push(hub);
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}${WS_PATH}`;
  }

  async function client(url: string) {
    const ws = new WebSocket(url);
    const frames: unknown[] = [];
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    return { ws, frames, send: (frame: unknown) => ws.send(JSON.stringify(frame)) };
  }

  const until = async (what: string, probe: () => boolean): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (!probe()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it('watches only while at least one cockpit holds it, and a change reaches every holder once', async () => {
    const registry = fakeRegistry();
    registry.statuses.set('alpha', idle());
    const url = await boot(mcpLeaderTopic({ ...registry.deps, recheckMs: 60_000 }));
    expect(registry.watching).toBe(0);

    const a = await client(url);
    const b = await client(url);
    a.send({ type: 'subscribe', topic: 'mcp-leader' });
    await until('the snapshot for a', () => a.frames.length === 1);
    expect(a.frames[0]).toEqual({ type: 'event', topic: 'mcp-leader', data: { projects: { alpha: idle() } } });
    expect(registry.watching).toBe(1);
    b.send({ type: 'subscribe', topic: 'mcp-leader' });
    await until('the snapshot for b', () => b.frames.length === 1);
    expect(registry.watches).toBe(1); // the second holder starts nothing

    const attached = idle({ leader: { client: 'pi', state: 'attached' } });
    registry.statuses.set('alpha', attached);
    registry.announce('alpha');
    await until('the change on both', () => a.frames.length === 2 && b.frames.length === 2);
    expect(a.frames[1]).toEqual({ type: 'event', topic: 'mcp-leader', data: { projects: { alpha: attached } } });

    a.send({ type: 'unsubscribe', topic: 'mcp-leader' });
    b.ws.close(); // a dying socket releases its hold as a polite unsubscribe does
    await until('the publisher to stop', () => registry.watching === 0);
    a.ws.close();
  });
});

describe('the delivery path’s announcements (`project-leaders.ts`)', () => {
  const port = (status: McpLeaderStatus): ProjectLeaderPort => ({ status: () => status, act: async () => ({ ok: true, status }) });

  it('announces a registration, a release of that registration, and each change the delivery path reports', () => {
    const heard: string[] = [];
    const unwatch = watchProjectLeaders((projectId) => heard.push(projectId));
    try {
      const release = registerProjectLeader('xz-topic-a', port(idle()));
      expect(projectLeaderIds()).toContain('xz-topic-a');
      projectLeaderChanged('xz-topic-a');
      // A late release from an older composition evicts nothing, so it announces nothing either.
      const newer = registerProjectLeader('xz-topic-a', port(idle({ owner: { client: null } })));
      release();
      expect(projectLeaderIds()).toContain('xz-topic-a');
      newer();
      expect(projectLeaderIds()).not.toContain('xz-topic-a');
      expect(heard).toEqual(['xz-topic-a', 'xz-topic-a', 'xz-topic-a', 'xz-topic-a']);
    } finally {
      unwatch();
    }
    projectLeaderChanged('xz-topic-a');
  });

  it('a watcher that throws reaches neither the delivery path nor the other watchers', () => {
    const heard: string[] = [];
    const unwatchBad = watchProjectLeaders(() => {
      throw new Error('a broken watcher');
    });
    const unwatchGood = watchProjectLeaders((projectId) => heard.push(projectId));
    try {
      expect(() => projectLeaderChanged('xz-topic-b')).not.toThrow();
      expect(heard).toEqual(['xz-topic-b']);
    } finally {
      unwatchBad();
      unwatchGood();
    }
  });
});

/** The wiring in `createApp`: registered beside `health`, and the same answer the GET gives. */
describe('createApp registers the mcp-leader topic', () => {
  let repoRoot: string;
  let store: RunStore;
  const savedDryRun = process.env.XEZ_DRY_RUN;
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-mcp-leader-topic-'));
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    process.env.XEZ_DRY_RUN = '1';
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.XEZ_DRY_RUN;
    else process.env.XEZ_DRY_RUN = savedDryRun;
  });

  it('serves each running project’s `GET /mcp/leader` answer, trusted connections only', async () => {
    const topics = new Map<string, { publisher: TopicPublisher; loopbackReadable: boolean }>();
    const hub: SocketHub = {
      registerTopic: (name, publisher, options) => {
        topics.set(name, { publisher, loopbackReadable: options?.loopbackReadable ?? false });
      },
      attach: () => undefined,
      close: () => undefined,
    };
    // The unscoped route answers for the boot project, whose registry id `startServer` passes in.
    const projectId = 'xz-topic-boot';
    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', socketHub: hub, bootProjectId: projectId });
    const topic = topics.get('mcp-leader');
    if (!topic) throw new Error('no mcp-leader topic registered');
    // Default trust: legible to the cockpit's own connection, never to a page admitted by the loopback fallback.
    expect(topic.loopbackReadable).toBe(false);

    const status = idle({ owner: { client: 'codex' }, blocker: { code: 'no-leader-session', message: 'kept', fix: 'attach' } });
    const release = registerProjectLeader(projectId, port(status));
    try {
      const viaGet = await (await apiRequest(app, '/api/v1/mcp/leader')).json();
      const snapshot = (await topic.publisher.snapshot()) as { projects: Record<string, unknown> };
      expect(snapshot.projects[projectId]).toEqual(viaGet);
      expect(viaGet).toEqual(status);
    } finally {
      release();
    }
  }, 30_000);

  function port(status: McpLeaderStatus): ProjectLeaderPort {
    return { status: () => status, act: async () => ({ ok: true, status }) };
  }
});
