import { describe, expect, it } from 'vitest';
import {
  computeStableVersion,
  isReleaseBump,
  stampStableManifests,
  type ReleaseManifests,
} from './stable.ts';
import { isPublishable } from './manifests.ts';

describe('computeStableVersion', () => {
  it('increments each semver component the way npm version does', () => {
    expect(computeStableVersion('patch', '0.1.5')).toBe('0.1.6');
    expect(computeStableVersion('minor', '0.1.5')).toBe('0.2.0');
    expect(computeStableVersion('major', '0.1.5')).toBe('1.0.0');
  });

  it('returns the base verbatim for the existing bump', () => {
    expect(computeStableVersion('existing', '0.1.5')).toBe('0.1.5');
    expect(computeStableVersion('existing', '2.3.4')).toBe('2.3.4');
  });

  it('rejects a non-plain base version so a snapshot can never be released', () => {
    expect(computeStableVersion('patch', '0.1.5-pr482.123')).toBeNull();
    expect(computeStableVersion('patch', 'not-a-version')).toBeNull();
    expect(computeStableVersion('patch', '')).toBeNull();
  });
});

describe('isReleaseBump', () => {
  it('accepts the four supported modes and nothing else', () => {
    expect(isReleaseBump('patch')).toBe(true);
    expect(isReleaseBump('existing')).toBe(true);
    expect(isReleaseBump('snapshot')).toBe(false);
    expect(isReleaseBump('')).toBe(false);
  });
});

describe('stampStableManifests', () => {
  const set = (): ReleaseManifests => ({
    contract: { name: '@scope/contract', version: '0.1.5' },
    apiClient: { name: '@scope/client', version: '0.1.5' },
    xezar: {
      name: '@scope/impl',
      version: '0.1.5',
      files: ['dist'],
      devDependencies: { '@scope/client': '^0.1.5' },
    },
  });

  it('stamps every manifest and keeps caret ranges on the intra-release pins', () => {
    const stamped = stampStableManifests(set(), '0.1.6');

    expect(stamped.contract.version).toBe('0.1.6');
    expect(stamped.apiClient.version).toBe('0.1.6');
    expect(stamped.xezar.version).toBe('0.1.6');
    expect(stamped.xezar.files).toEqual(['dist']); // passthrough untouched
    // Caret, not an exact pin: a stable service follows compatible releases of its siblings.
    expect(stamped.xezar.devDependencies).toEqual({ '@scope/client': '^0.1.6' });
  });

  it('re-pins the api-client wherever it is declared, so the dev→runtime move is transparent', () => {
    // Today the service only needs the client in its tests; the phase that single-sources the
    // DTOs moves it to `dependencies`. The release pipeline must not need to be told.
    const manifests = set();
    manifests.xezar = {
      name: '@scope/impl',
      version: '0.1.5',
      dependencies: { '@scope/client': '^0.1.5', hono: '^4.6.0' },
    };

    const stamped = stampStableManifests(manifests, '0.1.6');

    expect(stamped.xezar.dependencies).toEqual({ '@scope/client': '^0.1.6', hono: '^4.6.0' });
    expect(stamped.xezar.devDependencies).toBeUndefined();
  });

  it('keeps the published package its own repository field, which provenance requires', () => {
    // We publish with `--provenance`, and npm rejects (E422) any manifest whose
    // `repository.url` does not match the repository the release is built from. Stamping must
    // pass it through untouched rather than dropping or rewriting it.
    const repository = { type: 'git', url: 'https://github.com/qodeca/xezar' };
    const manifests = set();
    manifests.xezar = {
      ...manifests.xezar,
      repository,
      homepage: 'https://example.test',
      bugs: { url: 'https://example.test/issues' },
    };

    const stamped = stampStableManifests(manifests, '0.1.6');

    expect(stamped.xezar.repository).toEqual(repository);
    expect(stamped.xezar.homepage).toBe('https://example.test');
    expect(stamped.xezar.bugs).toEqual({ url: 'https://example.test/issues' });
  });

  it('stamps exactly three manifests — the retired unscoped alias is not one of them', () => {
    // The release used to carry a second, unscoped distribution package. Only `@qodeca/xezar`
    // reaches the registry now, and a stray fourth member would resurrect the split identity
    // this rename removed.
    expect(Object.keys(stampStableManifests(set(), '0.1.6'))).toEqual([
      'contract',
      'apiClient',
      'xezar',
    ]);
  });

  it('stamps a private package like any other — it is in the release, just not on the registry', () => {
    // The api-client is consumed inside the workspace long before it is offered to anyone
    // else. Freezing its version would leave the service's pin against it pointing at a build
    // the release was never cut from, which is the drift this pipeline exists to prevent.
    const manifests = set();
    manifests.apiClient = { ...manifests.apiClient, private: true };

    const stamped = stampStableManifests(manifests, '0.1.6');

    expect(stamped.apiClient.version).toBe('0.1.6');
    expect(stamped.apiClient.private).toBe(true);
    expect(isPublishable(stamped.apiClient)).toBe(false);
    // …and the service's pin against it still moves.
    expect(stamped.xezar.devDependencies).toEqual({ '@scope/client': '^0.1.6' });
  });

  it('treats a manifest with no `private` flag as publishable', () => {
    expect(isPublishable(set().xezar)).toBe(true);
    expect(isPublishable({ name: 'x', version: '1.0.0', private: false })).toBe(true);
  });

  it('does not mutate its inputs', () => {
    const manifests = set();
    stampStableManifests(manifests, '0.1.6');
    expect(manifests.xezar.version).toBe('0.1.5');
    expect(manifests.xezar.devDependencies).toEqual({ '@scope/client': '^0.1.5' });
  });
});
