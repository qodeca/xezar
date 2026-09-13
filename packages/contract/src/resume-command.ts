import type { Runner } from './health.ts';

/**
 * The session id shape every backend currently mints. The command is pasted into bash or cmd.exe,
 * so accepting only characters that are inert in both shells is safer than platform-specific
 * quoting. A leading dash is excluded so the id cannot become a CLI option.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,199}$/;

export function isSafeSessionId(sessionId: string): boolean {
  return SAFE_SESSION_ID.test(sessionId);
}

/**
 * Build the interactive resume command shared by the Node service and browser cockpit.
 * Undefined runners are legacy records from before runner affinity and therefore mean Claude.
 */
export function resumeCommand(runner: Runner | undefined, sessionId: string): string | null {
  if (!isSafeSessionId(sessionId)) return null;

  const resolvedRunner = runner ?? 'claude';
  switch (resolvedRunner) {
    case 'claude':
      return `claude --resume ${sessionId}`;
    case 'codex':
      return `codex resume ${sessionId}`;
    case 'opencode':
      return `opencode --session ${sessionId}`;
    case 'pi':
      return `pi --session ${sessionId}`;
  }

  // Adding a runner to the contract without deciding its resume command must fail typecheck.
  const _exhaustive: never = resolvedRunner;
  void _exhaustive;
  return null;
}
