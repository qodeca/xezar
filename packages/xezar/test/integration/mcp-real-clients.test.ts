import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, closeSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  MCP_PROJECT_OCCUPIED_CODE,
  MCP_PROJECT_OCCUPIED_REASON,
  MCP_SESSION_EXPIRED_CODE,
  MCP_SESSION_EXPIRED_REASON,
} from '@qodeca/xezar-contract';

import { PROJECT_A, PROJECT_B, XEZAR_VERSION, createAbWorld, leaked, type AbWorld } from '../helpers/ab-fixture.ts';
import { ProjectOwnership } from '../../src/workspace/project-owner.ts';
import { runVersion } from '../../src/mcp/stale-write.ts';

/**
 * #118 — the OWNERSHIP, DELIVERY AND SETUP half of the whole-feature acceptance suite (requirements
 * § 9): A-01, A-17, A-18, A-19, A-20 (leader half) and A-23, with REAL MCP clients. The cockpit half
 * of A-20 is `packages/web/e2e/mcp-live-sync.e2e.ts`; the per-client results are recorded in
 * `docs/features/mcp-server/mcp-client-acceptance-record.md`.
 *
 * WHY THIS IS NOT IN ANY GATE. It spawns the real Claude Code, Codex and OpenCode CLIs installed on
 * the machine, a real `xezar serve` and real `xez mcp` bridge processes. `npm test` and
 * `npm run test:unit` are the fast gate — no server, no browser — so this file lives under
 * `test/integration/`, which neither of them includes (packages/xezar/vitest.config.ts includes
 * `src/**`, `test:unit` globs `test/unit/*`). § 9 asks for exactly this: "real MCP clients and agreed
 * transports need separate integration validation". Run it, after `npm run build`, from
 * `packages/xezar`:
 *
 *   TMPDIR=/tmp node --import ../../scripts/test-local-state.mjs --import tsx --test test/integration/mcp-real-clients.test.ts
 *
 * `TMPDIR=/tmp` keeps the fixture repositories outside the checkout, so a client that walks up from
 * its working directory never finds this repository's own `.mcp.json`, `opencode.json` or
 * `.codex/config.toml`. It is node:test on the installed, pinned `tsx`; no `npx` fetches anything.
 *
 * WHAT A RESULT MEANS. Every case records, per client, a verdict — PASSED, FAILED, BLOCKED or
 * NOT-RUN — with the checks behind it, the transcripts, the revision (`git rev-parse HEAD` and whether
 * the tree was dirty) and the fixture configuration, into `.local/qa/mcp-real-clients/<stamp>/`
 * (`results.json` plus one transcript file per process). A test FAILS when the product lacks a
 * required behaviour: the suite asserts what § 9 requires, never what the product happens to do.
 * BLOCKED means the requirement cannot be observed at all in a § 9 fixture (a real model reaction
 * needs a personal account, which § 9 forbids) or depends on a piece that does not exist; those
 * tests are reported as `todo` with the missing piece named, which node:test never counts as a pass.
 * A client that is not installed is NOT-RUN and its test is skipped — also never a pass.
 *
 * THE FIXTURE (§ 9 and the compatibility report's rules):
 *   - The shared A/B world (`test/helpers/ab-fixture.ts`, #115): two real git projects, A's real
 *     `RunManager`, the real MCP service loop (`listenMcpSocket`) on one Unix socket per project,
 *     `XEZ_DRY_RUN=1`, stubbed provider auth, no personal account, no secret. The world wires the
 *     registry tools to the in-process service — its documented non-production hop — so a real client
 *     reaching A's socket gets real answers. This harness adds the one thing a separate PROCESS needs
 *     to find those sockets: the workspace registry entry for A and B in the world's `XEZ_HOME`.
 *   - A real `xezar serve` (the built `dist/index.js`) over a third fixture repository, for the facts
 *     only the shipped product can answer: whether it writes the connection file, whether its MCP tools
 *     reach the service, whether its task lifecycle reaches an event journal, and what a restart does.
 *   - Each client runs with `HOME` and its own config directory pinned to a scratch folder, every
 *     `ANTHROPIC_*`, `OPENAI_*`, `CODEX_*`, `CLAUDE_*`, `OPENCODE_*` and `XDG_*` variable removed from
 *     its environment. A client binary that is a wrapper overriding that pin (this machine's `codex`
 *     on PATH is one — D-01 § 9.3) is refused, and the next real binary on PATH is used instead.
 *     Isolation is PROVEN, not assumed: Claude's `mcp add` must name a file inside the pinned folder,
 *     Codex's `initialize` must answer the pinned `codexHome`, or the client is NOT-RUN.
 *   - Any model turn goes to a SCRIPTED local Anthropic-Messages endpoint in this process — not a
 *     model, a stand-in with fixed rules ("CALL <tool>" → a tool call, a tool result → an ack). Claude
 *     Code runs with `--bare` (never reads OAuth or the keychain) and a dummy key string that is not a
 *     credential. Nothing here spends a real user's task permissions or account.
 *   - The one-time setup is D-04 § 3's, as the cockpit's MCP connection screen shows it, with one
 *     substitution recorded in every result: the command is this revision's built bridge
 *     (`node <repo>/packages/xezar/dist/index.js mcp`) rather than `npx -y @qodeca/xezar mcp`, which
 *     would fetch the PUBLISHED package, and each entry carries `XEZ_HOME` because the fixture service
 *     runs under an isolated home (a real user's entry needs neither).
 *
 * DECISIONS THIS SUITE TESTS AND DOES NOT MAKE. The occupied and expired errors are D-02 § 4's
 * (`-32080` / `-32081`, discriminated by `data.reason`); the connection file is D-04.1's
 * (`<root>/.local/xezar/mcp-connection.json`). No lease duration is asserted anywhere: the idle-owner
 * case waits past one renewal interval (D-02.5's 5 s) and makes no claim about the 30 s lease.
 */

// ---- where things are ----------------------------------------------------------------------

const REPO = resolve(import.meta.dirname, '../../../..');
const DIST_CLI = join(REPO, 'packages/xezar/dist/index.js');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, '.local/qa/mcp-real-clients', STAMP);
const T0 = Date.now();

type Verdict = 'PASSED' | 'FAILED' | 'BLOCKED' | 'NOT-RUN';
type ClientName = 'claude-code' | 'codex' | 'opencode' | 'pi';
const CLIENTS: readonly ClientName[] = ['claude-code', 'codex', 'opencode', 'pi'];
/** The three clients whose A-19 leg has no attach path at all; pi's is measured (#330 WP5). */
const CLIENTS_WITHOUT_ADAPTER: readonly ClientName[] = ['claude-code', 'codex', 'opencode'];

interface Check {
  name: string;
  required: string;
  observed: unknown;
  /** `true` met, `false` not met, `null` could not be observed in this fixture. */
  ok: boolean | null;
}

interface CaseRecord {
  case: string;
  client: string;
  verdict: Verdict;
  summary: string;
  missing?: string;
  checks: Check[];
  transcripts: string[];
  fixture: Record<string, unknown>;
}

const results: CaseRecord[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=h118@example.invalid', '-c', 'user.name=h118', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const REVISION = (() => {
  const sha = git(REPO, 'rev-parse', 'HEAD').trim();
  const dirty = git(REPO, 'status', '--porcelain', '--untracked-files=no').trim() !== '';
  return { sha, dirty };
})();

function record(entry: Omit<CaseRecord, 'transcripts'> & { transcripts?: string[] }): CaseRecord {
  const full: CaseRecord = { transcripts: [], ...entry };
  results.push(full);
  return full;
}

/** The verdict a set of checks earns: any unmet requirement fails; an unobservable one blocks. */
function verdictOf(checks: readonly Check[]): Verdict {
  if (checks.some((c) => c.ok === false)) return 'FAILED';
  if (checks.some((c) => c.ok === null)) return 'BLOCKED';
  return 'PASSED';
}

/** End a test the way its record says: FAILED fails, BLOCKED is a todo, NOT-RUN a skip. */
function settle(t: TestContext, entry: CaseRecord): void {
  const failed = entry.checks.filter((c) => c.ok === false).map((c) => `${c.name}: required ${c.required}; observed ${short(c.observed)}`);
  if (entry.verdict === 'FAILED') assert.fail(`${entry.case} ${entry.client} FAILED — ${entry.missing ?? entry.summary}\n  ${failed.join('\n  ')}`);
  if (entry.verdict === 'BLOCKED') {
    // A todo that THROWS: node:test reports it as ✖ # TODO and counts it neither as a pass nor as a
    // failure. A todo that returned would print ✔, which reads like a pass.
    t.todo(`${entry.case} ${entry.client} BLOCKED — ${entry.missing ?? entry.summary}`);
    throw new Error(`${entry.case} ${entry.client} BLOCKED — ${entry.missing ?? entry.summary}`);
  }
  if (entry.verdict === 'NOT-RUN') t.skip(`${entry.case} ${entry.client} NOT-RUN — ${entry.summary}`);
}

const short = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 400 ? `${text.slice(0, 400)}…` : text;
};

// ---- transcripts ---------------------------------------------------------------------------

class Transcript {
  readonly path: string;
  constructor(name: string) {
    mkdirSync(OUT, { recursive: true });
    this.path = join(OUT, `${name}.log`);
    writeFileSync(this.path, '');
  }
  line(direction: string, text: string): void {
    appendFileSync(this.path, `${String(Date.now() - T0).padStart(7)} ${direction} ${text.replace(/\n/g, '\\n')}\n`);
  }
  /** The file name relative to the results directory, as a record cites it. */
  get name(): string {
    return this.path.slice(OUT.length + 1);
  }
}

// ---- processes -----------------------------------------------------------------------------

const children = new Set<ChildProcess>();

/** Stop one child we started, by its own handle — never by pattern (#156). */
async function stop(child: ChildProcess | undefined, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    if (child) children.delete(child);
    return;
  }
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  child.kill(signal);
  const escalate = delay(5_000, undefined, { ref: false }).then(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    return exited;
  });
  await Promise.race([exited, escalate]);
  children.delete(child);
}

interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Run one CLI to completion (bounded), recording both streams. */
function runCli(bin: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv; transcript: Transcript; timeoutMs?: number }): Promise<CliRun> {
  const started = Date.now();
  opts.transcript.line('$', `${bin} ${args.join(' ')}   (cwd ${opts.cwd})`);
  return new Promise((done) => {
    // PWD follows cwd: a Bun-built client (OpenCode) reads $PWD, not the process cwd, to find its project.
    const child = spawn(bin, [...args], { cwd: opts.cwd, env: { ...opts.env, PWD: opts.cwd }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => void stop(child, 'SIGKILL'), opts.timeoutMs ?? 90_000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      for (const line of stdout.split('\n').filter(Boolean)) opts.transcript.line('out', line);
      for (const line of stderr.split('\n').filter(Boolean)) opts.transcript.line('err', line);
      opts.transcript.line('exit', `code=${code} signal=${signal} ms=${Date.now() - started}`);
      done({ code, signal, stdout, stderr, ms: Date.now() - started });
    });
  });
}

interface RpcAnswer {
  id?: number | string;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

/**
 * A newline-delimited JSON-RPC peer over a child's stdio: the real `xez mcp` bridge (`jsonrpc:
 * '2.0'`) or `codex app-server` (the header omitted, as its protocol does). Every line either way is
 * in the transcript.
 */
class LineRpc {
  readonly child: ChildProcess;
  readonly transcript: Transcript;
  readonly unsolicited: any[] = [];
  private readonly pending = new Map<number, (answer: RpcAnswer) => void>();
  private nextId = 1;
  private buffer = '';
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(
    bin: string,
    args: readonly string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; transcript: Transcript; jsonrpc: boolean },
  ) {
    this.transcript = opts.transcript;
    this.jsonrpc = opts.jsonrpc;
    opts.transcript.line('$', `${bin} ${args.join(' ')}   (cwd ${opts.cwd})`);
    this.child = spawn(bin, [...args], { cwd: opts.cwd, env: { ...opts.env, PWD: opts.cwd }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(this.child);
    this.child.stdout!.on('data', (chunk: Buffer) => this.push(chunk.toString('utf8')));
    this.child.stderr!.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) opts.transcript.line('err', line);
    });
    this.child.stdin!.on('error', () => {
      // A peer that died mid-write is reported by `exited`, not by an unhandled error.
    });
    this.exited = new Promise((done) =>
      this.child.on('exit', (code, signal) => {
        children.delete(this.child);
        opts.transcript.line('exit', `code=${code} signal=${signal}`);
        for (const settle of this.pending.values()) settle({ error: { code: -1, message: `process exited (${code ?? signal})` } });
        this.pending.clear();
        done({ code, signal });
      }),
    );
  }

  private readonly jsonrpc: boolean;

  private push(text: string): void {
    this.buffer += text;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      this.transcript.line('<-', line);
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.id === 'number' && this.pending.has(message.id) && !('method' in message)) {
        this.pending.get(message.id)!(message as RpcAnswer);
        this.pending.delete(message.id);
      } else {
        this.unsolicited.push(message);
      }
    }
  }

  private send(message: Record<string, unknown>): void {
    const line = JSON.stringify(this.jsonrpc ? { jsonrpc: '2.0', ...message } : message);
    this.transcript.line('->', line);
    this.child.stdin!.write(`${line}\n`);
  }

  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<RpcAnswer> {
    const id = this.nextId++;
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        done({ error: { code: -2, message: `no answer to ${method} within ${timeoutMs} ms` } });
      }, timeoutMs);
      this.pending.set(id, (answer) => {
        clearTimeout(timer);
        done(answer);
      });
      this.send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  get alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  async close(): Promise<void> {
    this.child.stdin!.end();
    const quit = await Promise.race([this.exited.then(() => true), delay(3_000, false, { ref: false })]);
    if (!quit) await stop(this.child);
  }
}

// ---- environment isolation -----------------------------------------------------------------

// `PI_` is here for the same reason every other vendor prefix is: `PI_CODING_AGENT_DIR` relocates
// pi's WHOLE per-user directory — settings, installed extensions, models.json and its `apiKey`, the
// session files (#329, re-verified against pi 0.85.1) — so an inherited one would point a pi this
// harness starts at the developer's own pi. `PI_OFFLINE` and `PI_TELEMETRY` are pinned per process.
const ISOLATED_PREFIXES = /^(ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_|OPENCODE_|PI_|XDG_|XEZ_|GITHUB_TOKEN$|GH_TOKEN$)/;

/** A child environment with every agent, vendor and xezar variable removed, then the pins added. */
function isolatedEnv(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!ISOLATED_PREFIXES.test(key)) env[key] = value;
  return { ...env, HOME: home, ...extra };
}

interface ResolvedClient {
  bin: string;
  version: string;
  /** Candidates on PATH that were refused, and why. */
  refused: string[];
}

/**
 * The first real binary for a client on PATH that does not override `isolationVar`. A shell
 * wrapper that assigns that variable would send the client to the user's real configuration.
 */
