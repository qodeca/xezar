/** POSIX-only built-CLI + authenticated streaming proxy verification (#547).
 * Run from the repository: npm run test:server-mode. No browser or public service.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const cli = join(root, 'packages/xezar/dist/index.js');
const started = performance.now();
let child, proxy, fixture, backend, authority;
let childExited = false;
const extraChildren = new Set();
const groups = new Set(); // process-group ids of every CLI spawned (each leads its own)
let fixtureRepo, fixtureEnv;
let forwarded = 0;
let lastForwardedHost;
let bootOutput = '';
const sockets = new Set();
const upstreams = new Set();
const auth = `Basic ${Buffer.from(`fixture:${randomBytes(24).toString('hex')}`).toString('base64')}`;
const proxyUser = 'fixture';
const abort = new AbortController();
const deadline = setTimeout(() => abort.abort(new Error('harness exceeded 45 seconds')), 45_000);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort(new Error(signal)));

async function until(predicate, message, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    abort.signal.throwIfAborted();
    assert.ok(Date.now() < end, message);
    await sleep(25);
  }
}

function request(path, { direct = false, authorization = auth, headers = {}, method = 'GET', body, stream = false, upgrade = false } = {}) {
  return new Promise((resolveRequest, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: direct ? backend : proxy.address().port,
      path, method, agent: false, signal: abort.signal, headers: {
        host: direct ? `127.0.0.1:${backend}` : authority,
        ...(authorization ? { authorization } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(upgrade ? { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
          'sec-websocket-key': randomBytes(16).toString('base64') } : {}), ...headers,
      } });
    const timer = setTimeout(() => req.destroy(new Error(`${path}: no complete response/frame within 3s`)), 3000);
    req.once('error', reject);
    req.once('close', () => clearTimeout(timer));
    req.once('upgrade', (_res, socket) => { socket.destroy(); resolveRequest({ status: 101, headers: {}, body: '' }); });
    req.once('response', (res) => {
      let data = '';
      res.on('error', reject);
      res.on('data', (chunk) => {
        data += chunk;
        if (stream && res.statusCode === 200 && /\r?\n\r?\n/.test(data)) {
          resolveRequest({ status: res.statusCode, headers: res.headers, body: data });
          res.destroy(); req.destroy();
        }
      });
      res.once('end', () => resolveRequest({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/**
 * Two DISTINCT ephemeral ports, with both probe listeners held open until both numbers are
 * known.
 *
 * Two sequential `freePort()` calls cannot promise that: each closes its listener before
 * returning, so the OS may hand the same ephemeral port out twice. A-PORT-01 distinguishes the
 * two precedence sources by comparing their numbers, so equal numbers would let a resolver that
 * wrongly lets XEZ_PORT outrank `--port` bind the expected port and pass vacuously. Overlapping
 * the two listeners makes the ports distinct by construction — a port that is bound cannot be
 * handed to the other probe — and the assertion below fails loudly rather than letting a
 * collision reach either CLI launch.
 */
async function twoDistinctFreePorts() {
  const probes = [http.createServer(), http.createServer()];
  try {
    await Promise.all(probes.map((probe) => new Promise((done) => probe.listen(0, '127.0.0.1', done))));
    const [first, second] = probes.map((probe) => probe.address().port);
    assert.notEqual(first, second, 'A-PORT-01 could not allocate two distinct ephemeral ports');
    return [first, second];
  } finally {
    await Promise.all(probes.map((probe) => new Promise((done) => probe.close(done))));
  }
}

/**
 * Every CLI this harness starts leads its OWN process group (`detached: true`), and nothing is
 * removed from the scratch directory until the kernel says that group is empty (#876).
 *
 * The CLI's exit is not the end of what it started. `serve` exits on SIGTERM without waiting
 * for its descendants: the background team-skills clone (unref'd by design, #249) keeps writing
 * into the scratch home, and the dry-run agent of a run keeps writing into the scratch repo
 * (`notes.md`, the handoff file) until it finishes its turn. Removing the directory while they
 * run is what failed with ENOTEMPTY after every case had passed. Those descendants inherit the
 * CLI's process group, so once the CLI's own `exit` event has fired, cleanup signals that exact
 * group and removes the directory only when `kill(-pgid, 0)` answers ESRCH: nothing the system
 * under test started can still write. That is a kernel answer, not an elapsed time; the bounds
 * below only turn a descendant that will not die into a named failure instead of a wait.
 */
