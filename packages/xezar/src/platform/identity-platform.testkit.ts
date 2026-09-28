/**
 * Test-only: force the Windows IDENTITY rule on every OS while every other platform answer – path
 * syntax, `node:path`, the file system – keeps following the host (#963).
 *
 * `withPlatform` (test/helpers/platform.ts) is the default tool for an identity call-site test: it
 * switches `process.platform` for the call. It is the wrong tool when the same code path also runs
 * a SYNTAX helper on a POSIX host's path: the Windows typed-folder rule refuses `/tmp/x`
 * (`isFullyQualifiedPath`) and `fromGitPath` rewrites it to `\tmp\x`, so the forced run would fail
 * before it reached the identity line. There, mock the identity module through this kit instead:
 *
 *   vi.mock('<relative>/platform/path-identity.ts', async (importOriginal) =>
 *     (await import('<relative>/platform/identity-platform.testkit.ts')).identityModuleWith(await importOriginal()));
 *
 * and wrap the call in `withIdentityPlatform('win32', …)`. Outside that wrapper every helper answers
 * exactly as the real module does (an explicit `platform` argument always wins).
 */
import type * as Identity from './path-identity.ts';

let forced: NodeJS.Platform | undefined;

/** The platform an identity helper uses: the caller's explicit one, else the forced one, else the host. */
const platformFor = (explicit: NodeJS.Platform | undefined): NodeJS.Platform => explicit ?? forced ?? process.platform;

/** The path-identity module with every helper routed through the switch. */
export function identityModuleWith(actual: typeof Identity): typeof Identity {
  return {
    ...actual,
    samePath: (a, b, platform) => actual.samePath(a, b, platformFor(platform)),
    isInsideByIdentity: (parent, child, platform) => actual.isInsideByIdentity(parent, child, platformFor(platform)),
    containsPathSegments: (path, segments, platform) => actual.containsPathSegments(path, segments, platformFor(platform)),
    lookupSamePath: (entries, path, platform) => actual.lookupSamePath(entries, path, platformFor(platform)),
    isInsideDotGit: (realTarget, realRoot, platform) => actual.isInsideDotGit(realTarget, realRoot, platformFor(platform)),
  };
}

/** Run `fn` with the identity helpers answering for `platform`; afterwards, also when `fn` throws,
 *  the switch goes back to what it was before the call, so a nested call leaves the outer one's
 *  platform in force. */
export async function withIdentityPlatform<T>(platform: NodeJS.Platform, fn: () => T | Promise<T>): Promise<T> {
  const previous = forced;
  forced = platform;
  try {
    return await fn();
  } finally {
    forced = previous;
  }
}