function resolveClient(name: string, isolationVar: string, versionArgs: string[]): ResolvedClient | { absent: string } {
  let candidates: string[];
  try {
    candidates = execFileSync('which', ['-a', name], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return { absent: `\`${name}\` is not on PATH` };
  }
  const refused: string[] = [];
  for (const candidate of [...new Set(candidates)]) {
    const head = Buffer.alloc(8192);
    const fd = openSync(candidate, 'r');
    const read = readSync(fd, head, 0, head.length, 0);
    closeSync(fd);
    const text = head.subarray(0, read).toString('utf8');
    if (text.startsWith('#!') && text.includes(`${isolationVar}=`)) {
      refused.push(`${candidate}: a wrapper script that assigns ${isolationVar}, which would defeat the fixture's isolation`);
      continue;
    }
    let version: string;
    try {
      version = execFileSync(candidate, versionArgs, { encoding: 'utf8', timeout: 20_000, env: isolatedEnv(process.env.HOME ?? '/', {}) }).trim().split('\n')[0] ?? '';
    } catch (err) {
      refused.push(`${candidate}: \`${versionArgs.join(' ')}\` failed (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
      continue;
    }
    return { bin: candidate, version, refused };
  }
  return { absent: `no usable \`${name}\` on PATH: ${refused.join('; ')}` };
}

// ---- the scripted model endpoint -----------------------------------------------------------

interface ModelRequest {
  n: number;
  client: string;
  /** The model id the request named. Unique per pi process, so one endpoint can count one pi (#330 WP5). */
  model: string;
  tools: string[];
  lastText: string;
  decision: string;
  isTitle: boolean;
}

/**
 * A scripted stand-in for the Anthropic Messages API, streaming and not — NOT a model. "CALL <name>"
 * in the pending user text becomes a tool call to the first offered tool whose name contains <name>,
 * with the fixed arguments below; a tool result becomes an acknowledgement quoting it. Every request
 * is logged.
 */
const TOOL_ARGUMENTS: Record<string, Record<string, unknown>> = {
  task_read: { view: 'list', archived: 'include' },
};

class ScriptedEndpoint {
  readonly requests: ModelRequest[] = [];
  private server: Server | undefined;
  port = 0;
  private readonly transcript = new Transcript('scripted-model-endpoint');

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      req.on('end', () => {
        try {
          this.answer(req.url ?? '', raw, String(req.headers['user-agent'] ?? ''), res);
        } catch (err) {
          // Never leave a client waiting on a request this stand-in could not script.
          this.transcript.line('fail', err instanceof Error ? err.message : String(err));
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'scripted endpoint failed' } }));
        }
      });
    });
    await new Promise<void>((done) => this.server!.listen(0, '127.0.0.1', () => done()));
    this.port = (this.server!.address() as { port: number }).port;
  }

  private answer(url: string, raw: string, agent: string, res: import('node:http').ServerResponse): void {
    // pi reaches a provider through `api: "openai-completions"` (its own `models.json` shape), so
    // this stand-in answers BOTH wires. Same rules, same `requests` log — "count the model's requests
    // at an endpoint you control" must have exactly one place to count.
    if (url.includes('/chat/completions')) return this.openaiCompletions(raw, res);
    if (url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    if (!url.includes('/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    let body: any = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      /* logged below as an empty request */
    }
    const textOf = (content: unknown): string =>
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'tool_result' ? `TOOL_RESULT: ${textOf(b.content)}` : '')).join('\n')
          : '';
    const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
    let i = messages.length;
    while (i > 0 && messages[i - 1]?.role !== 'assistant') i -= 1;
    const pending = messages.slice(i).map((m) => textOf(m.content)).join('\n');
    const system = Array.isArray(body.system) ? body.system.map((s: any) => s?.text ?? '').join('\n') : String(body.system ?? '');
    const tools: string[] = (body.tools ?? []).map((t: any) => String(t.name));
    const isTitle = tools.length === 0 && /title/i.test(system);
    let tool: { name: string; input: unknown } | undefined;
    let text: string;
    const toolResult = pending.indexOf('TOOL_RESULT: ');
    if (isTitle) text = 'scripted session';
    else if (toolResult >= 0) text = `SCRIPTED-ACK ${pending.slice(toolResult + 13, toolResult + 13 + 600)}`;
    else {
      // A bare word: OpenCode quotes the message it was given, so nothing after the name is parsed.
      const call = /CALL ([A-Za-z0-9_]+)/.exec(pending);
      const name = call ? tools.find((t) => t.includes(call[1]!)) : undefined;
      if (call && name) {
        tool = { name, input: TOOL_ARGUMENTS[call[1]!] ?? {} };
        text = '';
      } else text = call ? `SCRIPTED-NO-TOOL matching ${call[1]} among ${tools.length} tools` : `SCRIPTED-REPLY ${pending.slice(0, 200)}`;
    }
    const entry: ModelRequest = {
      n: this.requests.length + 1,
      client: /claude/i.test(agent) ? 'claude-code' : /opencode|ai-sdk/i.test(agent) ? 'opencode' : agent.slice(0, 40),
      model: String(body.model ?? ''),
      tools: tools.filter((t) => /xezar/.test(t)),
      lastText: pending.slice(0, 1_500),
      decision: tool ? `tool ${tool.name}` : `text ${text.slice(0, 120)}`,
      isTitle,
    };
    this.requests.push(entry);
    this.transcript.line('req', JSON.stringify(entry));
    const id = `msg_scripted_${entry.n}`;
    const stop = tool ? 'tool_use' : 'end_turn';
    const usage = { input_tokens: 1, output_tokens: 1 };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: tool ? [{ type: 'tool_use', id: `toolu_scripted_${entry.n}`, name: tool.name, input: tool.input }] : [{ type: 'text', text }],
          stop_reason: stop,
          stop_sequence: null,
          usage,
        }),
      );
      return;
    }
    const sse = (event: string, data: unknown): void => void res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
    if (tool) {
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_scripted_${entry.n}`, name: tool.name, input: {} } });
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } });
    } else {
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    }
    sse('content_block_stop', { type: 'content_block_stop', index: 0 });
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
    sse('message_stop', { type: 'message_stop' });
    res.end();
  }

  /**
   * The OpenAI chat-completions wire, for pi (#330 WP5). The scripting rules are the Anthropic
   * branch's, and deliberately so: a stand-in that behaved differently per client would make a
   * per-client verdict a fact about this file. Two differences are pi's, not choices:
   *   - a tool name is matched with `endsWith('_' + <name>)` too, because pi-mcp-adapter offers the
   *     bridge's tools as `xezar_<tool>` (its `directTools` mode) alongside pi's own `read`/`bash`;
   *   - the `system` message is left out of `lastText`, because pi's is ~4 kB of built-in tool
   *     documentation and would bury the text a check is looking for. Nothing decides on it.
   */
  private openaiCompletions(raw: string, res: import('node:http').ServerResponse): void {
    let body: any = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      /* logged below as an empty request */
    }
    const textOf = (content: unknown): string =>
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
          : '';
    const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
    let i = messages.length;
    while (i > 0 && messages[i - 1]?.role !== 'assistant') i -= 1;
    const pending = messages
      .slice(i)
      .filter((m) => m?.role !== 'system')
      .map((m) => (m?.role === 'tool' ? `TOOL_RESULT: ${textOf(m.content)}` : textOf(m.content)))
      .join('\n');
    const tools: string[] = (body.tools ?? []).map((t: any) => String(t?.function?.name ?? t?.name ?? '')).filter(Boolean);
    let tool: { name: string; input: unknown } | undefined;
    let text: string;
    const toolResult = pending.indexOf('TOOL_RESULT: ');
    if (toolResult >= 0) text = `SCRIPTED-ACK ${pending.slice(toolResult + 13, toolResult + 13 + 600)}`;
    else {
      const call = /CALL ([A-Za-z0-9_]+)/.exec(pending);
      const name = call ? tools.find((t) => t === call[1] || t.endsWith(`_${call[1]!}`)) : undefined;
      if (call && name) {
        tool = { name, input: TOOL_ARGUMENTS[call[1]!] ?? {} };
        text = '';
      } else text = call ? `SCRIPTED-NO-TOOL matching ${call[1]} among ${tools.length} tools` : `SCRIPTED-REPLY ${pending.slice(0, 200)}`;
    }
    const entry: ModelRequest = {
      n: this.requests.length + 1,
      client: 'pi',
      model: String(body.model ?? ''),
      tools: tools.filter((t) => /xezar/.test(t)),
      // Wider than the Anthropic branch's 1 500: the pi dispatch text carries the role instruction
      // and every row, and a check that looked for a row id must not lose it to a slice.
      lastText: pending.slice(0, 8_000),
      decision: tool ? `tool ${tool.name}` : `text ${text.slice(0, 120)}`,
      isTitle: false,
    };
    this.requests.push(entry);
    this.transcript.line('req', JSON.stringify(entry));
    const id = `chatcmpl_scripted_${entry.n}`;
    const created = Math.floor(Date.now() / 1_000);
    const model = body.model ?? 'scripted-model';
    const finish = tool ? 'tool_calls' : 'stop';
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    const callId = `call_scripted_${entry.n}`;
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [
            {
              index: 0,
              message: tool
                ? { role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] }
                : { role: 'assistant', content: text },
              finish_reason: finish,
            },
          ],
          usage,
        }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (choices: unknown[], extra: Record<string, unknown> = {}): void =>
      void res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices, ...extra })}\n\n`);
    chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
    if (tool) {
      chunk([{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] }, finish_reason: null }]);
    } else {
      chunk([{ index: 0, delta: { content: text }, finish_reason: null }]);
    }
    chunk([{ index: 0, delta: {}, finish_reason: finish }]);
    chunk([], { usage });
    res.write('data: [DONE]\n\n');
    res.end();
  }

  /** Tool results the endpoint received since request `from` (1-based count), as text. */
  toolResultsSince(from: number): string[] {
    return this.requests
      .slice(from)
      .map((r) => r.lastText)
      .filter((text) => text.includes('TOOL_RESULT: '))
      .map((text) => text.slice(text.indexOf('TOOL_RESULT: ') + 13));
  }

  close(): void {
    this.server?.close();
  }
}

// ---- the fixture ---------------------------------------------------------------------------

const freePort = (): Promise<number> =>
  new Promise((done, fail) => {
    const probe = createNetServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => done(port));
    });
  });

async function waitFor<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await delay(100);
  }
}

/** A committed fixture repository whose `git status` starts clean. */
function makeRepo(base: string, name: string): string {
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'README.md'), `# ${name}\n`, 'utf8');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return realpathSync(root);
}

/** A real `xezar serve` process over its own repository and home — the shipped product. */
interface ServeHandle {
  child: ChildProcess;
  base: string;
  projectId: string;
  socket: string;
  root: string;
  home: string;
  transcript: Transcript;
}

async function startServe(root: string, home: string, name: string, agentHome: string): Promise<ServeHandle> {
  const port = await freePort();
  const transcript = new Transcript(name);
  const env = isolatedEnv(process.env.HOME ?? '/', {
    XEZ_DRY_RUN: '1',
    XEZ_HOME: home,
    XEZ_SKILLS_AUTO_UPDATE: '0',
    CLAUDE_CONFIG_DIR: join(agentHome, 'claude'),
    CODEX_HOME: join(agentHome, 'codex'),
    OPENCODE_CONFIG_DIR: join(agentHome, 'opencode'),
  });
  for (const dir of ['claude', 'codex', 'opencode']) mkdirSync(join(agentHome, dir), { recursive: true });
  transcript.line('$', `node ${DIST_CLI} --repo ${root} --port ${port} --no-open`);
  const child = spawn(process.execPath, [DIST_CLI, '--repo', root, '--port', String(port), '--no-open'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  for (const stream of [child.stdout!, child.stderr!]) {
    stream.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) transcript.line('log', line);
    });
  }
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${name} health`, async () => {
    try {
      return (await fetch(`${base}/api/v1/health`)).ok || undefined;
    } catch {
      return undefined;
    }
  }, 60_000);
  const projectId = ((await (await fetch(`${base}/api/v1/projects`)).json()) as { bootProject: string }).bootProject;
  const socket = join(home, 'ipc', `${projectId}.sock`);
  await waitFor(`${name} MCP socket`, () => (existsSync(socket) ? true : undefined), 15_000).catch(() => undefined);
  return { child, base, projectId, socket, root, home, transcript };
}

interface JournalRow {
  eventId: string;
  journalSeq: number;
  category: string;
  kind: string;
  origin: string;
  causedBy: string | null;
  subject: { type: string; id: string };
  summary: string;
}

/** A project's event journal as the running service wrote it (`<dataDir>/mcp/event-journal.ndjson`). */
function readJournal(root: string): JournalRow[] | undefined {
  const file = join(root, '.local/xezar/mcp/event-journal.ndjson');
  if (!existsSync(file)) return undefined;
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as JournalRow);
}

/** A run's status through the cockpit, whichever envelope the route answers with. */
async function runStatus(serve: ServeHandle, runId: string | undefined): Promise<string | undefined> {
  if (!runId) return undefined;
  const run = await cockpit(serve, `/api/v1/runs/${runId}`);
  return run.json?.status ?? run.json?.run?.status;
}

/** A same-origin cockpit request to a real serve — the human's door. */
async function cockpit(serve: ServeHandle, path: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${serve.base}${path}`, {
    method,
    headers: { origin: serve.base, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* kept as text */
  }
  return { status: res.status, json };
}

interface Fixture {
  world: AbWorld;
  scratch: string;
  endpoint: ScriptedEndpoint;
  clients: Partial<Record<ClientName, ResolvedClient>>;
  absent: Partial<Record<ClientName, string>>;
  /** Every result the A-01 legs produced, reused by A-23. */
  setup: Partial<Record<ClientName, CaseRecord>>;
  /** Every A-17 second-client observation, reused by A-23. */
  competing: Partial<Record<ClientName, Check>>;
  reaction: Partial<Record<ClientName, CaseRecord>>;
  /** pi's one-time extension install, or why there is none (#330 WP5). */
  piInstall?: PiAdapterInstall;
  piInstallFailure?: string;
  /** The one real serve + real pi world the A-18, A-19 and A-20 pi cases share. */
  piWorld?: PiWorld;
}

let fx: Fixture;

const bridgeEnv = (world: AbWorld, home: string): NodeJS.ProcessEnv => isolatedEnv(home, { XEZ_HOME: world.home, XEZ_DRY_RUN: '1' });

/** A real `xez mcp` bridge process spawned in `root`, the way a client spawns it. */
async function openBridge(name: string, root: string, env: NodeJS.ProcessEnv): Promise<{ rpc: LineRpc; init: RpcAnswer }> {
  const rpc = new LineRpc(process.execPath, [DIST_CLI, 'mcp'], { cwd: root, env, transcript: new Transcript(name), jsonrpc: true });
  const init = await rpc.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: `h118-${name}`, version: '0' } });
  if (!init.error) rpc.notify('notifications/initialized');
  return { rpc, init };
}

/**
 * Wait until nobody owns a project, and say how long that took.
 *
 * The A-01 client legs run one after another against the SAME project A, and until #302 that needed
 * no thought: nothing enforced ownership, so a leg never met the previous leg's leftovers. It does
 * now. The client legs spawn a bridge xezar does not own — `claude -p` spawns one for its turn, the
 * adapter spawns one for pi — and that bridge exits a moment AFTER the command we awaited returned,
 * so the next leg's handshake met `-32080` and failed a client that is perfectly fine. It is the
 * first thing this file met of § Changing a mechanism that already works: the new mechanism is right
 * and the old scenario quietly lost an assumption nobody had written down.
 *
 * The wait is bounded and its result is a FACT the caller records, never a silent sleep: D-02 § 4
 * says the project "becomes available when that client disconnects", so how long that takes is
 * exactly the kind of thing this harness exists to measure. A probe that times out is reported as
 * still-occupied and the leg fails on it.
 *
 * The probe itself takes the slot for an instant, which is why it is released with an AWAITED
 * `close()` — that resolves on the bridge process's own exit, so by the time this returns the slot is
 * really free and the only next connection is the caller's.
 */
async function waitForProjectFree(label: string, root: string, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<{ freeAfterMs: number; occupied: boolean }> {
  const started = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    const probe = await openBridge(`${label}-free-probe-${attempt}`, root, env);
    const occupied = isOccupied(probe.init);
    await probe.rpc.close();
    if (!occupied) return { freeAfterMs: Date.now() - started, occupied: false };
    if (Date.now() - started > timeoutMs) return { freeAfterMs: Date.now() - started, occupied: true };
    await delay(500);
  }
}