function spawnCli(args, extraEnv = {}) {
  const proc = spawn(process.execPath, [cli, 'serve', '--repo', fixtureRepo, '--no-open', '--output', 'lines', '--color', 'never', ...args],
    { cwd: fixtureRepo, env: { ...fixtureEnv, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  proc.exited = new Promise((done) => proc.once('exit', done)); // attached at spawn, so an early exit is never missed
  if (proc.pid) groups.add(proc.pid); // a failed spawn has no pid and reports through 'error'
  return proc;
}
const hasExited = (proc) => proc.exitCode !== null || proc.signalCode !== null;
function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
/** Waits for a kernel fact; the bound only turns a leak into a named failure. */
async function waitFor(predicate, bound) {
  const end = Date.now() + bound;
  while (!predicate() && Date.now() < end) await sleep(25);
  return predicate();
}
/** SIGTERM the CLI itself (its own graceful shutdown is under test), then await its `exit` event. */
async function stopCli(proc) {
  if (hasExited(proc)) return false;
  proc.kill('SIGTERM'); // exact saved ChildProcess PID, never a process-name search
  if (await Promise.race([proc.exited.then(() => true), sleep(5000).then(() => false)])) return false;
  proc.kill('SIGKILL');
  await Promise.race([proc.exited, sleep(2000)]);
  return true;
}
/** End what the CLI left behind — its own process group, by exact id — and await an empty group. */
async function reapGroup(pgid) {
  if (!groupAlive(pgid)) return;
  process.kill(-pgid, 'SIGTERM'); // the exact group this harness created, never a process-name search
  if (await waitFor(() => !groupAlive(pgid), 5000)) return;
  process.kill(-pgid, 'SIGKILL');
  await waitFor(() => !groupAlive(pgid), 2000);
}

async function stopChild(proc) {
  await stopCli(proc);
  extraChildren.delete(proc);
  assert.ok(hasExited(proc), 'A-PORT-01 auxiliary CLI survived teardown');
  await reapGroup(proc.pid);
}

function deny(req, res) {
  if (req.headers.host !== authority) { res.writeHead(421); res.end(); return true; }
  if (req.headers.authorization !== auth) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="server-mode-fixture"' }); res.end(); return true;
  }
  return false;
}
function forward(req, res) {
  if (deny(req, res)) return;
  // Model a proxy that owns forwarding metadata. Never forward client credentials.
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) =>
    !key.startsWith('x-forwarded-') && !['forwarded', 'authorization', 'host'].includes(key)));
  headers.host = authority;
  headers['x-forwarded-host'] = authority;
  headers['x-forwarded-proto'] = 'http';
  // Like the bundled nginx (`proxy_set_header X-Xezar-User $remote_user`): the proxy OVERWRITES the
  // user header with the user it authenticated, so a client-sent value never reaches xezar (#306).
  headers['x-xezar-user'] = proxyUser;
  const upstream = http.request({ hostname: '127.0.0.1', port: backend, path: req.url,
    method: req.method, headers, agent: false });
  forwarded++;
  lastForwardedHost = upstream.getHeader('x-forwarded-host');
  upstreams.add(upstream);
  upstream.on('close', () => upstreams.delete(upstream));
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  upstream.on('response', (response) => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res); // deliberately no buffering
    res.on('close', () => { response.destroy(); upstream.destroy(); });
  });
  upstream.on('upgrade', (_response, socket) => { socket.destroy(); res.writeHead(101); res.end(); });
  req.pipe(upstream);
}

