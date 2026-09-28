import { describe, expect, it } from 'vitest';
import { identityModuleWith, withIdentityPlatform } from './identity-platform.testkit.ts';
import * as identity from './path-identity.ts';

type Identity = typeof identity;
type AnyFunction = (...args: unknown[]) => unknown;

const exportedFunctions = Object.keys(identity).filter(
  (name) => typeof identity[name as keyof Identity] === 'function',
);

/** Same folder on Windows only: the answer tells which identity rule is in force. */
const CASE_TWINS = ['C:\\Repo', 'c:\\repo'] as const;

describe('identity-platform testkit (#963)', () => {
  // A helper added to path-identity.ts without a wrapper would pass through the kit's spread
  // un-forced, and every call-site test relying on the kit would silently run the host rule.
  it('forces every function path-identity.ts exports', async () => {
    expect(exportedFunctions).toEqual(
      expect.arrayContaining(['samePath', 'isInsideByIdentity', 'containsPathSegments', 'lookupSamePath', 'isInsideDotGit']),
    );
    const received = new Map<string, unknown[]>();
    const recorder = Object.fromEntries(
      exportedFunctions.map((name) => [name, (...args: unknown[]) => void received.set(name, args)]),
    ) as unknown as Identity;
    const kit = identityModuleWith(recorder);
    await withIdentityPlatform('win32', () => {
      for (const name of exportedFunctions) (kit[name as keyof Identity] as AnyFunction)();
    });
    for (const name of exportedFunctions) expect(received.get(name)?.at(-1), name).toBe('win32');
  });

  // Both orders, so the host's own rule can never stand in for the outer one.
  it.each([
    ['win32', 'linux'],
    ['linux', 'win32'],
  ] as const)('restores the outer %s rule after a nested %s call, also when it throws', async (outer, inner) => {
    const kit = identityModuleWith(identity);
    const outerAnswer = identity.samePath(...CASE_TWINS, outer);
    await withIdentityPlatform(outer, async () => {
      await withIdentityPlatform(inner, () => expect(kit.samePath(...CASE_TWINS)).toBe(!outerAnswer));
      expect(kit.samePath(...CASE_TWINS)).toBe(outerAnswer);
      await expect(
        withIdentityPlatform(inner, () => {
          throw new Error('inner');
        }),
      ).rejects.toThrow('inner');
      expect(kit.samePath(...CASE_TWINS)).toBe(outerAnswer);
    });
    expect(kit.samePath(...CASE_TWINS)).toBe(identity.samePath(...CASE_TWINS)); // the host rule again
  });
});
