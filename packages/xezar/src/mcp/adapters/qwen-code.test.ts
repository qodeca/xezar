import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { McpJournalRow } from '@qodeca/xezar-contract';
import { describe, expect, it } from 'vitest';
import type { EventDispatch } from '../event-controller.ts';
import { QWEN_PUSH_HELD_MESSAGE, QWEN_PUSH_UNACKNOWLEDGED_MESSAGE, QwenCodeInboxAdapter } from './qwen-code.ts';

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

  it('stops sending after Qwen Code holds or refuses a message, and says why, so no copies pile up (#1067 review)', async () => {
    for (const receipt of ['held: needs approval', 'refused']) {
      let sends = 0;
      const { a } = adapter({ push: async () => { sends += 1; throw new Error(`Qwen Code did not take the message (${receipt})`); } });
      await expect(a.deliver(dispatch([row(1)]), signal)).rejects.toThrow(/did not take the message/);
      await expect(a.deliver(dispatch([row(1)]), signal)).rejects.toThrow(/sends nothing more until the leader attaches again/);
      await expect(a.deliver(dispatch([row(2)]), signal)).rejects.toThrow(/sends nothing more/);
      expect(sends).toBe(1);
      expect(a.status().blocker).toMatchObject({ code: 'qwen-push-held', message: QWEN_PUSH_HELD_MESSAGE, fix: expect.stringContaining('agents.crossSessionInbound') });
    }
  });

  it('keeps retrying a passing failure (dropped, timeout): only held and refused are lasting', async () => {
    let sends = 0;
    const { a } = adapter({ push: async () => { sends += 1; throw new Error('Qwen Code did not take the message (dropped: sent too fast)'); } });
    await expect(a.deliver(dispatch([row(1)]), signal)).rejects.toThrow(/dropped/);
    await expect(a.deliver(dispatch([row(1)]), signal)).rejects.toThrow(/dropped/);
    expect(sends).toBe(2);
    expect(a.status().blocker).toBeUndefined();
  });

  it('waits out xezar\'s own send pacing inside the attempt and tries again, instead of failing it (#1067 review)', async () => {
    let calls = 0;
    const waits: number[] = [];
    const a = new QwenCodeInboxAdapter({
      projectId: 'p1',
      roleInstruction: 'lead the project',
      push: async () => {
        calls += 1;
        if (calls === 1) throw new Error('xezar is sending to this Qwen Code session faster than it accepts messages, so this one waits for the next attempt; the next send is free in 1500 ms');
      },
      alive: () => true,
      acknowledged: () => 0,
      heartbeatMs: 1_000,
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(await a.deliver(dispatch([row(1)]), signal)).toEqual({ handedThrough: 1 });
    expect(calls).toBe(2);
    expect(waits).toEqual([1_550]);
    // An aborted attempt does not wait or send again.
    const aborted = new AbortController();
    aborted.abort();
    calls = 0;
    await expect(a.deliver(dispatch([row(2)]), aborted.signal)).rejects.toThrow(/next send is free/);
    expect(calls).toBe(1);
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
