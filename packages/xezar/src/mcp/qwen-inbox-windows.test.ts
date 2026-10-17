/**
 * #1086: Qwen Code 0.25.2 opens no inbox on Windows. Its automatic inbox paths are Unix socket files,
 * and on win32 it binds only a named pipe, so it starts with cross-session messaging off and gives its
 * xezar bridge no inbox. No setting turns it on. A Windows leader is therefore pull-only (owner
 * decision on #1086): the text must say so and must not send the person to Qwen's messaging settings,
 * while Linux and macOS keep the push and the settings fix.
 */
import { describe, expect, it } from 'vitest';
import { leaderSetupGuide } from '../onboarding/leader-setup.ts';
import { qwenInboxUnavailable } from './leader-delivery.ts';

describe('qwenInboxUnavailable (#1086)', () => {
  it('on Windows names Qwen Code as the cause and the read-and-ack path, and no setting', () => {
    const blocker = qwenInboxUnavailable('win32');
    expect(blocker.code).toBe('qwen-inbox-unavailable');
    expect(blocker.message).toContain('Windows');
    expect(blocker.fix).toContain('leader_events');
    expect(blocker.fix).toContain('ack');
    expect(`${blocker.message} ${blocker.fix}`).not.toMatch(/crossSession/);
  });

  // Guard that passes both ways: Linux and macOS keep the settings fix.
  it('on Linux and macOS keeps the version and settings fix', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const blocker = qwenInboxUnavailable(platform);
      expect(blocker.code).toBe('qwen-inbox-unavailable');
      expect(blocker.fix).toContain('0.25.2');
      expect(blocker.fix).toContain('agents.crossSessionMessaging');
      expect(blocker.message).not.toContain('Windows');
    }
  });
});

describe('the Qwen Code leader setup guide (#1086)', () => {
  it('says that a Windows leader reads its events instead of getting a push', () => {
    const text = leaderSetupGuide('qwen').prerequisites.join(' ');
    expect(text).toMatch(/On Windows[^.]*no push/);
    expect(text).toContain('leader_events');
    expect(text).not.toContain('which is on by default');
  });
});
