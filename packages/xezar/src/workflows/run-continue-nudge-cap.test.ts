import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, SessionOptions } from '../core/agent-runner.ts';
import * as factory from '../core/runner-factory.ts';
import { RunStore } from '../runs/store.ts';
import { MAX_AUTO_CONTINUES, MAX_GATED_CONTINUE_NUDGES, RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * #613 — `execution_control continue` re-prompted a finished turn 41 times.
 *
 * Run `04af6692` (autonomous, `address-review-findings`) failed its `address` step without
 * `XEZ:DONE` (#317), and the leader's Continue built a fresh `ActiveRun` whose turn-end handler
 * fed the autonomous nudge — the one bounded by `MAX_AUTO_CONTINUES = 40`. Every re-prompted turn
 * polled CI once or twice and said "Waiting for CI", so the loop ran its whole budget (notes
 * `1/40` … `40/40`), parked, sat out the 15-minute idle close, and only THEN failed with
 * `remaining workflow requires XEZ:DONE from the continued turn`: 3.2 M tokens, $144.
 *
 * The session is scripted here (only the agent process is replaced), and unlike the shared
 * `scriptedRunner` it ACCEPTS a nudge and plays the next scripted turn, repeating the last one
 * once the script runs out — the shape that let the incident spin.
 *
 * RED WITHOUT THE FIX: the cap test and both idle tests. GUARDS (pass both ways): DONE on the
 * first re-prompt still completes the workflow tail, and a busy final step keeps its 40 budget.
 */
interface Turn { text: string; toolCalls?: number }

function nudgeRunner(sessions: Turn[][]) {
  const specs: AgentRunSpec[] = [];
  const nudges: unknown[] = [];
  const mock = vi.spyOn(factory, 'createRunner').mockImplementation(() => ({
    backend: 'claude',
    run: async () => { throw new Error('unexpected one-shot runner'); },
    interrupt: async () => {},
    startSession(spec: AgentRunSpec, emit: (event: AgentEvent) => void, options?: SessionOptions) {
      const script = sessions[specs.length];
      specs.push(spec);
      if (!script) throw new Error('unscripted agent invocation');
      let open = true;
      let played = 0;
      let finish!: (result: AgentRunResult) => void;
      const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
      const end = () => {
        if (!open) return;
        open = false;
        finish({ text: '', tokensUsed: 0, toolCalls: [] });
      };
      const play = () => {
        if (!open) return;
        const turn = script[Math.min(played, script.length - 1)]!;
        played++;
        for (let i = 0; i < (turn.toolCalls ?? 0); i++) {
          emit({ type: 'tool-call', id: `t${played}-${i}`, tool: 'Bash', input: { command: 'gh run view' } });
          emit({ type: 'tool-result', toolCallId: `t${played}-${i}`, result: 'in_progress', isError: false });
        }
        emit({ type: 'text', text: turn.text });
        emit({ type: 'turn-end' });
        if (options?.autoEndAfterFirstTurn) end();
      };
      queueMicrotask(() => {
        emit({ type: 'session', sessionId: spec.sessionId ?? 'scripted-session' });
        play();
      });
      return {
        result,
        get open() { return open; },
        end,
        interrupt: end,
        sendMessage: (blocks: unknown) => {
          if (!open) return false;
          nudges.push(blocks);
          setTimeout(play, 0);
          return true;
        },
      };
    },
  }));
  return { specs, nudges, restore: () => mock.mockRestore() };
}

/** An agent step whose remaining tail (one real check) needs the continued turn's DONE. */
const GATED: WorkflowDef = {
  name: 'gated', source: 'built-in',
  steps: [{ id: 'author', prompt: '{{task}}' }, { id: 'readiness', command: 'node -e ""' }],
};
const SINGLE: WorkflowDef = { name: 'single', source: 'built-in', steps: [{ id: 'task', prompt: '{{task}}' }] };

const POLLING: Turn = { text: 'Waiting for CI run 35291913711.', toolCalls: 1 };
const PROSE_ONLY: Turn = { text: 'Everything is finished and pushed.' };
/** The first, non-final step ends without DONE, so #317 fails it and the run stops. */
const AUTHOR_STOPS: Turn[] = [{ text: 'Pushed; waiting for CI.', toolCalls: 3 }];

// Each case waits on two or three real turn ends and one real check process; the default 5 s
// test timeout is too tight when the gate runs this file beside the rest of the suite.
describe('#613 — the autonomous re-prompt loop is bounded', { timeout: 30_000 }, () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let runner: ReturnType<typeof nudgeRunner> | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-613-'));
    store = RunStore.open(join(root, 'data'));
    manager = new RunManager(store, root);
  });

  afterEach(async () => {
    await manager.quiesce();
    manager.dispose();
    store.flush();
    runner?.restore();
    runner = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  const status = (id: string) => store.getRun(id)?.status;
  const until = (pred: () => boolean) =>
    expect.poll(pred, { timeout: 10_000, interval: 10 }).toBe(true);

  /** Start the gated run, let its author step fail on the missing marker, then Continue it. */
  const continueGated = async (continued: Turn[]) => {
    runner = nudgeRunner([AUTHOR_STOPS, continued]);
    const record = manager.startRun(GATED, { task: 'address the review', worktree: false, autonomous: true });
    await until(() => status(record.id) === 'failed');
    expect(manager.continueRun(record.id, { text: 'finish the remaining steps' })).toEqual({ ok: true });
    // Wait for the continued session, not for `running`: a bounded loop can go running → failed
    // between two polls. The run is `running` before this spawn, so a later status is its own.
    await until(() => runner!.specs.length === 2);
    return record.id;
  };

  it('a continued turn that never says XEZ:DONE fails within the cap, naming the cap and the turns used', async () => {
    const id = await continueGated([POLLING]);
    await until(() => ['failed', 'done', 'waiting'].includes(String(status(id))));

    // Before the fix: 40 nudges, then a park at `waiting` that only a 15-minute idle close ended.
    // A literal, so the red proof reads "got 40" instead of comparing against a missing export.
    expect(runner!.nudges).toHaveLength(3);
    expect(MAX_GATED_CONTINUE_NUDGES).toBe(3);
    expect(status(id)).toBe('failed');
    const error = String(store.getRun(id)?.error);
    expect(error).toContain('continue failed: remaining workflow requires XEZ:DONE from the continued turn');
    expect(error).toContain(`after ${MAX_GATED_CONTINUE_NUDGES + 1} turns`);
    expect(error).toContain(`cap of ${MAX_GATED_CONTINUE_NUDGES} automatic re-prompts`);
    // The tail never ran without the marker.
    expect(store.getRun(id)?.steps.find(s => s.id === 'readiness')?.status).toBe('pending');
  });

  it('an idle re-prompted turn (no tool call) stops the continue loop at once', async () => {
    const id = await continueGated([PROSE_ONLY]);
    await until(() => ['failed', 'done', 'waiting'].includes(String(status(id))));

    // The first nudge still fires — it is what answers a question in autonomous mode — but
    // the turn it prompted did nothing, so there is no second one.
    expect(runner!.nudges).toHaveLength(1);
    expect(status(id)).toBe('failed');
    const error = String(store.getRun(id)?.error);
    expect(error).toContain('remaining workflow requires XEZ:DONE from the continued turn');
    expect(error).toContain('after 2 turns');
    expect(error).toContain('made no tool call');
  });

  it('XEZ:DONE on the first re-prompt still completes the continued step and runs the tail (guard)', async () => {
    const id = await continueGated([POLLING, { text: 'All green.\nXEZ:DONE' }]);
    await until(() => ['failed', 'done', 'waiting'].includes(String(status(id))));

    expect(runner!.nudges).toHaveLength(1);
    expect(status(id)).toBe('done');
    expect(store.getRun(id)?.steps.find(s => s.id === 'readiness')?.status).toBe('done');
  });

  it('the final interactive step also stops nudging at an idle re-prompted turn and parks', async () => {
    runner = nudgeRunner([[PROSE_ONLY]]);
    const record = manager.startRun(SINGLE, { task: 'ship it', worktree: false, autonomous: true });
    await until(() => status(record.id) === 'waiting');
    // A late nudge would have to be delivered within this window to count.
    await new Promise(r => setTimeout(r, 200));

    expect(runner.nudges).toHaveLength(1); // before the fix: all 40
    expect(status(record.id)).toBe('waiting');
    expect(store.readEvents(record.id).some(e =>
      e.type === 'note' && String(e.message).includes('made no tool call'))).toBe(true);
  });

  it('a busy final step keeps the full MAX_AUTO_CONTINUES budget — the small cap is Continue-gated only (guard)', async () => {
    const busy = Array.from({ length: MAX_GATED_CONTINUE_NUDGES + 3 }, () => POLLING);
    runner = nudgeRunner([[...busy, { text: 'XEZ:DONE' }]]);
    const record = manager.startRun(SINGLE, { task: 'ship it', worktree: false, autonomous: true });
    await until(() => status(record.id) === 'done');

    expect(MAX_AUTO_CONTINUES).toBe(40);
    expect(runner.nudges).toHaveLength(busy.length);
  });
});
