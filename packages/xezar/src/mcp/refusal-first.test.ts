// FIRST import on purpose: the home pin is a module-load side effect and must run before anything
// that reaches `skills.ts` (#671).
import './tools/mcp-test-home.testkit.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectDataDir } from '../project-data-paths.ts';
import { RunStore } from '../runs/store.ts';
import { registerProject } from '../workspace/projects.ts';
import { runBridge } from './bridge.ts';
import { resolveMcpTarget, startMcpService } from './index.ts';
import { LineFramer, encodeFrame, type McpToolResult } from './ipc.ts';
import { RECEIPT_JOURNAL_FILE } from './operation-receipts.ts';
import type { ServiceDispatch } from './service-adapter.ts';
import { acceptedKeysSentence, schemaKeys } from './tool.ts';
import { tools } from './tools/index.ts';
import { ACTION_FIELDS, projectConfigTool } from './tools/project-config.ts';

/**
 * #819 item 6 — A REFUSAL OUTRANKS AN ARGUMENT ERROR, AND AN ARGUMENT ERROR SAYS WHAT THE ACTION TAKES.
 *
 * In the field a leader spent four calls on one refused action: every call carried a key the schema
 * did not know, so it was told `Unrecognized key` instead of the refusal, and it corrected arguments
 * for an action no argument could ever make a write. The service now asks the tool's `preflight`
 * before it answers an argument error; for `project_config` that is the project-binding and the
 * boundary refusal. And when a key IS unknown, the error also says what zod's abort used to hide
 * (`… needs provider`) and which keys the action takes, read from `ACTION_FIELDS` itself.
 *
 * Three guarantees the old order carried, each held here on its own:
 *   - no argument turns a refusal into a write: the refusal dispatches nothing (T6.1);
 *   - a refusal never offers an approval route and never echoes the key it was sent (T6.1);
 *   - `.strict()` stays: a typo'd key on a write that is NOT refused still fails (T6.3).
 *
 * The stack is the real one from the bridge inward — registry, composed door, receipts, journal —
 * with a recording stand-in for the cockpit's routes, so "was anything dispatched" is a question
 * about one list.
 */

const VERSION = '9.9.9-refusal-first';
const tempDirs: string[] = [];
const closers: Array<() => unknown> = [];
const saved = { home: process.env.XEZ_HOME, dryRun: process.env.XEZ_DRY_RUN };

// A short home under /tmp: the per-worker sandbox is past the 104-byte socket limit on macOS (D-01 E5).
const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  tempDirs.push(dir);
  return dir;
};

