/** The manifest arithmetic both release channels share — the pure half of stamping.
 *
 *  `stable.ts` and `snapshot.ts` differ in exactly one decision (how a released package pins
 *  its sibling: a caret range for stable, an exact pin for a snapshot), so everything else
 *  lives here rather than twice.
 *
 *  Deliberately name-agnostic: names come from the checked-out manifests at call time, never
 *  from constants, so a package rename lands without touching this pipeline.
 */

/** The minimal manifest shape the stamper touches; everything else passes through. */
export interface ManifestLike {
  name: string;
  version: string;
  /** npm's own opt-out. A private package is still versioned in lockstep, never published. */
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Whether a release stamps AND publishes this package, or only stamps it.
 *
 * The distinction exists because "in the release" and "on the registry" are different things.
 * A package that ships nowhere yet still needs its version moved in lockstep: the api-client is
 * the worked example — the service pins it, so a frozen version would leave that range pointing
 * at a build the release was not cut from, which is exactly the drift this pipeline exists to
 * prevent. Publishing is gated on npm's own `private` flag rather than a list here, so opening
 * a package up is one line in ITS manifest and no change to the release code.
 */
export function isPublishable(pkg: ManifestLike): boolean {
  return pkg.private !== true;
}

/**
 * Every manifest a release stamps.
 *
 * The order of the fields is the order they must be PUBLISHED in, because each one depends on
 * the one before it: the service (from the phase where it stops merely testing against the
 * client and starts importing it) depends on the api-client, which depends on the contract.
 * Publishing the dependent first would briefly advertise a version of its dependency that does
 * not exist on the registry yet.
 *
 * There is exactly ONE published package in this set — the scoped service, `@qodeca/xezar`.
 * The unscoped bin alias this pipeline used to carry was retired with the rename: a second
 * distribution name is a second thing to keep in lockstep and a second way for a user to end up
 * on a version the release never cut.
 */
export interface ReleaseManifests {
  /**
   * The API contract (zod schemas + inferred types). FIRST in the stamped set because both the
   * api-client and the service depend on it, so its version has to settle before their pins are
   * rewritten. Like the api-client it is `private`, so it is stamped but never published — which
   * is exactly why the service cannot simply depend on it at runtime: `packages/xezar/scripts/
   * inline-contract.mjs` folds it into `dist/contract/` at build time instead. It moves to a real
   * publish the day that script is deleted.
   */
  contract: ManifestLike;
  /** The contract package a consumer installs to talk to a xezar service. */
  apiClient: ManifestLike;
  /** The published service + CLI — the only member of the set that reaches the registry. */
  xezar: ManifestLike;
}

/** How a released package pins a sibling it depends on. */
export type PinStyle = (version: string) => string;

/**
 * Rewrite `pkg`'s range for `depName`, in whichever dependency section already declares it.
 *
 * Absent means absent: a package that does not depend on the other is returned untouched. That
 * is what lets the api-client dependency migrate from `devDependencies` (today: only the tests
 * import it) to `dependencies` (once the service imports its DTOs at runtime) without the
 * release pipeline needing to know it happened.
 */
export function pinDependency(pkg: ManifestLike, depName: string, range: string): ManifestLike {
  const sections = ['dependencies', 'devDependencies', 'peerDependencies'] as const;
  const out: ManifestLike = { ...pkg };
  for (const section of sections) {
    const deps = pkg[section] as Record<string, string> | undefined;
    if (deps && depName in deps) out[section] = { ...deps, [depName]: range };
  }
  return out;
}

/**
 * Stamp every manifest to `version` and re-pin the intra-release dependencies.
 *
 * The pins are derived from the manifests rather than hardcoded: the service pins the
 * api-client and the contract, so a published service can never resolve a client or contract
 * build it was not released with.
 */
export function stampManifestSet(
  manifests: ReleaseManifests,
  version: string,
  pin: PinStyle,
): ReleaseManifests {
  const { contract, apiClient, xezar } = manifests;
  const range = pin(version);

  return {
    contract: { ...contract, version },
    apiClient: pinDependency({ ...apiClient, version }, contract.name, range),
    xezar: pinDependency(
      pinDependency({ ...xezar, version }, apiClient.name, range),
      contract.name,
      range,
    ),
  };
}
