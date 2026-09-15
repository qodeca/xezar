import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { channelMeta, renderChannelContent } from './adapters/claude-code.ts';
import { HEALTH_TOOL, SERVICE_DISCONNECTED_NOTICE, runBridge } from './bridge.ts';
import { EventJournal } from './event-journal.ts';
import { LineFramer, encodeFrame } from './ipc.ts';
import { LEADER_ROLE_INSTRUCTION, LeaderDelivery } from './leader-delivery.ts';
import { toolListing, type McpToolContext } from './tool.ts';
import { tools } from './tools/index.ts';
import { executionControlTool } from './tools/execution-control.ts';
import { handoffGitTool } from './tools/handoff-git.ts';
import { leaderEventsTool } from './tools/leader-events.ts';
import { localHandoffTool } from './tools/local-handoff.ts';
import { resultsEvidenceTool } from './tools/results-evidence.ts';
import { taskCreateTool } from './tools/task-create.ts';
import { taskReadsTool } from './tools/task-reads.ts';
import { organiseWorkTool } from './tools/work-organisation.ts';

/**
 * #439 — the owner's operating rule (2026-09-15): a project leader works through the xezar MCP tools
 * only, never the cockpit UI or the HTTP API, and is attached so events are pushed; `leader_events`
 * is the fallback. These pins cover the strings a leader reads at runtime that no generated
 * reference already pins (tool descriptions are pinned byte-for-byte by `mcp-api-doc.test.ts`, the
 * initialize instructions by `bridge.test.ts`, the no-leader blocker by `leader-delivery.test.ts`).
 */

const ctx = { project: { id: 'leader', name: 'Leader', root: '/nonexistent' }, xezarVersion: '0.0.0-test' } as McpToolContext;
const textOf = (result: { content: ReadonlyArray<{ type: string; text?: string }> }): string =>
  result.content.map((part) => part.text ?? '').join('\n');

describe('an unconnected tool never sends a leader to the cockpit (#439, #450 T-26)', () => {
  const unwired = [
    ['task_read', () => taskReadsTool.call({ view: 'list' } as never, ctx)],
    ['execution_control', () => executionControlTool.call({ action: 'cancel' } as never, ctx)],
    ['handoff_git', () => handoffGitTool.call({ action: 'repo' } as never, ctx)],
    ['organise_work', () => organiseWorkTool.call({ action: 'delete' } as never, ctx)],
    ['leader_events', () => leaderEventsTool.call({ action: 'read' } as never, ctx)],
    ['leader_events attach', () => leaderEventsTool.call({ action: 'attach' } as never, ctx)],
    ['read_results_evidence', () => resultsEvidenceTool.call({ read: 'summary', runId: 'r' } as never, ctx)],
    ['local_handoff', () => localHandoffTool.call({ action: 'list_apps' } as never, ctx)],
    ['task_create', () => taskCreateTool.call({ action: 'start', prompt: 'p', operationId: 'op-unwired-01' } as never, ctx)],
  ] as const;

  for (const [name, call] of unwired) {
    it(`${name} tells the leader to report the blocker, not to switch surface`, async () => {
      // RED against: the old "Use the cockpit …" fallback in the not-connected answer.
      const result = await call();
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toMatch(/not connected/);
      expect(text).toContain('Report this');
      expect(text).toContain('to the person');
      // #450: and it says where to look next, through the tools.
      expect(text).toContain('Call `health`');
      expect(text).not.toMatch(/Use the cockpit/);
    });
  }
});

describe('the role text pushed with every event states the MCP-only rule (#439)', () => {
  it('names the tools as the only surface and `gh` as the source of GitHub facts', () => {
    expect(LEADER_ROLE_INSTRUCTION).toContain('Use only these tools: never the cockpit UI and never its HTTP API.');
    expect(LEADER_ROLE_INSTRUCTION).toContain('Read GitHub facts (labels, review verdicts, merge state) with `gh`');
  });
});


/**
 * #450 (T-26): every leader-facing string xezar sends at runtime attaches through `leader_events`, never
 * through an HTTP route, and never sends the leader to the cockpit. Read from the runtime objects, not
 * from source text: the listing the bridge answers, the three `initialize` instruction variants, every
 * blocker and door refusal, the pushed text and the bridge's stop notice.
 */