const toolText = (answer: RpcAnswer): string =>
  answer.error ? `JSON-RPC error ${answer.error.code}: ${answer.error.message}` : ((answer.result?.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');

/** The `version` a task read carries: a leader reads a task before it changes it (#250). */
const versionIn = (answer: RpcAnswer): string | undefined => {
  try {
    return JSON.parse(toolText(answer)).version;
  } catch {
    return undefined;
  }
};

/** D-02 § 4's occupied error, by its authoritative discriminator. */
const isOccupied = (answer: RpcAnswer | undefined): boolean =>
  answer?.error?.code === MCP_PROJECT_OCCUPIED_CODE && answer.error.data?.reason === MCP_PROJECT_OCCUPIED_REASON;
const isExpired = (answer: RpcAnswer | undefined): boolean =>
  answer?.error?.code === MCP_SESSION_EXPIRED_CODE && answer.error.data?.reason === MCP_SESSION_EXPIRED_REASON;

// ---- pi (#330 WP5) -------------------------------------------------------------------------

/**
 * pi is the fourth required client and the only one that is not an MCP client by itself: pi 0.85.1's
 * own README says "**No MCP**", and the capability comes from the third-party `pi-mcp-adapter`
 * extension (#330). So its leg has one step the other three do not — install that extension — and
 * two pins instead of one, because pi reads its whole per-user directory from
 * `PI_CODING_AGENT_DIR` (#329) and the adapter ALSO reads `~/.config/mcp/mcp.json`, `~/.agents/mcp.json`
 * and `~/.agents/mcp/mcp.json` from `HOME` (the adapter's `config.ts`). Pinning one and not the other
 * would let the developer's own configuration into a verdict, which #330's PI-07 names as a falsifier.
 *
 * The install writes into a throwaway directory ONCE per run and every scenario copies from there.
 * The developer's `~/.pi` is never read and never written: not by the install, not by a scenario.
 */
const PI_ADAPTER_SPEC = 'npm:pi-mcp-adapter@2.32.1';
const PI_EXTENSION = join(REPO, 'packages/xezar/scripts/pi-leader-extension.ts');

interface PiAdapterInstall {
  /** A `PI_CODING_AGENT_DIR` holding `npm/` and a `settings.json` that enables the adapter. */
  readonly agentDir: string;
  readonly version: string;
}

/** Install the adapter once, into a throwaway pi directory. Needs the network; says so when it fails. */
function installPiAdapter(scratch: string, bin: string): PiAdapterInstall | { absent: string } {
  const home = realpathSync(mkdtempSync(join(scratch, 'pi-install-home-')));
  const agentDir = join(home, 'agent');
  mkdirSync(agentDir, { recursive: true });
  const transcript = new Transcript('a01-pi-install');
  transcript.line('$', `${bin} install ${PI_ADAPTER_SPEC}   (HOME and PI_CODING_AGENT_DIR pinned)`);
  try {
    const out = execFileSync(bin, ['install', PI_ADAPTER_SPEC], {
      cwd: home,
      encoding: 'utf8',
      timeout: 300_000,
      env: piEnv(home, agentDir, join(home, 'tmp')),
    });
    for (const line of out.split('\n').filter(Boolean)) transcript.line('out', line);
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n').slice(0, 2).join(' ') : String(err);
    transcript.line('err', reason);
    return { absent: `\`pi install ${PI_ADAPTER_SPEC}\` failed (it needs the network): ${reason}` };
  }
  // Proof the pin held, not an assumption: the package and the settings that enable it must both be
  // inside the pinned directory. If they are not, pi wrote somewhere else and the leg is NOT-RUN.
  const settingsPath = join(agentDir, 'settings.json');
  if (!existsSync(settingsPath) || !existsSync(join(agentDir, 'npm'))) {
    return { absent: `pi install wrote no settings.json or npm/ inside the pinned PI_CODING_AGENT_DIR — refusing to go on with a possibly real pi configuration` };
  }
  let version = PI_ADAPTER_SPEC;
  try {
    version = String(JSON.parse(readFileSync(join(agentDir, 'npm/node_modules/pi-mcp-adapter/package.json'), 'utf8')).version);
  } catch {
    /* the spec above stands as the recorded version */
  }
  return { agentDir, version };
}

/**
 * pi's environment: `env -i`-like, with both homes pinned and no network at startup.
 *
 * `TMPDIR` is pinned, and to a PRIVATE directory rather than `/tmp`, for two reasons that pull the
 * same way:
 *
 *  - **Length.** A Unix socket path is capped at ~104 bytes and the leader extension puts its private
 *    directory in `os.tmpdir()`. This repository's own task temporary directory is already 78 of them,
 *    so an inherited `TMPDIR` leaves no room and the extension correctly opens nothing.
 *  - **Who else can write into this pi.** The extension's socket lives in a `0700` directory, which
 *    keeps OTHER accounts out and — deliberately — says nothing about this one. On a machine running
 *    several agents as one user, a peer that knows the path can send `prompt` and `steer` down it, and
 *    that is not a theory: a peer agent's probe was pointed at this harness's live pi mid-run and its
 *    two prompts landed as model requests 17 and 18 of a case whose whole claim is that request 1 was
 *    the only one. The socket directory is named `xez-pi-*` inside `os.tmpdir()`, so `/tmp` puts it
 *    where anything globbing `/tmp/xez-pi-*` finds it. A per-pi directory under this run's own scratch
 *    does not, and it is still short enough for the cap.
 */
function piEnv(home: string, agentDir: string, tmp?: string): NodeJS.ProcessEnv {
  const dir = tmp ?? '/tmp';
  mkdirSync(dir, { recursive: true });
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
    TERM: 'dumb',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TMPDIR: dir,
  };
}

interface PiClientHome {
  readonly home: string;
  readonly agentDir: string;
  readonly env: NodeJS.ProcessEnv;
  /** `provider/model` for `--model`, and the bare id the request names — unique per pi, so one
   *  endpoint can still answer "how many requests has THIS pi made". */
  readonly modelId: string;
  readonly modelName: string;
  /** The private `TMPDIR` this pi's leader socket directory is created in. */
  readonly tmp: string;
}

/**
 * A pi installation of its own: the adapter copied in (never the developer's), a scripted provider,
 * and the xezar MCP entry D-04 § 3 documents. A COLD adapter cache every time, which is what makes a
 * refusal observable — with a warm cache the adapter registers its cached tools and connects lazily.
 */
function makePiHome(label: string, install: PiAdapterInstall, opts: { xezHome: string; endpointPort: number; keepAlive?: boolean }): PiClientHome {
  const home = realpathSync(mkdtempSync(join(fx.scratch, `pi-${label}-`)));
  const agentDir = join(home, 'agent');
  mkdirSync(agentDir, { recursive: true });
  cpSync(join(install.agentDir, 'npm'), join(agentDir, 'npm'), { recursive: true });
  cpSync(join(install.agentDir, 'settings.json'), join(agentDir, 'settings.json'));
  // A model id of its own per pi, so "how many requests has THIS pi made" is answerable from the one
  // endpoint's log. A-19 turns on that count being 0 before the event, and every pi in the run shares
  // the endpoint — a run-wide count would read the A-01 leg's turns as this pi's polling.
  const model = `scripted-${label}-model`;
  writeFileSync(
    join(agentDir, 'models.json'),
    `${JSON.stringify(
      {
        providers: {
          scripted: {
            name: 'scripted fixture endpoint',
            baseUrl: `http://127.0.0.1:${opts.endpointPort}/v1`,
            apiKey: 'dummy-not-a-credential',
            api: 'openai-completions',
            models: [{ id: model, name: model, contextWindow: 128_000, maxTokens: 4_096 }],
          },
        },
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  const cmd = bridgeCommand();
  writeFileSync(
    join(agentDir, 'mcp.json'),
    `${JSON.stringify(
      {
        settings: { directTools: true },
        mcpServers: {
          xezar: {
            command: cmd.command,
            args: cmd.args,
            env: { XEZ_HOME: opts.xezHome, XEZ_DRY_RUN: '1' },
            // WP1 measured why this key is part of the documented setup: with the adapter's default
            // 10-minute `idleTimeout` it closes an idle bridge, which releases the project, and
            // another client then takes it.
            ...(opts.keepAlive === false ? {} : { lifecycle: 'keep-alive' }),
          },
        },
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  // Short on purpose: `<scratch>/t<label>` keeps the socket path under the ~104-byte cap while staying
  // out of the `/tmp/xez-pi-*` namespace a peer process can glob.
  const tmp = join(fx.scratch, `t${label}`);
  return { home, agentDir, env: piEnv(home, agentDir, tmp), modelId: `scripted/${model}`, modelName: model, tmp };
}

/**
 * A real `pi --mode rpc` peer over its own stdio. pi's framing is not the bridge's: ids are strings,
 * an answer is `{type:'response', id, success, data}` and everything else is one of pi's events, so
 * `LineRpc` (numeric ids, `result`/`error`) cannot read it.
 */
class PiRpc {
  readonly child: ChildProcess;
  readonly events: any[] = [];
  private readonly pending = new Map<string, (answer: { success: boolean; data?: any; error?: any }) => void>();
  private readonly transcript: Transcript;
  private buffer = '';
  private nextId = 0;
  readonly exited: Promise<void>;

  constructor(bin: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv; transcript: Transcript }) {
    this.transcript = opts.transcript;
    opts.transcript.line('$', `${bin} ${args.join(' ')}   (cwd ${opts.cwd})`);
    this.child = spawn(bin, [...args], { cwd: opts.cwd, env: { ...opts.env, PWD: opts.cwd }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(this.child);
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => this.push(chunk));
    this.child.stderr!.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) opts.transcript.line('err', line);
    });
    this.child.stdin!.on('error', () => {
      /* a peer that died mid-write is reported by `exited` */
    });
    this.exited = new Promise((done) =>
      this.child.on('exit', (code, signal) => {
        children.delete(this.child);
        opts.transcript.line('exit', `code=${code} signal=${signal}`);
        for (const settle of this.pending.values()) settle({ success: false, error: { message: `pi exited (${code ?? signal})` } });
        this.pending.clear();
        done();
      }),
    );
  }

  private push(text: string): void {
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        this.transcript.line('raw', line.slice(0, 400));
        continue;
      }
      // `message_update` is one frame per token; logging every one buries the transcript.
      if (message?.type !== 'message_update') this.transcript.line('<-', line.slice(0, 1_000));
      const id = typeof message?.id === 'string' ? message.id : undefined;
      if (message?.type === 'response' && id !== undefined && this.pending.has(id)) {
        this.pending.get(id)!({ success: message.success === true, data: message.data, error: message.error });
        this.pending.delete(id);
        continue;
      }
      this.events.push(message);
    }
  }

  request(type: string, extra: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<{ success: boolean; data?: any; error?: any }> {
    const id = `xez118-${++this.nextId}`;
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        done({ success: false, error: { message: `pi did not answer ${type} within ${timeoutMs} ms` } });
      }, timeoutMs);
      this.pending.set(id, (answer) => {
        clearTimeout(timer);
        done(answer);
      });
      const line = JSON.stringify({ id, type, ...extra });
      this.transcript.line('->', line.slice(0, 1_000));
      this.child.stdin!.write(`${line}\n`);
    });
  }

  /**
   * One frame with no answer expected. pi's extension-UI sub-protocol is not the command protocol:
   * an `extension_ui_response` correlates to the REQUEST's id, which pi chose, so it cannot go through
   * `request()`.
   */
  send(frame: Record<string, unknown>): void {
    const line = JSON.stringify(frame);
    this.transcript.line('->', line.slice(0, 1_000));
    this.child.stdin!.write(`${line}\n`);
  }

  /** pi's dialog requests, in order. In RPC mode these BLOCK pi until the client answers them. */
  uiRequests(): any[] {
    return this.events.filter((e) => e?.type === 'extension_ui_request' && typeof e.method === 'string');
  }

  /** Every notice the adapter pushed into pi's UI channel — where a connection refusal shows up. */
  notices(): string[] {
    return this.events
      .filter((e) => e?.type === 'extension_ui_request' && typeof e.message === 'string')
      .map((e) => String(e.message));
  }

  async close(): Promise<void> {
    this.child.stdin!.end();
    const quit = await Promise.race([this.exited.then(() => true), delay(5_000, false, { ref: false })]);
    if (!quit) await stop(this.child);
  }
}

/**
 * ONE real `xezar serve` with ONE real pi holding BOTH legs, shared by the A-18, A-19 and A-20 pi
 * cases. Both legs on one process is #330's PI-04 and it is not tidiness: delivery needs an MCP
 * session that OWNS the project (`LeaderDelivery`'s `no-owner-session` blocker), and the session that
 * owns it here is pi's own `pi-mcp-adapter` connection. So the client leg is the precondition of the
 * reaction leg, and a pi that had only one of them could not be measured for A-19 at all.
 */
interface PiWorld {
  readonly serve: ServeHandle;
  readonly rpc: PiRpc;
  readonly root: string;
  readonly transcript: Transcript;
  /** The descriptor the extension wrote, as read from disk. */
  readonly descriptor: unknown;
  /** `POST /api/v1/mcp/leader {attach, pi}`. */
  readonly attach: { status: number; json: any };
  /** The leader status once an owner session exists — `blocker: null` is the ready state. */
  readonly ready: any;
  /** Model requests pi had made by the time the world was ready. A-19 needs this to be 0. */
  readonly requestsWhenReady: number;
  readonly modelRequests: () => number;
  /** This pi's requests from index `from`, oldest first. */
  readonly requestsSince: (from: number) => ModelRequest[];
  readonly pi: PiClientHome;
}

async function startPiWorld(): Promise<PiWorld> {
  const resolved = fx.clients.pi!;
  const base = mkdtempSync(join(fx.scratch, 'pi-world-'));
  const root = makeRepo(base, 'project-pi');
  const home = join(base, 'home');
  const serve = await startServe(root, home, 'pi-world-serve', join(base, 'agent-home'));
  const transcript = new Transcript('pi-world-rpc');
  const pi = makePiHome('world', fx.piInstall!, { xezHome: home, endpointPort: fx.endpoint.port });
  // The leader extension is xezar's own shipped file, loaded the way its own documentation says.
  const rpc = new PiRpc(resolved.bin, piArgs(pi, ['--extension', PI_EXTENSION]), { cwd: root, env: pi.env, transcript });
  const descriptorPath = join(root, '.local/xezar/pi-leader.json');
  const descriptorRaw = await waitFor('the pi leader extension to announce itself', () => (existsSync(descriptorPath) ? readFileSync(descriptorPath, 'utf8') : undefined), 120_000).catch(() => undefined);
  const descriptor = descriptorRaw === undefined ? undefined : (JSON.parse(descriptorRaw) as unknown);
  // pi's own MCP connection is what makes an owner session exist. A cold cache connects at start.
  await waitFor('pi-mcp-adapter to connect the xezar entry', () => rpc.notices().find((m) => /MCP: .*servers? connected|MCP: Failed to connect/.test(m)), 120_000).catch(() => undefined);
  const attach = await cockpit(serve, '/api/v1/mcp/leader', 'POST', { action: 'attach', client: 'pi' });
  const ready = await waitFor(
    'the leader to have both a session and an owner',
    async () => {
      const status = await cockpit(serve, '/api/v1/mcp/leader');
      return status.json?.blocker === null ? status.json : undefined;
    },
    60_000,
  ).catch(async () => (await cockpit(serve, '/api/v1/mcp/leader')).json);
  // THIS pi's requests, by its own model id: every pi in the run shares the endpoint, and a run-wide
  // count would read the A-01 leg's turns as this session's polling.
  const mine = (): ModelRequest[] => fx.endpoint.requests.filter((r) => r.model === pi.modelName);
  return { serve, rpc, pi, root, transcript, descriptor, attach, ready, requestsWhenReady: mine().length, modelRequests: () => mine().length, requestsSince: (from: number) => mine().slice(from) };
}

/** The world, built once and only if a pi case needs it. */
async function piWorld(): Promise<PiWorld> {
  fx.piWorld ??= await startPiWorld();
  return fx.piWorld;
}

/**
 * Which of a pi's model requests this run actually caused.
 *
 * A-19 and A-20 both turn on a COUNT, and a count is only evidence if an unexpected one can be told
 * apart from a status poll. It can: xezar's own dispatch is recognisable, and so is a prompt this
 * harness sent. Anything else came from somewhere else — a peer process writing into the leader
 * socket, which happened once here and read as "the heartbeat polled" until the texts were looked at.
 * So classify, and let the check report the foreign text rather than a number that does not add up.
 */
const HARNESS_PROMPTS = ['CALL health', 'CALL task_read'];
function classifyPiRequests(requests: readonly ModelRequest[]): { mine: ModelRequest[]; foreign: ModelRequest[] } {
  const mine: ModelRequest[] = [];
  const foreign: ModelRequest[] = [];
  for (const request of requests) {
    const ours =
      request.lastText.includes('[xezar event notification]') ||
      request.lastText.includes('TOOL_RESULT: ') ||
      HARNESS_PROMPTS.some((prompt) => request.lastText.includes(prompt));
    (ours ? mine : foreign).push(request);
  }
  return { mine, foreign };
}

/** Wait until pi has settled every turn it started, so a count is not read mid-turn. */
async function piQuiet(rpc: PiRpc, ms: number): Promise<void> {
  const starts = (): number => rpc.events.filter((e) => e?.type === 'agent_start').length;
  const settles = (): number => rpc.events.filter((e) => e?.type === 'agent_settled').length;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (starts() > 0 && starts() === settles()) return;
    await delay(250);
  }
}

/** pi's arguments: the mode xezar's own pi runner uses, with nothing of the host's session state. */
function piArgs(pi: PiClientHome, extra: readonly string[] = []): string[] {
  return [
    '--mode',
    'rpc',
    '--offline',
    '--no-session',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--model',
    pi.modelId,
    ...extra,
  ];
}

const OWNERSHIP_GAP =
  'exclusive ownership over a live MCP session is not wired: nothing in the running service calls `ProjectOwnership` (src/workspace/project-owner.ts), and the bridge opens one socket connection per tool call (src/mcp/bridge.ts), so no session exists whose close could be observed — `initialize` is answered by the bridge without ever reaching the service. Leader decision: Phase 6 bridge protocol change, out of release 0.14.0';

before(async () => {
  assert.ok(existsSync(DIST_CLI), `the built CLI is missing at ${DIST_CLI}: run \`npm run build\` first — this harness drives the built bridge`);
  mkdirSync(OUT, { recursive: true });
  const world = await createAbWorld({});
  // The one thing a separate bridge PROCESS needs to find the world's sockets: A and B in the
  // registry the bridge reads (`resolveMcpTarget`), inside the world's own XEZ_HOME.
  writeFileSync(
    join(world.home, 'config.json'),
    `${JSON.stringify({
      projects: [
        { id: PROJECT_A, root: world.a.root, name: world.a.name, addedAt: '2026-09-11T00:00:00.000Z', lastOpenedAt: '' },
        { id: PROJECT_B, root: world.b.root, name: world.b.name, addedAt: '2026-09-11T00:00:00.000Z', lastOpenedAt: '' },
      ],
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  const scratch = realpathSync(mkdtempSync('/tmp/xez118-'));
  const endpoint = new ScriptedEndpoint();
  await endpoint.start();
  const clients: Fixture['clients'] = {};
  const absent: Fixture['absent'] = {};
  const found = {
    'claude-code': resolveClient('claude', 'CLAUDE_CONFIG_DIR', ['--version']),
    codex: resolveClient('codex', 'CODEX_HOME', ['--version']),
    opencode: resolveClient('opencode', 'OPENCODE_CONFIG_DIR', ['--version']),
    pi: resolveClient('pi', 'PI_CODING_AGENT_DIR', ['--version']),
  } as const;
  for (const name of CLIENTS) {
    const hit = found[name];
    if ('absent' in hit) absent[name] = hit.absent;
    else clients[name] = hit;
  }
  fx = { world, scratch, endpoint, clients, absent, setup: {}, competing: {}, reaction: {} };
  // pi's one extra one-time step, once for the whole run. A failure is NOT-RUN for pi and changes
  // nothing for the other three: the extension is where pi's MCP capability lives, so without it
  // there is no pi MCP client to measure and saying so is the honest answer (#330 PI-08).
  if (clients.pi) {
    const installed = installPiAdapter(scratch, clients.pi.bin);
    if ('absent' in installed) {
      fx.piInstallFailure = installed.absent;
      absent.pi = installed.absent;
      delete clients.pi;
    } else fx.piInstall = installed;
  }
  writeFileSync(
    join(OUT, 'environment.json'),
    `${JSON.stringify(
      {
        revision: REVISION,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        dist: { path: 'packages/xezar/dist/index.js', mtime: statSync(DIST_CLI).mtime.toISOString() },
        xezarVersionInWorld: XEZAR_VERSION,
        clients: Object.fromEntries(CLIENTS.map((c) => [c, clients[c] ? { version: clients[c]!.version, refusedCandidates: clients[c]!.refused } : { absent: absent[c] }])),
        piMcpAdapter: fx.piInstall ? { spec: PI_ADAPTER_SPEC, version: fx.piInstall.version } : { absent: fx.piInstallFailure ?? absent.pi },
        fixture: {
          world: 'test/helpers/ab-fixture.ts createAbWorld({}) — A and B, XEZ_DRY_RUN=1, stubbed provider auth',
          model: 'scripted local endpoint in the harness process (not a model): Anthropic Messages for Claude Code and OpenCode, OpenAI chat-completions for pi',
          bridgeCommand: 'node packages/xezar/dist/index.js mcp (instead of `npx -y @qodeca/xezar mcp`)',
          piLeaderExtension: 'packages/xezar/scripts/pi-leader-extension.ts, loaded with `pi --extension` (the A-19/A-20 pi cases only)',
        },
      },
      null,
      2,
    )}\n`,
  );
});

after(async () => {
  // pi first and by its own handle: its stdin is how it is asked to leave, and the extension's
  // `session_shutdown` is what removes the descriptor and its private 0700 directory.
  await fx?.piWorld?.rpc.close().catch(() => undefined);
  for (const child of [...children]) await stop(child);
  fx?.endpoint.close();
  writeFileSync(join(OUT, 'results.json'), `${JSON.stringify({ revision: REVISION, stamp: STAMP, results }, null, 2)}\n`);
  const table = results.map((r) => `| ${r.case} | ${r.client} | ${r.verdict} | ${r.summary.replace(/\|/g, '\\|')} |`).join('\n');
  writeFileSync(join(OUT, 'results.md'), `| Case | Client | Verdict | Summary |\n| --- | --- | --- | --- |\n${table}\n`);
  await fx?.world.dispose();
  if (fx?.scratch) rmSync(fx.scratch, { recursive: true, force: true });
  console.log(`\n#118 real-client results: ${join(OUT, 'results.json')}\n`);
});

