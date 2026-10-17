/**
 * The system prompt as a file, not an argument (#1008).
 *
 * Claude Code takes the system prompt on its command line. It carries the role skill, and
 * a long one pushed the whole line past the Windows limit (32,767 characters for `CreateProcess`):
 * the step died at spawn with `ENAMETOOLONG` before the agent started. The CLI reads the same text
 * from a file through `--append-system-prompt-file`, so the length of the prompt no longer reaches
 * the command line.
 *
 * Placement: a private `mkdtemp` directory under the OS temp dir, mode 0600, removed when the child exits. Never into the project.
 *
 * Returns null when the file cannot be written; the caller then passes the text on argv as before,
 * which still works for every prompt that fits (§ Zero config: degrade, never fail).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SystemPromptFile {
  /** Absolute path the CLI is pointed at. */
  readonly path: string;
  /** Best-effort removal of the private directory; safe to call more than once. */
  readonly cleanup: () => void;
}

export function writeSystemPromptFile(text: string): SystemPromptFile | null {
  let dir: string;
  let path: string;
  try {
    dir = mkdtempSync(join(tmpdir(), 'xez-prompt-'));
    path = join(dir, 'system-prompt.md');
    writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
  } catch {
    return null;
  }
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A temp file; failing to remove it never concerns the run.
      }
    },
  };
}
