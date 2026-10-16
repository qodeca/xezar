import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import type { RunnerId } from '../core/agent-runner.ts';
import { RunStore, type StepState } from '../runs/store.ts';
import { RunManager, stepRunnersLabel } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Every session a (mocked) runner opens, with the agent it was created for, in spawn order. */
const captured = vi.hoisted(() => ({
  sessions: [] as { backend: string | undefined; spec: AgentRunSpec }[],
  /** When set, the "agent" drops this reviewer packet beside its handoff file, as a reviewer does. */
  verdict: undefined as { role: string; verdict: string } | undefined,
}));

// The seam under test is which agent `runContinuation` is created for and what it puts into the
// spec, so the runner is a capture stub that records the backend `createRunner` was asked for.
vi.mock('../core/runner-factory.ts', async () => {
  const fs = await import('node:fs');
  return {
    createRunner: (backend: string | undefined) => ({
      backend: backend ?? 'claude',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
      startSession: (spec: AgentRunSpec) => {
        captured.sessions.push({ backend, spec });
        const handoff = spec.env?.XEZ_HANDOFF_FILE;
        if (captured.verdict && handoff) {
          const target = `${handoff}.verdict.json`;
          fs.writeFileSync(`${target}.tmp`, JSON.stringify({
            id: `test-${spec.env?.XEZ_STEP_ID}`,
            taskId: spec.env?.XEZ_TASK_ID,
            stepId: spec.env?.XEZ_STEP_ID,
            role: captured.verdict.role,
            verdict: captured.verdict.verdict,
            reviewedHeadSha: 'f'.repeat(40),
            summary: 'test review',
            recordedAt: new Date().toISOString(),
            labels: { requestedAdd: [], requestedRemove: [], observed: [], state: 'verified' },
          }), 'utf8');
          fs.renameSync(`${target}.tmp`, target);
        }
        return {
          result: Promise.resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 }),
          sendMessage: () => false,
          end: () => {},
          interrupt: () => {},
          open: false,
        };
      },
      interrupt: async () => {},
    }),
  };
});

/**
 * #998 — a continuation uses the STEP's runner and identity, not the task's.
 *
 * #984: a step that names its own agent (`runner:` on the step) lost it on Continue — restart
 * recovery, the usage-limit auto-resume and any Continue without an explicit agent ran on the
 * task's agent, in a fresh session without the step's history.
 *
 * #864 item 1: a fresh-session Continue (backend or account switch) recorded a verdict packet under
 * the definition's LAST agent step's role, whatever step it completed — so a continued author turn
 * of `implement → review (verdictRole: code-review)` was recorded as a code review.
 */
