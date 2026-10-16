import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { createApp } from '../server/server.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { executionControlTool } from '../mcp/tools/execution-control.ts';
import { taskReadsTool } from '../mcp/tools/task-reads.ts';
import type { McpTool, McpToolContext } from '../mcp/tool.ts';
import { RunManager } from './run.ts';
import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const MOCK_CODEX = join(import.meta.dirname, '../core/__fixtures__/codex/mock-codex-app-server.mjs');
const ENV_KEYS = ['XEZ_CODEX_BIN', 'XEZ_ENV_PASSTHROUGH', 'MOCK_CODEX_ORPHAN_PID_FILE', 'XEZ_DRY_RUN', 'XEZ_AUTONAME'] as const;

/**
 * #895: a Codex `continue` step whose app-server dies under the turn, then a cancel. Observed on
 * 0.18.0: the cancel answered accepted, the run's version never moved, it stayed `running` with no
 * live process, and it later ended `done`. The mock reproduces the death the way it leaves a run
 * stuck – the app-server exits 0 mid-turn while a process it started still holds its stdout.
 */
describe('cancel after the Codex app-server died during a continue step (#895)', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let pidFile: string;
  const saved = new Map<string, string | undefined>();

  beforeEach(async () => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    root = mkdtempSync(join(tmpdir(), 'xez-895-'));
    pidFile = join(root, 'orphan.pid');
    delete process.env.XEZ_DRY_RUN;
    // Not a dry run, so the namer would start the real `claude` CLI in this folder (#963).
    process.env.XEZ_AUTONAME = '0';
    process.env.XEZ_CODEX_BIN = MOCK_CODEX;
    process.env.XEZ_ENV_PASSTHROUGH = 'MOCK_CODEX_ORPHAN_PID_FILE';
    process.env.MOCK_CODEX_ORPHAN_PID_FILE = pidFile;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: root });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
    store = RunStore.open(join(root, '.local/xezar'));
    manager = new RunManager(store, root);
  });

  afterEach(async () => {
    // Stop only the grandchild the mock started for this test, by its own pid – first, so a
    // session still reading its pipe can end and the drain below cannot wait on it.
    try {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (pid > 0) process.kill(pid, 'SIGKILL');
    } catch {
      // never started, or already gone
    }
    await manager.quiesce();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await store.close();
    rmSync(root, TEST_DIR_RM_OPTIONS);
  });

  it('ends cancelled (or failed with a reason) with its version advanced, and never done', async () => {
    // The first agent step finished on Codex and left its thread to resume.
    const record = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'do the work',
      runner: 'codex',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateStep(record.id, 'work', {
      status: 'done',
      iterations: 1,
      sessionId: 'th_mock_1',
      backend: 'codex',
    });
    store.updateRun(record.id, { status: 'done', finishedAt: new Date().toISOString() });

    const app = createApp({ repoRoot: root, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
    const ctx = { project: { id: 'default', name: 'fixture', root }, xezarVersion: '0.0.0-test', service: app } as McpToolContext;
    const call = async (tool: McpTool, args: Record<string, unknown>) => {
      const result = await tool.call(tool.inputSchema.parse(args), ctx);
      return JSON.parse((result.content[0] as { text: string }).text);
    };
    const versionOf = async () => (await call(taskReadsTool, { view: 'task', taskId: record.id })).version as string;

    const continued = await call(executionControlTool, {
      action: 'continue', runId: record.id, expectedVersion: await versionOf(),
      operationId: 'op-895-continue', text: 'mock:exit-mid-turn-orphan keep going',
    });
    expect(continued).not.toHaveProperty('error');

    // The continue step is running and its app-server is gone: the mock writes the orphan's pid
    // just before it exits.
    await expect.poll(() => existsSync(pidFile), { timeout: 15_000 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(store.getRun(record.id)?.status).toBe('running');
    expect(store.getRun(record.id)?.steps.some((s) => s.id.startsWith('continue-') && s.status === 'running')).toBe(true);

    const statusesAfterCancel: string[] = [];
    store.on('run', (r: RunRecord) => {
      if (r.id === record.id) statusesAfterCancel.push(r.status);
    });
    const before = await versionOf();
    const cancelled = await call(executionControlTool, {
      action: 'cancel', runId: record.id, expectedVersion: before, operationId: 'op-895-cancel',
    });
    expect(cancelled).toMatchObject({ accepted: true });

    // No further input: the cancel alone must reach a final state, well inside the 10 s a dead
    // app-server's pipe is given on its own.
    await expect
      .poll(() => store.getRun(record.id)?.status, { timeout: 5_000 })
      .toMatch(/^(cancelled|failed)$/);
    const after = store.getRun(record.id)!;
    if (after.status === 'failed') expect(after.error).toBeTruthy();
    // The server died without a stop of xezar's, but the cancel is what ended the turn: it takes
    // the ordinary cancelled path.
    expect(after.status).toBe('cancelled');
    expect(after.steps.find((s) => s.id.startsWith('continue-'))?.status).toBe('cancelled');
    expect(await versionOf()).not.toBe(before);

    // Nothing settles it a second time as `done`.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(statusesAfterCancel).not.toContain('done');
    expect(store.getRun(record.id)?.status).toBe(after.status);
  }, 40_000);
});
