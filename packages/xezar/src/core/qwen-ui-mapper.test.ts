/**
 * Golden tests for the Qwen Code stream-json → v2 mapper (#1044). Each fixture in
 * `__fixtures__/qwen/` is a real `qwen -o stream-json` capture from Qwen Code 0.25.2 (2026-10-16,
 * against a local and a cloud OpenAI-compatible model), with paths replaced by `/work/proj` and
 * `/home/user`, the init frame's long tool/command lists shortened, and `stream_event` frames
 * dropped (they map to nothing). `hook-refusal` carries the refusal text of the shipped hook,
 * which replaced the probe hook's wording of the capture. Its `.expected.json` is the EXACT
 * `UiEvent` sequence the mapper must produce.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { UiEvent } from './ui-events.ts';
import {
  createQwenUiState,
  isQwenRefusal,
  mapQwenMessage,
  qwenTokenUsage,
  qwenTurnStarted,
  unwrapQwenToolCall,
  type QwenUiMapping,
} from './qwen-ui-mapper.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'qwen');

/** Replay a fixture as the runner drives the mapper: the turn starts before the first frame. */
export function replayQwen(raw: string): UiEvent[] {
  let state = createQwenUiState();
  const events: UiEvent[] = [];
  const push = (mapped: QwenUiMapping): void => {
    state = mapped.state;
    events.push(...mapped.events);
  };
  push(qwenTurnStarted(state));
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    push(mapQwenMessage(msg, state));
  }
  return events;
}

export const QWEN_GOLDEN_FIXTURES = [
  'text-turn',
  'resumed-tools',
  'todo-edit-subagent',
  'provider-error',
  'turn-limit',
  'permission-denied',
  'hook-refusal',
  'image-turn',
  // The final `result` frame is written to match the capture's shape: the capture's own turn went on.
  'bridge-error',
] as const;

describe('qwen → v2 golden fixtures', () => {
  for (const fixture of QWEN_GOLDEN_FIXTURES) {
    it(`maps ${fixture} to the exact UiEvent sequence`, () => {
      const raw = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8');
      const actual = JSON.parse(JSON.stringify(replayQwen(raw)));
      const expected = JSON.parse(readFileSync(join(FIXTURES, `${fixture}.expected.json`), 'utf8'));
      expect(actual).toStrictEqual(expected);
    });
  }
});

describe('qwen mapper rules', () => {
  it('starts the session once, although every turn process sends its own init', () => {
    let state = createQwenUiState();
    const events: UiEvent[] = [];
    for (const step of [
      (s: typeof state) => qwenTurnStarted(s),
      (s: typeof state) => mapQwenMessage({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }, s),
      (s: typeof state) => mapQwenMessage({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 2 } }, s),
      (s: typeof state) => qwenTurnStarted(s),
      (s: typeof state) => mapQwenMessage({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }, s),
    ]) {
      const mapped = step(state);
      state = mapped.state;
      events.push(...mapped.events);
    }
    expect(events.filter((e) => e.type === 'session.started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'turn.started').map((e) => (e as { turnId: string }).turnId)).toEqual(['turn_1', 'turn_2']);
  });

  it('shows the tool a tool_call bridge names, and leaves every other call alone', () => {
    expect(unwrapQwenToolCall('tool_call', { name: 'agent', arguments: { prompt: 'x' } })).toEqual({ name: 'agent', input: { prompt: 'x' } });
    expect(unwrapQwenToolCall('tool_call', {})).toEqual({ name: 'tool_call', input: {} });
    expect(unwrapQwenToolCall('read_file', { file_path: 'a' })).toEqual({ name: 'read_file', input: { file_path: 'a' } });
  });

  it('tells a refusal from a tool error', () => {
    expect(isQwenRefusal('This "run_shell_command" invocation was denied by permission rules. Matching deny rule: "edit".')).toBe(true);
    expect(isQwenRefusal('xezar refused this tool call: the shell is off')).toBe(true);
    expect(isQwenRefusal('[tool_call bridge refused] params must have required property \'name\'')).toBe(false);
  });

  it('keeps Claude Code usage semantics: input without the cache read, Qwen total kept', () => {
    expect(qwenTokenUsage({ input_tokens: 26374, output_tokens: 102, cache_read_input_tokens: 25216, total_tokens: 26476 }))
      .toEqual({ input: 1158, output: 102, cacheRead: 25216, total: 26476 });
  });

  it('ends a "success" turn whose text is an [API Error …] as an error turn', () => {
    let state = qwenTurnStarted(createQwenUiState()).state;
    state = mapQwenMessage({ type: 'system', subtype: 'init', session_id: 's' }, state).state;
    state = mapQwenMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '[API Error: 500 upstream]' }] } }, state).state;
    const done = mapQwenMessage({ type: 'result', subtype: 'success', is_error: false, result: '' }, state);
    expect(done.events.find((e) => e.type === 'turn.completed')).toMatchObject({ stopReason: 'error' });
  });

  it('prices a turn through the injected price and never throws on junk', () => {
    let state = qwenTurnStarted(createQwenUiState({ priceTurn: (u) => u.input * 0.001 })).state;
    const mapped = mapQwenMessage({ type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 5 } }, state);
    expect(mapped.events.find((e) => e.type === 'turn.completed')).toMatchObject({ costUsd: 0.1 });
    for (const junk of [null, 1, 'x', [], { type: 'assistant', message: { content: [null, 1] } }, { type: 'user', message: 'x' }]) {
      expect(() => mapQwenMessage(junk, state)).not.toThrow();
    }
  });
});
