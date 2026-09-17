#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DIST_CLI = join(REPO, 'packages/xezar/dist/index.js');
const TIMEOUT_MS = 60_000;
const TERMINAL = new Set(['done', 'failed', 'cancelled', 'review']);
const TASK_ENV_KEYS = ['XEZ_HANDOFF_FILE', 'XEZ_TODOS_FILE', 'XEZ_TASK_ID'];

export class HarnessBlockedError extends Error {}

export class ChildRegistry {
  constructor(stateFile) {
    this.stateFile = stateFile;
    this.children = new Map();
    this.descriptor = { children: [] };
  }

  spawn(name, command, args, options) {
    const child = spawn(command, args, options);
    if (!child.pid) throw new Error(`child ${name} started without a PID`);
    this.children.set(child.pid, child);
    this.descriptor.children.push({ name, pid: child.pid });
    this.persist();
    return child;
  }

  persist(extra = {}) {
    writeFileSync(this.stateFile, `${JSON.stringify({ ...this.descriptor, ...extra }, null, 2)}\n`, { mode: 0o600 });
  }

  assertOwned(child) {
    if (!child.pid || !this.children.has(child.pid) || !this.descriptor.children.some((entry) => entry.pid === child.pid)) {
      throw new Error('patternless-cleanup: child PID is not owned by the saved descriptor');
    }
  }

  async stopAll() {
    const stopped = [];
    for (const entry of [...this.descriptor.children].reverse()) {
      const child = this.children.get(entry.pid);
      if (!child) throw new Error(`saved PID ${entry.pid} (${entry.name}) has no owned child handle`);
      this.assertOwned(child);
      stopped.push({ ...entry, signal: await stopChild(child) });
    }
    return stopped;
  }
}

export async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return 'already-exited';
  child.kill('SIGTERM');
  if (await waitForExit(child, 3_000)) return 'SIGTERM';
  child.kill('SIGKILL');
  await waitForExit(child, 3_000);
  return 'SIGKILL';
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise((resolveExit) => child.once('exit', () => resolveExit(true))),
    delay(timeoutMs, false, { ref: false }),
  ]);
}

class LineRpc {
  constructor(name, registry, cwd, env, logs) {
    this.name = name;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.log = createWriteStream(join(logs, `${name}.ndjson`), { flags: 'a', mode: 0o600 });
    this.child = registry.spawn(name, process.execPath, [DIST_CLI, 'mcp'], {
      cwd,
      env: { ...env, PWD: cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (chunk) => this.push(chunk.toString('utf8')));
    this.child.stderr.on('data', (chunk) => this.writeLog('stderr', chunk.toString('utf8')));
    this.child.stdin.on('error', () => {});
    this.exited = new Promise((resolveExit) => this.child.once('exit', (code, signal) => {
      for (const settle of this.pending.values()) settle({ error: { code: -1, message: `bridge exited (${code ?? signal})` } });
      this.pending.clear();
      this.writeLog('exit', { code, signal });
      this.log.end();
      resolveExit({ code, signal });
    }));
  }

  writeLog(direction, value) {
    this.log.write(`${JSON.stringify({ at: new Date().toISOString(), direction, value })}\n`);
  }

  push(text) {
    this.buffer += text;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      this.writeLog('in', line);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && !message.method && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
      }
    }
  }

  send(message) {
    const line = JSON.stringify({ jsonrpc: '2.0', ...message });
    this.writeLog('out', line);
    this.child.stdin.write(`${line}\n`);
  }

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolveAnswer) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolveAnswer({ error: { code: -2, message: `no answer to ${method} within ${timeoutMs} ms` } });
      }, timeoutMs);
      this.pending.set(id, (answer) => {
        clearTimeout(timer);
        resolveAnswer(answer);
      });
      this.send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method, params) { this.send({ method, ...(params === undefined ? {} : { params }) }); }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    if (!(await Promise.race([this.exited.then(() => true), delay(3_000, false, { ref: false })]))) {
      await stopChild(this.child);
    }
  }
}

class SseCapture {
  constructor(response, logFile) {
    this.reader = response.body.getReader();
    this.decoder = new TextDecoder();
    this.text = '';
    this.logFile = logFile;
  }