describe('no leader-facing string names the HTTP attach route (#450, T-26)', () => {
  const FORBIDDEN = [/\/api\/v1\/(p\/[^/\s]+\/)?mcp\/leader/, /Use the cockpit/, /no MCP action attaches/];
  const clean = (label: string, value: string): void => {
    for (const pattern of FORBIDDEN) expect(value, `${label} matches ${pattern}`).not.toMatch(pattern);
  };
  const dirs: string[] = [];
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function instructions(clientName: string, grant?: Record<string, unknown>): Promise<string> {
    let path = '/nonexistent/xezar.sock';
    if (grant) {
      const dir = realpathSync(mkdtempSync('/tmp/xzlm-'));
      dirs.push(dir);
      path = join(dir, 's.sock');
      const server = createServer((socket) => {
        const framer = new LineFramer((line) => {
          const req = JSON.parse(line) as { v: number; id: number; method: string };
          if (req.method === 'session/open') socket.write(encodeFrame({ v: req.v, id: req.id, ok: true, result: grant }));
        }, () => {});
        socket.on('data', (c: Buffer) => framer.push(c));
      });
      servers.push(server);
      await new Promise<void>((r) => server.listen(path, r));
    }
    const input = new PassThrough();
    const output = new PassThrough();
    const answer = new Promise<string>((resolve) => {
      const framer = new LineFramer((line) => resolve(String((JSON.parse(line) as { result: { instructions: string } }).result.instructions)), () => {});
      output.on('data', (c: Buffer) => framer.push(c));
    });
    const done = runBridge({ input, output, version: 't', tools, resolveTarget: async () => ({ kind: 'socket', path, project: { id: 'leader', name: 'Leader' } }) });
    input.write(encodeFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: clientName } } }));
    const text = await answer;
    input.end();
    await done;
    return text;
  }

  it('the tools/list the bridge answers', () => {
    // RED against: re-adding the HTTP attach door to any tool description.
    clean('tools/list', JSON.stringify([HEALTH_TOOL, ...tools.map(toolListing)]));
    expect(JSON.stringify(tools.map(toolListing))).toContain('leader_events with action status');
  });

  it('every initialize instructions variant', async () => {
    // RED against: re-adding `ATTACH_DOOR` to the instructions.
    const variants = {
      other: await instructions('codex'),
      channel: await instructions('claude-code'),
      noPush: await instructions('claude-code', { owner: true, canPush: false, pushUnavailable: { code: 'hosted-mode', message: 'Hosted.' } }),
      older: await instructions('claude-code', { owner: true }),
    };
    for (const [label, text] of Object.entries(variants)) {
      clean(label, text);
      expect(text, label).toContain('never the cockpit UI and never the HTTP API');
    }
    expect(variants.other).toContain('Attach this session with `leader_events` action `attach`');
    expect(variants.channel).toContain('Attach this session with `leader_events` action `attach`');
  });

  it('every blocker and door refusal, the pushed text and the stop notice', async () => {
    const dataDir = realpathSync(mkdtempSync('/tmp/xzlm-'));
    dirs.push(dataDir);
    const journal = EventJournal.open({ dataDir, projectId: 'leader', secretValues: [], warn: () => {} });
    const texts: string[] = [];
    const collect = (value: unknown): void => void texts.push(JSON.stringify(value));
    const make = (over: Record<string, unknown> = {}) =>
      new LeaderDelivery({ projectId: 'leader', projectRoot: dataDir, journal, ownership: { projectId: 'leader', sessionToken: () => 'token', state: () => 'owned' }, guard: undefined, warn: () => {}, heartbeatMs: 60_000, ...over });
    try {
      const d = make();
      collect(d.status());
      for (const [key, transport] of [
        ['unknown', { clientName: 'x' }],
        ['opencode', { clientName: 'opencode' }],
        ['old', { clientName: 'claude-code' }],
        ['foreign', { clientName: 'opencode', leaderPush: true }],
        ['unregistered', { clientName: 'claude-code', leaderPush: true, channelAdvertised: false }],
        ['pi', { clientName: 'pi-mcp-xezar' }],
        ['codex', { clientName: 'codex-mcp-client' }],
      ] as const) {
        d.sessionOpened(key, { push: async () => {}, ...transport });
        collect(await d.attachSession(key));
        collect(await d.stopSession(key));
        collect(d.sessionStatus(key));
        collect(await d.act({ action: 'attach', client: 'claude-code' }));
      }
      collect(await d.attachSession('stale'));
      d.sessionOpened('owner', { push: async () => {}, clientName: 'claude-code', leaderPush: true });
      await d.act({ action: 'attach', client: 'opencode', baseUrl: 'http://127.0.0.1:1', sessionId: 'ses_closed0000000000000001' });
      collect(await d.attachSession('owner'));
      collect(await d.stopSession('owner'));
      d.close();
      collect(await d.attachSession('owner'));
      const hosted = make({ localHandoff: () => false });
      collect(await hosted.attachSession('k'));
      hosted.close();
      const dispatch = { projectId: 'leader', events: [], nextCursor: 'c', recovery: { required: 'current-state' as const, oldestSeq: 1, latestSeq: 2, message: 'gap' } };
      collect(renderChannelContent(dispatch, [], LEADER_ROLE_INSTRUCTION));
      collect(channelMeta(dispatch, []));
      collect(SERVICE_DISCONNECTED_NOTICE('leader'));
    } finally {
      journal.close();
    }
    const all = texts.join('\n');
    // Populated input: the codes this sweep must have reached, so an empty sweep cannot pass.
    for (const code of ['no-leader-session', 'client-unknown', 'client-needs-address', 'claude-code-bridge-too-old', 'not a Claude Code session', 'claude-code-channel-not-advertised', 'not-owner', 'leader-attached-elsewhere', 'leader-not-this-session', 'hosted-mode', 'delivery-unavailable', 'xezar stopped serving this project']) {
      expect(all).toContain(code);
    }
    clean('runtime texts', all);
  });
});
