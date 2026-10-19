import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// `packages/xezar/mutation/timing-reporter.mjs` measures how long each mutated file takes in a
// nightly shard, and `weights.mjs` turns a night of those measurements into the snapshot the shard
// planner packs on (#443). The planner's whole budget is only as good as these minutes: a snapshot
// the slow shards could never refresh is what let two to four shards a night hit the job ceiling
// for weeks. So the cases below are about a killed shard still leaving its measurement behind, and
// about a partial measurement never passing for a complete one.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type FileTiming = { planned: number; tested: number; seconds: number };
type Timing = { schema: number; complete: boolean; concurrency: number | null; wallSeconds: number; files: Record<string, FileTiming> };
type Io = { now: () => number; write: (path: string, text: string) => void; cwd: string; warn: (message: string) => void };
type Reporter = {
  out: string;
  onMutationTestingPlanReady: (event: { mutantPlans: { plan: string; mutant: { fileName: string }; runOptions?: { testFilter?: string[] } }[] }) => void;
  onMutantTested: (result: { fileName: string; status: string }) => void;
  onMutationTestReportReady: () => void;
};
type TimingModule = {
  TIMING_FILE: string;
  REPORTER_NAME: string;
  FLUSH_EVERY_MS: number;
  TimingReporter: (new (options: { jsonReporter?: { fileName?: string }; concurrency?: number }, io?: Partial<Io>) => Reporter) & { inject: readonly string[] };
  strykerPlugins: { kind: string; name: string; injectableClass: unknown }[];
};
type Measured = { minutes: number; partial: boolean };
type WeightsModule = {
  measuredMinutes: (timings: { files?: Record<string, FileTiming> }[]) => Map<string, Measured>;
  nextSnapshot: (
    previous: { weights?: Record<string, number> },
    measured: Map<string, Measured>,
    scope: string[],
    source: { run: string; revision: string; date: string },
  ) => { unit: string; source: { measuredRun: number }; estimatedPaths: { paths: string[] }; weights: Record<string, number> };
};

const load = async <T>(script: string): Promise<T> =>
  (await import(pathToFileURL(join(REPO_ROOT, 'packages/xezar/mutation', script)).href)) as T;
const timing = await load<TimingModule>('timing-reporter.mjs');
const weights = await load<WeightsModule>('weights.mjs');

const CWD = join(REPO_ROOT, 'sandbox-root');
const A = 'packages/xezar/src/mcp/a.ts';
const B = 'packages/xezar/src/mcp/b.ts';

/** A reporter on a hand-moved clock that keeps every write instead of touching the disk. */
function harness() {
  let now = 1_000_000;
  const writes: { path: string; body: Timing }[] = [];
  const warnings: string[] = [];
  const reporter = new timing.TimingReporter(
    { jsonReporter: { fileName: '.local/mutation/mcp/report.json' }, concurrency: 3 },
    {
      now: () => now,
      write: (path, text) => writes.push({ path, body: JSON.parse(text) as Timing }),
      cwd: CWD,
      warn: (message) => warnings.push(message),
    },
  );
  const plan = (file: string, filter: string[] | undefined, kind = 'Run') => ({ plan: kind, mutant: { fileName: join(CWD, file) }, runOptions: { testFilter: filter } });
  return {
    reporter,
    writes,
    warnings,
    plan,
    tick: (ms: number) => {
      now += ms;
    },
    tested: (file: string, status = 'Killed') => reporter.onMutantTested({ fileName: join(CWD, file), status }),
    last: () => writes.at(-1)!.body,
  };
}