  async until(predicate, label, timeoutMs = TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (predicate(this.text)) return this.text;
      const remaining = deadline - Date.now();
      const next = await Promise.race([this.reader.read(), delay(Math.max(1, remaining), { timeout: true })]);
      if (next?.timeout) break;
      if (next.done) break;
      this.text += this.decoder.decode(next.value, { stream: true });
      writeFileSync(this.logFile, this.text, { mode: 0o600 });
    }
    throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
  }

  async close() { await this.reader.cancel().catch(() => {}); }
}

// Parses every SSE `data: ...` payload out of raw captured text. A blind substring search over
// the whole stream (e.g. `text.includes('"project":"repo-a"')`) can pass for the wrong reason: a
// `usage` event also carries a `project` field, so it keeps matching even when the `run` event's
// OWN stamp is the thing that broke (observed against the `unstamped-b-event` break).
function sseDataObjects(text) {
  const objects = [];
  for (const match of text.matchAll(/^data: (.*)$/gm)) {
    try { objects.push(JSON.parse(match[1])); } catch { /* not every line is JSON (e.g. ping) */ }
  }
  return objects;
}

function isolatedEnv(scratch, xezarHome) {
  const env = { ...process.env };
  for (const key of TASK_ENV_KEYS) delete env[key];
  const agentRoot = join(scratch, 'agent-home');
  Object.assign(env, {
    HOME: join(agentRoot, 'home'),
    XEZ_HOME: xezarHome,
    XEZ_DRY_RUN: '1',
    XEZ_SKILLS_AUTO_UPDATE: '0',
    CLAUDE_CONFIG_DIR: join(agentRoot, 'claude'),
    CODEX_HOME: join(agentRoot, 'codex'),
    OPENCODE_CONFIG_DIR: join(agentRoot, 'opencode'),
    PI_CODING_AGENT_DIR: join(agentRoot, 'pi'),
  });
  return env;
}

function makeRepo(root, name) {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'README.md'), `# ${name}\n`);
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['add', '-A'],
    ['-c', 'user.name=Xezar Harness', '-c', 'user.email=harness@example.invalid', 'commit', '-q', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new HarnessBlockedError(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return realpathSync(repo);
}

// `computeProbe` in workspace/projects.ts caches a project root's status (ok/missing/not-git)
// for this long after each read. A status check performed sooner sees the stale verdict instead
// of a fresh `stat` — observed both ways: a registration-fresh `ok` survives a rename-away long
// enough to build the "missing" project (`ownProjectData`'s `mkdir -p` then recreates the removed
// folder, breaking the rename back), and a fresh `missing` survives a rename-back long enough to
// 409 a project that is present again. Callers wait this out around either edge.
const PROBE_TTL_MS = 5_000;
async function outlastProbeCache(sinceMs) {
  const elapsed = Date.now() - sinceMs;
  if (elapsed < PROBE_TTL_MS) await delay(PROBE_TTL_MS - elapsed + 250);
}

async function waitFor(label, probe, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    await delay(100);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
}

async function api(base, path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { origin: base, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = text;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, text, json };
}

async function openBridge(name, registry, cwd, env, logs) {
  const rpc = new LineRpc(name, registry, cwd, env, logs);
  const init = await rpc.request('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: `multi-project-${name}`, version: '0' },
  });
  if (!init.error) rpc.notify('notifications/initialized');
  return { rpc, init };
}

function toolText(answer) {
  if (answer.error) return JSON.stringify(answer.error);
  return (answer.result?.content ?? []).map((part) => part.text ?? '').join('\n');
}

function structured(answer) {
  if (answer.error) throw new Error(`MCP request failed: ${JSON.stringify(answer.error)}`);
  if (answer.result?.isError) throw new Error(`MCP tool failed: ${toolText(answer)}`);
  return answer.result?.structuredContent ?? JSON.parse(toolText(answer));
}

async function call(rpc, name, args = {}) {
  return rpc.request('tools/call', { name, arguments: args });
}

function runIdFrom(answer) {
  const body = structured(answer);
  return body.subject?.id ?? body.runId ?? body.id;
}

async function runState(base, projectId, runId) {
  const result = await api(base, `/api/v1/p/${projectId}/runs/${runId}`);
  if (result.status !== 200) return undefined;
  return result.json.status ?? result.json.run?.status;
}

function assertion(result, name, ok, observed) {
  result.assertions.push({ name, ok: Boolean(ok), observed });
  if (!ok) throw new Error(`${name}: ${JSON.stringify(observed)}`);
}

