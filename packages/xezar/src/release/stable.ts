/** Stable-release decisions — the pure half of `scripts/release.mjs`.
 *
 *  There is exactly ONE publish channel: the owner-driven `latest` one. The `Release` workflow
 *  (`.github/workflows/release.yml`) is `workflow_dispatch`-only and never fires from a push,
 *  so nothing publishes to npm without a human asking for it by name (#482).
 *
 *  Two decisions live here so they stay unit-testable and side-effect-free: the next stable
 *  version for a given bump, and the pin style the release set is stamped with. Stable releases
 *  use a **caret** range, so a published service follows compatible releases of the api-client
 *  and contract it was cut against.
 */

import { stampManifestSet, type ReleaseManifests as ReleaseManifestSet } from './manifests.ts';

/** The version-bump modes the Release workflow offers. `existing` publishes the
 *  version already committed to the service manifest (for hand-prepared releases);
 *  the rest increment semver from the current base. */
export type ReleaseBump = 'patch' | 'minor' | 'major' | 'existing';

export const RELEASE_BUMPS: readonly ReleaseBump[] = ['patch', 'minor', 'major', 'existing'];

export function isReleaseBump(value: string): value is ReleaseBump {
  return (RELEASE_BUMPS as readonly string[]).includes(value);
}

/** Compute the next stable version from the current base and a bump mode.
 *
 *  `base` must be a plain `major.minor.patch` (no prerelease/build suffix) — a
 *  stable release should never start from a snapshot version. `existing` returns
 *  the base verbatim; the increments zero out the lower components the way
 *  `npm version` does. Returns `null` for an unparseable base so the caller can
 *  fail loudly instead of publishing a garbage version. */
export function computeStableVersion(bump: ReleaseBump, base: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(base.trim());
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  switch (bump) {
    case 'existing':
      return `${major}.${minor}.${patch}`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'major':
      return `${major + 1}.0.0`;
    default:
      return null;
  }
}

export type { ManifestLike, ReleaseManifests } from './manifests.ts';

/** Stamp the release set to a stable version.
 *
 *  Intra-release dependencies get a **caret** range (`^0.1.6`), so a published service follows
 *  compatible releases of the api-client and the contract. Which manifests exist and which
 *  sections carry the pin live in `manifests.ts`. */
export function stampStableManifests(
  manifests: ReleaseManifestSet,
  version: string,
): ReleaseManifestSet {
  return stampManifestSet(manifests, version, (v) => `^${v}`);
}
