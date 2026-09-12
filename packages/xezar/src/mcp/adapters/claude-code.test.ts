import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { claudeCodeRoute } from './claude-code.ts';

/**
 * #108, as it stands after the owner's decision on #311: xezar does not start agent processes, so
 * the stream-json session this adapter drove is gone, and a Claude Code leader gets no push. These
 * tests pin the verdict, and that the spawn path cannot quietly come back.
 */

describe('the delivery hierarchy for a Claude Code leader', () => {
  it('walks all three rungs in order and ends in a recoverable blocker, never terminal input', () => {
    const route = claudeCodeRoute();
    expect(route.route).toBe('none');
    expect(route.steps.map((s) => [s.step, s.mechanism, s.outcome])).toEqual([
      [1, 'claude-channels', 'not-demonstrated'],
      [2, 'stream-json-session', 'unavailable'],
      [3, 'terminal-input', 'refused'],
    ]);
    expect(route.blocker).toMatchObject({ code: 'native-session-untargetable', recoverable: true });
    expect(route.blocker.fix).toMatch(/leader_events/);
  });

  it('holds no way to start a Claude Code process: no spawn, no argv builder (owner decision on #311)', () => {
    const source = readFileSync(join(import.meta.dirname, 'claude-code.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/child_process|spawn\(|buildClaudeCodeLeaderArgs|--input-format/);
  });
});
