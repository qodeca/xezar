/**
 * The PATH a person's login shell builds, put in front of this process's PATH (#963).
 *
 * Linux and macOS: `bash -lc 'printf %s "$PATH"'`, its entries first, duplicates dropped, joined
 * with `:` – the expression `index.ts` used before this module existed. Windows: no change. Its
 * `bash` may be WSL's, whose Linux PATH means nothing to a Windows program, and a `:` join would
 * break every `C:\` entry.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { launchFileSync } from './process-launch.ts';

export interface LoginShellPathDeps {
  /** Runs the login shell and returns its output. */
  run?: () => string;
}

/** The merged PATH, or `undefined` when PATH should stay as it is. Throws what the shell throws. */
export function pathWithLoginShell(
  current: string | undefined,
  deps: LoginShellPathDeps = {},
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'win32') return undefined;
  const run = deps.run ?? (() => launchFileSync('bash', ['-lc', 'printf %s "$PATH"'], { timeout: 5000, encoding: 'utf8' }));
  const loginPath = run().split('\n').map((s) => s.trim()).filter(Boolean).pop() ?? '';
  if (!loginPath) return undefined;
  const seen = new Set<string>();
  return [...loginPath.split(':'), ...(current ?? '').split(':')]
    .filter((d) => d && !seen.has(d) && seen.add(d))
    .join(':');
}
