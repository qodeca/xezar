import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunSpec } from '../core/agent-runner.ts';
import { DEFAULT_RUN_TIMEOUT_MS } from '../core/claude-cli-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Every spec a (mocked) runner's `startSession` receives, in spawn order. */
const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[] }));

// The seam under test is what `execute` puts INTO the spec. What each runner then DOES with
// `timeoutMs` is its own suite's business (`claude-cli-runner.test.ts` and friends already
// pin `spec.timeoutMs ?? this.timeoutMs`, and `0` disarming the timer entirely).
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent: (event: AgentEvent) => void) => {
      captured.specs.push(spec);
      return {
        // A finished turn that ends with `XEZ:DONE`: a non-final step is only done when its
        // turn says so (#317), and these cases need every step to spawn.
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

/**
 * A workflow step's own wall-clock cap reaches the runner (#22).
 *
 * `test/unit/workflow-types.test.ts` pins the duration grammar and the resolution rule;
 * this suite pins the part the PR actually ships — that a real run hands the value to the
 * runner spec, and that a workflow which never mentions `timeout` still spawns exactly the
 * spec it spawned before this field existed.
 */
describe('per-step timeout wiring', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    captured.specs.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-step-timeout-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
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

  async function specsFor(def: WorkflowDef, expected: number): Promise<AgentRunSpec[]> {
    const record = manager!.startRun(def, { task: 'do the thing' });
    await expect.poll(() => captured.specs.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(expected);
    await expect
      .poll(() => store.getRun(record.id)?.status, { timeout: 20_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled', 'waiting'].includes(String(status)));
    return captured.specs;
  }

  it('a workflow with NO timeout field spawns exactly the pre-#22 spec', async () => {
    // The zero-config proof. Step 1 is not the last step, so it gets `undefined` —
    // which is what makes the runner fall through to its own 30-minute default.
    const [first, last] = await specsFor(
      {
        name: 'untimed',
        source: 'built-in',
        steps: [
          { id: 'investigate', prompt: '{{task}}' },
          { id: 'implement', prompt: 'implement {{task}}' },
        ],
      },
      2,
    );

    expect(first?.timeoutMs).toBeUndefined();
    // Named so the assertion breaks loudly if anyone moves the constant: an absent
    // `timeout` must still mean 30 minutes on a non-final agent step.
    expect(DEFAULT_RUN_TIMEOUT_MS).toBe(30 * 60_000);
    // The workflow's LAST step stays interactive and uncapped, also unchanged.
    expect(last?.timeoutMs).toBe(0);
  }, 40_000);

  it("a step's own timeout reaches the runner spec, in milliseconds", async () => {
    const [investigate] = await specsFor(
      {
        name: 'timed',
        source: 'built-in',
        steps: [
          { id: 'investigate', prompt: '{{task}}', timeout: '90m' },
          { id: 'implement', prompt: 'implement {{task}}' },
        ],
      },
      1,
    );

    expect(investigate?.timeoutMs).toBe(5_400_000);
  }, 40_000);

  it('`timeout: none` lifts the cap off a non-final step', async () => {
    // 0 is the value all four runners read as "arm no deadline" (`limitMs > 0`).
    const [investigate] = await specsFor(
      {
        name: 'uncapped',
        source: 'built-in',
        steps: [
          { id: 'investigate', prompt: '{{task}}', timeout: 'none' },
          { id: 'implement', prompt: 'implement {{task}}' },
        ],
      },
      1,
    );

    expect(investigate?.timeoutMs).toBe(0);
  }, 40_000);

  it('each step carries its OWN value — one timed step does not re-time its neighbours', async () => {
    const specs = await specsFor(
      {
        name: 'mixed',
        source: 'built-in',
        steps: [
          { id: 'investigate', prompt: '{{task}}', timeout: '2h' },
          { id: 'implement', prompt: 'implement {{task}}' },
          { id: 'review', prompt: 'review {{task}}' },
        ],
      },
      3,
    );

    expect(specs.map((s) => s.timeoutMs)).toEqual([7_200_000, undefined, 0]);
  }, 40_000);
});