// ---- A-01: provisioning and one-time setup -------------------------------------------------

describe('A-01 — connection provisioning and one-time setup, per officially supported client', () => {
  test('[product] a running xezar writes the connection configuration into the project’s .local/xezar/', async (t) => {
    const base = mkdtempSync(join(fx.scratch, 'prod-'));
    const root = makeRepo(base, 'project-prod');
    const home = join(base, 'home');
    const serve = await startServe(root, home, 'a01-product-serve', join(base, 'agent-home'));
    try {
      const file = join(root, '.local/xezar/mcp-connection.json');
      const present = existsSync(file);
      const mode = present ? (statSync(file).mode & 0o777).toString(8) : null;
      const socketUp = existsSync(serve.socket);
      const ignored = present ? git(root, 'check-ignore', '.local/xezar/mcp-connection.json').trim() : null;
      const checks: Check[] = [
        { name: 'service socket open for the project', required: 'the MCP socket exists (D-01)', observed: socketUp ? serve.socket.slice(home.length) : 'absent', ok: socketUp },
        { name: 'connection file written', required: 'xezar writes <root>/.local/xezar/mcp-connection.json on project-context build (D-04.1, D-04.3)', observed: present ? `present, mode ${mode}` : 'absent after boot', ok: present },
      ];
      if (present) checks.push({ name: 'connection file mode 0600 and ignored by Git', required: 'mode 600, matched by .local/.gitignore (D-04.2, D-04.4)', observed: { mode, ignored }, ok: mode === '600' && ignored === '.local/xezar/mcp-connection.json' });
      const entry = record({
        case: 'A-01',
        client: '(xezar service)',
        verdict: verdictOf(checks),
        summary: present ? 'the running service wrote the connection file' : 'a real `xezar serve` opened the MCP socket but wrote no .local/xezar/mcp-connection.json',
        ...(present ? {} : { missing: 'no production writer of the D-04 connection file: `mcp-connection.json` is named only in tests (ab-fixture.ts plants it), and D-04.3’s creation trigger in ProjectContexts.build is not implemented' }),
        checks,
        transcripts: [serve.transcript.name],
        fixture: { serve: 'node packages/xezar/dist/index.js --repo <fresh repo> --no-open', env: 'XEZ_DRY_RUN=1, isolated XEZ_HOME and agent config dirs' },
      });
      settle(t, entry);
    } finally {
      await stop(serve.child);
    }
  });

  test('[product] the MCP tools of a real `xezar serve` reach the service', async (t) => {
    const base = mkdtempSync(join(fx.scratch, 'prod-'));
    const root = makeRepo(base, 'project-tools');
    const home = join(base, 'home');
    const serve = await startServe(root, home, 'a01-product-tools-serve', join(base, 'agent-home'));
    try {
      const { rpc } = await openBridge('a01-product-bridge', root, isolatedEnv(join(base, 'bridge-home'), { XEZ_HOME: home, XEZ_DRY_RUN: '1' }));
      const health = await rpc.request('tools/call', { name: 'health', arguments: {} });
      const list = await rpc.request('tools/call', { name: 'task_read', arguments: { view: 'list' } });
      await rpc.close();
      const checks: Check[] = [
        { name: 'bridge health reaches the service', required: 'health names this project', observed: toolText(health), ok: toolText(health).includes(serve.projectId) },
        { name: 'a registry tool reaches the service', required: 'task_read list answers with a task list', observed: toolText(list), ok: !list.result?.isError && toolText(list).includes('"tasks"') },
      ];
      const entry = record({
        case: 'A-01',
        client: '(xezar service tools)',
        verdict: verdictOf(checks),
        summary: checks[1]!.ok ? 'registry tools answer through the real service' : 'only the bridge’s own `health` reaches the real service; every registry tool answers that it is not connected',
        ...(checks[1]!.ok ? {} : { missing: '`listenMcpSocket` builds a tool context with only `project` and `xezarVersion` (src/mcp/service.ts) — no service entry reaches the tools in the shipped product' }),
        checks,
        transcripts: [serve.transcript.name, 'a01-product-bridge.log'],
        fixture: { serve: 'real xezar serve, XEZ_DRY_RUN=1', bridge: 'node packages/xezar/dist/index.js mcp, cwd = project root' },
      });
      settle(t, entry);
    } finally {
      await stop(serve.child);
    }
  });

  for (const client of CLIENTS) {
    test(`[${client}] one-time setup, then the client reaches A — and only A`, async (t) => {
      const resolved = fx.clients[client];
      if (!resolved) {
        const entry = record({ case: 'A-01', client, verdict: 'NOT-RUN', summary: fx.absent[client] ?? 'client not found', checks: [], fixture: {} });
        fx.setup[client] = entry;
        return settle(t, entry);
      }
      const entry = await setupLeg(client, resolved);
      fx.setup[client] = entry;
      settle(t, entry);
    });
  }
});

/**
 * #330's PI-08 edge path: "a user `approveTools` → a named `approval_required` state, not a hang".
 * `approveTools` is pi-mcp-adapter's own key, the only one that keeps a tool visible while stopping it
 * from running, and a leader reacting to an event has nobody at the keyboard. So the question is not
 * "is the reason named" — it is "does the turn END".
 *
 * Two phases, because the difference between them is the whole finding:
 *   1. Nobody answers. This is the leader-while-away case.
 *   2. The client answers `Deny`, through pi's extension-UI sub-protocol.
 *
 * pi's own `docs/rpc.md` § Extension UI Requests says a dialog method "blocks until the client sends
 * back an `extension_ui_response`", and auto-resolves only when the request carries a `timeout`. So
 * whether phase 1 ends is decided by whether that field is there, and that is read from the frame.
 */
