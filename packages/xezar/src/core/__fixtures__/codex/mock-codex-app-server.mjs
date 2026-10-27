#!/usr/bin/env node
// Test-only mock of `codex app-server` — speaks just enough JSON-RPC 2.0
// JSONL (§3 of agent-event-protocols.md) for the runner wiring test in
// `codex-ui-mapper.test.ts`: initialize/thread/turn handshake, one scripted
// turn with an agentMessage + a commandExecution (with live outputDelta),
// cumulative token usage, then exits on stdin EOF like the real server.
//
// `MOCK_CODEX_IGNORE_EOF=1` switches to the #703 teardown shape instead: the
// server stays deaf to stdin EOF (the CLI hang the EOF watchdog exists for)
// and handles SIGTERM itself, exiting 143 rather than dying from the signal.
// `MOCK_CODEX_SIGTERM_EXIT_CODE=<n>` (with IGNORE_EOF) exits n instead of 143 on
// SIGTERM – `1` is what a Windows stop (TerminateProcess) leaves, reproduced on
// every OS (#963).
// `MOCK_CODEX_FOREIGN_SIGNAL_EXIT=1` is the #156 mirror image: a clean turn
// followed by an unsolicited 143, as if a peer process had signalled it.
//
// `MOCK_CODEX_AMBIENT=1` is the #324 shape: `config/read` reports an MCP server
// from the person's own home config, one from the project's `.codex/`, xezar's
// bridge registered in the project (under three launch lines), a project server
// the home config tweaks and a home server named `__proto__` — and
// thread/start|resume refuse a `config` that does not switch off
// everything but the project's own server, plugins and apps included.
// #1007: it also reports `clash`, a project server the home config names too.
// Asked with `includeLayers: true`, the answer carries each layer's own table,
// and the thread must get `clash` as the project layer alone defines it.
// `MOCK_CODEX_CONFIG_READ_ERROR=1` answers `config/read` with an error, the
// shape of a Codex CLI that cannot say which servers it would load.
//
// #849: `MOCK_CODEX_EXPECT_SANDBOX=<mode>` makes thread/start|resume refuse any
// other `sandbox`, and `MOCK_CODEX_THREAD_LOG=<file>` appends each of those two
// requests (method + params) to that file so a test can pin them whole.
//
// #1026: `MOCK_CODEX_MCP_STARTUP_FAILED=1` follows thread/start with MCP startup
// statuses: `browser` fails, `docs` gets ready, and a child thread's `other` fails.
// #1057: `docs` reports ready twice, a child thread's `helper` gets ready, and
// `mcpServerStatus/list` answers for `th_mock_1` in two pages (`docs` with three
// tools on the second). `MOCK_CODEX_MCP_STATUS_LIST=error` answers it with an error.
//
// #895: a turn whose text contains `mock:exit-mid-turn` starts, streams one line of prose, and
// then the server exits 0 without `turn/completed`, the shape of a Codex CLI that dies under a
// live turn. `mock:exit-mid-turn-orphan` first starts a detached grandchild that inherits stdout
// and keeps the pipe open after the server is gone, as a tool process Codex started would; it
// writes its pid to `MOCK_CODEX_ORPHAN_PID_FILE` so the test can stop it, and ends itself after
// 60 seconds in any case.
//
// #942: `MOCK_CODEX_RESUME_HISTORY_CHARS=<n>` answers thread/resume the way a real
// Codex does for a long session: the whole history in the one response line,
// padded to n characters — unless the request sets `excludeTurns: true`.
// `MOCK_CODEX_IGNORE_EXCLUDE_TURNS=1` is a Codex too old to know that field.
//
// #1030: a turn whose text contains `mock:bash-crash` runs one command whose Git Bash dies the way
// it does in Codex's Windows sandbox, then waits; `turn/interrupt` ends it as `interrupted`. A turn
// started with `sandboxPolicy: { type: 'dangerFullAccess' }` runs normally, unless
// `MOCK_CODEX_BASH_CRASH=always`, which crashes every turn. `MOCK_CODEX_HOOK_PROBES=<json array of
// { tool_name, tool_input }>` (with MOCK_CODEX_HOOK_LOG) sends each probe to the registered
// read-only hook on every turn/start and logs the answer with that turn's `sandboxPolicy`.
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const rl = createInterface({ input: process.stdin });

const ambient = process.env.MOCK_CODEX_AMBIENT === '1';
let registeredHook;
let hookTrusted = false;