beforeEach(() => {
  process.env.XEZ_HOME = tmp('xzh-');
  process.env.XEZ_DRY_RUN = '1';
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await Promise.resolve(close()).catch(() => undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [['XEZ_HOME', saved.home], ['XEZ_DRY_RUN', saved.dryRun]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A registered project, its composed MCP service over a recording stand-in, and a bridge client. */
async function world() {
  const root = tmp('xzp-');
  mkdirSync(join(root, '.xezar'), { recursive: true });
  writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
  writeFileSync(join(root, '.gitignore'), '.local/\n', 'utf8');
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const { id } = await registerProject(root);
  const dispatched: string[] = [];
  // Anything that reaches here would have been an effect. Answer 500 so a case can never pass on a
  // dispatch that happened to succeed.
  const service: ServiceDispatch = {
    request: (input, init) => {
      dispatched.push(`${init?.method ?? 'GET'} ${new URL(typeof input === 'string' ? input : String(input)).pathname}`);
      return Promise.resolve(new Response(JSON.stringify({ error: 'recorded, not served' }), { status: 500 }));
    },
  };
  // A store, so `leader_events read` has the journal and the task state it reads.
  const store = RunStore.open(projectDataDir(root), { keepLive: true });
  closers.push(() => store.flush());
  const handle = await startMcpService({ projectId: id, version: VERSION, service, store, warn: () => {} });
  closers.push(() => handle.close());

  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<number, (result: McpToolResult) => void>();
  const framer = new LineFramer(
    (line) => {
      const message = JSON.parse(line) as { id: number; result: McpToolResult };
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
    },
    () => {},
  );
  output.on('data', (chunk: Buffer) => framer.push(chunk));
  const done = runBridge({ input, output, version: VERSION, tools, resolveTarget: () => resolveMcpTarget(root) });
  closers.push(() => {
    input.end();
    return done;
  });
  let next = 1;
  const call = (name: string, args: Record<string, unknown>): Promise<McpToolResult> => {
    const reqId = next++;
    return new Promise((resolve) => {
      pending.set(reqId, resolve);
      input.write(encodeFrame({ jsonrpc: '2.0', id: reqId, method: 'tools/call', params: { name, arguments: args } }));
    });
  };
  const receipts = (): string => {
    const path = join(projectDataDir(root), RECEIPT_JOURNAL_FILE);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  };
  return { call, dispatched, receipts };
}

const text = (result: McpToolResult): string => result.content.map((part) => (part as { text: string }).text).join('\n');

describe('#819 item 6 — a refusal is answered whatever else the call carries', () => {
  it('T6.1 a refused action with an approval key answers the refusal, dispatches nothing and never mentions approval', async () => {
    // RED against: validating before the refusal (the order up to 0.17.0), which answers
    // `Invalid arguments for project_config: … Unrecognized key: "approvedBy"`.
    const w = await world();
    const answers: Array<[string, McpToolResult]> = [];
    for (const extra of [
      { approvedBy: 'the human' },
      { humanApproval: true },
      { confirm: true },
      { override: true },
      // Several at once, and one carrying an operation key: still the refusal, still no receipt.
      { approvedBy: 'the human', override: true, operationId: 'op-refusal-first-01' },
    ]) {
      answers.push([JSON.stringify(extra), await w.call('project_config', { action: 'connect_provider', ...extra })]);
    }
    // An action that is refused for another boundary, with a nested payload the schema knows nothing about.
    answers.push(['apply_skill_updates', await w.call('project_config', { action: 'apply_skill_updates', payload: { approved: true } })]);

    expect(w.dispatched).toEqual([]);
    expect(w.receipts()).not.toContain('op-refusal-first-01');
    for (const [what, result] of answers) {
      expect(result.isError, what).toBe(true);
      expect(text(result), what).toMatch(/^Refused \((host process|workspace-wide setting)\): (connect_provider|apply_skill_updates) — /);
      expect(text(result), what).not.toMatch(/approv|humanApproval|confirm|override|payload/i);
      expect(text(result), what).toMatch(/Nothing was changed\.$/);
      expect(result.structuredContent, what).toMatchObject({ refused: true });
    }
  });

  it('T6.1 naming a project with an unknown key beside it answers the project-binding refusal', async () => {
    // RED against: validation first, which answered the unknown key instead.
    const w = await world();
    const result = await w.call('project_config', { action: 'get_config', projectId: 'another', approvedBy: 'the human' });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Refused \(project binding\): get_config — /);
    expect(text(result)).not.toMatch(/approv|another/i);
    expect(w.dispatched).toEqual([]);
  });

  it('an action the tool does not have is still an argument error, and its name is not echoed as a refusal', async () => {
    // Guard (green either way): the preflight answers only for an action this tool has, so an
    // arbitrary string never becomes the subject of a refusal sentence.
    const w = await world();
    const result = await w.call('project_config', { action: 'approve_everything', projectId: 'x', extra: 1 });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Invalid arguments for project_config: /);
    expect(text(result)).not.toMatch(/^Refused/);
    expect(w.dispatched).toEqual([]);
  });
});

describe('#819 item 6 — an unknown key says what the action takes', () => {
  it('T6.2 lists the accepted keys from ACTION_FIELDS and the requirements zod used to hide', async () => {
    // RED against: the plain zod text, which names only the unknown key.
    const w = await world();
    const result = await w.call('project_config', { action: 'set_provider_enabled', payload: { provider: 'claude', enabled: false } });
    expect(result.isError).toBe(true);
    const fields = ACTION_FIELDS.set_provider_enabled;
    // Derived from the table, so a change to ACTION_FIELDS moves the expected text with it.
    expect(text(result)).toContain(`Accepted for set_provider_enabled: ${['action', ...fields.required].join(', ')} (required).`);
    expect(text(result)).toContain('Accepted for set_provider_enabled: action, provider, enabled, operationId (required).');
    expect(text(result)).toMatch(/^Invalid arguments for project_config: \(arguments\): Unrecognized key: "payload"/);
    for (const field of fields.required) expect(text(result)).toContain(`${field}: set_provider_enabled needs ${field}`);
    expect(w.dispatched).toEqual([]);
  });

  it('T6.2 names optional keys too, and a tool without an action table is described by its schema', async () => {
    const w = await world();
    const dismiss = await w.call('project_config', { action: 'dismiss_onboarding_offer', dismis: true });
    expect(text(dismiss)).toContain('Accepted for dismiss_onboarding_offer: action, operationId (required); onboardingIdentity (optional).');
    // `leader_events` has no `acceptedKeys` hook: the hint is its schema's own shape.
    const events = await w.call('leader_events', { action: 'attach', operationId: 'op-attach-00001', client: 'pi' });
    expect(text(events)).toContain('Accepted for leader_events: action (required); cursor, limit, operationId (optional).');
    expect(w.dispatched).toEqual([]);
  });

  it('a nested unknown key keeps the plain text: the hint describes top-level keys only', async () => {
    // Guard (green either way): the object inside `uiState` is its own schema's to describe.
    const w = await world();
    const result = await w.call('project_config', {
      action: 'set_workspace_ui_state',
      uiState: { appearance: { theme: 'dark' } },
      operationId: 'op-nested-000001',
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Unrecognized key/);
    expect(text(result)).not.toContain('Accepted for');
    expect(w.dispatched).toEqual([]);
  });
});

describe('#819 item 6 — .strict() still refuses a typo on a write that is not refused', () => {
  it('T6.3 a misspelt optional guard fails instead of being dropped and dispatching the write', async () => {
    // RED against: stripping unknown keys (`.strict()` → `.strip()`): the misspelt stale guard
    // would vanish and the dismissal would dispatch against whatever identity is running now —
    // exactly what the guard the leader meant to send exists to prevent.
    const w = await world();
    const result = await w.call('project_config', {
      action: 'dismiss_onboarding_offer',
      operationId: 'op-typo-00000001',
      onboardingIdentiy: { engineVersion: '0.17.0', kitDigest: 'a'.repeat(64) },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Unrecognized key: "onboardingIdentiy"/);
    expect(w.dispatched).toEqual([]);
    expect(w.receipts()).not.toContain('op-typo-00000001');
  });
});

describe('#819 item 6 — leader_events status and read accept an operationId and ignore it', () => {
  it('T6.4 status with an operationId answers the plain status and files no receipt', async () => {
    // RED against: the old `operationId does not apply to status` rejection.
    const w = await world();
    const plain = await w.call('leader_events', { action: 'status' });
    const keyed = await w.call('leader_events', { action: 'status', operationId: 'op-status-ignored-1' });
    expect(keyed.isError, text(keyed)).toBeFalsy();
    expect(keyed).toEqual(plain);
    expect(text(keyed)).not.toMatch(/receipt|replay/i);
    expect(w.receipts()).not.toContain('op-status-ignored-1');
    // The same key again is answered afresh, never as a replay of the first.
    expect(await w.call('leader_events', { action: 'status', operationId: 'op-status-ignored-1' })).toEqual(plain);
  });

  it('T6.4 read with an operationId answers the rows and files no receipt', async () => {
    const w = await world();
    const keyed = await w.call('leader_events', { action: 'read', operationId: 'op-read-ignored-01' });
    expect(keyed.isError, text(keyed)).toBeFalsy();
    expect(keyed.structuredContent).toMatchObject({ status: 'ok' });
    expect(keyed.structuredContent).not.toHaveProperty('replayed');
    expect(w.receipts()).not.toContain('op-read-ignored-01');
  });
});

describe('#819 item 6 — the hooks themselves', () => {
  const ctx = { project: { id: 'p', name: 'P', root: '/nonexistent' }, xezarVersion: '0.0.0-test' };

  it('preflight answers only for an object naming an action this tool has', () => {
    for (const raw of [null, [], 'connect_provider', 7, {}, { action: 7 }, { action: 'toString' }, { action: 'get_config' }]) {
      expect(projectConfigTool.preflight!(raw, ctx), JSON.stringify(raw)).toBeUndefined();
    }
    expect(projectConfigTool.preflight!({ action: 'connect_provider', x: 1 }, ctx)?.isError).toBe(true);
  });

  it('acceptedKeys names nothing for a refused, unknown or absent action', () => {
    for (const raw of [{}, { action: 'connect_provider' }, { action: 'nope' }]) {
      expect(projectConfigTool.acceptedKeys!(raw), JSON.stringify(raw)).toBeUndefined();
    }
    expect(projectConfigTool.acceptedKeys!({ action: 'get_capabilities' })).toEqual({
      subject: 'get_capabilities',
      required: ['action'],
      optional: ['refresh'],
    });
  });

  it('the sentence reads the same for any split of required and optional keys', () => {
    expect(acceptedKeysSentence({ subject: 's', required: [], optional: [] })).toBe('Accepted for s: no arguments.');
    expect(acceptedKeysSentence({ subject: 's', required: [], optional: ['a'] })).toBe('Accepted for s: a (optional).');
    expect(acceptedKeysSentence({ subject: 's', required: ['a', 'b'], optional: [] })).toBe('Accepted for s: a, b (required).');
    const events = tools.find((t) => t.name === 'leader_events')!;
    expect(schemaKeys(events)).toEqual({ subject: 'leader_events', required: ['action'], optional: ['cursor', 'limit', 'operationId'] });
  });
});
