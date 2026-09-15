import { describe, expect, it } from 'vitest';

import {
  CHANNEL_INCOMPATIBLE_PROTOCOL_VERSION,
  SERVER_CAPABILITIES,
  SUPPORTED_PROTOCOL_VERSIONS,
  negotiateProtocolVersion,
  serverCapabilitiesFor,
} from './protocol.ts';

/**
 * #374 — the channel capability is advertised to Claude Code and to no one else, `claude/channel/
 * permission` is advertised to no one at all, and the bridge never negotiates the one protocol
 * revision Claude Code drops channels over. Each case is proven red against a named break in the PR
 * (AC-7, AC-8).
 */

describe('serverCapabilitiesFor (#374, #450)', () => {
  it('adds the claude/channel capability only for a claude-code client whose bridge decided a push can arrive', () => {
    // RED against: advertising the channel to every client (which changes their handshake), or (#450,
    // T-13) ignoring the `channel` argument, which registers a channel no push can ever use.
    const forClaude = serverCapabilitiesFor('claude-code', true) as Record<string, unknown>;
    expect(forClaude).toMatchObject({ tools: { listChanged: false }, experimental: { 'claude/channel': {} } });
    expect(serverCapabilitiesFor('claude-code', false)).toEqual(SERVER_CAPABILITIES);
    expect('experimental' in serverCapabilitiesFor('claude-code', false)).toBe(false);
  });

  it('leaves every other client’s capabilities byte-identical to today, whatever the channel argument (AC-7)', () => {
    // RED against: leaking `experimental` into a non-claude handshake.
    for (const name of [undefined, 'codex', 'opencode', 'pi', 'some-future-client']) {
      for (const channel of [true, false]) {
        expect(serverCapabilitiesFor(name, channel)).toEqual(SERVER_CAPABILITIES);
        expect('experimental' in serverCapabilitiesFor(name, channel)).toBe(false);
      }
    }
  });

  it('never declares claude/channel/permission, for any client (#73: never impersonate approval)', () => {
    // RED against: declaring the permission-relay capability, which would route approvals to xezar.
    for (const name of [undefined, 'claude-code', 'codex']) {
      const experimental = (serverCapabilitiesFor(name, true) as { experimental?: Record<string, unknown> }).experimental ?? {};
      expect('claude/channel/permission' in experimental).toBe(false);
    }
  });
});

describe('the protocol revision guard (§ 2.3 step 2)', () => {
  it('never offers the revision Claude Code refuses to deliver a channel over', () => {
    // RED against: adding 2026-07-28 to SUPPORTED_PROTOCOL_VERSIONS, which would make a Claude Code
    // leader attachable and silently unreachable.
    expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain(CHANNEL_INCOMPATIBLE_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(CHANNEL_INCOMPATIBLE_PROTOCOL_VERSION)).not.toBe(CHANNEL_INCOMPATIBLE_PROTOCOL_VERSION);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(negotiateProtocolVersion(CHANNEL_INCOMPATIBLE_PROTOCOL_VERSION));
  });
});
