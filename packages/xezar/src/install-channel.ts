import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the running xezar came from (#442): a source checkout, or an installed tarball. */
export type InstallChannel = 'release' | 'dev';

/**
 * `dev` when the package's own `src/index.ts` sits next to the running module, `release`
 * otherwise. The module lives one level under the package root in both shapes — `src/` under
 * tsx, `dist/` when built — which is the same resolution `readOwnVersion` uses for
 * `package.json`. The published tarball never ships `src/` (`files` in package.json, held by
 * `pack-check.ts`), and a checkout always has it, so no env var, flag or version suffix is
 * needed. A throw answers `release`: the safe direction is "no badge", never a false one on
 * every user's cockpit.
 */
export function detectInstallChannel(
  moduleUrl: string,
  exists: (path: string) => boolean = existsSync,
): InstallChannel {
  try {
    const pkgRoot = join(dirname(fileURLToPath(moduleUrl)), '..');
    return exists(join(pkgRoot, 'src', 'index.ts')) ? 'dev' : 'release';
  } catch {
    return 'release';
  }
}
