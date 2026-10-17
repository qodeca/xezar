import type { McpLeaderSelfStatus } from '@qodeca/xezar-contract';

/**
 * The project-only leader setup that the bundled onboarding fallback can prepare (#464 P3).
 *
 * These are data, not writes. The setup task merges the chosen entry into its reviewable candidate;
 * xezar never writes personal configuration, grants trust, signs in, starts a client or attaches a
 * leader as a side effect of generating a snippet. Keeping the three snippets here also keeps the
 * offline fallback and the runtime verification language on one reviewed source.
 */
export const LEADER_SETUP_STATES = ['files-prepared', 'connected', 'attached', 'delivery-verified'] as const;
export type LeaderSetupState = (typeof LEADER_SETUP_STATES)[number];

export type LeaderSetupClient = 'claude-code' | 'codex' | 'qwen';

export interface LeaderSetupGuide {
  client: LeaderSetupClient;
  label: string;
  destination: string;
  snippet: string;
  prerequisites: readonly string[];
}

const GUIDES: Readonly<Record<LeaderSetupClient, LeaderSetupGuide>> = {
  'claude-code': {
    client: 'claude-code',
    label: 'Claude Code',
    destination: '.mcp.json',
    snippet: JSON.stringify(
      { mcpServers: { xezar: { command: 'npx', args: ['-y', '@qodeca/xezar', 'mcp'] } } },
      null,
      2,
    ),
    prerequisites: [
      'Review and approve the project MCP entry, then sign in yourself.',
      'For pushed events, start Claude Code with --dangerously-load-development-channels server:xezar and accept its warning only if you intend to allow event injection. Provider and administrator restrictions can still make push unavailable.',
    ],
  },
  codex: {
    client: 'codex',
    label: 'Codex',
    destination: '.codex/config.toml',
    snippet: ['[mcp_servers.xezar]', 'command = "npx"', 'args = ["-y", "@qodeca/xezar", "mcp"]'].join('\n'),
    prerequisites: [
      'Trust the project and sign in yourself; Codex ignores project configuration until the project is trusted.',
      'For pushed events, run the shared local app-server under the same Codex home that xezar uses. A different home, an unloaded thread or a non-shared server is reported as unavailable.',
    ],
  },
  qwen: {
    client: 'qwen',
    label: 'Qwen Code',
    destination: '.qwen/settings.json',
    snippet: JSON.stringify(
      { mcpServers: { xezar: { command: 'npx', args: ['-y', '@qodeca/xezar', 'mcp'] } } },
      null,
      2,
    ),
    prerequisites: [
      'Use Qwen Code 0.25.2 or newer, review the project MCP entry, and set up a model provider yourself.',
      'On Linux and macOS, pushed events use Qwen Code cross-session messaging, on unless agents.crossSessionMessaging is false; if it is false, or agents.crossSessionInbound is hold or refuse, the leader reads its events instead.',
      'On Windows, Qwen Code has no push: it opens no inbox there (up to 0.25.2), and no setting changes this. The leader reads its events with leader_events action read and acknowledges them with action ack.',
    ],
  },
};

export function leaderSetupGuide(client: LeaderSetupClient): LeaderSetupGuide {
  return GUIDES[client];
}

/** Complete fallback content for the built-in setup workflow when the public skill is offline. */
export function leaderSetupFallbackInstructions(): string {
  const guides = (Object.keys(GUIDES) as LeaderSetupClient[]).map((client) => {
    const guide = GUIDES[client];
    return [
      `${guide.label} → ${guide.destination}`,
      '```',
      guide.snippet,
      '```',
      ...guide.prerequisites.map((item) => `- ${item}`),
    ].join('\n');
  });

  return [
    'Leader mode — prepare only the chosen client entry below, merging it with existing content.',
    'A snippet is only “files prepared”. It does not prove connection, trust, sign-in, attachment or delivery.',
    ...guides,
    'After the candidate is integrated, the person completes trust and sign-in, starts the chosen client in this project and makes a real xezar MCP tool call. That proves “connected”.',
    'Claude Code, Codex and Qwen Code then call leader_events with action attach and a new operationId; leader_events action status proves “attached”.',
    'Finally, while attached, call leader_events with action read and no cursor, or account for a real pushed event. The read answer or pushed event is the “delivery verified” evidence. A status counter from an earlier session is not enough.',
    'After xezar restarts, attachment is gone: make a tool call, check status, attach again with a new operationId, then read outstanding events. Page with nextCursor while hasMore is true; a gap requires current-state reconciliation before acknowledging resumeCursor.',
    'Report pending checks, delivery blockers, task.stalled as advisory only, pending reviewer verdicts and replay limits exactly as returned. Never call the leader ready while integration, trust, sign-in, attachment or delivery verification is pending.',
    'Use the installed MCP connection reference, the MCP API surface and the runtime leader_events description for current client details and refusal fixes.',
  ].join('\n\n');
}

/**
 * Explain only what THIS tool exchange proves. `status` is intentionally not enough to promote an
 * attachment to delivery-verified: its durable cursors may describe an earlier process/session.
 * A successful read in the current exchange is a replay check, while a pushed event is its own
 * direct evidence and carries the cursor to acknowledge.
 */
export function leaderSetupVerificationLine(
  status: McpLeaderSelfStatus | undefined,
  options: { replayChecked?: boolean } = {},
): string {
  if (!status?.available) {
    const reason = status?.reason ?? 'event delivery status is unavailable';
    return `Leader setup: connected — this real tool call reached the project, but attachment is pending because ${reason}`;
  }

  if (!status.self.attached) {
    if (status.leader !== null) {
      return `Leader setup: connected — this real tool call reached the project, but another ${clientLabel(status.leader.client)} leader is attached; this session is not attached.`;
    }
    if (status.pushUnavailable !== null) {
      return `Leader setup: connected — this real tool call reached the project, but attachment is pending: ${status.pushUnavailable.message}`;
    }
    return 'Leader setup: connected — this real tool call reached the project; attachment is still pending.';
  }

  if (options.replayChecked) {
    const limitation = status.blocker
      ? ` Push delivery is still limited: ${status.blocker.message} Fix: ${status.blocker.fix}`
      : status.pushUnavailable
        ? ` Push delivery is still unavailable: ${status.pushUnavailable.message}`
        : '';
    return `Leader setup: delivery verified — this session is attached and this call checked the retained replay path.${limitation}`;
  }

  const limitation = status.blocker
    ? ` Current blocker: ${status.blocker.message} Fix: ${status.blocker.fix}`
    : status.pushUnavailable
      ? ` Push unavailable: ${status.pushUnavailable.message}`
      : '';
  return `Leader setup: attached — status proves this session owns the attachment; a current pushed event or leader_events read is still required to verify delivery.${limitation}`;
}

function clientLabel(client: LeaderSetupClient): string {
  return client === 'claude-code' ? 'Claude Code' : client === 'codex' ? 'Codex' : 'Qwen Code';
}
