import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, AgentRunResult } from './agent-runner.js';
import { PiRunner } from './pi-runner.js';

/**
 * #164 — a pi turn that ends with NO assistant text and NO tool call.
 *
 * Two things were invisible. The stop reason was flattened to `end_turn`, so a
 * turn truncated at the model's output cap read exactly like one that finished
 * with nothing left to say; and the transcript recorded nothing at all about
 * the turn, so the user saw a gap and the only evidence lived in raw NDJSON.
 *
 * These drive the real `PiRunner` over a wire-faithful pi 0.85.1 RPC stream
 * (`docs/rpc.md`) with the child process swapped out, and assert the v1 events
 * the run transcript is built from.
 *
 * Lives beside `pi-runner.test.ts` rather than inside it: PR #163 is rewriting
 * that file's text handling in the same wave.
 */
const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override() : actual.spawn(...args),
  };
});

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'pi');

const OUTPUT_CAP_NOTE = 'pi: the model produced no output this turn — it hit the output token limit';
const PLAIN_NOTE = 'pi: the model produced no output this turn — no assistant text and no tool call';

function fixtureLines(name: string): string[] {
  return readFileSync(join(FIXTURES, `${name}.ndjson`), 'utf8').trim().split('\n').filter(Boolean);
}

/** A fake pi child the runner reads NDJSON from; `finish` ends stdout and
 *  reports the exit code so the runner settles the way a real exit does. */
function fakePiChild(): {
  child: import('node:child_process').ChildProcessWithoutNullStreams;
  write: (line: string) => void;
  finish: (code: number) => void;
} {
  const stdout = new PassThrough();
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    pid: 4321,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    kill: () => {
      Object.assign(child, { killed: true });
      return true;
    },
  }) as unknown as import('node:child_process').ChildProcessWithoutNullStreams;
  return {
    child,
    write: (line: string) => stdout.write(`${line}\n`),
    finish: (code: number) => {
      Object.assign(child, { exitCode: code });
      stdout.end();
      emitter.emit('close', code, null);
    },
  };
}

function feedStream(lines: string[]): { events: AgentEvent[]; result: Promise<AgentRunResult> } {
  const fake = fakePiChild();
  spawnHook.override = () => fake.child;
  const events: AgentEvent[] = [];
  const session = new PiRunner({ bin: 'pi', timeoutMs: 20_000 }).startSession(
    { userPrompt: 'do the thing', cwd: process.cwd() },
    (event) => events.push(event),
  );
  for (const line of lines) fake.write(line);
  fake.finish(0);
  return { events, result: session.result };
}

function notes(events: AgentEvent[]): string[] {
  return events.filter((e) => e.type === 'note').map((e) => (e as { message: string }).message);
}

describe('pi empty turn is visible (#164)', () => {
  afterEach(() => {
    spawnHook.override = null;
  });

  it('says the turn produced nothing, and names the output cap as the cause', async () => {
    const { events, result } = feedStream(fixtureLines('empty-turn-output-cap'));
    await result;
    expect(notes(events)).toContain(OUTPUT_CAP_NOTE);
    // The transcript reads in order: the notice, then the turn boundary.
    const noteAt = events.findIndex((e) => e.type === 'note' && e.message === OUTPUT_CAP_NOTE);
    const turnEndAt = events.findIndex((e) => e.type === 'turn-end');
    expect(noteAt).toBeGreaterThan(-1);
    expect(turnEndAt).toBe(noteAt + 1);
  });

  it('claims no cause when pi reported no stop reason', async () => {
    const { events, result } = feedStream([
      JSON.stringify({ id: 's', type: 'response', command: 'get_state', success: true, data: { sessionId: 's1' } }),
      JSON.stringify({
        type: 'message_update',
        usage: { input: 12, output: 3, totalTokens: 15, cost: { total: 0 } },
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Thinking, and nothing else.' },
      }),
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Thinking, and nothing else.' }],
          usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } },
        },
      }),
      JSON.stringify({ type: 'agent_settled' }),
    ]);
    await result;
    expect(notes(events)).toContain(PLAIN_NOTE);
  });

  /** GUARD: a normal turn — the golden lifecycle fixture, which emits text AND
   *  tool calls — must be untouched by this change and gain no notice. */
  it('GUARD: a turn that emits text and tool calls gets no empty-turn notice', async () => {
    const { events, result } = feedStream(fixtureLines('rpc-lifecycle'));
    await result;
    expect(notes(events)).not.toContain(OUTPUT_CAP_NOTE);
    expect(notes(events)).not.toContain(PLAIN_NOTE);
    expect(events.some((e) => e.type === 'turn-end')).toBe(true);
  });

  /** GUARD: work counts as output even when the model says nothing — a turn
   *  that only calls a tool is not a silent turn. */
  it('GUARD: a turn with a tool call but no text gets no empty-turn notice', async () => {
    const { events, result } = feedStream([
      JSON.stringify({ id: 's', type: 'response', command: 'get_state', success: true, data: { sessionId: 's1' } }),
      JSON.stringify({ type: 'tool_execution_start', toolCallId: 'bash-1', toolName: 'bash', args: { command: 'ls' } }),
      JSON.stringify({
        type: 'tool_execution_end',
        toolCallId: 'bash-1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'a.ts' }] },
        isError: false,
      }),
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } },
          stopReason: 'toolUse',
        },
      }),
      JSON.stringify({ type: 'agent_settled' }),
    ]);
    await result;
    expect(notes(events)).not.toContain(OUTPUT_CAP_NOTE);
    expect(notes(events)).not.toContain(PLAIN_NOTE);
  });
});
