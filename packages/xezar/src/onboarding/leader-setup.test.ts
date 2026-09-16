import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import type { McpLeaderSelfStatus } from '@qodeca/xezar-contract';

import {
  LEADER_SETUP_STATES,
  leaderSetupFallbackInstructions,
  leaderSetupGuide,
  leaderSetupVerificationLine,
} from './leader-setup.ts';

type AvailableStatus = Extract<McpLeaderSelfStatus, { available: true }>;

const attached = (client: 'claude-code' | 'codex' | 'pi'): AvailableStatus => ({
  available: true,
  owner: { client: client === 'claude-code' ? 'claude-code' : client === 'codex' ? 'codex' : null },
  leader: { client, state: 'attached' },
  delivery: { state: 'idle', deliveredSeq: 0, ackedSeq: 0, reactedSeq: 0, latestSeq: 0 },
  blocker: null,
  canPush: true,
  pushUnavailable: null,
  self: { client, isOwner: true, attached: true },
});

describe('leader setup snippets and client-owned prerequisites (#464 P3, ONB-13)', () => {
  it('prepares Claude Code project config while leaving the channel flag and refusal visible', () => {
    // RED against: removing the launch-flag prerequisite or replacing the project destination with
    // a personal configuration path.
    const guide = leaderSetupGuide('claude-code');
    expect(guide.destination).toBe('.mcp.json');
    expect(JSON.parse(guide.snippet)).toEqual({
      mcpServers: { xezar: { command: 'npx', args: ['-y', '@qodeca/xezar', 'mcp'] } },
    });
    expect(guide.prerequisites.join(' ')).toContain('--dangerously-load-development-channels server:xezar');
    expect(guide.prerequisites.join(' ')).toContain('restrictions can still make push unavailable');
  });

  it('prepares Codex project config and names trust plus the shared-home prerequisite', () => {
    // RED against: deleting either trust or same-home guidance; the snippet alone must never read
    // as a working connection.
    const guide = leaderSetupGuide('codex');
    expect(guide.destination).toBe('.codex/config.toml');
    expect(parseToml(guide.snippet)).toEqual({
      mcp_servers: { xezar: { command: 'npx', args: ['-y', '@qodeca/xezar', 'mcp'] } },
    });
    expect(guide.prerequisites.join(' ')).toMatch(/Trust the project.*same Codex home/s);
  });

  it('prepares pi project config and keeps adapter, extension and ownership separate', () => {
    // RED against: dropping `keep-alive`, the adapter prerequisite or the ownership warning.
    const guide = leaderSetupGuide('pi');
    expect(guide.destination).toBe('.pi/mcp.json');
    expect(JSON.parse(guide.snippet)).toMatchObject({
      settings: { directTools: true },
      mcpServers: { xezar: { lifecycle: 'keep-alive' } },
    });
    expect(guide.prerequisites.join(' ')).toMatch(/MCP adapter.*leader extension.*own the project connection/s);
  });

  it('ships all four states and an honest result checklist in the offline fallback', () => {
    // RED against: removing one state or changing the final checklist to call a prepared snippet
    // ready. The state list assertion pins the closed vocabulary too.
    expect(LEADER_SETUP_STATES).toEqual(['files-prepared', 'connected', 'attached', 'delivery-verified']);
    const text = leaderSetupFallbackInstructions();
    for (const state of ['files prepared', 'connected', 'attached', 'delivery verified']) expect(text).toContain(state);
    for (const pending of ['integration', 'trust', 'sign-in', 'attachment', 'delivery verification']) expect(text).toContain(pending);
    expect(text).toContain('task.stalled as advisory only');
    expect(text).toContain('pending reviewer verdicts');
    expect(text).toContain('installed MCP connection reference');
    expect(text).toContain('runtime leader_events description');
    expect(text).not.toMatch(/writes? .*home|configures? .*home/i);
  });
});

describe('leader setup verification is current-session evidence (#464 P3, ONB-04/07/14)', () => {
  it('reports connected, attached and replay-verified without promoting an old status counter', () => {
    // RED against: using durable deliveredSeq as current-session proof, or collapsing attachment
    // and replay verification into one state.
    const connected: McpLeaderSelfStatus = {
      ...attached('codex'),
      leader: null,
      self: { client: 'codex', isOwner: true, attached: false },
    };
    expect(leaderSetupVerificationLine(connected)).toContain('Leader setup: connected');
    expect(leaderSetupVerificationLine({
      ...attached('codex'),
      delivery: { state: 'idle', deliveredSeq: 99, ackedSeq: 99, reactedSeq: 99, latestSeq: 99 },
    })).toContain('Leader setup: attached');
    expect(leaderSetupVerificationLine(attached('codex'), { replayChecked: true })).toContain('Leader setup: delivery verified');
  });

  it('keeps hosted and client blockers pending instead of claiming readiness', () => {
    // RED against: treating any successful tool response as attachment or delivery verification.
    const hosted: McpLeaderSelfStatus = {
      ...attached('claude-code'),
      leader: null,
      canPush: false,
      pushUnavailable: { code: 'hosted-mode', message: 'Local attachment is unavailable in hosted mode.' },
      self: { client: 'claude-code', isOwner: true, attached: false },
    };
    expect(leaderSetupVerificationLine(hosted)).toBe(
      'Leader setup: connected — this real tool call reached the project, but attachment is pending: Local attachment is unavailable in hosted mode.',
    );
    const blocked = {
      ...attached('pi'),
      blocker: { code: 'pi-not-addressable', message: 'The pi adapter is connected without the leader extension.', fix: 'Load the extension.' },
    };
    expect(leaderSetupVerificationLine(blocked)).toMatch(/Leader setup: attached.*Current blocker:.*Load the extension/);
  });
});