const CLASH_PROJECT = { command: 'node', args: ['tools/clash.mjs'], default_tools_approval_mode: 'prompt' };
const CLASH_HOME = { command: 'npx', args: ['-y', 'clash-mcp@latest'], tools: { probe: { approval_mode: 'approve' } } };
/** What the thread must carry for `clash`: the project table, the home tool's mode pinned to the project default. */
const CLASH_OVERRIDE = { ...CLASH_PROJECT, tools: { probe: { approval_mode: 'prompt' } } };

function configReadResult(params) {
  if (!ambient) return { config: { mcp_servers: {} }, origins: {} };
  const user = { name: { type: 'user', file: '/home/u/.codex/config.toml', profile: null }, version: 'sha256:u' };
  const project = { name: { type: 'project', dotCodexFolder: '/repo/.codex' }, version: 'sha256:p' };
  const result = {
    config: {
      mcp_servers: {
        ambient: { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
        projsrv: { command: 'node', args: ['tools/mcp.mjs'] },
        xezar: { command: 'npx', args: ['-y', '@qodeca/xezar', 'mcp'] },
        mixed: { command: 'node', args: ['tools/other.mjs'], env: { TOOL_HOME: '/home/u/tool' } },
        // The bridge under other names and launch lines (#415 review): through `env`, and
        // through node running the package's bin directly.
        envleader: { command: '/usr/bin/env', args: ['xezar', 'mcp'] },
        nodeleader: { command: 'node', args: ['/opt/node_modules/@qodeca/xezar/dist/index.js', 'mcp'] },
        clash: { ...CLASH_PROJECT, tools: CLASH_HOME.tools },
      },
    },
    origins: {
      'mcp_servers.ambient.command': user,
      'mcp_servers.ambient.args.0': user,
      'mcp_servers.projsrv.command': project,
      'mcp_servers.projsrv.args.0': project,
      'mcp_servers.xezar.command': project,
      'mcp_servers.mixed.command': project,
      'mcp_servers.mixed.env.TOOL_HOME': user,
      'mcp_servers.envleader.command': project,
      'mcp_servers.envleader.args.0': project,
      'mcp_servers.nodeleader.command': project,
      'mcp_servers.nodeleader.args.0': project,
      'mcp_servers.__proto__.command': user,
      'mcp_servers.clash.command': project,
      'mcp_servers.clash.args.0': project,
      'mcp_servers.clash.default_tools_approval_mode': project,
      'mcp_servers.clash.tools.probe.approval_mode': user,
    },
  };
  if (params?.includeLayers === true) {
    result.layers = [
      {
        ...project,
        config: { mcp_servers: {
          projsrv: { command: 'node', args: ['tools/mcp.mjs'] },
          xezar: { command: 'npx' },
          mixed: { command: 'node' },
          envleader: { command: '/usr/bin/env', args: ['xezar', 'mcp'] },
          nodeleader: { command: 'node', args: ['/opt/node_modules/@qodeca/xezar/dist/index.js', 'mcp'] },
          clash: CLASH_PROJECT,
        } },
      },
      {
        ...user,
        config: { mcp_servers: {
          ambient: { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
          mixed: { env: { TOOL_HOME: '/home/u/tool' } },
          clash: CLASH_HOME,
        } },
      },
    ];
  }
  // A home server named `__proto__`, as an OWN key — the way JSON.parse delivers it from the
  // real app-server (observed with codex-cli 0.154.0). An object literal cannot spell that.
  Object.defineProperty(result.config.mcp_servers, '__proto__', {
    value: { command: 'node', args: ['proto.mjs'] },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return result;
}

/** What is wrong with a thread's `config` override under MOCK_CODEX_AMBIENT, or null. */
function isolationProblem(config) {
  if (!ambient) return null;
  const servers = config?.mcp_servers ?? {};
  for (const name of ['ambient', 'xezar', 'mixed', 'envleader', 'nodeleader', '__proto__']) {
    // `Object.hasOwn`: an inherited `__proto__` is Object.prototype, not an override for the server.
    if (!Object.hasOwn(servers, name) || servers[name]?.enabled !== false) return `MCP server ${name} was not switched off`;
  }
  if (servers.projsrv?.enabled === false) return 'the project server projsrv was switched off';
  if (JSON.stringify(servers.clash) !== JSON.stringify(CLASH_OVERRIDE)) return 'the project server clash did not get the project-only definition';
  if (config?.features?.plugins !== false || config?.features?.apps !== false) return 'plugins and apps were not switched off';
  return null;
}

const ignoreEof = process.env.MOCK_CODEX_IGNORE_EOF === '1';
if (ignoreEof) {
  process.on('SIGTERM', () => {
    if (process.env.MOCK_CODEX_IGNORE_SIGTERM !== '1') process.exit(Number(process.env.MOCK_CODEX_SIGTERM_EXIT_CODE ?? 143));
  });
  // Keep the event loop alive so EOF alone can never end the process.
  setInterval(() => {}, 60_000);
}

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (process.env.MOCK_CODEX_RPC_LOG && msg.method) {
    appendFileSync(process.env.MOCK_CODEX_RPC_LOG, `${JSON.stringify({ method: msg.method, params: msg.params })}\n`);
  }
  if (msg.id === 'ask-1' && msg.result) {
    const answer = msg.result.answers?.library?.answers;
    const freeText = msg.result.answers?.first?.answers;
    emit((Array.isArray(answer) && answer[0] === 'Vitest') || (Array.isArray(freeText) && freeText[0] === 'Use sensible defaults')
      ? { method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } }
      : { method: 'turn/failed', params: { turn: { id: 'turn_mock_1', status: 'failed' }, error: { message: 'bad answer' } } });
  } else if (msg.method === 'initialize') {
    emit({ id: msg.id, result: {
      userAgent: 'mock-codex/0.0.0',
      ...(process.env.MOCK_CODEX_OMIT_HOME !== '1' && (process.env.MOCK_CODEX_HOME ?? process.env.CODEX_HOME)
        ? { codexHome: process.env.MOCK_CODEX_HOME ?? process.env.CODEX_HOME }
        : {}),
    } });
  } else if (msg.method === 'config/read') {
    emit(process.env.MOCK_CODEX_CONFIG_READ_ERROR === '1'
      ? { id: msg.id, error: { code: -32601, message: 'Method not found: config/read' } }
      : { id: msg.id, result: configReadResult(msg.params) });
  } else if (msg.method === 'hooks/list') {
    const hook = registeredHook
      ? [{
          key: 'session:pre_tool_use:0:0',
          command: registeredHook.command,
          matcher: registeredHook.matcher,
          enabled: true,
          currentHash: 'sha256:mock-hook',
          trustStatus: hookTrusted ? 'trusted' : 'untrusted',
        }]
      : [];
    emit({ id: msg.id, result: { data: [{ cwd: msg.params?.cwds?.[0], hooks: hook, warnings: [], errors: [] }] } });
  } else if (msg.method === 'config/batchWrite') {
    if (process.env.MOCK_CODEX_REJECT_HOOK_TRUST === '1') {
      emit({ id: msg.id, error: { code: -32603, message: 'mock trust store is read-only' } });
    } else {
      hookTrusted = true;
      emit({ id: msg.id, result: { status: 'ok', filePath: '/mock/config.toml' } });
    }
  } else if (msg.method === 'mcpServerStatus/list') {
    const tool = (name) => ({ name, inputSchema: { type: 'object' } });
    if (process.env.MOCK_CODEX_MCP_STATUS_LIST === 'error' || msg.params?.threadId !== 'th_mock_1') {
      emit({ id: msg.id, error: { code: -32603, message: 'mock MCP status listing is unavailable' } });
    } else if (msg.params?.cursor !== 'page-2') {
      emit({ id: msg.id, result: { nextCursor: 'page-2', data: [
        { name: 'browser', authStatus: 'unsupported', tools: {}, resources: [], resourceTemplates: [], toolsError: 'not started' },
        { name: 'helper', authStatus: 'unsupported', tools: { only: tool('only') }, resources: [], resourceTemplates: [] },
      ] } });
    } else {
      emit({ id: msg.id, result: { nextCursor: null, data: [
        { name: 'docs', authStatus: 'unsupported', tools: { search: tool('search'), read: tool('read'), list: tool('list') }, resources: [], resourceTemplates: [], toolsError: null },
      ] } });
    }
  } else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    const problem = isolationProblem(msg.params?.config);
    if (problem) {
      emit({ id: msg.id, error: { code: -32602, message: problem } });
      return;
    }
    if (process.env.MOCK_CODEX_THREAD_LOG) {
      appendFileSync(process.env.MOCK_CODEX_THREAD_LOG, `${JSON.stringify({ method: msg.method, params: msg.params })}\n`);
    }
    registeredHook = msg.params?.config?.hooks?.PreToolUse?.[0]?.hooks?.[0]
      ? {
          command: msg.params.config.hooks.PreToolUse[0].hooks[0].command,
          matcher: msg.params.config.hooks.PreToolUse[0].matcher,
        }
      : undefined;
    const expectedSandbox = process.env.MOCK_CODEX_EXPECT_SANDBOX
      ?? (process.env.XEZ_CODEX_NETWORK === '0' ? 'workspace-write' : 'danger-full-access');
    if (msg.params?.sandbox !== expectedSandbox || msg.params?.approvalPolicy !== 'never') {
      emit({ id: msg.id, error: { code: -32602, message: `expected ${expectedSandbox} auto permissions` } });
      return;
    }
    if (process.argv.includes('sandbox_workspace_write.network_access=true')) {
      emit({ id: msg.id, error: { code: -32602, message: 'workspace-write override is obsolete in full-access mode' } });
      return;
    }
    if (msg.method === 'thread/start') {
      emit({ method: 'thread/started', params: { thread: { id: 'th_mock_1' } } });
      emit({ id: msg.id, result: { thread: { id: 'th_mock_1' } } });
      if (process.env.MOCK_CODEX_MCP_STARTUP_FAILED === '1') {
        const status = (threadId, name, state, error = null) =>
          emit({ method: 'mcpServer/startupStatus/updated', params: { threadId, name, status: state, error, failureReason: null } });
        status('th_mock_1', 'browser', 'starting');
        status('th_mock_1', 'browser', 'failed', 'MCP client for `browser` timed out after 30 seconds.');
        status('th_mock_1', 'docs', 'ready');
        status('th_child_2', 'other', 'failed', 'a sub-agent thread of its own');
        status('th_child_2', 'helper', 'ready');
        status('th_mock_1', 'docs', 'ready');
      }
    } else if (process.env.MOCK_CODEX_REJECT_RESUME === '1') {
      emit({ id: msg.id, error: { code: -32603, message: `no rollout found for thread id ${msg.params?.threadId ?? ''}` } });
      rl.close();
    } else {
      const historyChars = Number(process.env.MOCK_CODEX_RESUME_HISTORY_CHARS ?? 0);
      const withTurns = historyChars > 0
        && (msg.params?.excludeTurns !== true || process.env.MOCK_CODEX_IGNORE_EXCLUDE_TURNS === '1');
      const turns = [{ id: 'turn_old_1', status: 'completed', items: [{ type: 'agentMessage', id: 'msg_old_1', text: 'x'.repeat(historyChars) }] }];
      emit({ id: msg.id, result: { thread: { id: msg.params?.threadId, ...(withTurns ? { turns } : {}) } } });
    }
  } else if (msg.method === 'turn/interrupt') {
    emit({ id: msg.id, result: {} });
    emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: msg.params?.turnId ?? 'turn_mock_1', status: 'interrupted' } } });
  } else if (msg.method === 'turn/start') {
    emit({ id: msg.id, result: { turn: { id: 'turn_mock_1' } } });
    emit({ method: 'turn/started', params: { turn: { id: 'turn_mock_1', status: 'inProgress', items: [] } } });
    const turnText = msg.params?.input?.map?.((part) => part.text ?? '').join('\n') ?? '';
    if (process.env.MOCK_CODEX_HOOK_LOG && registeredHook?.command) {
      const match = registeredHook.command.match(/^(?:& )?'[^']+' '([^']+)' --xezar-read-only-hook$/);
      const probes = process.env.MOCK_CODEX_HOOK_PROBES
        ? JSON.parse(process.env.MOCK_CODEX_HOOK_PROBES)
        : [{ tool_name: 'Bash', tool_input: { command: 'git status' } }];
      for (const probe of probes) {
        const invoked = match
          ? spawnSync(process.execPath, [match[1], '--xezar-read-only-hook'], {
              input: JSON.stringify({
                session_id: 'th_mock_1',
                cwd: msg.params?.cwd ?? process.cwd(),
                hook_event_name: 'PreToolUse',
                model: 'mock',
                permission_mode: 'dontAsk',
                tool_name: probe.tool_name,
                tool_input: probe.tool_input,
                tool_use_id: 'tool_mock_1',
                transcript_path: null,
                turn_id: 'turn_mock_1',
              }),
              encoding: 'utf8',
              env: process.env,
            })
          : { status: -1, stdout: '', stderr: 'could not parse hook command' };
        appendFileSync(
          process.env.MOCK_CODEX_HOOK_LOG,
          `${JSON.stringify(process.env.MOCK_CODEX_HOOK_PROBES
            ? { probe: probe.tool_name, sandboxPolicy: msg.params?.sandboxPolicy ?? null, status: invoked.status, stdout: invoked.stdout, stderr: invoked.stderr }
            : invoked)}\n`,
        );
      }
    }
    const lifted = msg.params?.sandboxPolicy?.type === 'dangerFullAccess';
    if (process.env.MOCK_CODEX_BASH_CRASH === 'always' || (turnText.includes('mock:bash-crash') && !lifted)) {
      const command = ['pwsh', '-Command', 'bash .local/xezar/cache/kit/checks/git-read.sh --help'];
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'commandExecution', id: 'item_crash', command, cwd: '/repo', status: 'inProgress' } } });
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: {
        type: 'commandExecution', id: 'item_crash', command, cwd: '/repo', status: 'failed', exitCode: 1,
        aggregatedOutput: '      0 [main] bash (23784) C:\\Program Files\\Git\\usr\\bin\\bash.exe: *** fatal error - CreateFileMapping S-1-5-21-1000000000-2000000000-3000000000-1001.1, Win32 error 5.  Terminating.\n',
      } } });
      return;
    }
    if (turnText.includes('mock:quota')) {
      emit({ method: 'account/rateLimits/updated', params: {
        rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1790685902 } },
      } });
    }
    if (turnText.includes('mock:usage-limit') || turnText.includes('mock:context-window') || turnText.includes('mock:rate-limit')) {
      // Codex 0.156.0 schema shape (#565): a failed turn is `turn/completed` with `turn.status:
      // "failed"` and a structured `turn.error.codexErrorInfo`; there is no `turn/failed`.
      const usage = turnText.includes('mock:usage-limit');
      const rate = turnText.includes('mock:rate-limit');
      if (usage) {
        emit({ method: 'account/rateLimits/updated', params: { rateLimits: {
          limitId: 'codex', normalModelSlug: null, rateLimitReachedType: 'rate_limit_reached',
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1893456000 },
          secondary: null,
        } } });
      }
      if (rate) {
        // `mock:rate-limit-reached` says the plan limit was reached; `mock:rate-limit` alone does
        // not, which is how a short HTTP rate limit would look. The later weekly window is below
        // 100 %, so it must never date the limit.
        emit({ method: 'account/rateLimits/updated', params: { rateLimits: {
          limitId: 'codex', normalModelSlug: null,
          rateLimitReachedType: turnText.includes('mock:rate-limit-reached') ? 'rate_limit_reached' : null,
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1893456000 },
          secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1893801600 },
        } } });
      }
      emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: {
        id: 'turn_mock_1', status: 'failed', items: [],
        error: usage
          ? { message: "You've hit your usage limit. Try again later.", codexErrorInfo: 'usageLimitExceeded', additionalDetails: null }
          : rate
            ? { message: 'Rate limit reached.', codexErrorInfo: 'rateLimitExceeded', additionalDetails: null }
            : { message: 'Context window exceeded.', codexErrorInfo: 'contextWindowExceeded', additionalDetails: null },
      } } });
      return;
    }
    if (turnText.includes('mock:turn-failed')) {
      emit({ method: 'turn/failed', params: {
        turn: { id: 'turn_mock_1', status: 'failed' },
        error: { message: 'model unavailable' },
      } });
      return;
    }
    if (turnText.includes('mock:hook-blocked') && !turnText.includes('mock:hook-blocked-long')) {
      for (const [eventName, reason] of [
        ['preToolUse', 'Rule prefix.entry refused the command: it did not match any bashAllowlist entry.'],
        ['preToolUse', 'Rule payload.tool-name refused the command: tool "apply_patch" is not the Bash shell tool.'],
        ['stop', 'token expired in a third-party Stop hook'],
      ]) {
        emit({ method: 'hook/completed', params: {
          threadId: 'th_mock_1',
          turnId: 'turn_mock_1',
          run: {
            id: `pre-tool-use:0:mock:exec-${reason.includes('apply_patch') ? 'patch' : 'bash'}`,
            eventName,
            status: 'blocked',
            entries: [{ kind: 'feedback', text: reason }],
          },
        } });
      }
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:hook-blocked-long')) {
      emit({ method: 'hook/completed', params: {
        threadId: 'th_mock_1',
        turnId: 'turn_mock_1',
        run: {
          id: 'pre-tool-use:0:mock:long',
          eventName: 'preToolUse',
          status: 'blocked',
          entries: [{ kind: 'feedback', text: `Rule prefix.entry refused the command: ${'x'.repeat(2_100)}` }],
        },
      } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:subagent-activity')) {
      emit({ method: 'item/started', params: { item: { type: 'subAgentActivity', id: 'activity_1', kind: 'started', agentThreadId: 'th_child', agentPath: '/root/scope_review' } } });
      emit({ method: 'item/completed', params: { item: { type: 'subAgentActivity', id: 'activity_1', kind: 'started', agentThreadId: 'th_child', agentPath: '/root/scope_review' } } });
      emit({ method: 'item/started', params: { item: { type: 'collabAgentToolCall', id: 'wait_1', tool: 'wait', status: 'inProgress', receiverThreadIds: [] } } });
      emit({ method: 'item/completed', params: { item: { type: 'collabAgentToolCall', id: 'wait_1', tool: 'wait', status: 'completed', receiverThreadIds: [] } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:child-turn')) {
      // A spawned sub-agent runs in its OWN child thread that emits a full turn
      // lifecycle over the shared connection. Its turn/completed must not end the
      // parent turn (#600): the parent is still working after the child finishes.
      emit({ method: 'turn/started', params: { threadId: 'th_child', turn: { id: 'turn_child', status: 'inProgress', items: [] } } });
      emit({ method: 'item/started', params: { threadId: 'th_child', turnId: 'turn_child', item: { type: 'commandExecution', id: 'item_child', command: ['rg', 'requestUserInput'], cwd: '/repo', status: 'inProgress' } } });
      emit({ method: 'turn/completed', params: { threadId: 'th_child', turn: { id: 'turn_child', status: 'completed' } } });
      // Parent keeps streaming after the child's turn ended.
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_p1', text: '' } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_p1', delta: 'Still working after the sub-agent.' } });
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_p1', text: 'Still working after the sub-agent.' } } });
      emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:exit-mid-turn')) {
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_d1', text: '' } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_d1', delta: 'Starting the work.' } });
      if (turnText.includes('mock:exit-mid-turn-orphan')) {
        const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
          stdio: ['ignore', 'inherit', 'ignore'],
          detached: true,
        });
        if (process.env.MOCK_CODEX_ORPHAN_PID_FILE) writeFileSync(process.env.MOCK_CODEX_ORPHAN_PID_FILE, String(orphan.pid));
        orphan.unref();
      }
      process.stdout.write('', () => process.exit(0));
      return;
    }
    if (process.env.MOCK_CODEX_ASK === '1' || turnText.includes('mock:native-codex-ask')) {
      const questions = turnText.includes('multi free text')
        ? [{ id: 'first', header: 'First', question: 'First choice?', isOther: true, isSecret: false,
            options: [{ label: 'A', description: 'Option A.' }, { label: 'B', description: 'Option B.' }] },
          { id: 'second', header: 'Second', question: 'Second choice?', isOther: true, isSecret: false,
            options: [{ label: 'C', description: 'Option C.' }, { label: 'D', description: 'Option D.' }] }]
        : [{ id: 'library', header: 'Library', question: 'Which test library?', isOther: true,
            isSecret: false, options: [{ label: 'Vitest', description: 'Use the existing test runner.' },
              { label: 'Node test', description: 'Use node:test.' }] }];
      emit({ id: 'ask-1', method: 'item/tool/requestUserInput', params: {
        threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_ask_1', autoResolutionMs: null,
        questions,
      } });
      return;
    }
    emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m1', text: '' } } });
    emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_m1', delta: 'Checking the working tree.' } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m1', text: 'Checking the working tree.' } } });
    emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'commandExecution', id: 'item_c1', command: ['bash', '-lc', 'git status --short'], cwd: '/repo', status: 'inProgress' } } });
    emit({ method: 'item/commandExecution/outputDelta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_c1', delta: ' M src/example.ts\n' } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'commandExecution', id: 'item_c1', command: ['bash', '-lc', 'git status --short'], cwd: '/repo', status: 'completed', exitCode: 0 } } });
    emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th_mock_1', tokenUsage: { total: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 }, last: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 } } } });
    emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
    if (process.env.MOCK_CODEX_FOREIGN_SIGNAL_EXIT === '1') {
      // #156 shape: something outside xezar SIGTERMs the app-server, which
      // handles the signal itself and exits 143. The runner therefore sees a
      // signal exit it never asked for — the case the message must name.
      process.stdout.write('', () => process.exit(143));
    }
  }
});

rl.on('close', () => {
  if (!ignoreEof) process.exit(0);
});