describe('a continuation keeps its step’s own agent and identity (#998)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  /** A one-step workflow whose step names its own agent, as #984's crash reproduction had. */
  const STEP_RUNNER_DEF: WorkflowDef = {
    name: 'own-agent',
    source: 'file',
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}', runner: 'qwen' }],
  };

  beforeEach(async () => {
    captured.sessions.length = 0;
    captured.verdict = undefined;
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-998-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(async () => {
    await manager?.dispose();
    manager = undefined;
    await store.close();
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

  /** A run on the task agent `claude` whose steps and definition are exactly what the caller says. */
  function recordedRun(input: {
    def: WorkflowDef;
    steps: { id: string; status: StepState['status']; sessionId?: string; backend?: RunnerId }[];
    status?: 'done' | 'failed' | 'running' | 'queued';
    model?: string;
    error?: string;
    autoResumeAt?: string;
  }): string {
    const record = store.createRun({
      title: 't',
      workflow: input.def.name,
      task: 'do the thing',
      runner: 'claude',
      model: input.model,
      steps: input.steps.map((s) => ({ id: s.id, name: s.id, kind: 'agent' as const })),
    });
    store.updateRun(record.id, {
      status: input.status ?? 'failed',
      finishedAt: new Date().toISOString(),
      workflowDef: input.def,
      error: input.error,
      autoResumeAt: input.autoResumeAt,
    });
    for (const s of input.steps) {
      store.updateStep(record.id, s.id, { status: s.status, sessionId: s.sessionId, backend: s.backend });
    }
    return record.id;
  }

  async function sessionAt(index: number): Promise<{ backend: string | undefined; spec: AgentRunSpec }> {
    await expect.poll(() => captured.sessions.length, { timeout: 15_000 }).toBeGreaterThan(index);
    return captured.sessions[index]!;
  }

  async function settled(runId: string): Promise<void> {
    await expect
      .poll(() => store.getRun(runId)?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled'].includes(String(status)));
  }

  describe('#984 — Continue without an explicit agent stays on the step’s own agent', () => {
    it('starts Qwen Code and resumes its session for a step-level `runner: qwen` on a claude task', async () => {
      const id = recordedRun({
        def: STEP_RUNNER_DEF,
        steps: [{ id: 'work', status: 'failed', sessionId: 'qw-1', backend: 'qwen' }],
      });

      expect(manager!.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
      const { backend, spec } = await sessionAt(0);
      expect(backend).toBe('qwen');
      expect(spec.resume).toBe(true);
      expect(spec.sessionId).toBe('qw-1');
      expect(store.getRun(id)?.steps.find((s) => s.id === 'continue-1')?.backend).toBe('qwen');
      // Following the step's agent is not a switch: the task's own runner is left as it was.
      expect(store.getRun(id)?.runner).toBe('claude');
      await settled(id);
    });

    it('restart recovery resumes the interrupted step on its own agent', async () => {
      // The #984 reproduction: an engine crash mid-turn, then `recover()` → `continueRun`.
      const id = recordedRun({
        def: STEP_RUNNER_DEF,
        status: 'running',
        steps: [{ id: 'work', status: 'running', sessionId: 'qw-1', backend: 'qwen' }],
      });
      await manager!.dispose();
      manager = new RunManager(store, repoRoot);
      await manager.recover();

      const { backend, spec } = await sessionAt(0);
      expect(backend).toBe('qwen');
      expect(spec.resume).toBe(true);
      expect(spec.sessionId).toBe('qw-1');
      await settled(id);
    });

    it('the usage-limit auto-resume resumes on the step’s own agent', async () => {
      const id = recordedRun({
        def: STEP_RUNNER_DEF,
        steps: [{ id: 'work', status: 'failed', sessionId: 'qw-1', backend: 'qwen' }],
        error: 'Claude AI usage limit reached|1756166400',
        autoResumeAt: new Date(Date.now() - 1_000).toISOString(),
      });
      await manager!.dispose();
      manager = new RunManager(store, repoRoot);
      await manager.recover();

      const { backend, spec } = await sessionAt(0);
      expect(backend).toBe('qwen');
      expect(spec.sessionId).toBe('qw-1');
      await settled(id);
    });

    it('a queued continuation re-adopted after a restart keeps the step’s own agent', async () => {
      const id = recordedRun({
        def: STEP_RUNNER_DEF,
        status: 'queued',
        steps: [
          { id: 'work', status: 'failed', sessionId: 'qw-1', backend: 'qwen' },
          { id: 'continue-1', status: 'pending' },
        ],
      });
      await manager!.dispose();
      manager = new RunManager(store, repoRoot);
      await manager.recover();

      const { backend, spec } = await sessionAt(0);
      expect(backend).toBe('qwen');
      expect(spec.resume).toBe(true);
      expect(spec.sessionId).toBe('qw-1');
      await settled(id);
    });

    it('spawns with the step’s own model, not the task’s model for another agent', async () => {
      const def: WorkflowDef = {
        name: 'own-agent-model',
        source: 'file',
        steps: [{ id: 'work', name: 'Work', prompt: '{{task}}', runner: 'codex', model: 'gpt-5-codex' }],
      };
      const id = recordedRun({
        def,
        model: 'opus',
        steps: [{ id: 'work', status: 'failed', sessionId: 'cx-1', backend: 'codex' }],
      });

      expect(manager!.continueRun(id, { text: 'keep going' })).toEqual({ ok: true });
      const { backend, spec } = await sessionAt(0);
      expect(backend).toBe('codex');
      expect(spec.resume).toBe(true);
      expect(spec.sessionId).toBe('cx-1');
      expect(spec.model).toBe('gpt-5-codex');
      // The task's own pin is untouched for the steps that run on the task's agent.
      expect(store.getRun(id)?.model).toBe('opus');
      await settled(id);
    });

    // Guards that pass both ways: the explicit choice and the cockpit follow-up keep today's rules.
    it('an explicit agent choice still wins, in a fresh session', async () => {
      const id = recordedRun({
        def: STEP_RUNNER_DEF,
        steps: [{ id: 'work', status: 'failed', sessionId: 'qw-1', backend: 'qwen' }],
      });

      expect(manager!.continueRun(id, { text: 'keep going', runner: 'codex' })).toEqual({ ok: true });
      const { backend, spec } = await sessionAt(0);
      expect(backend).toBe('codex');
      expect(spec.resume).toBe(false);
      expect(spec.sessionId).toBeUndefined();
      await settled(id);
    });

    it('a follow-up that keeps the run’s agent (the untouched cockpit pill) stays on the task’s agent', async () => {
      const id = recordedRun({
        def: STEP_RUNNER_DEF,
        steps: [{ id: 'work', status: 'failed', sessionId: 'qw-1', backend: 'qwen' }],
      });

      expect(manager!.continueRun(id, { text: 'keep going', keepRunAgent: true })).toEqual({ ok: true });
      const { backend, spec } = await sessionAt(0);
      expect(backend).toBe('claude');
      expect(spec.resume).toBe(false);
      await settled(id);
    });
  });

  describe('#864 item 1 — a fresh-session Continue reports as the step it completes', () => {
    /** `implement → review`, where only the reviewer declares a role — the shape #864 names. */
    const CHAIN_DEF: WorkflowDef = {
      name: 'author-then-review',
      source: 'file',
      steps: [
        { id: 'implement', name: 'Implement', prompt: '{{task}}' },
        { id: 'review', name: 'Review', prompt: 'review {{task}}', verdictRole: 'code-review' },
      ],
    };

    async function continuationSettled(runId: string): Promise<void> {
      await expect
        .poll(() => store.getRun(runId)?.steps.find((s) => s.id === 'continue-1')?.status, { timeout: 15_000 })
        .toSatisfy((status) => ['done', 'failed', 'cancelled'].includes(String(status)));
      await settled(runId);
    }

    it('records no verdict under the reviewer’s role for a continued non-reviewing step', async () => {
      // `implement` failed on codex; the Continue switches to claude, so it opens a fresh session
      // that no definition step owns, and it completes `implement` (resumeIndex 0).
      const id = recordedRun({
        def: CHAIN_DEF,
        steps: [
          { id: 'implement', status: 'failed', sessionId: 'cx-1', backend: 'codex' },
          { id: 'review', status: 'pending' },
        ],
      });
      captured.verdict = { role: 'code-review', verdict: 'APPROVE' };

      expect(manager!.continueRun(id, { text: 'keep going', runner: 'claude' })).toEqual({ ok: true });
      expect((await sessionAt(0)).spec.resume).toBe(false);
      await continuationSettled(id);

      expect(store.getRun(id)?.verdicts ?? []).toEqual([]);
      expect(store.getRun(id)?.verdictIssues?.map((issue) => issue.stepId)).toEqual(['continue-1']);
    });

    it('still records the reviewer’s verdict for a continued reviewing step', async () => {
      // Guard: the same fresh-session Continue of the REVIEW step keeps reporting as code-review.
      const id = recordedRun({
        def: CHAIN_DEF,
        steps: [
          { id: 'implement', status: 'done', sessionId: 'cx-1', backend: 'codex' },
          { id: 'review', status: 'failed', sessionId: 'cx-2', backend: 'codex' },
        ],
      });
      captured.verdict = { role: 'code-review', verdict: 'APPROVE' };

      expect(manager!.continueRun(id, { text: 'keep going', runner: 'claude' })).toEqual({ ok: true });
      expect((await sessionAt(0)).spec.resume).toBe(false);
      await continuationSettled(id);

      expect(store.getRun(id)?.verdicts?.map((v) => [v.role, v.verdict, v.stepId])).toEqual([
        ['code-review', 'APPROVE', 'continue-1'],
      ]);
    });
  });
});

describe('#910 — the run header names the runner each step really uses', () => {
  const def = (steps: WorkflowDef['steps']): WorkflowDef => ({ name: 'w', source: 'file', steps });

  it('names the step’s own runner for a one-step workflow with `runner: codex`', () => {
    expect(stepRunnersLabel(def([{ id: 'work', prompt: '{{task}}', runner: 'codex' }]), 'claude')).toBe('runner: codex');
  });

  it('says the steps use more than one runner, in step order', () => {
    expect(stepRunnersLabel(def([
      { id: 'plan', prompt: '{{task}}', runner: 'codex' },
      { id: 'gates', command: 'true' },
      { id: 'work', prompt: '{{task}}' },
      { id: 'again', prompt: '{{task}}', runner: 'codex' },
    ]), 'claude')).toBe('runners: codex, claude');
  });

  it('keeps the task’s runner when no step names its own, or there is no agent step', () => {
    expect(stepRunnersLabel(def([{ id: 'work', prompt: '{{task}}' }]), 'qwen')).toBe('runner: qwen');
    expect(stepRunnersLabel(def([{ id: 'gates', command: 'true' }]), 'claude')).toBe('runner: claude');
  });
});
