import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { createConnection, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createAbWorld, PROJECT_A, XEZAR_VERSION } from '../helpers/ab-fixture.ts';
import { LeaderCursors, runStateReader } from '../../src/mcp/reconnect.ts';
import { leaderEventsTool, type LeaderEventsPort } from '../../src/mcp/tools/leader-events.ts';

/**
 * #373 / A-19 real-model clause. Manual node:test integration ONLY; neither fast test glob includes
 * this directory. After npm run build:server, run from packages/xezar:
 * TMPDIR=/tmp node --import ../../scripts/test-local-state.mjs --import tsx --test test/integration/mcp-real-model.test.ts
 *
 * Owner's manual command, like mcp-real-clients.test.ts: all three XEZ_REAL_MODEL_* variables
 * come only from the operator's environment. Missing any variable or a 401/403 auth probe
 * means node:test skip / NOT-RUN, never a model failure. Supply XEZ_REAL_MODEL_API_KEY. No personal account/config is read.
 * pi-runner delegates auth to pi's provider configuration (PI_CODING_AGENT_DIR/models.json);
 * it does not manufacture a key. In the shell already holding the provider's key, use
 * export XEZ_REAL_MODEL_API_KEY="$LOCAL_MODEL_API_KEY" (replace that variable with your authorized
 * provider-key variable). The proxy uses the key only in memory; pi receives a dummy fixture credential.
 * No key in command arguments, results, or transcripts. Adapter: npm:pi-mcp-adapter@2.32.1,
 * installed into a fresh HOME, as in mcp-real-clients. Only the three explicit env vars reach the
 * model proxy. A text assertion, a model request, a stale ack or a wrong cursor cannot pass.
 *
 * Evidence: .local/qa/mcp-real-model/<stamp>/{results.json,*.ndjson}, including exact argv,
 * revision + dirty state, model id, request counts, delivered page and service-side ack ledger.
 * A/B world supplies the real MCP socket/registry; a test-only context hook supplies leaderEvents
 * and observes ack inputs. Delivery uses the shipped pi extension's private socket, with no
 * xezar reaction adapter in the loop. The scripted text-only control must make exactly one
 * request and zero acks, then remain quiet for 45 seconds (longer than the existing harness heartbeat). The live verdict requires the exact nonce AND cursor
 * in a new service-side ack within 120 seconds. No browser coverage is claimed.
 */
const ROOT = resolve(import.meta.dirname, '../../../..');
const COMMAND = 'TMPDIR=/tmp node --import ../../scripts/test-local-state.mjs --import tsx --test test/integration/mcp-real-model.test.ts';
const STANDING = 'When a xezar event arrives, acknowledge it by calling the xezar leader_events tool with action ack, cursor equal to the delivered page nextCursor, and operationId equal to react-<nonce>, where <nonce> is the 12-character token after nonce= in the event. Do not invent a nonce, poll, or acknowledge before an event arrives. After the ack, stop.';
const WINDOW_MS = 120_000;
type Ack = { at: number; operationId?: unknown; cursor?: unknown };

function judge(acks: Ack[], before: Ack[], nonce: string, cursor: string, deliveredAt: number): 'waiting' | 'PASSED' | 'FAILED' {
  const operationId = `react-${nonce}`;
  if (before.some((ack) => ack.operationId === operationId)) return 'FAILED';
  const received = acks.filter((ack) => ack.at >= deliveredAt);
  if (received.some((ack) => ack.operationId !== operationId || ack.cursor !== cursor)) return 'FAILED';
  return received.some((ack) => ack.operationId === operationId && ack.cursor === cursor && ack.at - deliveredAt <= WINDOW_MS) ? 'PASSED' : 'waiting';
}

test('nonce judge rejects request-only, wrong nonce, wrong cursor, pre-delivery and late acknowledgements', () => {
  const good = { at: 101, operationId: 'react-123456abcdef', cursor: 'page' };
  assert.equal(judge([good], [], '123456abcdef', 'page', 100), 'PASSED');
  assert.equal(judge([], [], '123456abcdef', 'page', 100), 'waiting');
  assert.equal(judge([{ ...good, operationId: 'react-wrong' }], [], '123456abcdef', 'page', 100), 'FAILED');
  assert.equal(judge([{ ...good, cursor: 'wrong' }], [], '123456abcdef', 'page', 100), 'FAILED');
  assert.equal(judge([good], [good], '123456abcdef', 'page', 100), 'FAILED');
  assert.equal(judge([{ ...good, at: 99 }], [], '123456abcdef', 'page', 100), 'waiting');
  assert.equal(judge([{ ...good, at: 100 + WINDOW_MS + 1 }], [], '123456abcdef', 'page', 100), 'waiting');
});

// Positive control for the service-side observation hook, without pi or a model endpoint.
test('the real MCP service records a valid leader_events ack and advances its cursor', async () => {
  const acks: Ack[] = [];
  let port: LeaderEventsPort | undefined;
  const world = await createAbWorld({ toolContext(name, input, ctx) {
    const args = input as { action?: string; operationId?: unknown; cursor?: unknown };
    if (name === 'leader_events' && args.action === 'ack') acks.push({ at: Date.now(), operationId: args.operationId, cursor: args.cursor });
    return { ...ctx, leaderEvents: port };
  } });
  try {
    port = { journal: world.a.journal, cursors: LeaderCursors.open({ dataDir: world.a.dataDir, projectId: PROJECT_A, journal: world.a.journal }), readState: runStateReader(world.a.store, world.a.journal), secretValues: world.secrets };
    world.a.journal.append({ category: 'E-01', kind: 'task.terminal', subject: { type: 'run', id: world.a.ids.done, version: null }, origin: 'human', causedBy: null, summary: 'fixture positive control' });
    const page = await world.call('a', 'leader_events', { action: 'read' });
    assert.equal(page.isError, undefined);
    const cursor = (page.structuredContent as { nextCursor: string }).nextCursor;
    assert.ok(cursor);
    assert.equal(acks.length, 0);
    const result = await world.call('a', 'leader_events', { action: 'ack', cursor, operationId: 'react-123456abcdef' });
    assert.equal(result.isError, undefined);
    assert.equal(acks.length, 1);
    assert.equal(acks[0]?.operationId, 'react-123456abcdef');
    assert.equal(acks[0]?.cursor, cursor);
    assert.equal(port.cursors.position().ackedSeq, world.a.journal.latestSeq);
  } finally {
    await world.dispose();
  }
});

function recordedHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, name.toLowerCase() === 'authorization' ? '[REDACTED]' : value]));
}

function assertEvidenceClean(directory: string, key: string): void {
  assert.ok(key.length > 0, 'evidence scan needs a populated key');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) assertEvidenceClean(path, key);
    else assert.ok(!readFileSync(path).includes(Buffer.from(key)), `endpoint key leaked into evidence file ${entry.name}`);
  }
}

async function probeAuth(baseUrl: string, key: string): Promise<number> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  return response.status;
}

const authRejected = (status: number): boolean => status === 401 || status === 403;

test('auth probe distinguishes rejection from model evidence and redacts Authorization', async () => {
  const key = 'fixture-key-' + randomBytes(12).toString('hex');
  let status = 401;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    res.writeHead(status).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    for (const code of [401, 403, 200, 500]) {
      status = code;
      const actual = await probeAuth(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, key);
      assert.equal(actual, code);
      assert.equal(authRejected(actual), code === 401 || code === 403);
    }
    assert.deepEqual(recordedHeaders({ Authorization: `Bearer ${key}`, authorization: key, accept: 'application/json' }), { Authorization: '[REDACTED]', authorization: '[REDACTED]', accept: 'application/json' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('evidence hygiene fails on a planted key, including nested files', () => {
  const directory = mkdtempSync(join(ROOT, '.local/key-control-'));
  const key = 'fixture-key-' + randomBytes(12).toString('hex');
  try {
    mkdirSync(join(directory, 'nested'));
    writeFileSync(join(directory, 'nested', 'requests.json'), JSON.stringify(recordedHeaders({ Authorization: `Bearer ${key}` })));
    assertEvidenceClean(directory, key);
    writeFileSync(join(directory, 'nested', 'leak.txt'), key);
    assert.throws(() => assertEvidenceClean(directory, key), /endpoint key leaked/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

async function until(check: () => boolean, ms: number, reason: string): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < end, reason);
    await delay(50);
  }
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.end();
  await Promise.race([new Promise<void>((done) => child.once('exit', done)), delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.race([new Promise<void>((done) => child.once('exit', done)), delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

test('[pi] a real model acknowledges the delivered nonce and cursor', { timeout: 780_000 }, async (t) => {
  const baseUrl = process.env.XEZ_REAL_MODEL_BASE_URL;
  const modelId = process.env.XEZ_REAL_MODEL_ID;
  const key = process.env.XEZ_REAL_MODEL_API_KEY;
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const out = join(ROOT, '.local/qa/mcp-real-model', stamp);
  mkdirSync(out, { recursive: true });
  const redact = (text: string): string => key ? text.replaceAll(key, '[REDACTED]') : text;
  const save = (name: string, value: unknown): void => writeFileSync(join(out, name), redact(JSON.stringify(value, null, 2)) + '\n');
  const record: Record<string, unknown> = {
    case: 'A-19', client: 'pi', stamp, command: COMMAND, modelId: modelId ?? null,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '',
    invocation: { executable: process.execPath, args: [...process.execArgv, ...process.argv.slice(1)], cwd: process.cwd() },
    sourceHashes: Object.fromEntries(['packages/xezar/test/integration/mcp-real-model.test.ts', 'packages/xezar/test/helpers/ab-fixture.ts', 'packages/xezar/scripts/pi-leader-extension.ts'].map((path) => [path, createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex')])),
    windowMs: WINDOW_MS, verdict: 'NOT-RUN',
  };
  if (!baseUrl || !modelId || !key) {
    record.summary = 'Operator must supply XEZ_REAL_MODEL_BASE_URL, XEZ_REAL_MODEL_ID and XEZ_REAL_MODEL_API_KEY; leg skipped';
    save('results.json', record);
    if (key) assertEvidenceClean(out, key);
    t.skip(String(record.summary));
    return;
  }
  const target = new URL(baseUrl);
  assert.ok(['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname), 'only a local endpoint is authorized');
  assert.equal(target.username + target.password + target.search + target.hash, '', 'credentials belong only in the API-key environment variable');
  record.baseUrl = baseUrl;
  let probeStatus: number;
  try { probeStatus = await probeAuth(baseUrl, key); } catch (error) {
    record.verdict = 'BLOCKED';
    record.summary = 'Endpoint auth probe unavailable; no model verdict established';
    save('results.json', record);
    assertEvidenceClean(out, key);
    throw error;
  }
  record.authProbe = { status: probeStatus, headers: recordedHeaders({ Authorization: `Bearer ${key}` }) };
  if (authRejected(probeStatus)) {
    record.summary = `endpoint answered HTTP ${probeStatus}: authentication rejected; leg skipped`;
    save('results.json', record);
    assertEvidenceClean(out, key);
    t.skip(String(record.summary));
    return;
  }
  if (probeStatus !== 200) {
    record.verdict = 'BLOCKED';
    record.summary = `Auth probe answered HTTP ${probeStatus}; no model verdict established`;
    save('results.json', record);
    assertEvidenceClean(out, key);
    assert.fail(String(record.summary));
  }
  const scratch = realpathSync(mkdtempSync('/tmp/x373-'));
  const children: ChildProcess[] = [];
  const sockets: Socket[] = [];
  const ledger: Ack[] = [];
  let port: LeaderEventsPort | undefined;
  let world: Awaited<ReturnType<typeof createAbWorld>> | undefined;
  let mode: 'scripted' | 'real' = 'scripted';
  let modelReached = false;
  let rejectedStatus: number | undefined;
  const requests: { mode: string; at: number; body: unknown; headers: Record<string, string> }[] = [];
  const proxy = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) {
        raw += String(chunk);
        if (raw.length > 2_000_000) throw new Error('request exceeds fixture limit');
      }
      const body = JSON.parse(raw);
      requests.push({ mode, at: Date.now(), body, headers: recordedHeaders({ Authorization: mode === 'real' ? `Bearer ${key}` : 'fixture-no-secret' }) });
      if (mode === 'scripted') {
        // A text assertion is deliberately insufficient: one delivered event, one request, no ack.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'control', object: 'chat.completion.chunk', created: 1, model: modelId, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        res.end(chunk({ role: 'assistant', content: 'I reacted.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
      } else {
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: raw, signal: AbortSignal.timeout(WINDOW_MS), redirect: 'error',
        });
        if (authRejected(response.status)) rejectedStatus = response.status;
        else if (response.ok) modelReached = true;
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
        if (response.body) for await (const chunk of response.body) res.write(chunk);
        res.end();
      }
    } catch (error) {
      appendFileSync(join(out, 'proxy-errors.ndjson'), redact(JSON.stringify({ error: String(error) })) + '\n');
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
  try {
    assert.ok(existsSync(join(ROOT, 'packages/xezar/dist/index.js')), 'run npm run build:server first');
    record.piVersion = execFileSync('pi', ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: scratch, PI_CODING_AGENT_DIR: join(scratch, 'version-agent'), PI_OFFLINE: '1' }, timeout: 10_000 }).trim();
    world = await createAbWorld({ toolContext(name, input, ctx) {
      if (name === 'leader_events' && (input as { action?: string }).action === 'ack') {
        const args = input as { operationId?: unknown; cursor?: unknown };
        ledger.push({ at: Date.now(), operationId: args.operationId, cursor: args.cursor });
      }
      return { ...ctx, leaderEvents: port };
    } });
    // These seeded queue rows are read fixtures, not work for the queue watchdog to adopt.
    world.a.store.updateRun(world.a.ids.queued, { status: 'cancelled' });
    world.a.store.updateRun(world.a.ids.queued2, { status: 'cancelled' });
    world.a.store.flush();
    port = { journal: world.a.journal, cursors: LeaderCursors.open({ dataDir: world.a.dataDir, projectId: PROJECT_A, journal: world.a.journal }), readState: runStateReader(world.a.store, world.a.journal), secretValues: world.secrets };
    save('fixture.json', { kind: 'ab-world', adapter: 'pi-mcp-adapter@2.32.1', transport: 'pi leader extension socket' });
    writeFileSync(join(world.home, 'config.json'), JSON.stringify({ projects: [world.a, world.b].map((side) => ({ id: side.id, root: side.root, name: side.name, addedAt: '2026-09-13T00:00:00.000Z', lastOpenedAt: '' })) }));
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
    const proxyPort = (proxy.address() as { port: number }).port;
    for (const leg of ['scripted', 'real'] as const) {
      mode = leg;
      const home = join(scratch, leg);
      const agentDir = join(home, 'agent');
      const tmp = join(scratch, leg === 'real' ? 'r' : 's');
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(tmp, { recursive: true });
      const env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0', TERM: 'dumb', TMPDIR: tmp };
      const install = spawn('pi', ['install', 'npm:pi-mcp-adapter@2.32.1'], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(install);
      for (const stream of [install.stdout, install.stderr]) stream.on('data', (chunk) => appendFileSync(join(out, `${leg}-install.log`), redact(String(chunk))));
      await until(() => install.exitCode !== null || install.signalCode !== null, 120_000, 'adapter installation timed out');
      assert.equal(install.exitCode, 0, 'pinned adapter installation failed');
      writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${proxyPort}/v1`, api: 'openai-completions', apiKey: 'fixture-no-secret', models: [{ id: modelId, name: modelId, contextWindow: 128_000, maxTokens: 4096 }] } } }));
      writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ settings: { directTools: true }, mcpServers: { xezar: { command: process.execPath, args: [join(ROOT, 'packages/xezar/dist/index.js'), 'mcp'], env: { XEZ_HOME: world.home, XEZ_DRY_RUN: '1' }, lifecycle: 'keep-alive' } } }));
      const args = ['--mode', 'rpc', '--offline', '--no-session', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--model', `fixture/${modelId}`, '--append-system-prompt', STANDING, '--extension', join(ROOT, 'packages/xezar/scripts/pi-leader-extension.ts')];
      save(`${leg}-command.json`, { command: 'pi', args, cwd: world.a.root, install: ['pi', 'install', 'npm:pi-mcp-adapter@2.32.1'], environment: 'fresh HOME, PI_CODING_AGENT_DIR and private TMPDIR; no inherited provider credentials' });
      const child = spawn('pi', args, { cwd: world.a.root, env, stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child);
      let transcript = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
        const text = redact(String(chunk));
        transcript += text;
        appendFileSync(join(out, `${leg}-pi.ndjson`), text);
      });
      const descriptor = join(world.a.dataDir, 'pi-leader.json');
      await until(() => existsSync(descriptor) && /MCP: (?!connecting)/.test(transcript), 60_000, 'pi extension/MCP setup did not become ready');
      assert.match(transcript, /MCP:/);
      const link = createConnection(JSON.parse(readFileSync(descriptor, 'utf8')).endpoint.socket);
      sockets.push(link);
      await new Promise<void>((done, reject) => { link.once('connect', done); link.once('error', reject); });
      link.on('data', (chunk) => appendFileSync(join(out, `${leg}-extension.ndjson`), redact(String(chunk))));
      const countBefore = requests.filter((r) => r.mode === leg).length;
      assert.equal(countBefore, 0, 'pi must not ask the model before delivery');
      const nonce = randomBytes(6).toString('hex');
      world.a.store.updateRun(world.a.ids.done, { title: `Fixture task outcome nonce=${nonce}` });
      world.a.journal.append({ category: 'E-01', kind: 'task.terminal', subject: { type: 'run', id: world.a.ids.done, version: null }, origin: 'human', causedBy: null, summary: `Fixture task completed nonce=${nonce}` });
      const page = await leaderEventsTool.call({ action: 'read' }, { project: { id: PROJECT_A, name: world.a.name, root: world.a.root }, xezarVersion: XEZAR_VERSION, leaderEvents: port } as Parameters<typeof leaderEventsTool.call>[1]);
      const structured = page.structuredContent as { nextCursor: string };
      assert.ok(structured.nextCursor);
      const before = [...ledger];
      const deliveredAt = Date.now();
      save(`${leg}-delivery.json`, { nonce, deliveredAt, before, page });
      const content = page.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      link.write(JSON.stringify({ id: leg, type: 'prompt', message: `xezar leader_events delivery\n${content}` }) + '\n');
      assert.ok(!before.some((ack) => ack.operationId === `react-${nonce}`), 'nonce ack cannot predate delivery');
      if (leg === 'scripted') {
        await until(() => /agent_end/.test(transcript), 30_000, 'scripted turn did not settle');
        await delay(45_000);
        assert.equal(requests.filter((r) => r.mode === leg).length, 1, 'scripted control: exactly one request');
        const offered = requests.find((r) => r.mode === leg)?.body as { tools?: { function?: { name?: string } }[] };
        assert.ok(offered.tools?.some((tool) => tool.function?.name?.endsWith('leader_events')), 'populated-input control: pi must offer the real MCP ack tool to its model');
        assert.equal(ledger.length, before.length, 'text assertion must not count as ack');
        record.scriptedControl = { verdict: 'PASSED', requests: 1, acks: 0, quietWindowMs: 45_000 };
        // Fixture reset between independent clients; this is NOT a model/tool acknowledgement.
        port.cursors.ack(structured.nextCursor);
      } else {
        await until(() => rejectedStatus !== undefined || judge(ledger, before, nonce, structured.nextCursor, deliveredAt) !== 'waiting', WINDOW_MS, 'FAILED: no exact nonce/cursor ack within 120 seconds');
        if (rejectedStatus !== undefined) {
          record.verdict = 'NOT-RUN';
          record.summary = `endpoint answered HTTP ${rejectedStatus}: authentication rejected after probe; leg skipped`;
          t.skip(String(record.summary));
          return;
        }
        assert.equal(judge(ledger, before, nonce, structured.nextCursor, deliveredAt), 'PASSED', 'wrong nonce or cursor ack');
        await until(() => /agent_settled/.test(transcript), 30_000, 'real turn did not settle after ack');
        assert.equal(judge(ledger, before, nonce, structured.nextCursor, deliveredAt), 'PASSED', 'a later incorrect ack invalidates reaction');
        record.reaction = { nonce, cursor: structured.nextCursor, deliveredAt, before, ack: ledger.find((ack) => ack.operationId === `react-${nonce}`) };
        record.verdict = 'PASSED';
        record.summary = 'Real model called leader_events ack with the delivered nonce and exact nextCursor';
      }
      link.destroy();
      await stop(child);
      await until(() => !existsSync(descriptor), 5000, 'pi did not remove its descriptor');
    }
  } catch (error) {
    record.verdict = modelReached ? 'FAILED' : 'BLOCKED';
    record.summary = redact(String(error));
    throw error;
  } finally {
    for (const socket of sockets) socket.destroy();
    for (const child of children) await stop(child);
    proxy.closeAllConnections();
    await new Promise<void>((done) => proxy.close(() => done()));
    world?.a.store.flush();
    await world?.dispose();
    record.requestCounts = { scripted: requests.filter((r) => r.mode === 'scripted').length, real: requests.filter((r) => r.mode === 'real').length };
    save('requests.json', requests);
    save('ack-ledger.json', ledger);
    save('results.json', record);
    try {
      assertEvidenceClean(out, key);
    } catch (error) {
      record.verdict = 'FAILED';
      record.summary = 'Evidence hygiene failed: endpoint key found in an evidence file';
      save('results.json', record);
      throw error;
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    t.diagnostic(`evidence: ${out}; verdict: ${record.verdict}`);
  }
});

// ---- #67: the same real-model clause for Claude Code and Codex ------------------------------------
/**
 * The pi leg above hands the page to pi's extension socket itself. Claude Code and Codex have no such
 * socket: their delivery path is the product's own (`xezar serve` → LeaderDelivery → the Claude
 * Channels push or the Codex app-server turn), exactly as the scripted legs in mcp-real-clients.test.ts
 * drive it. So these legs reuse that world (real serve, real bridge, real client on a PTY) and replace
 * only the scripted endpoint with the client's own configured real model and account — the owner
 * authorized that paid usage for #67 on 2026-09-15. Opt in per client with
 * XEZ_REAL_MODEL_CLIENTS=claude-code,codex; without it both legs skip as NOT-RUN.
 *
 * The judge keeps the pi leg's rule — an exact nonce AND an exact cursor in a new ack within 120 s — with
 * the nonce moved to where a serve-delivered row can carry one: the run id the service mints for the
 * event's task (row summaries are fixed text). The pushed message carries no cursor, so the model must
 * read the page itself; the cursor it acks must be the nextCursor of a read, made after delivery, whose
 * page holds the event. Both halves are observed in the transport (a pass-through tee between the client
 * and the real bridge, test/helpers/mcp-stdio-tee.mjs) and confirmed in the service's own
 * leader-cursors.json. Model prose, a request, or an ack of anything else cannot pass.
 */
const SERVE_STANDING = 'You are a xezar project leader in a test. When a xezar event notification arrives: first call the xezar leader_events tool with action read; then call leader_events with action ack, cursor equal to the nextCursor that read returned, and operationId equal to react-<run id>, where <run id> is the full id of the run named in the task.done event. Do not use any other tool, do not poll, and do not acknowledge before an event arrives. After the ack, stop.';
const TEE = join(ROOT, 'packages/xezar/test/helpers/mcp-stdio-tee.mjs');
const DIST = join(ROOT, 'packages/xezar/dist/index.js');
const CLAUDE_PTY = join(ROOT, 'packages/xezar/test/helpers/claude-channel-pty.py');

type TeeFrame = { at: number; dir: 'client' | 'bridge'; line: string };
type ToolCall = { at: number; name?: string; args: Record<string, any>; answeredAt?: number; structured?: any; isError?: boolean };

function toolCalls(frames: readonly TeeFrame[]): ToolCall[] {
  const byId = new Map<string, ToolCall>();
  const calls: ToolCall[] = [];
  for (const frame of frames) {
    let message: any;
    try { message = JSON.parse(frame.line); } catch { continue; }
    if (frame.dir === 'client' && message.method === 'tools/call') {
      const call: ToolCall = { at: frame.at, name: message.params?.name, args: message.params?.arguments ?? {} };
      calls.push(call);
      byId.set(JSON.stringify(message.id), call);
    } else if (frame.dir === 'bridge' && message.id !== undefined && byId.has(JSON.stringify(message.id))) {
      const call = byId.get(JSON.stringify(message.id))!;
      call.answeredAt = frame.at;
      call.structured = message.result?.structuredContent;
      call.isError = message.error !== undefined || message.result?.isError === true;
    }
  }
  return calls;
}

function serveJudge(calls: readonly ToolCall[], runId: string, rowSeq: number, deliveredAt: number): { verdict: 'waiting' | 'PASSED' | 'FAILED'; reason: string } {
  const operationId = `react-${runId}`;
  const events = calls.filter((call) => call.name === 'leader_events' && !call.isError);
  const acks = events.filter((call) => call.args.action === 'ack' && call.args.operationId === operationId);
  if (acks.some((ack) => ack.at < deliveredAt)) return { verdict: 'FAILED', reason: 'the nonce ack predates delivery' };
  const cursors = new Set(events
    .filter((call) => call.args.action === 'read' && call.at >= deliveredAt && Array.isArray(call.structured?.events)
      && call.structured.events.some((row: any) => row?.subject?.id === runId && row?.journalSeq === rowSeq))
    .map((call) => call.structured.nextCursor));
  if (acks.some((ack) => ack.answeredAt !== undefined && !cursors.has(ack.args.cursor))) return { verdict: 'FAILED', reason: 'the nonce ack names a cursor no post-delivery read of the event returned' };
  const good = acks.find((ack) => cursors.has(ack.args.cursor) && ack.at - deliveredAt <= WINDOW_MS && (ack.structured?.ackedSeq ?? -1) >= rowSeq);
  return good ? { verdict: 'PASSED', reason: 'exact nonce and cursor acked through the event' } : { verdict: 'waiting', reason: 'no qualifying ack yet' };
}

test('serve judge rejects request-only, wrong nonce, wrong cursor, pre-delivery, unread-cursor and late acknowledgements', () => {
  const runId = '0f3c9a1e-5b7d-4c2a-9e8f-1a2b3c4d5e6f';
  const read = (at: number, cursor = 'c1', subject = runId): ToolCall => ({ at, name: 'leader_events', args: { action: 'read' }, answeredAt: at + 1, structured: { nextCursor: cursor, events: [{ subject: { id: subject }, journalSeq: 7 }] } });
  const ack = (at: number, extra: Record<string, any> = {}, ackedSeq = 7): ToolCall => ({ at, name: 'leader_events', args: { action: 'ack', cursor: 'c1', operationId: `react-${runId}`, ...extra }, answeredAt: at + 1, structured: { status: 'acked', ackedSeq } });
  assert.equal(serveJudge([read(110), ack(120)], runId, 7, 100).verdict, 'PASSED');
  assert.equal(serveJudge([], runId, 7, 100).verdict, 'waiting');
  assert.equal(serveJudge([read(110)], runId, 7, 100).verdict, 'waiting');
  assert.equal(serveJudge([read(110), ack(120, { operationId: 'react-someone-else' })], runId, 7, 100).verdict, 'waiting');
  assert.equal(serveJudge([read(110), ack(120, { cursor: 'forged' })], runId, 7, 100).verdict, 'FAILED');
  assert.equal(serveJudge([read(110, 'c1', 'other-run'), ack(120)], runId, 7, 100).verdict, 'FAILED');
  assert.equal(serveJudge([read(90), ack(95)], runId, 7, 100).verdict, 'FAILED');
  assert.equal(serveJudge([read(110), ack(100 + WINDOW_MS + 1)], runId, 7, 100).verdict, 'waiting');
  assert.equal(serveJudge([read(110), ack(120, {}, 6)], runId, 7, 100).verdict, 'waiting');
  assert.equal(serveJudge([read(110), { ...ack(120), isError: true }], runId, 7, 100).verdict, 'waiting');
});

test('the tee reconstructs tool calls with their answers from a frame log', () => {
  const frames: TeeFrame[] = [
    { at: 1, dir: 'client', line: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'leader_events', arguments: { action: 'read' } } }) },
    { at: 2, dir: 'bridge', line: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: 'x' } }) },
    { at: 3, dir: 'bridge', line: JSON.stringify({ jsonrpc: '2.0', id: 4, result: { structuredContent: { nextCursor: 'c' } } }) },
    { at: 4, dir: 'client', line: 'not json' },
  ];
  assert.deepEqual(toolCalls(frames), [{ at: 1, name: 'leader_events', args: { action: 'read' }, answeredAt: 3, structured: { nextCursor: 'c' }, isError: false }]);
});

const AGENT_VARS = /^(ANTHROPIC_|OPENAI_|CODEX_|CLAUDE|OPENCODE_|PI_|XDG_|XEZ_|GITHUB_TOKEN$|GH_TOKEN$|VITEST|NODE_OPTIONS$)/;
function clientEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!AGENT_VARS.test(name)) env[name] = value;
  return { ...env, TERM: 'xterm-256color', TMPDIR: '/tmp', ...extra };
}

async function waitFor<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await delay(250);
  }
}

function fixtureRepo(base: string): string {
  const root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'], ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture']]) execFileSync('git', args, { cwd: root });
  return realpathSync(root);
}

type Serve = { child: ChildProcess; base: string; projectId: string; log: string };
async function startServe(root: string, xezHome: string, codexHome: string, out: string, scratch: string): Promise<Serve> {
  const log = join(out, 'serve.log');
  const env = clientEnv({ XEZ_DRY_RUN: '1', XEZ_HOME: xezHome, XEZ_SKILLS_AUTO_UPDATE: '0', CLAUDE_CONFIG_DIR: join(scratch, 'serve-claude'), CODEX_HOME: codexHome, OPENCODE_CONFIG_DIR: join(scratch, 'serve-opencode') });
  const child = spawn(process.execPath, [DIST, '--repo', root, '--port', '0', '--no-open'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (chunk) => appendFileSync(log, chunk));
  const base = await waitFor('serve port', () => {
    const match = existsSync(log) ? /cockpit → http:\/\/localhost:(\d+)/.exec(readFileSync(log, 'utf8')) : null;
    return match ? `http://127.0.0.1:${match[1]}` : undefined;
  }, 60_000);
  await waitFor('serve health', async () => { try { return (await fetch(`${base}/api/v1/health`)).ok || undefined; } catch { return undefined; } }, 60_000);
  const projectId = ((await (await fetch(`${base}/api/v1/projects`)).json()) as { bootProject: string }).bootProject;
  await waitFor('serve MCP socket', () => (existsSync(join(xezHome, 'ipc', `${projectId}.sock`)) ? true : undefined), 15_000);
  return { child, base, projectId, log };
}

async function cockpitCall(serve: Serve, path: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${serve.base}${path}`, { method, headers: { origin: serve.base, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: text }; }
}

const journalRows = (root: string): any[] => {
  const file = join(root, '.local/xezar/mcp/event-journal.ndjson');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const teeFrames = (file: string): TeeFrame[] => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
const plainScreen = (text: string): string => text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, '');
// Account e-mail addresses in a client's banner are personal data, not evidence.
const scrub = (text: string): string => text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]');

function optedIn(client: string): boolean {
  return (process.env.XEZ_REAL_MODEL_CLIENTS ?? '').split(',').map((name) => name.trim()).includes(client);
}

/** The shared middle of both legs: cause one task.done row through the human's door, then judge. */
async function reactToOneEvent(opts: { serve: Serve; root: string; tee: string; record: Record<string, unknown>; deliveredWhen: (runId: string, frames: TeeFrame[]) => number | undefined }): Promise<void> {
  const { serve, root, tee, record } = opts;
  const created = await cockpitCall(serve, '/api/v1/runs', 'POST', { workflow: 'quick-task', task: 'mock:done a task whose completion is the event the leader must react to', worktree: false, autonomous: true });
  const runId: string | undefined = created.json?.id;
  const createdAt = Date.now();
  assert.ok(runId, `the run was not created: ${created.status}`);
  const row = await waitFor('the task.done journal row', () => journalRows(root).find((entry) => entry.subject?.id === runId && entry.kind === 'task.done'), 90_000);
  const deliveredAt = await waitFor('delivery of the event to the client', () => opts.deliveredWhen(runId, teeFrames(tee)), 90_000).catch(() => undefined);
  record.event = { runId, createdAt, eventId: row.eventId, journalSeq: row.journalSeq, deliveredAt: deliveredAt ?? null };
  if (deliveredAt === undefined) throw new Error('BLOCKED: the event was not observed reaching the client within 90 s');
  // Pre-delivery guard measured from run creation, the earliest moment the nonce existed anywhere.
  const judgeNow = () => serveJudge(toolCalls(teeFrames(tee)), runId, row.journalSeq, Math.min(createdAt, deliveredAt));
  const settled = await waitFor('a judged reaction', () => (judgeNow().verdict === 'waiting' ? undefined : judgeNow()), WINDOW_MS).catch(() => judgeNow());
  await delay(5_000); // a later wrong ack still invalidates the reaction
  const final = judgeNow();
  const cursorsFile = join(root, '.local/xezar/mcp/leader-cursors.json');
  const serviceState = existsSync(cursorsFile) ? JSON.parse(readFileSync(cursorsFile, 'utf8')) : null;
  const serviceAcked = serviceState?.ackedByLeader === false ? null : serviceState?.acked?.seq ?? null;
  record.toolCalls = toolCalls(teeFrames(tee)).filter((call) => call.at >= createdAt - 60_000);
  record.serviceCursors = serviceState;
  record.judge = { first: settled, final };
  if (final.verdict !== 'PASSED' || settled.verdict !== 'PASSED') throw new Error(`FAILED: ${final.reason}`);
  if (typeof serviceAcked !== 'number' || serviceAcked < row.journalSeq) throw new Error(`FAILED: the service's leader-cursors.json acked seq ${serviceAcked} does not cover #${row.journalSeq}`);
  record.verdict = 'PASSED';
  record.summary = 'Real model read the delivered event and called leader_events ack with the exact run-id nonce and the nextCursor of its own post-delivery read; the service cursor advanced';
}

function legRecord(client: string, stamp: string): Record<string, unknown> {
  return {
    case: 'A-19', client, stamp, windowMs: WINDOW_MS, verdict: 'NOT-RUN',
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '',
    invocation: { executable: process.execPath, args: [...process.execArgv, ...process.argv.slice(1)], env: { XEZ_REAL_MODEL_CLIENTS: process.env.XEZ_REAL_MODEL_CLIENTS ?? null } },
    sourceHashes: Object.fromEntries(['packages/xezar/test/integration/mcp-real-model.test.ts', 'packages/xezar/test/helpers/mcp-stdio-tee.mjs', 'packages/xezar/test/helpers/claude-channel-pty.py'].map((path) => [path, createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex')])),
  };
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise<void>((done) => child.once('exit', () => done())), delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

test('[claude-code] a real model acknowledges a Channels-delivered event with the exact nonce and cursor', { timeout: 900_000 }, async (t) => {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const record = legRecord('claude-code', stamp);
  if (!optedIn('claude-code')) return t.skip('XEZ_REAL_MODEL_CLIENTS does not name claude-code; leg NOT-RUN');
  const out = join(ROOT, '.local/qa/mcp-real-model', `${stamp}-claude-code`);
  mkdirSync(out, { recursive: true });
  const save = (name: string, value: unknown) => writeFileSync(join(out, name), scrub(JSON.stringify(value, null, 2)) + '\n');
  const scratch = realpathSync(mkdtempSync('/tmp/x67c-'));
  const model = process.env.XEZ_REAL_MODEL_CLAUDE_MODEL ?? 'sonnet';
  let serve: Serve | undefined;
  let child: ChildProcess | undefined;
  try {
    const bin = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
    const env = clientEnv({});
    record.client = { bin, version: execFileSync(bin, ['--version'], { encoding: 'utf8', env, timeout: 20_000 }).trim(), model, account: 'the owner\'s own Claude Code login (default config directory); no key handled by this harness' };
    const root = fixtureRepo(scratch);
    const xezHome = join(scratch, 'x');
    serve = await startServe(root, xezHome, join(scratch, 'serve-codex'), out, scratch);
    const tee = join(out, 'bridge-tee.ndjson');
    const mcpConfig = join(scratch, 'mcp.json');
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { xezar: { command: process.execPath, args: [TEE, tee, process.execPath, DIST, 'mcp'], env: { XEZ_HOME: xezHome, XEZ_DRY_RUN: '1' } } } }));
    const args = ['--model', model, '--strict-mcp-config', '--mcp-config', mcpConfig, '--allowedTools', 'mcp__xezar__leader_events', '--append-system-prompt', SERVE_STANDING, '--dangerously-load-development-channels', 'server:xezar'];
    save('command.json', { command: 'python3', args: [CLAUDE_PTY, bin, ...args.map((arg) => (arg === SERVE_STANDING ? '<SERVE_STANDING>' : arg))], standing: SERVE_STANDING, cwd: '<fixture project>' });
    child = spawn('python3', [CLAUDE_PTY, bin, ...args], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let screen = '';
    const answered = new Set<string>();
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (chunk: Buffer) => {
      appendFileSync(join(out, 'claude.pty.log'), scrub(chunk.toString('utf8')));
      screen += plainScreen(chunk.toString('utf8'));
      // The launch's own one-time screens, answered as the person would; nothing else is typed.
      // The trust screen's cursor starts on "No, exit", so the person moves down to "Yes" first.
      for (const [name, pattern, keys] of [['trust', /Yes,?\s*I\s*trust\s*this\s*folder/i, '\x1b[B'], ['channels', /I\s*am\s*using\s*this\s*for\s*local\s*development/, '']] as const) {
        if (!answered.has(name) && pattern.test(screen.slice(-4000))) {
          answered.add(name); screen = '';
          setTimeout(() => { if (keys) child?.stdin?.write(keys); setTimeout(() => child?.stdin?.write('\r'), 400); }, 700);
          appendFileSync(join(out, 'human-input.log'), `${Date.now()} ${name}: ${keys ? 'Down, ' : ''}Enter\n`);
        }
      }
    });
    await waitFor('Claude Code to own the project over MCP', async () => ((await cockpitCall(serve!, '/api/v1/mcp/leader')).json?.delivery ? true : undefined), 120_000);
    const attach = await cockpitCall(serve, '/api/v1/mcp/leader', 'POST', { action: 'attach', client: 'claude-code' });
    record.attach = { status: attach.status, leader: attach.json?.leader ?? attach.json?.error };
    assert.equal(attach.status, 200, 'attach claude-code');
    await delay(15_000);
    await reactToOneEvent({ serve, root, tee, record, deliveredWhen: (runId, frames) => frames.find((frame) => frame.dir === 'bridge' && frame.line.includes('notifications/claude/channel') && frame.line.includes(runId))?.at });
  } catch (error) {
    if (record.verdict !== 'PASSED') {
      const message = String(error instanceof Error ? error.message : error);
      record.verdict = message.startsWith('FAILED') ? 'FAILED' : 'BLOCKED';
      record.summary = message;
    }
    throw error;
  } finally {
    await stopChild(child);
    await stopChild(serve?.child);
    save('results.json', record);
    rmSync(scratch, { recursive: true, force: true });
    t.diagnostic(`evidence: ${out}; verdict: ${record.verdict}`);
  }
});

function codexInstall(): { bin: string; home: string; wrapper?: string } {
  // The owner's installed `codex` may be a wrapper that pins its own CODEX_HOME; that home IS the
  // configured profile (model, auth), so the leg uses it and runs the real binary behind the wrapper.
  const candidates = [...new Set(execFileSync('which', ['-a', 'codex'], { encoding: 'utf8' }).split('\n').filter(Boolean))];
  let home = join(process.env.HOME ?? '/', '.codex');
  let wrapper: string | undefined;
  for (const candidate of candidates) {
    const head = readFileSync(candidate).subarray(0, 4096).toString('utf8');
    const pinned = head.startsWith('#!') ? /CODEX_HOME=(\S+)/.exec(head) : null;
    if (pinned) { wrapper ??= candidate; home = pinned[1]!; continue; }
    return { bin: candidate, home, ...(wrapper ? { wrapper } : {}) };
  }
  throw new Error('BLOCKED: no codex binary behind the wrappers on PATH');
}

test('[codex] a real model acknowledges an app-server-delivered event with the exact nonce and cursor', { timeout: 900_000 }, async (t) => {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const record = legRecord('codex', stamp);
  if (!optedIn('codex')) return t.skip('XEZ_REAL_MODEL_CLIENTS does not name codex; leg NOT-RUN');
  const out = join(ROOT, '.local/qa/mcp-real-model', `${stamp}-codex`);
  mkdirSync(out, { recursive: true });
  const save = (name: string, value: unknown) => writeFileSync(join(out, name), scrub(JSON.stringify(value, null, 2)) + '\n');
  const scratch = realpathSync(mkdtempSync('/tmp/x67x-'));
  let serve: Serve | undefined;
  let appServer: ChildProcess | undefined;
  let tui: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  try {
    const install = codexInstall();
    const env = clientEnv({ CODEX_HOME: install.home });
    record.client = { bin: install.bin, wrapper: install.wrapper ?? null, home: install.home.replace(process.env.HOME ?? '\0', '~'), version: execFileSync(install.bin, ['--version'], { encoding: 'utf8', env, timeout: 20_000 }).trim(), account: 'the owner\'s own Codex login in that home; no credential read or copied by this harness' };
    const controlSocket = join(install.home, 'app-server-control', 'app-server-control.sock');
    if (existsSync(controlSocket)) throw new Error('BLOCKED: a Codex app-server is already listening in the owner\'s home; the leg will not share or replace it');
    const root = fixtureRepo(scratch);
    const xezHome = join(scratch, 'x');
    serve = await startServe(root, xezHome, install.home, out, scratch);
    const tee = join(out, 'bridge-tee.ndjson');
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(join(root, '.codex/config.toml'), `[mcp_servers.xezar]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([TEE, tee, process.execPath, DIST, 'mcp'])}\nenv = { XEZ_HOME = ${JSON.stringify(xezHome)}, XEZ_DRY_RUN = "1" }\n`);
    const overrides = ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '-c', 'check_for_update_on_startup=false'];
    const appLog = join(out, 'app-server.log');
    save('command.json', { appServer: [install.bin, ...overrides, 'app-server', '--listen', 'unix://'], tui: ['python3', '<claude-channel-pty.py>', install.bin, ...overrides, '--no-alt-screen', '-C', '<fixture project>', '<SERVE_STANDING + ready prompt>'], standing: SERVE_STANDING, codexHome: record.client && (record.client as any).home });
    appServer = spawn(install.bin, [...overrides, 'app-server', '--listen', 'unix://'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [appServer.stdout!, appServer.stderr!]) stream.on('data', (chunk) => appendFileSync(appLog, scrub(String(chunk))));
    await waitFor('the shared app-server control socket', () => (existsSync(controlSocket) ? true : undefined), 30_000);
    const prompt = `${SERVE_STANDING}\n\nNo event has arrived yet. Reply READY and do not call any tool now.`;
    tui = spawn('python3', [CLAUDE_PTY, install.bin, ...overrides, '--no-alt-screen', '-C', root, prompt], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let screen = '';
    const answered = new Set<string>();
    const terminal = tui;
    for (const stream of [terminal.stdout!, terminal.stderr!]) stream.on('data', (chunk: Buffer) => {
      const text = chunk.toString('latin1');
      appendFileSync(join(out, 'codex-tui.pty.log'), scrub(chunk.toString('utf8')));
      if (text.includes('\x1b[6n')) terminal.stdin!.write('\x1b[1;1R');
      if (text.includes('\x1b[c')) terminal.stdin!.write('\x1b[?1;2c');
      screen += plainScreen(text);
      if (!answered.has('trust') && /trust\s*(the\s*files\s*in\s*)?this\s*(folder|directory)|Do\s*you\s*trust/i.test(screen.slice(-4000))) {
        answered.add('trust'); screen = ''; setTimeout(() => terminal.stdin!.write('\r'), 700); appendFileSync(join(out, 'human-input.log'), `${Date.now()} trust: Enter\n`);
      }
    });
    // The person's side, as in the scripted Codex leg: find the TUI's thread and have Codex call a
    // xezar tool for it so the bridge announces the thread. No event is delivered this way.
    socket = await new Promise<WebSocket>((done, reject) => { const ws = new WebSocket(`ws+unix://${controlSocket}:/`, { perMessageDeflate: false }); ws.once('open', () => done(ws)); ws.once('error', reject); });
    let next = 1;
    const pending = new Map<number, (value: any) => void>();
    socket.on('message', (raw) => { appendFileSync(join(out, 'person-view.ndjson'), scrub(raw.toString()).slice(0, 4000) + '\n'); try { const message = JSON.parse(raw.toString()); if (typeof message.id === 'number' && !('method' in message)) { pending.get(message.id)?.(message); pending.delete(message.id); } } catch { /* not JSON */ } });
    const rpc = (method: string, params: unknown, ms = 60_000): Promise<any> => new Promise((done) => { const id = next++; const timer = setTimeout(() => { pending.delete(id); done({ error: { message: `no answer to ${method}` } }); }, ms); pending.set(id, (value) => { clearTimeout(timer); done(value); }); socket!.send(JSON.stringify({ id, method, params })); });
    await rpc('initialize', { clientInfo: { name: 'x67-codex-person', version: '0' } });
    const threadId = await waitFor('the TUI thread', async () => ((await rpc('thread/list', { cwd: root, modelProviders: [] })).result?.data ?? [])[0]?.id as string | undefined, 120_000);
    const configured = await rpc('config/read', { cwd: root });
    record.client = { ...(record.client as object), configuredModel: configured.result?.config?.model ?? null, configuredReasoningEffort: configured.result?.config?.model_reasoning_effort ?? null };
    await waitFor('the ready turn to finish', () => (/READY/.test(screen) ? true : undefined), 180_000).catch(() => undefined);
    await rpc('thread/name/set', { threadId, name: 'Xezar real-model fixture' });
    const call = await rpc('mcpServer/tool/call', { server: 'xezar', threadId, tool: 'task_read', arguments: { view: 'list', archived: 'include' } }, 120_000);
    record.announce = call.error ?? (call.result?.isError ? 'tool error' : 'answered');
    const leaderRoute = `/api/v1/p/${serve.projectId}/mcp/leader`;
    await waitFor('the owner to be Codex', async () => ((await cockpitCall(serve!, leaderRoute)).json?.owner?.client === 'codex' ? true : undefined), 60_000);
    const attach = await cockpitCall(serve, leaderRoute, 'POST', { action: 'attach', client: 'codex' });
    record.attach = { status: attach.status, leader: attach.json?.leader ?? attach.json?.error };
    assert.equal(attach.status, 200, 'attach codex');
    await waitFor('an unblocked Codex leader', async () => ((await cockpitCall(serve!, leaderRoute)).json?.blocker === null ? true : undefined), 60_000);
    await delay(10_000);
    const leaderBefore = (await cockpitCall(serve, leaderRoute)).json?.delivery?.deliveredSeq ?? 0;
    record.leaderBefore = leaderBefore;
    await reactToOneEvent({
      serve, root, tee, record,
      // Codex delivery happens inside app-server, not on the bridge; the service's own deliveredSeq
      // reaching the row is the delivery observation, polled here and stamped when first seen.
      deliveredWhen: (runId) => {
        const row = journalRows(root).find((entry) => entry.subject?.id === runId && entry.kind === 'task.done');
        if (!row) return undefined;
        const seen = (record as any).__delivered as number | undefined;
        if (seen) return seen;
        void cockpitCall(serve!, leaderRoute).then((status) => { if ((status.json?.delivery?.deliveredSeq ?? 0) >= row.journalSeq) (record as any).__delivered ??= Date.now(); });
        return undefined;
      },
    });
  } catch (error) {
    if (record.verdict !== 'PASSED') {
      const message = String(error instanceof Error ? error.message : error);
      record.verdict = message.startsWith('FAILED') ? 'FAILED' : 'BLOCKED';
      record.summary = message;
    }
    throw error;
  } finally {
    delete (record as any).__delivered;
    socket?.close();
    await stopChild(tui);
    await stopChild(appServer);
    await stopChild(serve?.child);
    save('results.json', record);
    rmSync(scratch, { recursive: true, force: true });
    t.diagnostic(`evidence: ${out}; verdict: ${record.verdict}`);
  }
});
