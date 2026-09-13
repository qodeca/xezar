import { describe, expect, it } from 'vitest';

import { resumeCommand, type Runner } from './index.ts';

const EXPECTED_COMMAND: Record<Runner, string> = {
  claude: 'claude --resume session-123',
  codex: 'codex resume session-123',
  opencode: 'opencode --session session-123',
  pi: 'pi --session session-123',
};

describe('resumeCommand', () => {
  it('maps every contract runner to its own CLI command', () => {
    for (const [runner, command] of Object.entries(EXPECTED_COMMAND) as [Runner, string][]) {
      expect(resumeCommand(runner, 'session-123')).toBe(command);
    }
  });

  it('defaults legacy records without a runner to Claude', () => {
    expect(resumeCommand(undefined, 'session-123')).toBe('claude --resume session-123');
  });

  it('fails closed for unsafe or option-like session ids', () => {
    expect(resumeCommand('claude', '')).toBeNull();
    expect(resumeCommand('pi', '--help')).toBeNull();
    expect(resumeCommand('codex', 'a && calc.exe')).toBeNull();
  });
});
