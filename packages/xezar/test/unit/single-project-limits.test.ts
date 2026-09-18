import assert from 'node:assert/strict';
import { totalmem } from 'node:os';
import test from 'node:test';
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
