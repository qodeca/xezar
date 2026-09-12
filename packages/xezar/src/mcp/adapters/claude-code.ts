/**
 * Claude Code and push delivery (#108, Phase 6 of #67): what xezar can do to wake a Claude Code
 * leader, walked through the agreed hierarchy (requirements § 12; not reordered here). The runtime
 * evidence is `docs/features/mcp-server/mcp-adapter-evidence-claude-code.md`.
 *
 * 1. Native mechanism, only where the client DEMONSTRABLY reacts. Not demonstrated: generic MCP
 *    notifications start no turn (D-05 § 4, spike T04), and a Channels push
 *    (`notifications/claude/channel`) did not register under isolated fixtures on 2.1.268 —
 *    Channels is a research preview behind account and organisation eligibility.
 * 2. The official programmatic session interface (`claude -p --input-format stream-json`). It only
 *    reaches a session whose stdin the caller owns, which means a `claude` process xezar started
 *    itself. #108 built that path and #309 connected it; the owner then REMOVED it before release
 *    0.14.0 (decision on #311): xezar does not start agent processes — the person runs their own
 *    leader, in their own terminal, and connects it to xezar over MCP. So this rung is unavailable.
 * 3. Terminal text input. REFUSED. Nothing proves project/session targeting, separation from
 *    approval prompts, the shell, user typing and active turns, or duplicate prevention for a
 *    terminal, and xezar never simulates keystrokes.
 *
 * The result: a Claude Code leader gets NO push. It reads its events with the `leader_events` tool
 * (#251) — the pull that works today — and `GET /api/v1/mcp/leader` states the blocker. This module
 * is the recorded verdict; there is no Claude Code reaction adapter to construct.
 */

/** A condition the user can resolve. Never a secret, never an account. */
export interface ClaudeCodeBlocker {
  readonly code: 'native-session-untargetable';
  readonly recoverable: true;
  readonly message: string;
  readonly fix: string;
}

export interface ClaudeCodeRouteStep {
  readonly step: 1 | 2 | 3;
  readonly mechanism: 'claude-channels' | 'stream-json-session' | 'terminal-input';
  readonly outcome: 'not-demonstrated' | 'unavailable' | 'refused';
}

export interface ClaudeCodeRoute {
  readonly route: 'none';
  readonly steps: readonly ClaudeCodeRouteStep[];
  readonly blocker: ClaudeCodeBlocker;
}

/** The hierarchy, walked in order, for the only Claude Code leader there is: one the person runs. */
export function claudeCodeRoute(): ClaudeCodeRoute {
  return {
    route: 'none',
    steps: [
      { step: 1, mechanism: 'claude-channels', outcome: 'not-demonstrated' },
      { step: 2, mechanism: 'stream-json-session', outcome: 'unavailable' },
      { step: 3, mechanism: 'terminal-input', outcome: 'refused' },
    ],
    blocker: {
      code: 'native-session-untargetable',
      recoverable: true,
      message:
        'xezar cannot wake a Claude Code session you run yourself: Claude Code did not react to MCP notifications, Channels did not register under tested conditions, xezar does not start agent processes, and typing into your terminal is refused.',
      fix: 'Read events from your leader with the leader_events tool, or run the leader in OpenCode and attach it to xezar.',
    },
  };
}
