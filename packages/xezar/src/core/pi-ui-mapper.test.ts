import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { UiEvent } from './ui-events.js';
import {
  createPiUiState,
  mapPiRpcMessage,
  piTurnStarted,
  type PiUiMapperState,
  type PiUiMapping,
} from './pi-ui-mapper.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'pi');

function replay(fixture: string): UiEvent[] {
  const lines = readFileSync(join(FIXTURES, `${fixture}.ndjson`), 'utf8').trim().split('\n');
  let state: PiUiMapperState = createPiUiState();
  const events: UiEvent[] = [];
  const push = (mapped: PiUiMapping): void => {
    state = mapped.state;
    events.push(...mapped.events);
  };
  push(piTurnStarted(state));
  for (const line of lines) push(mapPiRpcMessage(JSON.parse(line), state));
  return JSON.parse(JSON.stringify(events)) as UiEvent[];
}

describe('pi RPC → v2 golden fixture', () => {
  it('maps the wire-faithful lifecycle exactly', () => {
    const expected = JSON.parse(readFileSync(join(FIXTURES, 'rpc-lifecycle.expected.json'), 'utf8'));
    expect(replay('rpc-lifecycle')).toStrictEqual(expected);
  });

  it('malformed and unknown RPC messages are ignored without throwing', () => {
    const state = createPiUiState();
    for (const value of [null, 42, [], {}, { type: 'future_event' }]) {
      const mapped = mapPiRpcMessage(value, state);
      expect(mapped.events).toEqual([]);
      expect(mapped.state).toBe(state);
    }
  });

  /**
   * #164 — a turn that spent its whole output allowance on reasoning and ended
   * with no text and no tool call. The wire shape is pi 0.85.1's RPC output
   * (`docs/rpc.md` §Events + §Types → AssistantMessage): `message_update`
   * carries no cumulative `message`/`partial`, and the turn's authoritative
   * `stopReason` — here `"length"` — rides `message_end.message`.
   */
  it('records the output-cap stop as max_tokens, not end_turn', () => {
    const expected = JSON.parse(
      readFileSync(join(FIXTURES, 'empty-turn-output-cap.expected.json'), 'utf8'),
    );
    expect(replay('empty-turn-output-cap')).toStrictEqual(expected);
  });

  it('maps every documented pi stop reason onto the normalized turn reason', () => {
    // Vocabulary: pi `docs/rpc.md` — "stop", "length", "toolUse", "error", "aborted".
    const cases: ReadonlyArray<[string, string]> = [
      ['stop', 'end_turn'],
      ['length', 'max_tokens'],
      ['toolUse', 'end_turn'],
      ['error', 'error'],
      ['aborted', 'cancelled'],
    ];
    for (const [wire, normalized] of cases) {
      let state = piTurnStarted(createPiUiState()).state;
      state = mapPiRpcMessage(
        { type: 'message_end', message: { role: 'assistant', stopReason: wire } },
        state,
      ).state;
      expect(mapPiRpcMessage({ type: 'agent_settled' }, state).events).toEqual([
        { type: 'turn.completed', turnId: 'turn_1', stopReason: normalized },
      ]);
    }
  });

  /** GUARD: a stop reason pi has not published yet must not be forced to
   *  `end_turn` — the turn keeps whatever reason it already had. */
  it('GUARD: an unknown stop reason leaves the turn reason untouched', () => {
    let state = piTurnStarted(createPiUiState()).state;
    state = mapPiRpcMessage(
      { type: 'message_end', message: { role: 'assistant', stopReason: 'length' } },
      state,
    ).state;
    state = mapPiRpcMessage(
      { type: 'message_end', message: { role: 'assistant', stopReason: 'someFutureReason' } },
      state,
    ).state;
    expect(mapPiRpcMessage({ type: 'agent_settled' }, state).events).toEqual([
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'max_tokens' },
    ]);
  });

  it('maps upstream model stop reasons onto the normalized turn reason', () => {
    let state = piTurnStarted(createPiUiState()).state;
    state = mapPiRpcMessage(
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'done', reason: 'length', message: {} },
      },
      state,
    ).state;
    expect(mapPiRpcMessage({ type: 'agent_settled' }, state).events).toEqual([
      { type: 'turn.completed', turnId: 'turn_1', stopReason: 'max_tokens' },
    ]);
  });
});