async function cleanup() {
  let forced = false;
  clearTimeout(deadline);
  for (const request of upstreams) request.destroy();
  for (const socket of sockets) socket.destroy();
  for (const proc of [...extraChildren]) {
    await stopCli(proc);
    extraChildren.delete(proc);
  }
  if (proxy?.listening) await new Promise((done) => proxy.close(done));
  if (child) forced = await stopCli(child);
  assert.ok(!child || childExited, 'BREAK-TEARDOWN-PID: backend survived cleanup');
  if (child?.pid) assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  assert.equal(proxy?.listening ?? false, false, 'proxy listener survived cleanup');
  // Only once no process the system under test started can still write into it (#876).
  for (const pgid of groups) await reapGroup(pgid);
  const survivors = [...groups].filter(groupAlive);
  assert.deepEqual(survivors, [], 'BREAK-TEARDOWN-TREE: a descendant of the CLI outlived teardown; the scratch directory is left in place');
  if (fixture) await rm(fixture, { recursive: true, force: true });
  assert.equal(forced, false, 'backend required SIGKILL; graceful teardown failed');
}

try {
  assert.notEqual(process.platform, 'win32', 'POSIX process teardown is required (0.16.0)');
  await access(cli); // missing build fails, never falls back to source
  await mkdir(join(root, '.local'), { recursive: true });
  fixture = await mkdtemp(join(root, '.local/server-mode-'));
  const env = { PATH: process.env.PATH, HOME: join(fixture, 'home'), CI: '1', NO_COLOR: '1',
    XEZ_HOME: join(fixture, 'xez-home'), XEZ_REMOTE: '1', XEZ_DRY_RUN: '1', XEZ_SKILLS_AUTO_UPDATE: '0',
    CLAUDE_CONFIG_DIR: join(fixture, 'claude'), CODEX_HOME: join(fixture, 'codex'),
    OPENCODE_CONFIG_DIR: join(fixture, 'opencode'), PI_CODING_AGENT_DIR: join(fixture, 'pi'),
    XDG_CONFIG_HOME: join(fixture, 'xdg-config'), XDG_CACHE_HOME: join(fixture, 'xdg-cache'),
    XDG_DATA_HOME: join(fixture, 'xdg-data'), TMPDIR: join(fixture, 'tmp'),
  };
  for (const [key, value] of Object.entries(env)) {
    if (key.includes('HOME') || key.endsWith('_DIR') || key === 'TMPDIR') await mkdir(value, { recursive: true });
  }
  const repo = join(fixture, 'repo');
  fixtureRepo = repo;
  fixtureEnv = env;
  await mkdir(repo);
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, env, stdio: 'ignore', timeout: 5000 });
  await writeFile(join(repo, '.gitignore'), '.local/\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: repo, env, timeout: 5000 });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd: repo, env, stdio: 'ignore', timeout: 5000 });

  // A-PORT-01: the guide's documented port precedence is a property of the built CLI, not
  // only of the helper that resolves it. A fresh XEZ_HOME has no saved project port, so
  // XEZ_PORT is the next layer; an explicit --port still outranks it. The two ports are
  // distinct by construction (see `twoDistinctFreePorts`), so a wrong precedence cannot
  // satisfy both assertions with one number.
  const [envPort, flagPort] = await twoDistinctFreePorts();
  const bootCliPort = async (args, extraEnv) => {
    const proc = spawnCli(args, extraEnv);
    extraChildren.add(proc);
    let output = '';
    let exited = false;
    proc.once('exit', () => { exited = true; });
    proc.once('error', (error) => abort.abort(error));
    for (const pipe of [proc.stdout, proc.stderr]) pipe.on('data', (chunk) => { output = (output + chunk).slice(-16_384); });
    await until(() => {
      assert.equal(exited, false, 'A-PORT-01 auxiliary CLI exited before reporting its bound URL');
      return Number(/http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(output)?.[1]) > 0;
    }, 'A-PORT-01 auxiliary CLI did not report its bound port');
    return { proc, port: Number(/http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(output)[1]) };
  };
  const flagged = await bootCliPort(['--port', String(flagPort)], { XEZ_PORT: String(envPort) });
  assert.equal(flagged.port, flagPort, 'A-PORT-01 an explicit --port must beat XEZ_PORT');
  await stopChild(flagged.proc);
  const envOnly = await bootCliPort([], { XEZ_PORT: String(envPort) });
  assert.equal(envOnly.port, envPort, 'A-PORT-01 XEZ_PORT must decide when no --port is given');
  await stopChild(envOnly.proc);
  console.log('PASS A-PORT-01 documented port precedence through the built CLI (--port beats XEZ_PORT)');

  child = spawnCli(['--port', '0', '--bind-host', '127.0.0.1']);
  child.once('exit', () => { childExited = true; });
  child.once('error', (error) => abort.abort(error));
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', (chunk) => { bootOutput = (bootOutput + chunk).slice(-16_384); });
  await until(() => {
    assert.equal(childExited, false, 'built CLI exited before reporting its bound URL');
    backend = Number(/http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(bootOutput)?.[1]);
    return backend > 0;
  }, 'built CLI did not report its OS-assigned port');
  proxy = http.createServer(forward);
  proxy.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('upgrade', (req, socket, head) => {
    const res = new http.ServerResponse(req);
    res.assignSocket(socket);
    res.on('finish', () => socket.end());
    if (head.length) { res.writeHead(400); res.end(); return; }
    forward(req, res);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  authority = `hosted.invalid:${proxy.address().port}`;

  for (const authorization of [null, 'Basic incorrect']) {
    for (const path of ['/api/v1/health', '/api/v1/workspace/events', '/api/v1/events', '/api/v1/ws']) {
      const before = forwarded;
      const response = await request(path, { authorization, upgrade: path.endsWith('/ws') });
      assert.equal(response.status, 401, `A-AUTH ${path}`);
      assert.match(response.headers['www-authenticate'], /^Basic /);
      assert.equal(forwarded, before, 'unauthenticated request reached backend');
    }
  }
  console.log('PASS A-AUTH HTTP/SSE/WS anonymous and wrong credentials');
  const health = JSON.parse((await request('/api/v1/health')).body);
  assert.equal(health.capabilities.localHandoff, false, 'A-MODE hosted capability');
  assert.equal(health.repoRoot, 'repo', 'A-DISCLOSE-01 root basename');
  for (const origin of [undefined, 'https://evil.invalid', `http://127.0.0.1:${backend}`, `http://${authority}`]) {
    assert.equal((await request('/api/v1/ws', { upgrade: true, headers: origin ? { origin } : {} })).status, 403, `A-WS Origin ${origin}`);
  }
  console.log('PASS A-WS-01..03 pre-handshake refusal');
  const beforeHost = forwarded;
  assert.equal((await request('/api/v1/runs', { headers: { host: 'evil.invalid' } })).status, 421, 'A-HOST-01');
  assert.equal(forwarded, beforeHost);
  assert.equal((await request('/api/v1/runs', { direct: true, headers: { host: 'evil.invalid' } })).status, 200, 'A-HOST-02 private backend is not authentication');
  assert.equal((await request('/api/v1/runs', { headers: { 'x-forwarded-host': 'evil.invalid' } })).status, 200);
  assert.equal(lastForwardedHost, authority, 'A-XFH-01 proxy must overwrite attacker authority');
  assert.equal((await request('/api/v1/runs', { direct: true, headers: { 'x-forwarded-host': 'evil.invalid' } })).status, 200, 'A-XFH-02');
  console.log('PASS A-HOST/A-XFH proxy and direct controls');
  const body = { task: 'fixture verification', worktree: false, steps: [{ id: 'work', prompt: '{{task}}' }] };
  const beforeRuns = (await request('/api/v1/runs')).body;
  assert.equal((await request('/api/v1/runs', { method: 'POST', authorization: null, headers: { origin: 'https://evil.invalid' }, body })).status, 401, 'A-CSRF-01');
  assert.equal((await request('/api/v1/runs', { method: 'POST', headers: { origin: 'https://evil.invalid', 'x-forwarded-host': 'evil.invalid' }, body })).status, 403, 'A-CSRF-02');
  assert.equal((await request('/api/v1/runs')).body, beforeRuns, 'forbidden mutation changed runs');
  const created = await request('/api/v1/runs', { method: 'POST', headers: { origin: `http://${authority}`, 'x-xezar-user': 'mallory' }, body });
  assert.equal(created.status, 201, 'A-CSRF-03 valid authenticated mutation');
  const run = JSON.parse(created.body);
  for (const authorization of [null, 'Basic incorrect']) {
    const before = forwarded;
    assert.equal((await request(`/api/v1/runs/${run.id}/events`, { authorization })).status, 401);
    assert.equal(forwarded, before);
  }
  const noOrigin = await request('/api/v1/runs', { method: 'POST', body });
  assert.equal(noOrigin.status, 201, 'A-CSRF-04 native authenticated mutation');
  console.log('PASS A-CSRF-01..04 state unchanged on rejection; positive controls create runs');
  for (const path of ['/api/v1/workspace/events', '/api/v1/events', `/api/v1/runs/${run.id}/events`]) {
    for (let reconnect = 0; reconnect < 2; reconnect++) {
      const frame = await request(path, { stream: true });
      assert.equal(frame.status, 200, `A-SSE ${path}`);
      assert.match(frame.headers['content-type'], /text\/event-stream/);
      assert.match(frame.headers['cache-control'], /no-transform/);
      assert.equal(frame.headers['x-accel-buffering'], 'no', 'A-SSE-02 buffering');
      assert.match(frame.body, /(?:event:|data:)/);
    }
  }
  await until(() => upstreams.size === 0, 'SSE requests survived client abort');
  console.log('PASS A-SSE-01..02 all stream families, authenticated reconnect and abort');
  for (const method of ['GET', 'OPTIONS']) {
    const response = await request('/api/v1/health', { method, headers: { origin: 'https://evil.invalid', cookie: 'fixture=1' } });
    assert.equal(response.status, method === 'GET' ? 200 : 204);
    assert.equal(response.headers['access-control-allow-origin'], '*', 'A-CORS-01');
    assert.notEqual(response.headers['access-control-allow-credentials'], 'true');
  }
  // Exhaustiveness belongs to local-handoff-routes.test.ts, not a second list here.
  assert.equal((await request(`/api/v1/runs/${run.id}/open-in-cli`, { method: 'POST' })).status, 409);
  assert.equal((await request('/api/v1/agent-config/claude.user.settings', { method: 'PUT', body: { content: '', version: null } })).status, 409);
  assert.equal((await request('/api/v1/workspace/agent-profiles', { method: 'POST', body: { provider: 'claude', configDir: join(fixture, 'account') } })).status, 409);
  assert.equal((await request('/api/v1/mcp/leader', { method: 'POST', body: { action: 'attach', client: 'codex' } })).status, 409);
  const accounts = JSON.parse((await request('/api/v1/workspace/agent-profiles')).body);
  assert.deepEqual(accounts.profiles, []);
  assert.equal((await request('/api/v1/agent-config/claude.user.settings')).status, 409);
  assert.equal((await request('/api/v1/agent-config/claude.project.settings')).status, 200);
  console.log('PASS A-CORS/A-LOCAL/A-DISCLOSE hosted surface');
  // #306 part 2: every cockpit-door record written through the proxy carries the proxy's user,
  // labelled asserted-by-proxy; the value the client forged is never stored.
  const auditRaw = await readFile(join(repo, '.local/xezar/audit.ndjson'), 'utf8');
  const audit = auditRaw.trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.origin === 'ui');
  assert.equal(audit.filter((record) => record.action === 'run.start' && record.outcome.status === 'applied').length, 2, 'A-AUDIT-01 both created runs recorded');
  assert.ok(audit.some((record) => record.outcome.status === 'refused'), 'A-AUDIT-01 a refused local-machine write is recorded');
  for (const record of audit) assert.deepEqual(record.actor, { type: 'ui', proxyUser: { value: proxyUser, trust: 'asserted-by-proxy' } }, 'A-AUDIT-02');
  assert.equal(auditRaw.includes('mallory'), false, 'A-AUDIT-03 a forged user header never reaches the trail');
  console.log('PASS A-AUDIT-01..03 proxy user asserted by the proxy, forgery overwritten');
} catch (error) {
  // Credentials and arbitrary child output are never diagnostics.
  console.error(`FAIL server-mode: ${error.message}`);
  process.exitCode = 1;
} finally {
  try { await cleanup(); } catch (error) { console.error(`FAIL cleanup: ${error.message}`); process.exitCode = 1; }
}
if (!process.exitCode) console.log(`PASS server-mode including exact-PID teardown (${Math.round(performance.now() - started)}ms)`);
