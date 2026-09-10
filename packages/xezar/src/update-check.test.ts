import { chmodSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdate, isNewerVersion } from './update-check.ts';

/**
 * `update-check.ts` runs on the BOOT path and reaches the npm registry, so this
 * suite pins the two guarantees AGENTS.md is categorical about: it never throws,
 * and it never blocks. Every case fakes the request at the module's own seam —
 * the global `fetch` — so no test touches the network (#58).
 */

/** The one URL the module is allowed to ask for. */
const REGISTRY_URL = 'https://registry.npmjs.org/%40qodeca%2Fxezar/latest';

/** Upper bound for "resolves quickly enough to be harmless on boot". The module's own
 *  registry timeout is 3s, so a wired timeout lands far below this; an unwired one
 *  never lands at all and the case fails on the test timeout instead. */
const NEVER_BLOCKS_BOUND_MS = 8_000;

type FetchArgs = Parameters<typeof fetch>;

/** Install a fake `fetch` and record what the module asked for. */
function stubFetch(impl: (...args: FetchArgs) => Promise<unknown>): FetchArgs[] {
  const calls: FetchArgs[] = [];
  vi.stubGlobal('fetch', (...args: FetchArgs) => {
    calls.push(args);
    return impl(...args);
  });
  return calls;
}

/** A registry answer: the status and the body `res.json()` resolves to (or throws). */
function registryResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): unknown {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkForUpdate — the answer', () => {
  it('reports a newer published version', async () => {
    const calls = stubFetch(async () => registryResponse({ version: '0.14.0' }));
    expect(await checkForUpdate('@qodeca/xezar', '0.13.0')).toBe('0.14.0');
    // The package name is encoded, and the request carries the abort signal that
    // bounds it — the fake never reaches the real registry.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(REGISTRY_URL);
    expect((calls[0]?.[1] as { signal?: AbortSignal } | undefined)?.signal).toBeInstanceOf(
      AbortSignal,
    );
  });

  it('reports nothing for the same or an older published version', async () => {
    stubFetch(async () => registryResponse({ version: '0.13.0' }));
    expect(await checkForUpdate('@qodeca/xezar', '0.13.0')).toBeNull();
    vi.unstubAllGlobals();
    stubFetch(async () => registryResponse({ version: '0.12.9' }));
    expect(await checkForUpdate('@qodeca/xezar', '0.13.0')).toBeNull();
  });

  it('reports nothing when the payload carries no usable version', async () => {
    stubFetch(async () => registryResponse({}));
    expect(await checkForUpdate('@qodeca/xezar', '0.13.0')).toBeNull();
    vi.unstubAllGlobals();
    // A non-string `version` is a weird payload, not an update.
    stubFetch(async () => registryResponse({ version: 14 }));
    expect(await checkForUpdate('@qodeca/xezar', '0.13.0')).toBeNull();
  });
});

describe('checkForUpdate — every failure degrades quietly', () => {
  it('swallows a network failure', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(checkForUpdate('@qodeca/xezar', '0.13.0')).resolves.toBeNull();
  });

  it('swallows a non-JSON body', async () => {
    stubFetch(async () => registryResponse(new SyntaxError('Unexpected token < in JSON')));
    await expect(checkForUpdate('@qodeca/xezar', '0.13.0')).resolves.toBeNull();
  });

  it('swallows a 500 from the registry', async () => {
    const calls = stubFetch(async () => registryResponse({ version: '9.9.9' }, { ok: false, status: 500 }));
    await expect(checkForUpdate('@qodeca/xezar', '0.13.0')).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('swallows a synchronous throw from the fetch seam itself', async () => {
    // A missing/blocked global `fetch` must degrade the same way an offline one does.
    vi.stubGlobal('fetch', () => {
      throw new Error('fetch is not available');
    });
    await expect(checkForUpdate('@qodeca/xezar', '0.13.0')).resolves.toBeNull();
  });

  it('produces no unhandled rejection while failing', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      stubFetch(async () => {
        throw new Error('offline');
      });
      await checkForUpdate('@qodeca/xezar', '0.13.0');
      // Give a stray rejection a turn of the loop to surface.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe('checkForUpdate — it never blocks the boot', () => {
  it(
    'resolves within a bound against a registry that never answers',
    async () => {
      // A registry that answers only when the caller aborts it — exactly what a
      // hung connection looks like to `fetch`. With no timeout wired into the
      // request this promise never settles, and this case fails on its timeout.
      stubFetch(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
            if (!signal) return; // no bound → hangs forever, which is the regression
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      );

      const started = Date.now();
      await expect(checkForUpdate('@qodeca/xezar', '0.13.0')).resolves.toBeNull();
      expect(Date.now() - started).toBeLessThan(NEVER_BLOCKS_BOUND_MS);
    },
    NEVER_BLOCKS_BOUND_MS + 2_000,
  );
});

describe('checkForUpdate — a read-only home degrades', () => {
  it('answers normally and writes nothing when the cache location cannot be written', async () => {
    const readOnlyHome = mkdtempSync(join(realpathSync(tmpdir()), 'xez-readonly-home-'));
    const savedXezHome = process.env.XEZ_HOME;
    const savedHome = process.env.HOME;
    chmodSync(readOnlyHome, 0o500); // r-x: any write below it fails with EACCES
    stubFetch(async () => registryResponse({ version: '0.14.0' }));
    try {
      process.env.XEZ_HOME = readOnlyHome;
      process.env.HOME = readOnlyHome;
      // The check is pure network + compare: it must neither fail nor cache anything.
      await expect(checkForUpdate('@qodeca/xezar', '0.13.0')).resolves.toBe('0.14.0');
      expect(readdirSync(readOnlyHome)).toEqual([]);
    } finally {
      if (savedXezHome === undefined) delete process.env.XEZ_HOME;
      else process.env.XEZ_HOME = savedXezHome;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      chmodSync(readOnlyHome, 0o700);
      rmSync(readOnlyHome, { recursive: true, force: true });
    }
  });
});

describe('isNewerVersion', () => {
  it('compares numerically, not lexically', () => {
    expect(isNewerVersion('1.2.10', '1.2.9')).toBe(true);
    expect(isNewerVersion('1.10.0', '1.9.9')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true);
  });

  it('is false for the same or an older candidate', () => {
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
    expect(isNewerVersion('1.2.2', '1.2.3')).toBe(false);
    expect(isNewerVersion('0.9.0', '1.0.0')).toBe(false);
  });

  it('treats a missing or unparseable part as 0', () => {
    // Documented behaviour: pre-release tags and junk compare as 0, so they never
    // announce an "update" the user cannot install.
    expect(isNewerVersion('1.3', '1.2.9')).toBe(true);
    expect(isNewerVersion('1.2', '1.2.0')).toBe(false);
    expect(isNewerVersion('1.2.3-beta.1', '1.2.3')).toBe(false);
    expect(isNewerVersion('not-a-version', '0.0.1')).toBe(false);
    expect(isNewerVersion('', '')).toBe(false);
  });
});