describe('A-01 — edge paths that must name their reason (#330 PI-08)', () => {
  test('[pi] a tool the person gated behind approval fails closed with a named reason, not a hang', async (t) => {
    if (!fx.clients.pi) {
      const entry = record({ case: 'A-01', client: 'pi (approveTools)', verdict: 'NOT-RUN', summary: fx.absent.pi ?? 'pi not found', checks: [], fixture: {} });
      return settle(t, entry);
    }
    const { world, endpoint } = fx;
    const transcript = new Transcript('a01-pi-approvetools');
    const pi = makePiHome('approve', fx.piInstall!, { xezHome: world.home, endpointPort: endpoint.port });
    // The one difference from the A-01 leg: the person gated `health` behind approval.
    const entryFile = join(pi.agentDir, 'mcp.json');
    const config = JSON.parse(readFileSync(entryFile, 'utf8')) as { mcpServers: { xezar: Record<string, unknown> } };
    config.mcpServers.xezar.approveTools = ['health'];
    writeFileSync(entryFile, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    const free = await waitForProjectFree('a01-pi-approve', world.a.root, bridgeEnv(world, join(pi.home, 'probe')), 30_000);
    const rpc = new PiRpc(fx.clients.pi.bin, piArgs(pi), { cwd: world.a.root, env: pi.env, transcript });
    const settles = (): number => rpc.events.filter((e) => e?.type === 'agent_settled').length;
    let dialog: any;
    let endedUnanswered = false;
    let endedAfterDeny = false;
    let denied: unknown = 'the dialog never arrived, so nothing was answered';
    try {
      await waitForNotice(rpc, 120_000);
      const answer = await rpc.request('prompt', { message: 'CALL health' }, 30_000);
      if (answer.success) {
        // Phase 1. The gate must produce a NAMED request; whether the turn can end without an answer
        // is decided by the `timeout` field, so wait past a generous one and then read the frame.
        dialog = await waitFor('pi to ask for approval', () => rpc.uiRequests().find((r) => /approv|wants to run/i.test(`${r.title ?? ''} ${r.method}`)), 90_000).catch(() => undefined);
        endedUnanswered = await waitFor('the unanswered turn to end', () => (settles() > 0 ? true : undefined), 30_000)
          .then(() => true)
          .catch(() => false);
        // Phase 2. Answer it the way pi documents, and see the turn close.
        if (dialog && !endedUnanswered) {
          rpc.send({ type: 'extension_ui_response', id: dialog.id, value: 'Deny' });
          endedAfterDeny = await waitFor('the answered turn to end', () => (settles() > 0 ? true : undefined), 60_000)
            .then(() => true)
            .catch(() => false);
          const ended = rpc.events.find((e) => e?.type === 'tool_execution_end');
          denied = ended ? { isError: ended.isError, text: JSON.stringify(ended.result).slice(0, 300) } : 'the turn ended with no tool_execution_end';
        }
      }
    } finally {
      await rpc.close();
    }
    const checks: Check[] = [
      { name: 'project A is free before this client connects', required: "the previous client's ownership was released", observed: free.occupied ? `still occupied after ${free.freeAfterMs} ms` : `free after ${free.freeAfterMs} ms`, ok: !free.occupied },
      {
        name: 'the gate names what it is asking for',
        required: 'a dialog naming the server and the tool, not a generic failure',
        observed: dialog ? { method: dialog.method, title: String(dialog.title ?? '').slice(0, 120), options: dialog.options } : 'no approval dialog was emitted',
        ok: dialog !== undefined && /xezar/.test(String(dialog.title ?? '')) && /health/.test(String(dialog.title ?? '')),
      },
      {
        name: 'the gated call does not hang when nobody can answer',
        required: 'the turn ends on its own — a leader reacting to an event has nobody at the keyboard (PI-08: "not a hang")',
        observed: {
          turnEnded: endedUnanswered,
          // pi auto-resolves a dialog ONLY when the request carries `timeout` (docs/rpc.md § Extension
          // UI Requests). Read from the frame, so the cause is in the record and not inferred.
          dialogTimeout: dialog === undefined ? 'no dialog' : (dialog.timeout ?? 'absent — pi will not auto-resolve'),
        },
        ok: endedUnanswered,
      },
      {
        name: 'answering it closes the turn, and the refusal is reported',
        required: '`extension_ui_response` with `Deny` ends the turn and the model is told the call was refused',
        observed: { endedAfterDeny, result: denied },
        ok: endedAfterDeny && /den|refus|not allow|reject/i.test(JSON.stringify(denied)),
      },
    ];
    const entry = record({
      case: 'A-01',
      client: 'pi (approveTools)',
      verdict: verdictOf(checks),
      summary: endedUnanswered
        ? 'a gated tool call ended on its own and named approval as the reason'
        : 'a gated tool call BLOCKS: pi emits a named approval dialog with no `timeout` and waits for an answer that a headless leader has nobody to give',
      ...(endedUnanswered
        ? {}
        : {
            missing:
              "an answerer for pi's extension-UI dialogs, or setup guidance that says not to gate xezar's tools. pi's `docs/rpc.md` says a dialog blocks until the client sends `extension_ui_response`, and auto-resolves only with a `timeout` this one does not carry. Nothing in xezar answers one: `core/pi-runner.ts`, `scripts/pi-leader-extension.ts` and `mcp/adapters/pi.ts` never mention `extension_ui_request`. Answering `Deny` here did end the turn, so the block is an unanswered dialog and not a lost call.",
          }),
      checks,
      transcripts: [transcript.name],
      fixture: { pi: `${fx.clients.pi.version} + pi-mcp-adapter ${fx.piInstall!.version}`, setting: "the xezar entry's `approveTools: ['health']`, headless RPC session (nobody to approve)" },
    });
    settle(t, entry);
  });
});

/** The adapter's own startup notice: how a pi says its MCP entry connected, or did not. */
const waitForNotice = (rpc: PiRpc, timeoutMs: number): Promise<string | undefined> =>
  waitFor('the pi-mcp-adapter connection notice', () => rpc.notices().find((m) => /MCP: /.test(m)), timeoutMs).catch(() => undefined);

/** What every client's entry runs — this revision's bridge, pointed at the fixture's home. */
const bridgeCommand = (): { command: string; args: string[] } => ({ command: process.execPath, args: [DIST_CLI, 'mcp'] });

async function setupLeg(client: ClientName, resolved: ResolvedClient): Promise<CaseRecord> {
  const { world, endpoint } = fx;
  const home = realpathSync(mkdtempSync(join(fx.scratch, `${client}-home-`)));
  const transcript = new Transcript(`a01-${client}`);
  const before = git(world.a.root, 'status', '--porcelain', '--untracked-files=all');
  const checks: Check[] = [];
  // The previous leg's bridge outlives the command that spawned it by a moment, and since #302 that
  // moment is a refusal for whoever connects next. Waiting for A to be free is the precondition of
  // this leg, and how long the release took is recorded rather than slept through.
  const free = await waitForProjectFree(`a01-${client}`, world.a.root, bridgeEnv(world, join(home, 'probe')), 30_000);
  checks.push({
    name: 'project A is free before this client connects',
    required: 'the previous client\'s ownership was released, so this leg tests the client and not the queue (D-02 § 4)',
    observed: free.occupied ? `still occupied after ${free.freeAfterMs} ms` : `free after ${free.freeAfterMs} ms`,
    ok: !free.occupied,
  });
  const fixture: Record<string, unknown> = { client: resolved.bin, version: resolved.version, refusedCandidates: resolved.refused, home: '<scratch>' };
  const cmd = bridgeCommand();
  const aName = `project ${world.a.name} (${PROJECT_A})`;
  let reached: string[] = [];
  let configText = '';
  let setupFiles: string[] = [];

  if (client === 'claude-code') {
    const env = isolatedEnv(home, { CLAUDE_CONFIG_DIR: join(home, '.claude') });
    const add = await runCli(resolved.bin, ['mcp', 'add', '--scope', 'local', 'xezar', '-e', `XEZ_HOME=${world.home}`, '-e', 'XEZ_DRY_RUN=1', '--', cmd.command, ...cmd.args], { cwd: world.a.root, env, transcript });
    const configFile = /File modified: (\S+)/.exec(add.stdout)?.[1];
    const isolated = configFile !== undefined && realpathSync(dirname(configFile)).startsWith(home);
    checks.push({ name: 'one-time step (`claude mcp add --scope local`)', required: 'exit 0, writing a file inside the pinned config folder', observed: { code: add.code, configFile: configFile?.replace(home, '<home>') }, ok: add.code === 0 && isolated });
    if (!isolated) return notRun(client, 'Claude Code did not write inside the pinned CLAUDE_CONFIG_DIR — refusing to go on with a possibly real configuration', checks, transcript, fixture);
    configText = readFileSync(configFile!, 'utf8');
    setupFiles = [configFile!.replace(home, '<home>')];
    const list = await runCli(resolved.bin, ['mcp', 'list'], { cwd: world.a.root, env, transcript });
    checks.push({ name: 'handshake (`claude mcp list`)', required: 'xezar ✔ Connected', observed: list.stdout.split('\n').find((l) => l.startsWith('xezar')) ?? list.stdout.slice(0, 300), ok: /^xezar:.*Connected/m.test(list.stdout) });
    // The handshake never touches the service (D-01 § 5), so reaching A needs a tool call, and a
    // tool call needs a model turn. `--bare` never reads OAuth or the keychain; in bare mode Claude
    // Code reads MCP servers only from `--mcp-config`, so the SAME entry is passed there.
    const mcpConfig = join(home, 'mcp-config.json');
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { xezar: { type: 'stdio', command: cmd.command, args: cmd.args, env: { XEZ_HOME: world.home, XEZ_DRY_RUN: '1' } } } }));
    const turnEnv = isolatedEnv(home, { CLAUDE_CONFIG_DIR: join(home, '.claude'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${endpoint.port}`, ANTHROPIC_API_KEY: 'dummy-not-a-credential', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
    for (const prompt of ['CALL health', 'CALL task_read']) {
      const from = endpoint.requests.length;
      const turn = await runCli(
        resolved.bin,
        ['-p', '--bare', '--mcp-config', mcpConfig, '--strict-mcp-config', '--allowedTools', 'mcp__xezar__health', 'mcp__xezar__task_read', '--output-format', 'stream-json', '--verbose', prompt],
        { cwd: world.a.root, env: turnEnv, transcript, timeoutMs: 120_000 },
      );
      reached.push(...endpoint.toolResultsSince(from));
      if (turn.code !== 0) reached.push(`(claude -p exited ${turn.code}: ${turn.stderr.slice(0, 200)})`);
    }
    fixture.turn = 'claude -p --bare --mcp-config <same entry> --strict-mcp-config; ANTHROPIC_BASE_URL = scripted endpoint; dummy key';
  }

  if (client === 'codex') {
    const codexHome = join(home, '.codex');
    mkdirSync(codexHome, { recursive: true });
    // D-04 § 3.2, both parts: the project file, and trusting the project once. The model provider
    // points at a closed local port: nothing here may reach a real account, and no turn is started.
    mkdirSync(join(world.a.root, '.codex'), { recursive: true });
    const projectToml = `[mcp_servers.xezar]\ncommand = ${JSON.stringify(cmd.command)}\nargs = ${JSON.stringify(cmd.args)}\nenv = { XEZ_HOME = ${JSON.stringify(world.home)}, XEZ_DRY_RUN = "1" }\n`;
    writeFileSync(join(world.a.root, '.codex/config.toml'), projectToml);
    writeFileSync(
      join(codexHome, 'config.toml'),
      `model = "scripted"\nmodel_provider = "fixture"\n\n[model_providers.fixture]\nname = "fixture"\nbase_url = "http://127.0.0.1:9/v1"\nenv_key = "H118_DUMMY_KEY"\nwire_api = "responses"\n\n[projects.${JSON.stringify(world.a.root)}]\ntrust_level = "trusted"\n`,
    );
    configText = projectToml;
    setupFiles = ['<A>/.codex/config.toml', '<home>/.codex/config.toml (trust entry)'];
    const env = isolatedEnv(home, { CODEX_HOME: codexHome, H118_DUMMY_KEY: 'dummy-not-a-credential' });
    const app = new LineRpc(resolved.bin, ['app-server'], { cwd: world.a.root, env, transcript, jsonrpc: false });
    try {
      const init = await app.request('initialize', { clientInfo: { name: 'h118', title: 'xezar #118 harness', version: '0' } });
      const codexHomeSeen = init.result?.codexHome as string | undefined;
      const isolated = codexHomeSeen !== undefined && realpathSync(codexHomeSeen) === realpathSync(codexHome);
      checks.push({ name: 'app-server isolation', required: 'initialize answers the pinned codexHome', observed: codexHomeSeen?.replace(home, '<home>') ?? init.error, ok: isolated });
      if (!isolated) return notRun(client, 'Codex did not run inside the pinned CODEX_HOME — refusing to go on with a possibly real configuration', checks, transcript, fixture);
      app.notify('initialized');
      const thread = await app.request('thread/start', { cwd: world.a.root });
      const threadId = thread.result?.thread?.id as string | undefined;
      const status = await app.request('mcpServerStatus/list', { threadId: threadId ?? null });
      const names = ((status.result?.data ?? []) as Array<{ name: string }>).map((s) => s.name);
      checks.push({ name: 'the project entry is loaded (trusted project)', required: 'xezar listed by mcpServerStatus/list', observed: names, ok: names.includes('xezar') });
      for (const [tool, args] of [
        ['health', {}],
        ['task_read', { view: 'list', archived: 'include' }],
      ] as const) {
        const call = await app.request('mcpServer/tool/call', { server: 'xezar', threadId: threadId ?? '', tool, arguments: args }, 60_000);
        reached.push(call.error ? `(error ${call.error.message})` : ((call.result?.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n'));
      }
    } finally {
      await app.close();
    }
    fixture.turn = 'none — codex app-server `mcpServer/tool/call` calls the tool with no model turn (D-01 E3)';
  }

  if (client === 'opencode') {
    const cfgDir = join(home, 'opencode-config');
    mkdirSync(cfgDir, { recursive: true });
    const entry = { type: 'local', command: [cmd.command, ...cmd.args], environment: { XEZ_HOME: world.home, XEZ_DRY_RUN: '1' }, enabled: true };
    // D-04 § 3.3's block, plus — for the tool-call leg only — a provider pointed at the scripted endpoint.
    const projectJson = {
      $schema: 'https://opencode.ai/config.json',
      autoupdate: false,
      share: 'disabled',
      provider: { scripted: { npm: '@ai-sdk/anthropic', name: 'scripted fixture endpoint', options: { baseURL: `http://127.0.0.1:${endpoint.port}/v1`, apiKey: 'dummy-not-a-credential' }, models: { 'scripted-model': { name: 'scripted-model' } } } },
      model: 'scripted/scripted-model',
      small_model: 'scripted/scripted-model',
      mcp: { xezar: entry },
    };
    writeFileSync(join(world.a.root, 'opencode.json'), `${JSON.stringify(projectJson, null, 2)}\n`);
    configText = JSON.stringify(projectJson);
    setupFiles = ['<A>/opencode.json'];
    const env = isolatedEnv(home, { OPENCODE_CONFIG_DIR: cfgDir });
    const list = await runCli(resolved.bin, ['mcp', 'list'], { cwd: world.a.root, env, transcript, timeoutMs: 120_000 });
    const plain = list.stdout.replace(/\u001b\[[0-9;]*m/g, '');
    checks.push({ name: 'handshake (`opencode mcp list`)', required: 'xezar connected', observed: plain.split('\n').filter((l) => /xezar/.test(l)).join(' / ') || plain.slice(0, 300), ok: /xezar\s+connected/i.test(plain) });
    for (const prompt of ['CALL health', 'CALL task_read']) {
      const from = endpoint.requests.length;
      const turn = await runCli(resolved.bin, ['run', '--print-logs', '--model', 'scripted/scripted-model', prompt], { cwd: world.a.root, env, transcript, timeoutMs: 180_000 });
      reached.push(...endpoint.toolResultsSince(from));
      if (turn.code !== 0) reached.push(`(opencode run exited ${turn.code}: ${turn.stderr.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 300)})`);
    }
    fixture.turn = 'opencode run --model scripted/scripted-model; provider @ai-sdk/anthropic at the scripted endpoint; dummy key';
  }

  if (client === 'pi') {
    const install = fx.piInstall!;
    const pi = makePiHome('a01', install, { xezHome: world.home, endpointPort: endpoint.port });
    // Proof the pins held BEFORE a turn runs, the same rule Claude Code's and Codex's legs follow:
    // both files pi reads for this must be inside the pinned directory, and `HOME` must be the
    // throwaway one. Otherwise the leg is NOT-RUN rather than a verdict on someone's real pi.
    const inside = realpathSync(pi.agentDir).startsWith(pi.home) && existsSync(join(pi.agentDir, 'mcp.json')) && existsSync(join(pi.agentDir, 'npm/node_modules/pi-mcp-adapter'));
    checks.push({
      name: `one-time step (\`pi install ${PI_ADAPTER_SPEC}\` + the mcp.json entry)`,
      required: 'the extension and the entry are both inside the pinned PI_CODING_AGENT_DIR',
      observed: { adapter: install.version, agentDir: '<home>/agent', entry: 'mcp.json (directTools, lifecycle keep-alive)' },
      ok: inside,
    });
    if (!inside) return notRun(client, 'pi did not keep its installation inside the pinned PI_CODING_AGENT_DIR — refusing to go on with a possibly real configuration', checks, transcript, fixture);
    configText = readFileSync(join(pi.agentDir, 'mcp.json'), 'utf8');
    setupFiles = ['<home>/agent/settings.json (the `packages` list)', '<home>/agent/mcp.json (the xezar entry)'];
    const rpc = new PiRpc(resolved.bin, piArgs(pi), { cwd: world.a.root, env: pi.env, transcript });
    try {
      // The handshake is the adapter's own: it connects at start with a cold cache and says how many
      // tools it registered. pi has no `mcp list` command, so this notice IS the handshake evidence.
      const notice = await waitFor(
        'the pi-mcp-adapter connection notice',
        () => rpc.notices().find((m) => /MCP: .*servers connected|MCP: Failed to connect/.test(m)),
        120_000,
      ).catch(() => undefined);
      checks.push({
        name: 'handshake (pi-mcp-adapter connects the entry)',
        required: '1 server connected, with the bridge’s tools registered',
        observed: notice ?? rpc.notices().slice(0, 4),
        ok: notice !== undefined && /1 servers? connected \(\d+ tools?\)/.test(notice),
      });
      for (const prompt of ['CALL health', 'CALL task_read']) {
        const from = endpoint.requests.length;
        const answer = await rpc.request('prompt', { message: prompt }, 30_000);
        if (!answer.success) {
          reached.push(`(pi refused the prompt: ${JSON.stringify(answer.error).slice(0, 160)})`);
          continue;
        }
        // The turn is done when pi says so; a fixed sleep would either be slow or race.
        const settledBefore = rpc.events.filter((e) => e?.type === 'agent_settled').length;
        await waitFor('pi to settle its turn', () => (rpc.events.filter((e) => e?.type === 'agent_settled').length > settledBefore ? true : undefined), 120_000).catch(() => undefined);
        reached.push(...endpoint.toolResultsSince(from));
      }
      // PI-04's second half, on the SAME process: the model is really offered every xezar tool.
      const offered = [...new Set(endpoint.requests.flatMap((r) => (r.model === pi.modelName ? r.tools : [])))].sort();
      checks.push({
        name: 'the model is offered the bridge’s tools as first-class tools',
        required: 'every xezar tool in the model’s tool list (the adapter’s `directTools` mode)',
        observed: offered,
        ok: offered.length >= 11 && offered.includes('xezar_health') && offered.includes('xezar_task_read') && offered.includes('xezar_leader_events'),
      });
    } finally {
      await rpc.close();
    }
    fixture.turn = 'pi --mode rpc (the mode xezar’s pi runner uses); RPC `prompt`; provider `scripted` at the scripted OpenAI-completions endpoint; dummy key';
    fixture.piMcpAdapter = install.version;
  }

  const joined = reached.join('\n');
  // A client shows the health result either as its text ("… for project alpha project (alpha-proj).")
  // or as its structured content (`"project":{"id":"alpha-proj",…}`); both name A's id.
  const health = reached[0] ?? '';
  checks.push({ name: 'the client reaches A through the bridge (health)', required: `the health result names ${aName}`, observed: reached.slice(0, 1), ok: health.includes(PROJECT_A) && !health.includes(PROJECT_B) && !health.startsWith('(') });
  const aTaskSeen = joined.includes(world.a.ids.done);
  checks.push({ name: 'a registry tool answers with A’s data (task_read list)', required: `A’s task ${world.a.ids.done.slice(0, 8)}… in the result`, observed: reached.slice(1).map((r) => r.slice(0, 200)), ok: aTaskSeen });
  checks.push({ name: 'nothing of B reaches the client', required: 'no B identifier in any tool result', observed: leaked(joined, world.b.names), ok: leaked(joined, world.b.names).length === 0 });
  const secrets = [...world.secrets, 'mcp-connection'];
  checks.push({ name: 'no connection data or secret in the client configuration', required: 'the entry names a command only (F-15)', observed: leaked(configText, secrets), ok: leaked(configText, secrets).length === 0 });
  const afterStatus = git(world.a.root, 'status', '--porcelain', '--untracked-files=all');
  const added = afterStatus.split('\n').filter((l) => l && !before.split('\n').includes(l));
  checks.push({ name: 'what the setup added to A’s working tree', required: 'only the documented client file (none for Claude local scope)', observed: added, ok: added.every((l) => /\.codex\/config\.toml|opencode\.json/.test(l)) });
  const verdict = verdictOf(checks);
  return record({
    case: 'A-01',
    client,
    verdict,
    summary:
      verdict === 'PASSED'
        ? 'one-time setup as documented; the client reached A through the real bridge and saw nothing of B'
        : `setup leg ${verdict}: ${checks.filter((c) => c.ok === false).map((c) => c.name).join('; ')}`,
    checks,
    transcripts: [transcript.name, 'scripted-model-endpoint.log'],
    fixture: { ...fixture, setupFiles, bridge: 'node packages/xezar/dist/index.js mcp', world: 'A/B world, A bound' },
  });
}

function notRun(client: string, reason: string, checks: Check[], transcript: Transcript, fixture: Record<string, unknown>): CaseRecord {
  return record({ case: 'A-01', client, verdict: 'NOT-RUN', summary: reason, checks, transcripts: [transcript.name], fixture });
}

// ---- A-17: a competing owner, same-owner concurrency, another project ----------------------

describe('A-17 — only the competing owner is rejected', () => {
  test('a second logical client of A is refused with the occupied error; the owner’s own requests and project B work', async (t) => {
    const { world } = fx;
    const home = realpathSync(mkdtempSync(join(fx.scratch, 'a17-')));
    const owner = await openBridge('a17-owner-bridge', world.a.root, bridgeEnv(world, home));
    const ownerHealth = await owner.rpc.request('tools/call', { name: 'health', arguments: {} });
    const second = await openBridge('a17-second-bridge', world.a.root, bridgeEnv(world, home));
    const secondWrite = isOccupied(second.init) ? undefined : await second.rpc.request('tools/call', { name: 'organise_work', arguments: { action: 'pin', runId: world.a.ids.done, expectedVersion: runVersion(world.a.store, world.a.ids.done), operationId: 'op-a17-second-pin' } });
    // Same owner: many requests at once are not additional clients.
    const burst = await Promise.all(Array.from({ length: 20 }, () => owner.rpc.request('tools/call', { name: 'task_read', arguments: { view: 'list', limit: 1 } })));
    // Another project: B has its own socket and its own owner slot.
    const other = await openBridge('a17-project-b-bridge', world.b.root, bridgeEnv(world, home));
    const otherHealth = await other.rpc.request('tools/call', { name: 'health', arguments: {} });
    // The control: the ownership module, driven directly, does answer D-02's occupied error — so
    // the detector above recognises a refusal when one exists.
    const control = new ProjectOwnership({ dataDir: join(home, 'control-data'), projectId: PROJECT_A, autoRenew: false });
    const first = await control.acquire('control-session-1');
    const refused = await control.acquire('control-session-2');
    control.dispose();
    for (const peer of [owner, second, other]) await peer.rpc.close();
    world.a.store.setPinned(world.a.ids.done, false);

    const checks: Check[] = [
      { name: 'the owner reaches A', required: 'health names A', observed: toolText(ownerHealth), ok: toolText(ownerHealth).includes(PROJECT_A) },
      { name: 'a second logical client is refused', required: `initialize answers ${MCP_PROJECT_OCCUPIED_CODE} with data.reason ${MCP_PROJECT_OCCUPIED_REASON} (D-02 § 4)`, observed: second.init.error ?? { accepted: second.init.result?.serverInfo, thenPinned: secondWrite ? toolText(secondWrite).slice(0, 120) : undefined }, ok: isOccupied(second.init) },
      { name: 'the owner’s concurrent requests all succeed', required: '20 of 20 answered without an error', observed: `${burst.filter((b) => !b.error && !b.result?.isError).length} of 20`, ok: burst.every((b) => !b.error && !b.result?.isError) },
      { name: 'another project works', required: 'a client of B reaches B', observed: toolText(otherHealth), ok: toolText(otherHealth).includes(PROJECT_B) },
      { name: 'control: the ownership module refuses a second session', required: 'acquire → occupied with the D-02 error', observed: { first: first.outcome, second: refused.outcome === 'occupied' ? refused.error : refused.outcome }, ok: first.outcome === 'owner' && refused.outcome === 'occupied' && refused.error.code === MCP_PROJECT_OCCUPIED_CODE },
    ];
    const entry = record({
      case: 'A-17',
      client: '(real bridge processes)',
      verdict: verdictOf(checks),
      summary: isOccupied(second.init) ? 'the second client was refused' : 'a second logical client of A was admitted and could write; same-owner concurrency and project B work',
      // Only when the check really failed. `OWNERSHIP_GAP` names a source fact ("nothing calls
      // `ProjectOwnership`"), and printing it beside a refusal that DID happen would publish a false
      // claim about the revision under test — #302 wired ownership after the first run of this file.
      ...(isOccupied(second.init) ? {} : { missing: OWNERSHIP_GAP }),
      checks,
      transcripts: ['a17-owner-bridge.log', 'a17-second-bridge.log', 'a17-project-b-bridge.log'],
      fixture: { world: 'A/B world', owner: 'xez mcp process in A', second: 'xez mcp process in A', other: 'xez mcp process in B' },
    });
    settle(t, entry);
  });

  for (const client of CLIENTS) {
    test(`[${client}] as the second logical client while A already has an owner`, async (t) => {
      const resolved = fx.clients[client];
      if (!resolved) {
        const entry = record({ case: 'A-17', client, verdict: 'NOT-RUN', summary: fx.absent[client] ?? 'client not found', checks: [], fixture: {} });
        return settle(t, entry);
      }
      if (!fx.setup[client] || fx.setup[client]!.verdict === 'NOT-RUN') {
        const entry = record({ case: 'A-17', client, verdict: 'NOT-RUN', summary: 'the A-01 setup for this client did not run, so it cannot compete', checks: [], fixture: {} });
        return settle(t, entry);
      }
      const { world } = fx;
      const home = realpathSync(mkdtempSync(join(fx.scratch, `a17-${client}-`)));
      const owner = await openBridge(`a17-owner-for-${client}`, world.a.root, bridgeEnv(world, home));
      await owner.rpc.request('tools/call', { name: 'health', arguments: {} });
      const transcript = new Transcript(`a17-${client}`);
      const observed = await competeAs(client, resolved, transcript);
      await owner.rpc.close();
      const check: Check = { name: `${client} connects while A is owned`, required: 'the client reports the occupied-project error and gets no tool access', observed: observed.text, ok: observed.refused };
      fx.competing[client] = check;
      const entry = record({
        case: 'A-17',
        client,
        verdict: verdictOf([check]),
        summary: observed.refused ? 'refused as occupied' : `admitted as a second client while A had a live owner: ${observed.text.slice(0, 160)}`,
        ...(observed.refused ? {} : { missing: OWNERSHIP_GAP }),
        checks: [check],
        transcripts: [transcript.name, `a17-owner-for-${client}.log`],
        fixture: { owner: 'a live xez mcp process in A', client: `${resolved.bin} (${resolved.version}), the A-01 setup` },
      });
      settle(t, entry);
    });
  }
});

/** One real client connecting to A with the A-01 configuration: did it get in? */
async function competeAs(client: ClientName, resolved: ResolvedClient, transcript: Transcript): Promise<{ refused: boolean; text: string }> {
  const { world } = fx;
  const home = realpathSync(mkdtempSync(join(fx.scratch, `compete-${client}-`)));
  if (client === 'claude-code') {
    // Its own pinned config, with the same local-scope entry the A-01 leg wrote.
    const env = isolatedEnv(home, { CLAUDE_CONFIG_DIR: join(home, '.claude') });
    const cmd = bridgeCommand();
    await runCli(resolved.bin, ['mcp', 'add', '--scope', 'local', 'xezar', '-e', `XEZ_HOME=${world.home}`, '-e', 'XEZ_DRY_RUN=1', '--', cmd.command, ...cmd.args], { cwd: world.a.root, env, transcript });
    const list = await runCli(resolved.bin, ['mcp', 'list'], { cwd: world.a.root, env, transcript });
    const line = list.stdout.split('\n').find((l) => l.startsWith('xezar')) ?? list.stdout.slice(0, 200);
    return { refused: !/Connected/.test(line) && /occupied|-32080/i.test(list.stdout + list.stderr), text: line };
  }
  if (client === 'codex') {
    const codexHome = join(home, '.codex');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'config.toml'), `model_provider = "fixture"\n\n[model_providers.fixture]\nname = "fixture"\nbase_url = "http://127.0.0.1:9/v1"\nenv_key = "H118_DUMMY_KEY"\nwire_api = "responses"\n\n[projects.${JSON.stringify(world.a.root)}]\ntrust_level = "trusted"\n`);
    const app = new LineRpc(resolved.bin, ['app-server'], { cwd: world.a.root, env: isolatedEnv(home, { CODEX_HOME: codexHome, H118_DUMMY_KEY: 'dummy-not-a-credential' }), transcript, jsonrpc: false });
    try {
      const init = await app.request('initialize', { clientInfo: { name: 'h118', version: '0' } });
      if (!init.result?.codexHome || realpathSync(init.result.codexHome) !== realpathSync(codexHome)) return { refused: false, text: 'NOT-RUN: codex left the pinned home' };
      app.notify('initialized');
      const thread = await app.request('thread/start', { cwd: world.a.root });
      const call = await app.request('mcpServer/tool/call', { server: 'xezar', threadId: thread.result?.thread?.id ?? '', tool: 'organise_work', arguments: { action: 'pin', runId: world.a.ids.done, expectedVersion: runVersion(world.a.store, world.a.ids.done), operationId: 'op-h118-pin' } }, 60_000);
      const text = call.error ? `error ${call.error.code} ${call.error.message}` : ((call.result?.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');
      world.a.store.setPinned(world.a.ids.done, false);
      return { refused: /occupied|-32080/i.test(text), text: `organise_work pin → ${text.slice(0, 200)}` };
    } finally {
      await app.close();
    }
  }
  if (client === 'pi') {
    // A COLD adapter cache, which is the condition under which a refusal is observable at all: WP1
    // measured that a warm cache registers the cached tools and answers the first call
    // `MCP server "xezar" not available`, with the occupied reason reaching nobody.
    const pi = makePiHome('a17', fx.piInstall!, { xezHome: world.home, endpointPort: fx.endpoint.port });
    const rpc = new PiRpc(resolved.bin, piArgs(pi), { cwd: world.a.root, env: pi.env, transcript });
    try {
      await waitFor('the pi-mcp-adapter connection notice', () => rpc.notices().find((m) => /MCP: /.test(m)), 120_000).catch(() => undefined);
      const notices = rpc.notices();
      const occupied = notices.filter((m) => /occupied|-32080/i.test(m));
      // "Gets no tool access" is the other half of the criterion, and it needs one turn to observe:
      // with the connection refused the model is offered no xezar tool and the call finds none.
      const from = fx.endpoint.requests.length;
      const answer = await rpc.request('prompt', { message: 'CALL health' }, 30_000);
      if (answer.success) {
        const settledBefore = rpc.events.filter((e) => e?.type === 'agent_settled').length;
        await waitFor('pi to settle its turn', () => (rpc.events.filter((e) => e?.type === 'agent_settled').length > settledBefore ? true : undefined), 120_000).catch(() => undefined);
      }
      const offered = fx.endpoint.requests.slice(from).flatMap((r) => r.tools);
      const results = fx.endpoint.toolResultsSince(from).join(' ');
      const reachedA = results.includes(PROJECT_A);
      return {
        refused: occupied.length > 0 && !reachedA,
        text: `notices ${JSON.stringify(notices.slice(0, 3))}; xezar tools offered to the model: ${offered.length}; reached A: ${reachedA}`,
      };
    } finally {
      await rpc.close();
    }
  }
  const env = isolatedEnv(home, { OPENCODE_CONFIG_DIR: join(home, 'cfg') });
  mkdirSync(join(home, 'cfg'), { recursive: true });
  const list = await runCli(resolved.bin, ['mcp', 'list'], { cwd: world.a.root, env, transcript, timeoutMs: 120_000 });
  const plain = list.stdout.replace(/\u001b\[[0-9;]*m/g, '');
  const line = plain.split('\n').filter((l) => /xezar/.test(l)).join(' / ') || plain.slice(0, 200);
  return { refused: !/connected/i.test(line) && /occupied|-32080/i.test(plain), text: line };
}

// ---- A-18: idle owner, crash, fencing, restart ---------------------------------------------

describe('A-18 — liveness, fencing and restart', () => {
  test('model silence keeps ownership, a stale owner is fenced, and a started task survives its owner', async (t) => {
    const { world } = fx;
    const home = realpathSync(mkdtempSync(join(fx.scratch, 'a18-')));
    const owner = await openBridge('a18-owner-bridge', world.a.root, bridgeEnv(world, home));
    const started = await owner.rpc.request('tools/call', {
      name: 'task_create',
      arguments: { operationId: `h118-a18-${Date.now()}`, prompt: 'mock:slow mock:done a long dry-run task for A-18', worktree: false, autonomous: true },
    });
    const startedText = toolText(started);
    const runId = /"(?:runId|id)"\s*:\s*"([0-9a-f-]{36})"/.exec(startedText)?.[1];
    // Silence: no call for longer than one renewal interval (D-02.5: 5 s). No lease is asserted.
    await delay(6_000);
    const intruder = await openBridge('a18-intruder-bridge', world.a.root, bridgeEnv(world, home));
    // Every write below sends the task's CURRENT version (#250) and its own operation key (#264), so
    // only ownership or fencing can refuse it.
    const intruderWrite = await intruder.rpc.request('tools/call', { name: 'organise_work', arguments: { action: 'set_title', runId: world.a.ids.done, title: 'A-18 intruder wrote this', expectedVersion: runVersion(world.a.store, world.a.ids.done), operationId: 'op-a18-intruder' } });
    // Crash: the owner's process dies without closing anything.
    owner.rpc.child.kill('SIGKILL');
    await owner.rpc.exited;
    const successor = await openBridge('a18-successor-bridge', world.a.root, bridgeEnv(world, home));
    const successorWrite = await successor.rpc.request('tools/call', { name: 'organise_work', arguments: { action: 'set_title', runId: world.a.ids.done, title: 'A-18 successor wrote this', expectedVersion: runVersion(world.a.store, world.a.ids.done), operationId: 'op-a18-successor' } });
    // The stale client is still alive: after a new owner exists, its write must be fenced.
    const staleWrite = await intruder.rpc.request('tools/call', { name: 'organise_work', arguments: { action: 'set_title', runId: world.a.ids.done, title: 'A-18 stale owner wrote this', expectedVersion: runVersion(world.a.store, world.a.ids.done), operationId: 'op-a18-stale' } });
    const finalTitle = world.a.store.getRun(world.a.ids.done)?.title;
    const terminal = runId
      ? await waitFor('the A-18 task to finish', () => {
          const status = world.a.store.getRun(runId)?.status;
          return status && ['done', 'failed', 'cancelled', 'review', 'waiting'].includes(status) ? status : undefined;
        }, 90_000).catch((err: Error) => `not terminal: ${err.message}`)
      : 'no run id in the task_create answer';
    await intruder.rpc.close();
    await successor.rpc.close();

    const checks: Check[] = [
      { name: 'a task starts through MCP', required: 'task_create is accepted with a run id', observed: startedText.slice(0, 200), ok: runId !== undefined },
      { name: 'model silence does not release ownership', required: `after ${6} s of owner silence a new client of A is refused as occupied`, observed: intruder.init.error ?? `admitted; its write answered: ${toolText(intruderWrite).slice(0, 120)}`, ok: isOccupied(intruder.init) },
      { name: 'confirmed termination releases ownership to exactly one successor', required: 'after the owner is SIGKILLed a new client acquires, and it is the only owner', observed: { successorInit: successor.init.error ?? 'accepted', successorWrite: toolText(successorWrite).slice(0, 80) }, ok: isOccupied(intruder.init) && !successor.init.error },
      { name: 'the stale owner is fenced', required: `a write from the still-alive previous client answers ${MCP_SESSION_EXPIRED_CODE} / ${MCP_SESSION_EXPIRED_REASON}`, observed: staleWrite.error ?? `accepted: ${toolText(staleWrite).slice(0, 120)} — final title "${finalTitle}"`, ok: isExpired(staleWrite) },
      { name: 'a started task continues after its owner crashed', required: 'the task reaches its own terminal state', observed: terminal, ok: terminal === 'done' },
    ];
    world.a.store.updateRun(world.a.ids.done, { title: 'ALPHA done task common' });
    const entry = record({
      case: 'A-18',
      client: '(real bridge processes)',
      verdict: verdictOf(checks),
      summary: checks.every((c) => c.ok) ? 'ownership survives silence, a crash hands over to exactly one successor, the stale owner is fenced, and the task survived' : 'task survival holds; the ownership and fencing checks that did not pass are named below',
      ...(checks.every((c) => c.ok) ? {} : { missing: OWNERSHIP_GAP }),
      checks,
      transcripts: ['a18-owner-bridge.log', 'a18-intruder-bridge.log', 'a18-successor-bridge.log'],
      fixture: { world: 'A/B world, A’s real RunManager, XEZ_DRY_RUN=1 (`mock:slow` holds the task about 25 s)' },
    });
    settle(t, entry);
  });

  test('[pi] a real pi that owns A keeps it through model silence, and a second client is refused', async (t) => {
    if (!fx.clients.pi) {
      const entry = record({ case: 'A-18', client: 'pi', verdict: 'NOT-RUN', summary: fx.absent.pi ?? 'pi not found', checks: [], fixture: {} });
      return settle(t, entry);
    }
    const world = await piWorld();
    // Silence longer than D-02.5's 5 s renewal interval, with pi connected and making no call at all.
    // No lease duration is asserted, exactly as the bridge-only A-18 case does not assert one.
    await delay(6_000);
    const base = mkdtempSync(join(fx.scratch, 'a18-pi-'));
    const intruder = await openBridge('a18-pi-intruder-bridge', world.root, isolatedEnv(base, { XEZ_HOME: world.serve.home, XEZ_DRY_RUN: '1' }));
    const write = isOccupied(intruder.init)
      ? undefined
      : await intruder.rpc.request('tools/call', { name: 'task_read', arguments: { view: 'list' } });
    await intruder.rpc.close();
    const checks: Check[] = [
      {
        name: 'pi owns the project through its own MCP connection',
        required: 'an owner session exists, so the event controller runs (LeaderDelivery `no-owner-session`)',
        observed: { blocker: world.ready === undefined ? 'status not read' : world.ready.blocker, delivery: world.ready?.delivery ?? null },
        ok: world.ready?.blocker === null,
      },
      {
        name: 'model silence does not release the project pi owns',
        required: `after 6 s of pi making no call, another client's initialize answers ${MCP_PROJECT_OCCUPIED_CODE} / ${MCP_PROJECT_OCCUPIED_REASON} (D-02 § 4)`,
        observed: intruder.init.error ?? `admitted; its read answered: ${write ? toolText(write).slice(0, 120) : 'n/a'}`,
        ok: isOccupied(intruder.init),
      },
      {
        name: 'pi made no model request to keep the project',
        required: 'ownership is renewed by the live connection, not by a turn',
        observed: `${world.modelRequests()} pi model requests since the world was ready (${world.requestsWhenReady} at that point)`,
        ok: world.modelRequests() === world.requestsWhenReady,
      },
    ];
    const entry = record({
      case: 'A-18',
      client: 'pi',
      verdict: verdictOf(checks),
      summary: isOccupied(intruder.init) ? 'pi kept A through 6 s of model silence and a second client was refused as occupied' : 'a second client was admitted while pi owned A',
      // Not re-run here, and said so rather than claimed: WP1 measured on 5031bf8 that with the
      // adapter's DEFAULT 10-minute `idleTimeout` the adapter closes an idle bridge (between 601 s
      // and 661 s), which releases the project, and that `lifecycle: "keep-alive"` — set on this
      // fixture's entry, as the documented setup says — kept it at 700 s. A 700 s wait per condition
      // does not belong in this harness.
      missing: isOccupied(intruder.init) ? 'the adapter\'s 10-minute idle close is NOT re-run here (WP1 measured it on 5031bf8); this entry carries `lifecycle: "keep-alive"`, which is why it is not reached' : OWNERSHIP_GAP,
      checks,
      transcripts: [world.transcript.name, 'a18-pi-intruder-bridge.log'],
      fixture: { serve: 'real xezar serve, XEZ_DRY_RUN=1', pi: `${fx.clients.pi.version} + pi-mcp-adapter ${fx.piInstall!.version}, both legs on one process` },
    });
    settle(t, entry);
  });

  test('[product] a service restart ends every session and keeps started work', async (t) => {
    const base = mkdtempSync(join(fx.scratch, 'restart-'));
    const root = makeRepo(base, 'project-restart');
    const home = join(base, 'home');
    const agentHome = join(base, 'agent-home');
    let serve = await startServe(root, home, 'a18-restart-serve-1', agentHome);
    const created = await cockpit(serve, '/api/v1/runs', 'POST', { workflow: 'quick-task', task: 'mock:done a task started before the restart', worktree: false, autonomous: true });
    const runId: string | undefined = created.json?.id ?? created.json?.runs?.[0]?.id;
    await waitFor('the pre-restart task to finish', async () => {
      const run = await cockpit(serve, `/api/v1/runs/${runId}`);
      return run.json?.status === 'done' || run.json?.run?.status === 'done' ? true : undefined;
    }, 60_000).catch(() => undefined);
    const bridge = await openBridge('a18-restart-bridge', root, isolatedEnv(join(base, 'bridge-home'), { XEZ_HOME: home, XEZ_DRY_RUN: '1' }));
    const beforeRestart = await bridge.rpc.request('tools/call', { name: 'health', arguments: {} });
    await stop(serve.child);
    const whileDown = await bridge.rpc.request('tools/call', { name: 'health', arguments: {} });
    serve = await startServe(root, home, 'a18-restart-serve-2', agentHome);
    try {
      // The bridge process survived the restart. D-02 § 5: its session ended with the service, so its
      // next call must be fenced and the client must re-initialize.
      const afterRestart = await bridge.rpc.request('tools/call', { name: 'health', arguments: {} });
      const kept = await cockpit(serve, `/api/v1/runs/${runId}`);
      await bridge.rpc.close();
      const keptStatus = kept.json?.status ?? kept.json?.run?.status;
      const checks: Check[] = [
        { name: 'the bridge reaches the service before the restart', required: 'health names the project', observed: toolText(beforeRestart), ok: toolText(beforeRestart).includes(serve.projectId) },
        { name: 'service down reads as down, not as a hang', required: 'an ordinary tool result saying xezar is not running (D-01 § 5)', observed: toolText(whileDown), ok: !whileDown.error && /not running|isn.t running|start/i.test(toolText(whileDown)) },
        { name: 'a pre-restart session is fenced after the restart', required: `the surviving client's next call answers ${MCP_SESSION_EXPIRED_CODE} / ${MCP_SESSION_EXPIRED_REASON} and it must reconnect (D-02 § 5)`, observed: afterRestart.error ?? `accepted: ${toolText(afterRestart).slice(0, 120)}`, ok: isExpired(afterRestart) },
        { name: 'started work survives the restart', required: 'the task and its result are still there', observed: keptStatus ?? kept.status, ok: keptStatus === 'done' },
      ];
      const entry = record({
        case: 'A-18',
        client: '(xezar service restart)',
        verdict: verdictOf(checks),
        summary: checks.every((c) => c.ok) ? 'work survives a restart and a pre-restart session is fenced' : 'work survives a restart; the fencing checks that did not pass are named below',
        ...(checks.every((c) => c.ok) ? {} : { missing: OWNERSHIP_GAP }),
        checks,
        transcripts: ['a18-restart-serve-1.log', 'a18-restart-serve-2.log', 'a18-restart-bridge.log'],
        fixture: { serve: 'real xezar serve, stopped with SIGTERM and started again on the same repo and home' },
      });
      settle(t, entry);
    } finally {
      await stop(serve.child);
    }
  });
});

// ---- A-19: delivery and a real model reaction ----------------------------------------------

describe('A-19 — immediate acceptance, delivery, and a real model reaction', () => {
  test('[product] a task’s significant events reach the project journal in a real `xezar serve`', async (t) => {
    const base = mkdtempSync(join(fx.scratch, 'events-'));
    const root = makeRepo(base, 'project-events');
    const home = join(base, 'home');
    const serve = await startServe(root, home, 'a19-product-serve', join(base, 'agent-home'));
    try {
      const outcomes: Record<string, unknown> = {};
      // The leader starts a long task through MCP: acceptance first, the result much later.
      const bridge = await openBridge('a19-product-bridge', root, isolatedEnv(join(base, 'bridge-home'), { XEZ_HOME: home, XEZ_DRY_RUN: '1' }));
      const operationId = `h118-a19-${Date.now()}`;
      const started = Date.now();
      const viaMcp = await bridge.rpc.request('tools/call', { name: 'task_create', arguments: { operationId, prompt: 'mock:slow mock:done a long task for A-19', worktree: false, autonomous: true } });
      outcomes.acceptedMs = Date.now() - started;
      const acceptedText = toolText(viaMcp);
      outcomes.accepted = acceptedText.slice(0, 240);
      const mcpRunId = /"(?:runId|id)"\s*:\s*"([0-9a-f-]{36})"/.exec(acceptedText)?.[1];
      outcomes.statusRightAfter = await runStatus(serve, mcpRunId);
      // The rest of the lifecycle through the human's door: a cancellation and a question.
      const slow = await cockpit(serve, '/api/v1/runs', 'POST', { workflow: 'quick-task', task: 'mock:slow to be cancelled', autonomous: true });
      const waiting = await cockpit(serve, '/api/v1/runs', 'POST', { workflow: 'quick-task', task: 'mock:ask a question for the human' });
      await delay(2_000);
      if (slow.json?.id) outcomes.cancel = (await cockpit(serve, `/api/v1/runs/${slow.json.id}/cancel`, 'POST')).status;
      const terminal = await waitFor('the MCP-started task to finish', async () => ((await runStatus(serve, mcpRunId)) === 'done' ? 'done' : undefined), 90_000).catch(() => 'not done');
      outcomes.resultStatus = terminal;
      outcomes.resultMs = Date.now() - started;
      await waitFor('the question to park its task', async () => ((await runStatus(serve, waiting.json?.id)) === 'waiting' ? true : undefined), 30_000).catch(() => undefined);
      await bridge.rpc.close();
      await delay(1_000);
      const rows = readJournal(root);
      const categories = [...new Set((rows ?? []).map((r) => r.category))].sort();
      const mcpTerminal = (rows ?? []).find((r) => r.subject.id === mcpRunId && r.kind === 'task.done');
      const checks: Check[] = [
        { name: 'immediate acceptance is distinct from the result', required: 'task_create answers at once with a non-terminal status; `done` arrives later', observed: { acceptedMs: outcomes.acceptedMs, statusRightAfter: outcomes.statusRightAfter, resultMs: outcomes.resultMs, laterStatus: terminal }, ok: mcpRunId !== undefined && outcomes.statusRightAfter !== 'done' && terminal === 'done' },
        { name: 'the lifecycle reaches the project event journal', required: 'E-01 (done, cancelled) and E-02 (question) rows in <root>/.local/xezar/mcp/event-journal.ndjson', observed: rows ? { rows: rows.length, categories, kinds: rows.map((r) => `${r.kind}/${r.origin}`) } : 'no journal file', ok: categories.includes('E-01') && categories.includes('E-02') },
        { name: 'the completion of a leader-started task is not hidden as the leader’s own echo', required: 'its task.done row is not origin `leader` (the echo guard would drop it from delivery)', observed: mcpTerminal ? { origin: mcpTerminal.origin, causedBy: mcpTerminal.causedBy } : 'no task.done row for it', ok: mcpTerminal !== undefined && mcpTerminal.origin !== 'leader' },
      ];
      const entry = record({
        case: 'A-19',
        client: '(xezar service events)',
        verdict: verdictOf(checks),
        summary: rows ? `acceptance in ${outcomes.acceptedMs} ms, result ${terminal} later; the journal holds ${rows.length} rows (${categories.join(', ')})` : 'no significant event reaches any journal',
        ...(checks.every((c) => c.ok) ? {} : { missing: 'significant events do not reach the project journal as required (see the failed checks)' }),
        checks,
        transcripts: [serve.transcript.name, 'a19-product-bridge.log'],
        fixture: { serve: 'real xezar serve, XEZ_DRY_RUN=1; the bundled mock: mock:slow + mock:done (MCP), mock:slow (cancelled), mock:ask (waiting)', outcomes },
      });
      settle(t, entry);
    } finally {
      await stop(serve.child);
    }
  });

  test('[pi] an idle connected pi’s model reacts to a delivered event without polling', async (t) => {
    if (!fx.clients.pi) {
      const entry = record({ case: 'A-19', client: 'pi', verdict: 'NOT-RUN', summary: fx.absent.pi ?? 'pi not found', checks: [], fixture: {} });
      fx.reaction.pi = entry;
      return settle(t, entry);
    }
    const world = await piWorld();
    const setup = fx.setup.pi;
    const before = world.modelRequests();
    // ONE significant event, caused through the human's door so nothing about it is the leader's own:
    // a task the person starts and that finishes on its own (E-01 `task.done`, origin `system`).
    const created = await cockpit(world.serve, '/api/v1/runs', 'POST', { workflow: 'quick-task', task: 'mock:done a task whose completion is the event pi must react to', worktree: false, autonomous: true });
    const runId: string | undefined = created.json?.id;
    const finished = await waitFor('the A-19 pi task to finish', async () => ((await runStatus(world.serve, runId)) === 'done' ? 'done' : undefined), 90_000).catch(() => 'not done');
    // The reaction: a model request pi made, with nobody typing anything.
    const arrived = await waitFor('a pi model request carrying the event', () => (world.modelRequests() > before ? true : undefined), 90_000).catch(() => undefined);
    await piQuiet(world.rpc, 60_000);
    // A status-polling turn would show up as a SECOND request, so the count is read after the turn
    // settled and again after a quiet window longer than the controller's 30 s heartbeat.
    const afterTurn = world.modelRequests();
    await delay(40_000);
    const afterQuiet = world.modelRequests();
    const caused = world.requestsSince(before);
    const { foreign } = classifyPiRequests(caused);
    const carrying = caused.find((r) => r.lastText.includes('[xezar event notification]'));
    const journal = readJournal(world.root) ?? [];
    const row = journal.find((r) => r.subject.id === runId && r.kind === 'task.done');
    const status = await cockpit(world.serve, '/api/v1/mcp/leader');
    const delivery = status.json?.delivery ?? null;
    const userMessages = world.rpc.events.filter((e) => e?.type === 'message_start' && e.message?.role === 'user');
    const checks: Check[] = [
      { name: 'pi connected with the A-01 setup', required: 'the A-01 pi leg reached A', observed: setup?.verdict ?? 'no A-01 record', ok: setup ? setup.checks.some((c) => c.name.startsWith('the client reaches A') && c.ok === true) : false },
      { name: 'the reaction target is a real adapter, not the blocker', required: '`attach` accepted and `LeaderDelivery` built a PiReactionAdapter over the extension’s socket', observed: { attach: world.attach.status, leader: world.attach.json?.leader ?? world.attach.json?.error, descriptor: world.descriptor }, ok: world.attach.status === 200 && world.attach.json?.leader?.client === 'pi' },
      { name: 'immediate acceptance is distinct from the result', required: 'the task is accepted at once and reaches `done` later', observed: { run: created.status, finished }, ok: runId !== undefined && finished === 'done' },
      { name: 'the event reached the journal', required: 'an E-01 task.done row for it', observed: row ? { eventId: row.eventId, kind: row.kind, origin: row.origin } : `no task.done row among ${journal.length}`, ok: row !== undefined },
      { name: 'nothing had reached pi’s model before the event', required: '0 model requests while pi sat connected and idle', observed: `${before} pi model requests`, ok: before === 0 },
      { name: 'delivery is observed: the event was handed to pi as a user message', required: 'the adapter submitted the dispatch through the extension and pi took it into its conversation', observed: userMessages.map((m) => String(m.message?.content?.[0]?.text ?? '').slice(0, 80)), ok: userMessages.some((m) => String(m.message?.content?.[0]?.text ?? '').includes('[xezar event notification]')) },
      { name: 'a model reaction followed, with nobody typing anything', required: 'pi itself sent a new inference request that CARRIED the event', observed: carrying ? { request: carrying.n, carriesTheRow: row ? carrying.lastText.includes(row.eventId) : 'no row to look for', decision: carrying.decision } : `no request carried the notification among ${caused.length}`, ok: arrived === true && carrying !== undefined && row !== undefined && carrying.lastText.includes(row.eventId) },
      {
        name: 'no status-polling turn brought it about',
        required: 'the event turn is the ONLY model request in the session, and the 30 s heartbeat adds none',
        observed: {
          before,
          afterTurn,
          afterQuietWindow: afterQuiet,
          requests: caused.map((r) => `#${r.n} ${r.decision}`),
          // Named rather than counted: a request this run did not cause is a contaminated fixture, not
          // a polling leader, and the two must never read the same.
          ...(foreign.length === 0 ? {} : { foreignRequests: foreign.map((r) => `#${r.n} ${r.lastText.slice(0, 80)}`) }),
        },
        ok: afterTurn === before + 1 && afterQuiet === afterTurn,
      },
      { name: 'the model was still offered every xezar tool in that request (PI-04)', required: 'the reaction turn’s tool list holds the bridge’s tools — both legs on one pi process', observed: carrying?.tools ?? [], ok: (carrying?.tools.length ?? 0) >= 11 },
      { name: 'delivery and reaction are reported separately, and both advanced', required: 'deliveredSeq and reactedSeq both reach the journal’s latest (§ 6.6)', observed: delivery, ok: delivery !== null && delivery.deliveredSeq >= 1 && delivery.reactedSeq >= 1 && delivery.reactedSeq === delivery.latestSeq },
      {
        name: 'a REAL model reaction',
        required: 'a real model’s turn acts on the delivered event',
        observed: 'not observable: § 9 forbids personal accounts, so the model here is the scripted OpenAI-completions endpoint. pi really started a turn and really sent an inference request carrying the event; what a real model decides is not measured (OB-5 / PI-4, open for all four clients)',
        ok: null,
      },
    ];
    const measured = checks.filter((c) => c.ok !== null);
    const entry = record({
      case: 'A-19',
      client: 'pi',
      verdict: verdictOf(checks),
      summary: `${measured.filter((c) => c.ok).length} of ${measured.length} measured checks met; ${afterTurn - before} model request(s) caused by the event, ${afterQuiet - afterTurn} more in the quiet window`,
      missing: 'a REAL model reaction (OB-5 / PI-4), which no § 9 fixture may observe for any client. Everything else in this row was executed.',
      checks,
      transcripts: [world.serve.transcript.name, world.transcript.name, 'scripted-model-endpoint.log'],
      fixture: {
        serve: 'real xezar serve (dist/index.js), XEZ_DRY_RUN=1',
        pi: `${fx.clients.pi.version} --mode rpc, both legs on ONE process: pi-mcp-adapter ${fx.piInstall!.version} (the MCP client) and scripts/pi-leader-extension.ts (the reaction link)`,
        link: 'LeaderDelivery → adapters/pi-link.ts → the extension’s 0700 Unix socket → adapters/pi.ts',
        model: 'scripted OpenAI-completions endpoint in this process; every request counted there, never read from pi',
      },
    });
    fx.reaction.pi = entry;
    settle(t, entry);
  });

  for (const client of CLIENTS_WITHOUT_ADAPTER) {
    test(`[${client}] an idle connected client’s model reacts to a delivered event without polling`, (t) => {
      const setup = fx.setup[client];
      const checks: Check[] = [
        { name: 'client connected with the A-01 setup', required: 'A-01 client leg reached A', observed: setup?.verdict ?? 'no A-01 record', ok: setup ? setup.checks.some((c) => c.name.startsWith('the client reaches A') && c.ok === true) : null },
        // Corrected for this revision, read from source rather than carried over: `startMcpService`
        // DOES construct a `LeaderDelivery` and an `EventController` now (#311), and a pi leader is
        // really delivered to (the `[pi]` case above). What is missing for these three is narrower and
        // has not moved: `LeaderDelivery.#act` builds a target for `opencode` and `pi` only, and
        // `mcpLeaderActionInput` (packages/contract/src/mcp-leader.ts) accepts no other client — so no
        // Claude Code or Codex session can be attached, and a terminal session of either has no
        // address xezar could attach to. Their verdict is unchanged and was not re-measured here.
        { name: 'delivery to the client is observed', required: 'the service constructs this client’s reaction adapter and delivers a journal row to it', observed: 'no attach path exists for this client — read from source: `LeaderDelivery.#act` builds a target for `opencode` and `pi` only, and the contract\'s `client` enum is `[\'opencode\', \'pi\']`', ok: null },
        { name: 'a REAL model reaction follows, with no status-polling turn', required: 'a real model’s turn acts on the delivered event', observed: 'not observable: § 9 forbids personal accounts, so every model here is the scripted endpoint — a turn it answers is not a real model’s reaction (the adapter records #108–#110 say the same)', ok: null },
      ];
      if (!fx.clients[client]) {
        const entry = record({ case: 'A-19', client, verdict: 'NOT-RUN', summary: fx.absent[client] ?? 'client not found', checks, fixture: {} });
        fx.reaction[client] = entry;
        return settle(t, entry);
      }
      const entry = record({
        case: 'A-19',
        client,
        verdict: 'BLOCKED',
        summary: 'no attach path exists for this client, and no real model may be used in a § 9 fixture',
        missing: 'an adapter and an attach path for this client (F-20): `LeaderDelivery.#act` and the contract\'s `client` enum admit `opencode` and `pi` only, and no real model has answered a request — leader decision, out of release 0.14.0. Not passed on documentation.',
        checks,
        fixture: { client: fx.clients[client]!.version },
      });
      fx.reaction[client] = entry;
      settle(t, entry);
    });
  }
});

// ---- A-20: the leader half ------------------------------------------------------------------

describe('A-20 — MCP changes reach the cockpit, human changes reach the leader, no echo loop', () => {
  test('[product] a leader mutation reaches the cockpit’s stream; human changes reach the leader; reconnect reconciles', async (t) => {
    const base = mkdtempSync(join(fx.scratch, 'live-'));
    const root = makeRepo(base, 'project-live');
    const home = join(base, 'home');
    const serve = await startServe(root, home, 'a20-product-serve', join(base, 'agent-home'));
    const env = isolatedEnv(join(base, 'bridge-home'), { XEZ_HOME: home, XEZ_DRY_RUN: '1' });
    const stream = new AbortController();
    const cancelLater: string[] = [];
    try {
      const created = await cockpit(serve, '/api/v1/runs', 'POST', { workflow: 'quick-task', task: 'mock:done a finished task for A-20', autonomous: true });
      const runId: string | undefined = created.json?.id;
      await waitFor('the A-20 task to finish', async () => ((await runStatus(serve, runId)) === 'done' ? true : undefined), 60_000);
      // The cockpit's one live stream (packages/web/src/api/global-events.tsx), opened before the leader acts.
      let streamText = '';
      void fetch(`${serve.base}/api/v1/workspace/events`, { signal: stream.signal, headers: { accept: 'text/event-stream' } })
        .then(async (res) => {
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            streamText += decoder.decode(value, { stream: true });
          }
        })
        .catch(() => undefined);
      await delay(500);
      const leader = await openBridge('a20-leader-bridge', root, env);
      const listed = await leader.rpc.request('tools/list');
      const tools = (listed.result?.tools ?? []) as Array<{ name: string; description?: string; inputSchema?: unknown }>;
      const title = `A-20 leader title ${Date.now()}`;
      const leaderRead = await leader.rpc.request('tools/call', { name: 'task_read', arguments: { view: 'task', taskId: runId } });
      const mutation = await leader.rpc.request('tools/call', {
        name: 'organise_work',
        arguments: { action: 'set_title', runId, title, expectedVersion: versionIn(leaderRead), operationId: 'op-a20-rename' },
      });
      await waitFor('the cockpit stream to carry the leader title', () => (streamText.includes(title) ? true : undefined), 5_000).catch(() => undefined);

      // The leader's own effect that IS significant: it cancels a task. Its row must name its operation.
      const victim = await cockpit(serve, '/api/v1/runs', 'POST', { workflow: 'quick-task', task: 'mock:slow cancelled by the leader', autonomous: true });
      const victimId: string | undefined = victim.json?.id;
      await delay(1_500);
      // `execution_control` carries the leader's own operation key (#264), and the journal row names
      // it, so the catalog and the echo guard know the change as this leader's.
      // A RUNNING task's version moves with its agent's events (#250), so a cancel can meet a newer
      // version than the one read; the leader does what the refusal says — read again, decide again.
      // Each of those is a NEW decision, so each carries a new key: reusing one would replay the
      // stored refusal instead of trying the fresh version (D-06 § 5.2, § 6).
      let cancelAttempt = 0;
      const readThenCancel = async () => {
        const read = await leader.rpc.request('tools/call', { name: 'task_read', arguments: { view: 'task', taskId: victimId } });
        cancelAttempt += 1;
        return leader.rpc.request('tools/call', {
          name: 'execution_control',
          arguments: { action: 'cancel', runId: victimId, expectedVersion: versionIn(read), operationId: `op-a20-cancel-${cancelAttempt}` },
        });
      };
      let leaderCancel = await readThenCancel();
      for (let tries = 0; tries < 20 && toolText(leaderCancel).includes('stale_version'); tries += 1) leaderCancel = await readThenCancel();
      await waitFor('the leader cancel to land', async () => ((await runStatus(serve, victimId)) === 'cancelled' ? true : undefined), 20_000).catch(() => undefined);
      const beforeHuman = readJournal(root)?.length ?? 0;

      // Significant HUMAN changes through the cockpit's own door: a queued prompt edit (E-04) and a
      // project configuration write (E-05).
      let queuedId: string | undefined;
      for (let i = 0; i < 6 && !queuedId; i += 1) {
        const slow = await cockpit(serve, '/api/v1/runs', 'POST', { workflow: 'quick-task', task: `mock:slow filler ${i}`, autonomous: true });
        if (slow.json?.id) cancelLater.push(slow.json.id);
        if (slow.json?.status === 'queued') queuedId = slow.json.id;
      }
      const promptEdit = queuedId ? await cockpit(serve, `/api/v1/runs/${queuedId}`, 'PATCH', { task: 'mock:slow the human rewrote this queued prompt' }) : undefined;
      const configWrite = await cockpit(serve, '/api/v1/config', 'PUT', { systemPrompt: 'A-20 human project instruction' });
      await delay(1_000);
      const rows = readJournal(root) ?? [];
      const humanRows = rows.slice(beforeHuman).filter((r) => r.origin === 'human');
      const leaderRow = rows.find((r) => r.subject.id === victimId && r.kind === 'task.cancelled');

      // Can the leader receive the human rows? Any tool that describes itself as reading events —
      // `leader_events` (#251) on main today — asked to `read` when its schema offers that action.
      const readers = tools.filter((tool) => /event|journal|acknowledg|outstanding/i.test(`${tool.name} ${tool.description ?? ''}`) && tool.name !== 'task_read');
      const readArgs = (tool: (typeof tools)[number]): Record<string, unknown> =>
        ((tool.inputSchema as { properties?: { action?: { enum?: string[] } } } | undefined)?.properties?.action?.enum ?? []).includes('read') ? { action: 'read' } : {};
      const received: Record<string, string> = {};
      for (const reader of readers) received[reader.name] = toolText(await leader.rpc.request('tools/call', { name: reader.name, arguments: readArgs(reader) }));
      const humanReachesLeader = humanRows.length > 0 && Object.values(received).some((text) => humanRows.every((row) => text.includes(row.eventId)));
      await leader.rpc.close();

      // Reconnect: a fresh session reads the current state, the human's edit included — and, until
      // the leader acknowledges, the same outstanding events again (at-least-once, F-21).
      const again = await openBridge('a20-reconnect-bridge', root, env);
      const reread = queuedId ? await again.rpc.request('tools/call', { name: 'task_read', arguments: { view: 'task', taskId: queuedId } }) : undefined;
      const rereadTitle = await again.rpc.request('tools/call', { name: 'task_read', arguments: { view: 'task', taskId: runId } });
      const events = readers.find((tool) => tool.name === 'leader_events');
      let replay: { beforeAck: boolean; acked: string; afterAck: boolean } | undefined;
      if (events) {
        const first = toolText(await again.rpc.request('tools/call', { name: events.name, arguments: { action: 'read' } }));
        const cursor = /"nextCursor":"([^"]+)"/.exec(first)?.[1];
        // #264 made every mutating tool action carry an `operationId`, and `ack` is one. Without it
        // the call is refused with "ack needs operationId", which read as "the ack did not stick".
        const acked = cursor ? toolText(await again.rpc.request('tools/call', { name: events.name, arguments: { action: 'ack', cursor, operationId: `op-a20-ack-${Date.now()}` } })) : 'no nextCursor to ack';
        const after = toolText(await again.rpc.request('tools/call', { name: events.name, arguments: { action: 'read' } }));
        replay = { beforeAck: humanRows.length > 0 && humanRows.every((row) => first.includes(row.eventId)), acked: acked.slice(0, 160), afterAck: humanRows.some((row) => after.includes(row.eventId)) };
      }
      await again.rpc.close();
      const rereadText = reread ? toolText(reread) : '';

      const checks: Check[] = [
        { name: 'an MCP mutation reaches the cockpit’s live stream without reload', required: 'the leader’s new title arrives on GET /api/v1/workspace/events', observed: { tool: toolText(mutation).slice(0, 120), streamCarriedTitle: streamText.includes(title), streamBytes: streamText.length }, ok: !mutation.result?.isError && streamText.includes(title) },
        { name: 'a human queued-prompt edit reaches the journal (E-04)', required: 'a human-origin goal.changed row', observed: { edit: promptEdit?.status ?? 'no queued task to edit', rows: humanRows.map((r) => r.kind) }, ok: humanRows.some((r) => r.kind === 'goal.changed') },
        { name: 'a human configuration write reaches the journal (E-05)', required: 'a human-origin config.changed row after PUT /api/v1/config', observed: { write: configWrite.status, rows: humanRows.map((r) => r.kind) }, ok: humanRows.some((r) => r.kind === 'config.changed') },
        { name: 'the human changes reach the leader', required: 'a leader tool (or delivery) hands the leader every one of those rows (F-21)', observed: { readerTools: readers.map((r) => r.name), humanEventIds: humanRows.map((r) => r.eventId), received: Object.fromEntries(Object.entries(received).map(([k, v]) => [k, v.slice(0, 300)])) }, ok: humanReachesLeader },
        { name: 'reconnect reconciles', required: 'a new session reads current state: the human’s prompt edit and the leader’s title', observed: { queued: rereadText.slice(0, 160), titled: toolText(rereadTitle).includes(title) }, ok: rereadText.includes('the human rewrote this queued prompt') && toolText(rereadTitle).includes(title) },
        { name: 'reconnect re-delivers what was not acknowledged, and nothing after the ack', required: 'a new session’s read returns the human events again; after ack a read no longer does (F-21, N-10)', observed: replay ?? 'no leader_events tool', ok: replay ? replay.beforeAck && !replay.afterAck : false },
        { name: 'the leader’s own significant effect is marked as its echo', required: 'the row it caused is origin `leader` with the operation that caused it, which the echo guard withholds from that leader', observed: { tool: toolText(leaderCancel).slice(0, 120), row: leaderRow ? { origin: leaderRow.origin, causedBy: leaderRow.causedBy } : 'no task.cancelled row' }, ok: leaderRow?.origin === 'leader' && typeof leaderRow.causedBy === 'string' && leaderRow.causedBy.length > 0 },
        { name: 'no recursive leader loop from echoes, logs, tokens or visual changes', required: 'observed end to end: a delivered echo starts no new leader turn', observed: 'not observable: nothing delivers journal rows to a leader (see A-19), so no loop can be observed — only its precondition above', ok: null },
      ];
      const entry = record({
        case: 'A-20',
        client: '(leader half, real xezar serve)',
        verdict: verdictOf(checks),
        summary: checks.filter((c) => c.ok === true).map((c) => c.name).join('; ') || 'nothing passed',
        missing: [
          checks[2]!.ok ? undefined : 'the E-05 writer hooks: `EventCatalog.configChanged`/`workflowChanged`/`agentConfigChanged` have no production caller, so a human configuration write never reaches the journal',
          checks[3]!.ok ? undefined : 'a leader read/acknowledge tool: no MCP tool hands the leader journal rows, and nothing pushes them',
          'push delivery (out of release 0.14.0), so the loop clause cannot be observed',
        ]
          .filter(Boolean)
          .join('; '),
        checks,
        transcripts: [serve.transcript.name, 'a20-leader-bridge.log', 'a20-reconnect-bridge.log'],
        fixture: { serve: 'real xezar serve, XEZ_DRY_RUN=1', cockpit: 'HTTP same-origin requests and the cockpit’s SSE stream', browserHalf: 'packages/web/e2e/mcp-live-sync.e2e.ts' },
      });
      settle(t, entry);
    } finally {
      stream.abort();
      for (const id of cancelLater) await cockpit(serve, `/api/v1/runs/${id}/cancel`, 'POST').catch(() => undefined);
      await stop(serve.child);
    }
  });

  /**
   * A-20's last clause, for pi. It is BLOCKED in the record for the other three "because nothing
   * delivers rows to a leader, so no loop — or its absence — can be observed". For pi something now
   * does, so the clause itself is measurable: after a REAL reaction, does the reaction's own effects —
   * its echo rows, its logs, its tokens — start another turn, and another?
   *
   * Measured as quiescence, which is what "no recursive loop" means when the delivery path is live:
   * one event produced one turn, and the turn's own aftermath produced none, across a window longer
   * than the controller's own heartbeat. The A-19 pi case must have run first — it is the reaction.
   */
  test('[pi] a delivered event’s own reaction starts no further leader turn', async (t) => {
    if (!fx.clients.pi) {
      const entry = record({ case: 'A-20', client: 'pi', verdict: 'NOT-RUN', summary: fx.absent.pi ?? 'pi not found', checks: [], fixture: {} });
      return settle(t, entry);
    }
    const reaction = fx.reaction.pi;
    if (!reaction || reaction.verdict === 'NOT-RUN') {
      const entry = record({ case: 'A-20', client: 'pi', verdict: 'NOT-RUN', summary: 'the A-19 pi reaction did not run, so there is no reaction whose aftermath could loop', checks: [], fixture: {} });
      return settle(t, entry);
    }
    const world = await piWorld();
    const settledBefore = world.modelRequests();
    const journalBefore = (readJournal(world.root) ?? []).length;
    // Longer than the 30 s heartbeat, with the leader attached, the project owned and the journal
    // holding the row pi already reacted to.
    await delay(45_000);
    const after = world.modelRequests();
    const { foreign } = classifyPiRequests(world.requestsSince(settledBefore));
    const status = await cockpit(world.serve, '/api/v1/mcp/leader');
    const delivery = status.json?.delivery ?? null;
    const journal = readJournal(world.root) ?? [];
    const leaderRows = journal.filter((r) => r.origin === 'leader');
    const checks: Check[] = [
      { name: 'the delivery path is live for this leader', required: 'attached, owned, and no blocker', observed: { leader: status.json?.leader, blocker: status.json?.blocker }, ok: status.json?.leader?.client === 'pi' && status.json?.blocker === null },
      { name: 'the reaction happened', required: 'A-19 for pi recorded a model request that carried the event', observed: { case: reaction.verdict, reactionCheck: reaction.checks.find((c) => c.name.startsWith('a model reaction followed'))?.ok ?? 'not recorded' }, ok: reaction.checks.some((c) => c.name.startsWith('a model reaction followed') && c.ok === true) },
      {
        name: 'no recursive leader loop from echoes, logs, tokens or visual changes',
        required: 'over a window longer than the 30 s heartbeat, the reaction’s own aftermath starts no further model request',
        observed: {
          requestsBefore: settledBefore,
          requestsAfter: after,
          windowMs: 45_000,
          journalRows: `${journalBefore} → ${journal.length}`,
          leaderOriginRows: leaderRows.map((r) => r.kind),
          ...(foreign.length === 0 ? {} : { foreignRequests: foreign.map((r) => `#${r.n} ${r.lastText.slice(0, 80)}`) }),
        },
        ok: after === settledBefore,
      },
      { name: 'the cursors came to rest', required: 'reactedSeq equals latestSeq and the controller is idle, so nothing is owed and nothing is retried', observed: delivery, ok: delivery !== null && delivery.reactedSeq === delivery.latestSeq && delivery.state === 'idle' },
    ];
    const entry = record({
      case: 'A-20',
      client: 'pi',
      verdict: verdictOf(checks),
      summary: after === settledBefore ? `quiet for 45 s after a real reaction: ${after} model requests in the session's whole life, cursors at rest` : `the session kept asking the model: ${settledBefore} → ${after}`,
      checks,
      transcripts: [world.serve.transcript.name, world.transcript.name],
      fixture: {
        note: 'the cockpit half of A-20 and the rest of its leader half are not client-specific; this case measures ONLY the clause the record has as BLOCKED for want of a delivery path',
        browserHalf: 'packages/web/e2e/mcp-live-sync.e2e.ts',
      },
    });
    settle(t, entry);
  });
});

