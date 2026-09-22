import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { resolveBindHost } from './capabilities.ts';
import { startServer } from './server.ts';

/**
 * #838 item A, the programmatic door: `startServer` is the real first `listen`, so an empty
 * `bindHost` must bind loopback there too, not only after the CLI's `parseArgs`. Asserted on the
 * address the server actually bound, which is `::` (or `0.0.0.0` without IPv6) for `''` and
 * `127.0.0.1` for loopback — no connect probe, so no dependence on the host having IPv6.
 */
describe('resolveBindHost', () => {
  it('reads an empty value as the flag being absent and passes every other value through', () => {
    expect(resolveBindHost('')).toBeUndefined();
    expect(resolveBindHost(undefined)).toBeUndefined();
    expect(resolveBindHost('127.0.0.1')).toBe('127.0.0.1');
    expect(resolveBindHost('0.0.0.0')).toBe('0.0.0.0');
  });
});

describe('startServer bindHost', () => {
  let dir: string;
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xez-bind-host-'));
    repoRoot = join(dir, 'repo');
    mkdirSync(join(repoRoot, '.local/xezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.local/xezar'));
  });

  afterEach(() => {
    store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it("an empty bindHost binds 127.0.0.1, exactly like an absent one", async () => {
    const server = startServer(
      { repoRoot, store, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test', bindHost: '' },
      0,
    );
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
