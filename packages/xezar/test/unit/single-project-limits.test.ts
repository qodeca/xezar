import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectStateLayout, setActiveStateLayout } from '../../src/state-layout.js';
import { deriveDefaultMemoryLimitMb } from '../../src/workspace/config.js';
import { WorkspaceSemaphore } from '../../src/workspace/semaphore.js';

/**
 * SP-2.4 (#600 AC-7, FR-7.1, FR-7.3): a committed resource limit is applied as
 * written.
 *
 * Single-project mode makes `memoryLimitMb` and `maxParallel` COMMITTED state —
 * they live in `<project>/.xezar/workspace.json` and travel with the repository
 * to every machine that clones it. The obvious-looking kindness is to reconcile
 * them with the host: `Math.min(committed, deriveDefaultMemoryLimitMb())`, a
 * warning, a substituted value. The issue forbids all three, and the owner
 * accepted "a committed limit larger than the host" as a risk with no
 * mitigation to be built, because BR-5 puts identical behaviour everywhere
 * above host fit: a project that runs with different numbers on the reviewer's
 * laptop than on the author's is exactly what committing them was meant to end.
 *
 * So this file's whole job is to go red when a clamp appears. The host
 * derivation is a DEFAULT for an absent key and must never become a ceiling for
 * a present one.
 */

/** The workspace snapshot shape `refresh()` installs, with only the keys these cases read. */
function limits(memoryLimitMb: number | null, maxParallel: number) {
  return {
    maxParallel,
    maxMonitoringSessions: 2,
    monitoringWakeIntervalMinutes: 5,
    autoResumeOnUsageLimit: true,
    idleTimeoutMinutes: 15,
    memoryLimitMb,
  };
}

test('a committed memoryLimitMb far above this host is applied exactly, not clamped', async () => {
  const hostDerived = deriveDefaultMemoryLimitMb(totalmem());
  // 128 GiB: above the derivation on every machine this suite runs on, and
  // above the 8192 MiB ceiling the derivation itself is clamped to.
  const committed = 131_072;
  assert.ok(committed > hostDerived, 'fixture must exceed the host derivation to prove anything');

  const semaphore = new WorkspaceSemaphore({ load: async () => limits(committed, 2) });
  await semaphore.refresh();

  assert.equal(
    semaphore.memoryLimitMb(),
    committed,
    'the committed per-task memory ceiling was reduced — AC-7 forbids a clamp, a refusal and a warning-and-substitute',
  );
  // And the per-project lookup inherits the same unclamped value rather than
  // reconciling it a second time on the way out.
  assert.equal(semaphore.projectMemoryLimitMb('/some/repo'), committed);
});

test('a per-repo memoryLimitMb override above the host is applied exactly too', async () => {
  const committed = 262_144;
  const semaphore = new WorkspaceSemaphore({
    load: async () => ({
      ...limits(4096, 2),
      projectMemoryLimits: new Map([[process.cwd(), committed]]),
    }),
  });
  await semaphore.refresh();
  assert.equal(semaphore.projectMemoryLimitMb(process.cwd()), committed);
});

test('a committed maxParallel above the shipped default is applied exactly', async () => {
  // 16 is the schema's own upper bound — a validation range, not a host
  // reconciliation, and deliberately left alone. What must not happen is the
  // value being narrowed towards the shipped default of 2 because this host is
  // small.
  const semaphore = new WorkspaceSemaphore({ load: async () => limits(null, 16) });
  await semaphore.refresh();
  assert.equal(semaphore.maxParallel(), 16);
  assert.equal(semaphore.projectMaxParallel('/some/repo'), 16);
});

test('an explicit null memoryLimitMb still means no limit, host derivation included', async () => {
  // The control for the case above: the derivation fills an ABSENT key only.
  // If it ever became a ceiling it would also become a floor here, replacing a
  // deliberate "no guard" with a number the user never chose.
  const semaphore = new WorkspaceSemaphore({ load: async () => limits(null, 2) });
  await semaphore.refresh();
  assert.equal(semaphore.memoryLimitMb(), null);
  assert.equal(semaphore.projectMemoryLimitMb('/some/repo'), null);
});

test('a committed limit BELOW the host derivation is equally untouched', async () => {
  // A clamp written as `Math.min` passes the case above only if it is written
  // as `Math.max`; this pins the other direction so neither shape can land.
  const semaphore = new WorkspaceSemaphore({ load: async () => limits(256, 1) });
  await semaphore.refresh();
  assert.equal(semaphore.memoryLimitMb(), 256);
  assert.equal(semaphore.maxParallel(), 1);
});

/**
 * The case above and its four siblings all inject `load`, so between them they
 * pin only the GETTERS. A `Math.min(resources.memoryLimitMb, deriveDefault…)`
 * written inside `loadResourceLimits` — the production loader, which an
 * injected stub replaces — passes every one of them and still reduces the
 * committed number on every real launch, which is the AC-7 break itself.
 *
 * So this case uses the DEFAULT loader and a real committed file: an active
 * project state layout whose `<project>/.xezar/workspace.json` carries the two
 * machine-shaped keys, read through `loadWorkspaceConfig` exactly as a boot in
 * that folder reads them. It is the only case here that would go red against a
 * loader-side clamp, and it is what the comment in `semaphore.ts` now claims.
 */
test('the DEFAULT loader applies a committed workspace.json limit exactly (no loader-side clamp)', async () => {
  const committedMemory = 131_072; // 128 GiB — above the derivation on every host this runs on
  const committedParallel = 16; // the schema's own upper bound, deliberately left alone
  assert.ok(
    committedMemory > deriveDefaultMemoryLimitMb(totalmem()),
    'fixture must exceed the host derivation to prove anything',
  );

  const projectRoot = mkdtempSync(join(tmpdir(), 'xez-sp-limits-'));
  const layout = projectStateLayout(projectRoot);
  mkdirSync(layout.root, { recursive: true });
  writeFileSync(
    layout.workspacePath,
    `${JSON.stringify(
      { resources: { maxParallel: committedParallel, memoryLimitMb: committedMemory } },
      null,
      2,
    )}\n`,
  );

  setActiveStateLayout(layout);
  try {
    // No `load` — this is `loadResourceLimits`, reading the committed file.
    const semaphore = new WorkspaceSemaphore();
    await semaphore.refresh();

    assert.equal(
      semaphore.memoryLimitMb(),
      committedMemory,
      'the production loader reduced the committed memory ceiling — AC-7 forbids a clamp, a refusal and a warning-and-substitute',
    );
    assert.equal(
      semaphore.maxParallel(),
      committedParallel,
      'the production loader reduced the committed parallel cap',
    );
    assert.equal(semaphore.projectMemoryLimitMb(projectRoot), committedMemory);
    assert.equal(semaphore.projectMaxParallel(projectRoot), committedParallel);
  } finally {
    setActiveStateLayout(null);
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