// ---- A-23: native client vs another owner; three clients --------------------------------

describe('A-23 — one exclusive owner across clients; Claude Code, Codex and OpenCode each pass setup and reaction', () => {
  for (const client of CLIENTS) {
    test(`[${client}] local setup, reaction, and exclusivity against another owner`, (t) => {
      if (!fx.clients[client]) {
        const entry = record({ case: 'A-23', client, verdict: 'NOT-RUN', summary: fx.absent[client] ?? 'client not found', checks: [], fixture: {} });
        return settle(t, entry);
      }
      const setup = fx.setup[client];
      const reaction = fx.reaction[client];
      const competing = fx.competing[client];
      const setupOk = setup ? setup.checks.filter((c) => !c.name.startsWith('what the setup added')).every((c) => c.ok === true) : false;
      const checks: Check[] = [
        { name: 'local setup (A-01 client leg)', required: 'the one-time setup works and the client reaches A', observed: setup ? `${setup.verdict}: ${setup.summary}` : 'not recorded', ok: setupOk },
        { name: 'reaction (A-19)', required: 'a real model reaction to a delivered event', observed: reaction ? `${reaction.verdict}: ${reaction.summary}` : 'not recorded', ok: reaction?.verdict === 'PASSED' ? true : reaction?.verdict === 'BLOCKED' ? null : false },
        { name: 'exclusive owner against another owner of A', required: 'refused as occupied while another client owns A; handover only after that ownership ends', observed: competing?.observed ?? 'not recorded', ok: competing?.ok ?? false },
        { name: 'no covert second leader', required: 'two leaders never hold A at once', observed: competing && competing.ok === false ? 'two clients held A at once in A-17' : 'see A-17', ok: competing?.ok ?? false },
      ];
      const entry = record({
        case: 'A-23',
        client,
        verdict: verdictOf(checks),
        summary: `setup ${setup?.verdict ?? 'n/a'}; reaction ${reaction?.verdict ?? 'n/a'}; exclusivity ${competing?.ok ? 'held' : 'not enforced'}`,
        missing: [
          competing?.ok ? undefined : OWNERSHIP_GAP,
          'Reaction: see A-19',
          'The built-in leader half is out of scope (#118: the built-in leader is specified separately) and was NOT RUN; a second native client stood in as "the other owner"',
        ]
          .filter(Boolean)
          .join('. '),
        checks,
        fixture: { derivedFrom: ['A-01', 'A-17', 'A-19'] },
      });
      settle(t, entry);
    });
  }
});