async function main(options = {}) {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'xez-multi-project-'));
  const logs = join(scratch, 'logs');
  const home = join(scratch, 'home');
  const stateFile = join(scratch, 'state.json');
  const resultFile = join(scratch, 'result.json');
  for (const dir of [logs, home, ...['home', 'claude', 'codex', 'opencode', 'pi'].map((name) => join(scratch, 'agent-home', name))]) mkdirSync(dir, { recursive: true });
  const registry = new ChildRegistry(stateFile);
  const result = {
    status: 'FAILED',
    revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(),
    artifactMtime: existsSync(DIST_CLI) ? statSync(DIST_CLI).mtime.toISOString() : null,
    scratch,
    env: { XEZ_HOME: '<scratch>/home', XEZ_DRY_RUN: '1', isolatedAgentHomes: true, taskEnvRemoved: TASK_ENV_KEYS },
    projects: {}, assertions: [], children: registry.descriptor.children, teardown: [],
  };
  let sse;
  let server;
  let bridgeA;
  let bridgeB;
  let successorA;
  const persistResult = () => writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  const terminate = async () => {
    await Promise.allSettled([sse?.close(), bridgeA?.rpc.close(), bridgeB?.rpc.close(), successorA?.rpc.close()].filter(Boolean));
    result.teardown = await registry.stopAll();
    persistResult();
  };
  const onSignal = () => { void terminate().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    if (!existsSync(DIST_CLI)) throw new HarnessBlockedError(`built CLI missing: ${DIST_CLI}; run npm run build:server first`);
    const repoA = makeRepo(scratch, 'repo-a');
    const repoB = makeRepo(scratch, 'repo-b');
    const env = isolatedEnv(scratch, home);
    const serverLog = createWriteStream(join(logs, 'server.log'), { flags: 'a', mode: 0o600 });
    server = registry.spawn('cockpit', process.execPath, [DIST_CLI, '--repo', repoA, '--port', '0', '--no-open'], {
      cwd: repoA, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverOutput = '';
    for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { serverOutput += chunk.toString('utf8'); serverLog.write(chunk); });
    const base = await waitFor('cockpit loopback port', () => {
      const port = /cockpit → http:\/\/localhost:(\d+)/.exec(serverOutput)?.[1];
      return port ? `http://127.0.0.1:${port}` : undefined;
    });
    await waitFor('cockpit health', async () => (await api(base, '/api/v1/health')).status === 200 || undefined);

    const bRegisteredAt = Date.now();
    const registered = await api(base, '/api/v1/projects', 'POST', { root: repoB });
    assertion(result, 'repo B registers through the product API', registered.status === 200, registered);
    const projects = await api(base, '/api/v1/projects');
    const entries = projects.json.projects;
    const a = entries.find((entry) => entry.root === repoA);
    const b = entries.find((entry) => entry.root === repoB);
    assertion(result, 'one isolated home contains exactly A and B', entries.length === 2 && a && b, entries);
    result.projects = { a: a.id, b: b.id };
    registry.persist({ base, projects: result.projects });

    const [legacy, byId, byDefault] = await Promise.all([
      api(base, '/api/v1/runs'), api(base, `/api/v1/p/${a.id}/runs`), api(base, '/api/v1/p/default/runs'),
    ]);
    assertion(result, 'boot aliases agree byte-for-byte', legacy.status === 200 && legacy.text === byId.text && legacy.text === byDefault.text, { legacy: legacy.status, byId: byId.status, byDefault: byDefault.status });
    assertion(result, 'unknown project is 404', (await api(base, '/api/v1/p/unknown-project/runs')).status === 404, 'unknown-project');
    // Missing-root must be checked BEFORE B's first build: a context, once built, is served from
    // the in-memory map and never re-probes disk (`ProjectContexts.context`), so this assertion
    // has to land before "B builds lazily" touches B for the first time or it would pass vacuously.
    await outlastProbeCache(bRegisteredAt);
    const absentB = `${repoB}.missing`;
    const renamedAwayAt = Date.now();
    renameSync(repoB, absentB);
    const missing = await api(base, `/api/v1/p/${b.id}/runs`);
    renameSync(absentB, repoB);
    assertion(result, 'registered missing B is 409 before first build', missing.status === 409, missing);
    await outlastProbeCache(renamedAwayAt);
    assertion(result, 'B builds lazily on its first scoped request', (await api(base, `/api/v1/p/${b.id}/runs`)).status === 200, b.id);

    bridgeA = await openBridge('bridge-a', registry, repoA, env, logs);
    bridgeB = await openBridge('bridge-b', registry, repoB, env, logs);
    assertion(result, 'A and B bridge sessions initialize independently', !bridgeA.init.error && !bridgeB.init.error, { a: bridgeA.init.error, b: bridgeB.init.error });

    const healthA = toolText(await call(bridgeA.rpc, 'health'));
    const discoverA = toolText(await call(bridgeA.rpc, 'discover_project'));
    // `leader_events status`/`read` answer session-attachment state, not project identity — their
    // text never names either project id — so only health/discover are evidence of binding.
    const statusA = await call(bridgeA.rpc, 'leader_events', { action: 'status' });
    const readA = await call(bridgeA.rpc, 'leader_events', { action: 'read' });
    assertion(result, 'A bridge resolves only its own project', [healthA, discoverA].every((text) => text.includes(a.id) && !text.includes(b.id)), { healthA, discoverA });
    assertion(result, "A bridge's own leader_events session answers", !statusA.error && !readA.error, { status: statusA.error, read: readA.error });

    // #557 (found by running this harness for real, not asserted away): a project registered into
    // a shared cockpit — rather than being the boot project — never gets its own MCP socket today.
    // `startMcpSocket` (index.ts) opens exactly one socket, gated on `bootProjectId` alone; nothing
    // subscribes an equivalent per-project socket to `contexts.onContextBuilt` the way the boot
    // socket's siblings (`providerRuntimeAuth.watch`, `watchSetupCompletion`) already do. B's
    // HTTP-scoped routes work correctly (proven above and below); its MCP bridge honestly reports
    // "not running" instead of being asserted into a false pass — a first draft of this harness did
    // exactly that with a substring check weak enough to accept the error text. This harness proves
    // MP-03/04's cross-project MCP independence for the BOOT project only, and proves cross-project
    // HTTP/index/SSE/limit composition (A+B) below; it does not claim more than that.
    const healthB = await call(bridgeB.rpc, 'health');
    assertion(
      result,
      'B bridge honestly reports no MCP socket for a non-boot project (#557), not a fabricated pass',
      Boolean(healthB.result?.isError) && toolText(healthB).includes(b.id) && /not running/i.test(toolText(healthB)),
      { healthB: toolText(healthB), knownLimitation: 'https://github.com/qodeca/xezar/issues/557' },
    );

    const thirdA = await openBridge('bridge-a-competing', registry, repoA, env, logs);
    assertion(result, "third A bridge is refused without affecting B's HTTP route", thirdA.init.error?.code === -32080 && (await api(base, `/api/v1/p/${b.id}/runs`)).status === 200, thirdA.init.error);
    await thirdA.rpc.close();
    await bridgeA.rpc.close();
    successorA = await waitFor('successor A ownership', async () => {
      const candidate = await openBridge(`bridge-a-successor-${Date.now()}`, registry, repoA, env, logs);
      if (!candidate.init.error) return candidate;
      await candidate.rpc.close();
      return undefined;
    });
    assertion(result, "successor A owns A while B's HTTP route remains usable", !successorA.init.error && (await api(base, `/api/v1/p/${b.id}/runs`)).status === 200 && bridgeA.rpc.child.exitCode !== null, { successor: successorA.init.error, oldAExit: bridgeA.rpc.child.exitCode });

    const streamResponse = await fetch(`${base}/api/v1/workspace/events`);
    if (!streamResponse.ok || !streamResponse.body) throw new Error(`workspace SSE failed: ${streamResponse.status}`);
    sse = new SseCapture(streamResponse, join(logs, 'workspace-events.log'));
    await sse.until((text) => text.includes('event: ping'), 'initial workspace SSE ping');
    const cap = await api(base, '/api/v1/workspace/config', 'PUT', { resources: { maxParallel: 1 } });
    assertion(result, 'workspace cap one is accepted', cap.status === 200, cap);
    // `mock:slow` alone never reaches a terminal state: the mock only appends the `XEZ:DONE`
    // marker when the turn's text also contains `mock:done` (scripts/mock-claude.mjs), and without
    // it autonomous mode keeps nudging for a completion that never comes. Both markers coexist in
    // one message on purpose, so the run holds ~25s (observable queueing) and then finishes.
    const slowA = runIdFrom(await call(successorA.rpc, 'task_create', { action: 'start', operationId: `mp-slow-${Date.now()}`, prompt: 'mock:slow mock:done cap holder', autonomous: true }));
    await waitFor('A slow run to start', async () => (await runState(base, a.id, slowA)) === 'running' || undefined);
    // B has no MCP session (#557), so its side of the cap-sharing smoke goes through the same
    // product HTTP door the cockpit's own composer uses, matching `task_create`'s own default
    // workflow (`quick-task`) and prompt-to-task mapping — not an invented shortcut.
    const quickBCreate = await api(base, `/api/v1/p/${b.id}/runs`, 'POST', { task: 'mock:done queued behind A', workflow: 'quick-task', autonomous: true });
    assertion(result, 'B run creates through the product HTTP door', quickBCreate.status === 201, quickBCreate);
    const quickB = quickBCreate.json.id;
    await waitFor('B run to queue', async () => (await runState(base, b.id, quickB)) === 'queued' || undefined);
    assertion(result, 'production cap wiring queues B behind A', true, { slowA, quickB });
    await waitFor('A then B to finish', async () => {
      const [aState, bState] = await Promise.all([runState(base, a.id, slowA), runState(base, b.id, quickB)]);
      return TERMINAL.has(aState) && TERMINAL.has(bState) ? { aState, bState } : undefined;
    });
    const eventText = await sse.until((text) => text.includes(`"id":"${slowA}"`) && text.includes(`"id":"${quickB}"`), 'stamped A and B run events');
    const runEvents = sseDataObjects(eventText).filter((obj) => obj?.id === slowA || obj?.id === quickB);
    const slowAEvent = runEvents.find((e) => e.id === slowA);
    const quickBEvent = runEvents.find((e) => e.id === quickB);
    assertion(result, 'workspace SSE stamps both projects', slowAEvent?.project === a.id && quickBEvent?.project === b.id, { slowAEvent, quickBEvent });
    const index = await api(base, '/api/v1/workspace/runs-index');
    const byRun = new Map(index.json.runs.map((run) => [run.id, run]));
    assertion(result, 'runs index attributes A and B rows', byRun.get(slowA)?.projectId === a.id && byRun.get(quickB)?.projectId === b.id, index.json.runs);
    assertion(result, 'each scoped run endpoint owns its run', (await api(base, `/api/v1/p/${a.id}/runs/${slowA}`)).status === 200 && (await api(base, `/api/v1/p/${b.id}/runs/${quickB}`)).status === 200, { slowA, quickB });
    assertion(result, 'task worktree registration is suppressed', (await api(base, '/api/v1/projects')).json.projects.length === 2, (await api(base, '/api/v1/projects')).json.projects);

    const inPlace = runIdFrom(await call(successorA.rpc, 'task_create', { action: 'start', operationId: `mp-inplace-${Date.now()}`, prompt: 'mock:done dry-run worktree-off guard', worktree: false, autonomous: true }));
    await waitFor('worktree-off dry run to finish', async () => TERMINAL.has(await runState(base, a.id, inPlace)) || undefined);
    assertion(result, 'dry-run worktree-off keeps A ownership', !((await call(successorA.rpc, 'health')).error), { inPlace, limitation: 'does not exercise an external client loading project MCP configuration (#342)' });

    const removed = await api(base, `/api/v1/projects/${b.id}`, 'DELETE');
    assertion(result, 'B removes after its runs settle', removed.status === 200, removed);
    const staleBRoute = await api(base, `/api/v1/p/${b.id}/runs`);
    assertion(result, "disposed B's scoped route is unknown while A survives", staleBRoute.status === 404 && !((await call(successorA.rpc, 'health')).error), staleBRoute);
    const readded = await api(base, '/api/v1/projects', 'POST', { root: repoB });
    assertion(result, 'B re-adds without duplicating the registry', readded.status === 200 && (await api(base, '/api/v1/projects')).json.projects.length === 2, readded);

    result.status = 'PASSED';
  } catch (error) {
    result.status = error instanceof HarnessBlockedError ? 'BLOCKED' : 'FAILED';
    result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try { await terminate(); } catch (error) {
      result.status = 'FAILED';
      result.teardownError = error instanceof Error ? error.stack ?? error.message : String(error);
      persistResult();
    }
  }
  console.log(`${result.status}: ${resultFile}`);
  if (result.status === 'PASSED' && options.clean) rmSync(scratch, { recursive: true, force: true });
  return { result, resultFile, scratch };
}

export async function runHarness(options = {}) { return main(options); }

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const clean = process.argv.slice(2).includes('--clean');
  const { result } = await main({ clean });
  process.exitCode = result.status === 'PASSED' ? 0 : result.status === 'BLOCKED' ? 2 : 1;
}
