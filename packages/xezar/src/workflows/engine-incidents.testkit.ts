import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, SessionOptions } from '../core/agent-runner.ts';
import { V1TextCoalescer } from '../core/v1-text-coalescer.ts';
import * as factory from '../core/runner-factory.ts';
import type { RunStore } from '../runs/store.ts';
import type { WorkflowDef } from './types.ts';

export const INCIDENT_FINAL = 'XEZ:DONE\nCheckpoint: PR #522 at 43b59fb – APPROVE, review posted.';
export const COMPLETION_VARIANTS = [
  { name: 'checkpoint', chunks: [INCIDENT_FINAL] },
  { name: 'CRLF whitespace', chunks: ['  XEZ:DONE  \r\nCheckpoint: review posted.\r\n  '] },
  { name: 'split chunks', streamed: true, chunks: ['XEZ:', 'DO', 'NE\nCheckpoint: review posted.'] },
  { name: 'v2 final with v1 compatibility text', chunks: [INCIDENT_FINAL], v2: true },
] as const;
export interface ScriptedTurn {
  chunks?: readonly string[];
  v2?: boolean;
  streamed?: boolean;
  error?: string;
  /** What this turn reports as `token-usage`, and as the run result's `tokensUsed`. Whether that
   *  figure is this execution's own or the session's cumulative total is the RUNNER's convention —
   *  which is the thing `run.ts` has to get right on a resumed turn (#676). */
  tokensUsed?: number;
  before?: (spec: AgentRunSpec) => void;
}

/** Only the agent process is replaced. A rejected nudge is recorded, never allowed to spin 40 turns. */
export function scriptedRunner(turns: ScriptedTurn[]) {
  const specs: AgentRunSpec[] = [];
  const messages: unknown[] = [];
  const mock = vi.spyOn(factory, 'createRunner').mockImplementation(() => ({
    backend: 'claude',
    run: async () => { throw new Error('unexpected one-shot runner'); },
    interrupt: async () => {},
    startSession(spec: AgentRunSpec, emit: (event: AgentEvent) => void, options?: SessionOptions) {
      const turn = turns[specs.length];
      specs.push(spec);
      if (!turn) throw new Error('unscripted agent invocation');
      let open = true;
      let finish!: (result: AgentRunResult) => void;
      const text = (turn.chunks ?? ['XEZ:DONE']).join('');
      const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
      const end = () => { open = false; finish({ text, tokensUsed: turn.tokensUsed ?? 0, toolCalls: [] }); };
      queueMicrotask(() => {
        turn.before?.(spec);
        emit({ type: 'session', sessionId: spec.sessionId ?? 'scripted-session' });
        if (turn.error) { emit({ type: 'error', message: turn.error }); end(); return; }
        if (turn.tokensUsed !== undefined) emit({ type: 'token-usage', tokensUsed: turn.tokensUsed });
        if (turn.streamed) {
          // Runners emit whole v1 blocks, never deltas. Exercise the actual production coalescer.
          const coalescer = new V1TextCoalescer(value => emit({ type: 'text', text: value }));
          options?.onUiEvent?.({ type: 'item.started', item: {
            id: 'final-message', kind: 'message', role: 'assistant', phase: 'final', text: '',
          } });
          for (const delta of turn.chunks ?? ['XEZ:DONE']) {
            coalescer.append('final-message', delta);
            options?.onUiEvent?.({ type: 'item.delta', itemId: 'final-message', field: 'text', delta });
          }
          coalescer.complete('final-message');
        } else {
          for (const block of turn.chunks ?? ['XEZ:DONE']) emit({ type: 'text', text: block });
        }
        if (turn.v2 || turn.streamed) options?.onUiEvent?.({ type: 'item.completed', item: {
          id: 'final-message', kind: 'message', role: 'assistant', phase: 'final', text,
        } });
        emit({ type: 'turn-end' });
        if (options?.autoEndAfterFirstTurn) end();
      });
      return { result, get open() { return open; }, end, interrupt: end,
        sendMessage: (blocks) => { messages.push(blocks); return false; } };
    },
  }));
  return { specs, messages, restore: () => mock.mockRestore() };
}

export const SINGLE_STEP: WorkflowDef = { name: 'incident', source: 'built-in', steps: [{ id: 'author', prompt: '{{task}}' }] };
export async function terminal(store: RunStore, id: string) {
  await expect.poll(() => store.getRun(id)?.status, { interval: 10 })
    .toSatisfy(status => ['done', 'failed', 'review', 'cancelled'].includes(String(status)));
}

/** Real shell checks leave an observable order; readiness fails until the scripted repair writes its flag. */
export function checkFailureWorkflow(root: string): WorkflowDef {
  writeFileSync(join(root, 'check.cjs'), `const fs = require('node:fs');
const step = process.argv[2]; fs.appendFileSync('order.txt', step + '\\n');
if (step === 'readiness' && !fs.existsSync('repaired')) process.exit(1);\n`);
  return { name: 'check-failure', source: 'file', steps: [
    { id: 'author', prompt: '{{task}}' },
    ...['readiness', 'gates', 'evidence', 'handoff'].map(id => ({ id, command: `node check.cjs ${id}` })),
  ] };
}
export function order(root: string): string[] { return readFileSync(join(root, 'order.txt'), 'utf8').trim().split('\n'); }
export function repair(spec: AgentRunSpec) { appendFileSync(join(spec.cwd, 'order.txt'), 'repair\n'); writeFileSync(join(spec.cwd, 'repaired'), 'yes'); }

/** Advance quota appointments only. Shared quota holds still read Date.now; I/O timers stay real. */
export function providerClock() {
  let now = Date.now();
  const appointments = new Map<NodeJS.Timeout, { at: number; fire: () => void }>();
  const date = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const timer = {
    schedule(callback: () => void, delay: number) {
      const fire = () => { appointments.delete(handle); callback(); };
      const handle = setTimeout(fire, delay);
      appointments.set(handle, { at: now + delay, fire });
      return handle;
    },
    cancel(handle: NodeJS.Timeout) {
      clearTimeout(handle);
      appointments.delete(handle);
    },
  };
  return {
    timer,
    reset: (seconds = 60) => Math.floor(now / 1000) + seconds,
    advanceTo(at: number) {
      now = at;
      for (const [handle, appointment] of [...appointments]) {
        if (appointments.has(handle) && appointment.at <= now) {
          timer.cancel(handle);
          appointment.fire();
        }
      }
    },
    restore() {
      for (const handle of appointments.keys()) timer.cancel(handle);
      date.mockRestore();
    },
  };
}