describe('the timing reporter (#443)', () => {
  it('is a Stryker reporter plugin by the name the config lists, injected with the options only', async () => {
    expect(timing.strykerPlugins).toEqual([{ kind: 'Reporter', name: timing.REPORTER_NAME, injectableClass: timing.TimingReporter }]);
    expect(timing.TimingReporter.inject).toEqual(['options']);
    const config = (await import(pathToFileURL(join(REPO_ROOT, 'packages/xezar/stryker.config.mjs')).href)) as {
      default: { plugins: string[]; reporters: string[] };
    };
    expect(config.default.reporters).toContain(timing.REPORTER_NAME);
    expect(config.default.plugins).toContain('./packages/xezar/mutation/timing-reporter.mjs');
  });

  it('writes beside the JSON report, so the shard upload carries it with no workflow change', () => {
    const h = harness();
    expect(h.reporter.out).toBe(join('.local/mutation/mcp', timing.TIMING_FILE));
  });

  it('charges the wall time between results to the file of each result, in repository paths', () => {
    const h = harness();
    h.reporter.onMutationTestingPlanReady({
      mutantPlans: [h.plan(A, ['t1']), h.plan(A, ['t2']), h.plan(A, []), h.plan(B, ['t1']), h.plan(B, undefined, 'EarlyResult')],
    });
    // Planned counts only what goes to the test runner: no coverage and early results cost nothing.
    expect(h.last().files).toEqual({ [A]: { planned: 2, tested: 0, seconds: 0 }, [B]: { planned: 1, tested: 0, seconds: 0 } });
    h.tested(A, 'NoCoverage');
    h.tick(4_000);
    h.tested(A);
    h.tick(6_000);
    h.tested(A, 'Timeout');
    h.tick(10_000);
    h.tested(B, 'Survived');
    h.reporter.onMutationTestReportReady();
    expect(h.last()).toEqual({
      schema: 1,
      complete: true,
      concurrency: 3,
      wallSeconds: 20,
      files: { [A]: { planned: 2, tested: 2, seconds: 10 }, [B]: { planned: 1, tested: 1, seconds: 10 } },
    });
  });

  it('flushes while it runs, so a shard killed at the ceiling still leaves a partial measurement', () => {
    const h = harness();
    h.reporter.onMutationTestingPlanReady({ mutantPlans: [h.plan(A, ['t']), h.plan(A, ['t']), h.plan(A, ['t'])] });
    const before = h.writes.length;
    h.tick(timing.FLUSH_EVERY_MS / 2);
    h.tested(A);
    expect(h.writes.length, 'no write before a flush is due').toBe(before);
    h.tick(timing.FLUSH_EVERY_MS / 2);
    h.tested(A);
    // The job is killed here: no report-ready event ever arrives.
    expect(h.last()).toMatchObject({ complete: false, files: { [A]: { planned: 3, tested: 2, seconds: timing.FLUSH_EVERY_MS / 1000 } } });
  });

  it('never throws a failed write into Stryker’s run, and says so once', () => {
    const h = harness();
    const reporter = new timing.TimingReporter({}, { now: () => 0, cwd: CWD, write: () => { throw new Error('EROFS'); }, warn: (m) => h.warnings.push(m) });
    expect(() => reporter.onMutationTestingPlanReady({ mutantPlans: [] })).not.toThrow();
    expect(() => reporter.onMutationTestReportReady()).not.toThrow();
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatch(/could not write .*timing\.json: EROFS/);
  });
});

describe('refreshing the snapshot from a night of timing files (#443)', () => {
  const C = 'packages/xezar/src/mcp/c.ts';
  const D = 'packages/xezar/src/mcp/d.ts';

  it('measures a finished file, scales a part-tested one, and leaves out what no shard reached', () => {
    const measured = weights.measuredMinutes([
      { files: { [A]: { planned: 10, tested: 10, seconds: 600 } } },
      // The killed shard: B half done, C never started, D with nothing to test.
      { files: { [B]: { planned: 10, tested: 5, seconds: 300 }, [C]: { planned: 4, tested: 0, seconds: 0 }, [D]: { planned: 0, tested: 0, seconds: 0 } } },
    ]);
    expect(measured).toEqual(
      new Map([
        [A, { minutes: 10, partial: false }],
        [B, { minutes: 10, partial: true }],
        [D, { minutes: 0, partial: false }],
      ]),
    );
  });

  it('carries the previous value only for files still in scope, and lists every estimate', () => {
    const measured = new Map([
      [A, { minutes: 12.34, partial: false }],
      [B, { minutes: 50, partial: true }],
    ]);
    const previous = { weights: { [A]: 1, [C]: 33, 'packages/xezar/src/mcp/removed.ts': 99 } };
    const next = weights.nextSnapshot(previous, measured, [A, B, C, D], { run: '42', revision: 'abc1234', date: '2026-10-19' });
    expect(next.unit).toBe('minutes');
    expect(next.source.measuredRun).toBe(42);
    expect(next.weights).toEqual({ [A]: 12.3, [B]: 50, [C]: 33 });
    // B is extrapolated, C carried over, D unknown: none of them reads as a fresh measurement.
    expect(next.estimatedPaths.paths).toEqual([B, C, D]);
  });

  it('writes a snapshot the planner reads in minutes', async () => {
    const shards = (await load<{ fallbackWeights: (files: { path: string; size: number }[], w: Map<string, number> | null) => Map<string, number> }>('shards.mjs'));
    const next = weights.nextSnapshot({}, new Map([[A, { minutes: 30, partial: false }]]), [A, B], { run: '1', revision: 'x', date: 'd' });
    const planned = shards.fallbackWeights(
      [
        { path: A, size: 1_000 },
        { path: B, size: 500 },
      ],
      new Map(Object.entries(next.weights)),
    );
    expect(planned.get(B), 'the unmeasured file is estimated in minutes too').toBe(15);
  });
});
