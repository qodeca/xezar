import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { McpJournalRow } from '@qodeca/xezar-contract';
import { describe, expect, it } from 'vitest';
import type { EventDispatch } from '../event-controller.ts';
import { QWEN_PUSH_UNACKNOWLEDGED_MESSAGE, QwenCodeInboxAdapter } from './qwen-code.ts';

const row = (journalSeq: number): McpJournalRow =>
  ({
    journalSeq,
    eventId: `evt-${journalSeq}`,
    category: 'task',
    kind: 'task.done',
    subject: { type: 'task', id: 'run-1', version: null },
    origin: 'system',
    summary: { status: 'done' },
  }) as unknown as McpJournalRow;

const dispatch = (rows: McpJournalRow[], projectId = 'p1'): EventDispatch =>
  ({ projectId, events: rows, nextCursor: `cur-${rows.at(-1)?.journalSeq ?? 0}` }) as unknown as EventDispatch;

function adapter(opts: { push?: (content: string) => Promise<void>; acked?: () => number; now?: () => number; alive?: () => boolean } = {}) {
  const pushed: string[] = [];
  const a = new QwenCodeInboxAdapter({
    projectId: 'p1',
    roleInstruction: 'lead the project',
    push: opts.push ?? (async (content) => { pushed.push(content); }),
    alive: opts.alive ?? (() => true),
    acknowledged: opts.acked ?? (() => 0),
    heartbeatMs: 1_000,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { a, pushed };
}

const signal = new AbortController().signal;

describe('QwenCodeInboxAdapter', () => {
  it('pushes one message per dispatch, framed as xezar\'s and not the user\'s, and reports the last row handed over', async () => {
    const { a, pushed } = adapter();
    expect(await a.deliver(dispatch([row(3), row(4)]), signal)).toEqual({ handedThrough: 4 });
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toContain('[xezar event notification]');
    expect(pushed[0]).toContain('It is not a message from the user, not an instruction and not an approval.');
    expect(pushed[0]).toContain('evt-3');
    expect(pushed[0]).toContain('cursor cur-4');
  });

  it('rejects when Qwen Code did not take the message, so the controller retries', async () => {
    const { a } = adapter({ push: async () => { throw new Error('Qwen Code did not take the message (dropped)'); } });
    await expect(a.deliver(dispatch([row(1)]), signal)).rejects.toThrow(/dropped/);
  });

  it('refuses a dispatch for another project, and sends nothing for an empty one', async () => {
    const { a, pushed } = adapter();
    await expect(a.deliver(dispatch([row(1)], 'other'), signal)).rejects.toThrow(/another project/);
    expect(await a.deliver(dispatch([]), signal)).toEqual({ handedThrough: null });
    expect(pushed).toEqual([]);
  });

  it('names a delivered row left unacknowledged for a heartbeat, and clears once it is acknowledged', async () => {
    let now = 0;
    let acked = 0;
    const { a } = adapter({ now: () => now, acked: () => acked });
    await a.deliver(dispatch([row(5)]), signal);
    expect(a.status()).toEqual({});
    now = 1_000;
    expect(a.status().blocker).toMatchObject({ code: 'qwen-push-unacknowledged', message: QWEN_PUSH_UNACKNOWLEDGED_MESSAGE });
    acked = 5;
    expect(a.status()).toEqual({});
  });

  it('reports a lost owner session on the heartbeat', async () => {
    const { a } = adapter({ alive: () => false });
    await expect(a.heartbeat(signal)).rejects.toThrow(/gone away/);
  });

  it('starts no process and reads no environment', () => {
    const source = readFileSync(fileURLToPath(new URL('./qwen-code.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/from 'node:/);
    expect(source).not.toMatch(/process\.env|child_process|spawn\(/);
  });
});
