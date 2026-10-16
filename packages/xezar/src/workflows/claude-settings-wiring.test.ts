import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Every spec a (mocked) runner's `startSession` receives, in spawn order. */
const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[] }));

// The seam under test is what the engine puts INTO the spec; the spec → argv mapping is
// `claude-cli-runner.test.ts`'s business (`--settings` beside `--setting-sources user`).
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent: (event: AgentEvent) => void) => {
      captured.specs.push(spec);
      return {
        result: Promise.resolve().then(() => {
          onEvent({ type: 'text', text: 'ok\n\nXEZ:DONE' });
          onEvent({ type: 'turn-end' });
          return { text: 'ok', toolCalls: [], tokensUsed: 0 };
        }),
        sendMessage: () => false,
        end: () => {},
        interrupt: () => {},
        open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

const HOOKS = {
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash .xezar/hooks/guard.sh' }] }] },
};
const READ_ONLY = ['Read', 'Grep', 'Glob', 'Bash'];
const FIELD = { files: ['.xezar/claude/hooks.json'], scripts: ['.xezar/hooks/guard.sh'] };

/**
 * A workflow step's `claudeSettings` reaches the Claude session as a pinned file (#1001).
 * Both agent construction sites are covered: the first spawn (`runAgentStep`) and a continuation.
 */
describe('claudeSettings wiring', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  const write = (rel: string, content: string) => {
    mkdirSync(join(repoRoot, rel, '..'), { recursive: true });
    writeFileSync(join(repoRoot, rel), content);
  };
  const commit = async (message: string) => {
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', message], { cwd: repoRoot });
  };

  beforeEach(async () => {
    captured.specs.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-claude-settings-wiring-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    write('.xezar/claude/hooks.json', JSON.stringify(HOOKS));
    write('.xezar/hooks/guard.sh', '#!/bin/sh\necho base-guard\n');
    await commit('base');
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(async () => {
    manager?.dispose();
    manager = undefined;
    store.flush();
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  });

  async function finish(def: WorkflowDef): Promise<string> {
    const record = manager!.startRun(def, { task: 'review it' });
    await expect
      .poll(() => store.getRun(record.id)?.status, { timeout: 20_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled', 'waiting'].includes(String(status)));
    return record.id;
  }

  const def = (step: Partial<WorkflowDef['steps'][number]>): WorkflowDef => ({
    name: 'kit-review',
    source: 'file',
    steps: [{ id: 'review', prompt: '{{task}}', allowedTools: READ_ONLY, ...step }],
  });

  it('a read-only Claude step with claudeSettings spawns with the pinned hooks file', async () => {
    // An uncommitted edit in the primary checkout is not what the run loads either.
    write('.xezar/hooks/guard.sh', '#!/bin/sh\necho dirty\n');
    await finish(def({ claudeSettings: FIELD }));
    const spec = captured.specs[0]!;
    expect(spec.claudeSettingsFile).toBeDefined();
    const doc = JSON.parse(readFileSync(spec.claudeSettingsFile!, 'utf8')) as typeof HOOKS;
    const command = doc.hooks.PreToolUse[0]!.hooks[0]!.command;
    const pinnedScript = join(spec.claudeSettingsFile!, '..', 'scripts', '.xezar', 'hooks', 'guard.sh');
    expect(command).toBe(`bash '${pinnedScript}'`);
    expect(readFileSync(pinnedScript, 'utf8')).toBe('#!/bin/sh\necho base-guard\n');
  }, 40_000);

  it('a read-only step without the field spawns exactly as before, with no settings file', async () => {
    await finish(def({}));
    expect(captured.specs[0]!.claudeSettingsFile).toBeUndefined();
    expect('claudeSettingsFile' in captured.specs[0]!).toBe(false);
  }, 40_000);

  it('a settings file with a permission key fails the step before spawn, naming the key', async () => {
    write('.xezar/claude/hooks.json', JSON.stringify({ ...HOOKS, permissions: { allow: ['Bash'] } }));
    await commit('widen');
    const id = await finish(def({ claudeSettings: FIELD }));
    expect(captured.specs).toHaveLength(0);
    const record = store.getRun(id)!;
    expect(record.status).toBe('failed');
    expect(record.steps[0]!.error).toContain('key "permissions" is not allowed');
  }, 40_000);

  it('another runner records an unsupported note and gets no settings file', async () => {
    const id = await finish(def({ claudeSettings: FIELD, runner: 'codex' }));
    expect(captured.specs[0]!.claudeSettingsFile).toBeUndefined();
    const events = readFileSync(join(repoRoot, '.local/xezar/runs', `${id}.ndjson`), 'utf8');
    expect(events).toContain('claudeSettings is not supported by the codex runner');
  }, 40_000);

  it('a continuation of the step keeps its pinned hooks', async () => {
    const record = store.createRun({
      title: 't',
      workflow: 'kit-review',
      task: 'review it',
      steps: [{ id: 'review', name: 'review', kind: 'agent' as const }],
    });
    store.updateRun(record.id, {
      status: 'done',
      finishedAt: new Date().toISOString(),
      workflowDef: def({ claudeSettings: FIELD }),
      baseBranch: 'main',
    });
    store.updateStep(record.id, 'review', { status: 'done', sessionId: 'sess-1', backend: 'claude' });

    expect(manager!.continueRun(record.id, { text: 'one more look' })).toEqual({ ok: true });
    await expect.poll(() => captured.specs.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const spec = captured.specs[0]!;
    expect(spec.resume).toBe(true);
    expect(spec.claudeSettingsFile).toBeDefined();
    expect(readFileSync(spec.claudeSettingsFile!, 'utf8')).toContain('guard.sh');
    await expect
      .poll(() => store.getRun(record.id)?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled', 'waiting'].includes(String(status)));
  }, 40_000);
});