/**
 * A restart on PI's side — the half WP2 named as WP5's job, because only the xezar side was restarted
 * there. It has to come last in the file: it ends the pi every case above shares.
 *
 * What must hold is the recoverable shape, not survival: the person's pi is theirs to close, and when
 * they do, xezar must say so in a way they can act on and keep the rows. So: the extension removes its
 * descriptor and its private directory, the leader status reports the adapter's own recoverable
 * blocker rather than pretending, and a fresh pi announces itself again and can be attached again.
 */
describe('A-18 — a restart on pi’s own side (#330 WP5)', () => {
  test('[pi] when the person’s pi exits, the link is dropped, said plainly, and a new pi can be attached', async (t) => {
    if (!fx.clients.pi) {
      const entry = record({ case: 'A-18', client: 'pi (pi-side restart)', verdict: 'NOT-RUN', summary: fx.absent.pi ?? 'pi not found', checks: [], fixture: {} });
      return settle(t, entry);
    }
    const world = await piWorld();
    const descriptorPath = join(world.root, '.local/xezar/pi-leader.json');
    const socketPath = (world.descriptor as { endpoint?: { socket?: string } } | undefined)?.endpoint?.socket;
    const socketDir = socketPath === undefined ? undefined : dirname(socketPath);
    // The person closes their pi. Its own handle, never a pattern (#156).
    await world.rpc.close();
    await delay(2_000);
    const gone = !existsSync(descriptorPath);
    const socketGone = socketPath === undefined ? undefined : !existsSync(socketPath);
    const dirGone = socketDir === undefined ? undefined : !existsSync(socketDir);
    const afterExit = await cockpit(world.serve, '/api/v1/mcp/leader');
    // A second pi, the way the person would start one again.
    const pi2 = makePiHome('world2', fx.piInstall!, { xezHome: world.serve.home, endpointPort: fx.endpoint.port });
    const transcript2 = new Transcript('pi-world-rpc-2');
    const rpc2 = new PiRpc(fx.clients.pi.bin, piArgs(pi2, ['--extension', PI_EXTENSION]), { cwd: world.root, env: pi2.env, transcript: transcript2 });
    let reattach: { status: number; json: any } = { status: 0, json: 'not attempted' };
    let announced = false;
    try {
      announced = await waitFor('the new pi to announce itself', () => (existsSync(descriptorPath) ? true : undefined), 120_000).catch(() => false);
      await waitForNotice(rpc2, 120_000);
      reattach = await cockpit(world.serve, '/api/v1/mcp/leader', 'POST', { action: 'attach', client: 'pi' });
    } finally {
      await rpc2.close();
    }
    const checks: Check[] = [
      { name: 'the extension removed its descriptor when pi exited', required: 'no stale pi-leader.json naming a dead socket', observed: gone ? 'removed' : 'still present after pi exited', ok: gone },
      { name: 'the socket and its private directory went with it', required: 'nothing of the leader transport is left behind in the temporary directory', observed: { socketGone, dirGone, dir: socketDir }, ok: socketGone === true && dirGone === true },
      { name: 'xezar says the link is gone, recoverably', required: "a blocker naming pi's own reason and a fix, never a silent attached leader", observed: { leader: afterExit.json?.leader, blocker: afterExit.json?.blocker }, ok: typeof afterExit.json?.blocker?.code === 'string' && typeof afterExit.json?.blocker?.fix === 'string' && afterExit.json.blocker.fix.length > 0 },
      { name: 'nothing was lost: the rows are still there', required: 'the journal still holds what pi had reacted to', observed: `${(readJournal(world.root) ?? []).length} journal rows`, ok: (readJournal(world.root) ?? []).length > 0 },
      { name: 'a new pi announces itself in the same project', required: 'the descriptor is written again, with no human configuration step', observed: announced ? 'pi-leader.json written again' : 'no descriptor from the second pi', ok: announced },
      { name: 'and it can be attached again', required: '`attach` answers 200 with a pi leader', observed: { status: reattach.status, leader: reattach.json?.leader ?? reattach.json?.error }, ok: reattach.status === 200 && reattach.json?.leader?.client === 'pi' },
    ];
    const entry = record({
      case: 'A-18',
      client: 'pi (pi-side restart)',
      verdict: verdictOf(checks),
      summary: checks.every((c) => c.ok) ? "the person's pi exited, the link was dropped and named, and a fresh pi attached again with nothing configured" : 'a pi-side restart did not recover cleanly; see the checks',
      checks,
      transcripts: [world.transcript.name, 'pi-world-rpc-2.log', world.serve.transcript.name],
      fixture: { note: 'WP2 restarted only the xezar side (R-03); this is the pi side, which it named as WP5’s' },
    });
    settle(t, entry);
  });
});

// Guards the evidence itself (F-15): nothing this run wrote may carry a world secret.
describe('evidence hygiene', () => {
  test('no secret of the world reached a transcript or the results', () => {
    const hits: string[] = [];
    for (const secret of fx.world.secrets) {
      try {
        const out = execFileSync('grep', ['-rlF', '--', secret, OUT], { encoding: 'utf8' }).trim();
        if (out) hits.push(createHash('sha256').update(secret).digest('hex').slice(0, 12));
      } catch {
        /* grep exits 1 when nothing matched — the good case */
      }
    }
    assert.deepEqual(hits, [], 'a world secret reached the evidence directory');
    assert.ok(fx.world.secrets.length > 0, 'populated-input guard: the world must hold at least one secret for this search to mean anything');
  });
});
