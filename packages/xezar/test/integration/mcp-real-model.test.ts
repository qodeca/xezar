import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
