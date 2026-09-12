import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// `scripts/mutation-aggregate.mjs` is what makes the sharded schedule (#377,
// `.github/workflows/mutation.yml`) the SAME gate the release path used to run: it sums the status
// counts of every shard and puts them through Stryker's own formula, then applies the 80 % floor it
// reads out of `packages/xezar/stryker.config.mjs`.
//
// Everything here is about the ways a split gate can pass while measuring nothing. Stryker itself
// scores an empty run `NaN`, and `NaN < 80` is false — so "no mutants at all" is the one input that
// looks exactly like a perfect run unless something refuses it on purpose.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type Counts = Record<string, number>;
type Metrics = { detected: number; undetected: number; valid: number; invalid: number; total: number; score: number | null };
type ScopeFile = { path: string; size: number };
type Shard = { index: number; files: string[]; bytes: number };
type AggregateResult = {
  ok: boolean;
  problems: string[];
  threshold: number;
  counts: Counts;
  metrics: Metrics;
  perFile: { path: string; counts: Counts; score: number | null }[];
  perShard: { shard: number; counts: Counts; metrics: Metrics }[];
};
type AggregateModule = {
  emptyCounts: () => Counts;
  addCounts: (a: Counts, b: Counts) => Counts;
  metrics: (counts: Counts) => Metrics;
  normaliseFileKey: (key: string, root?: string) => string;
  countReport: (report: unknown, root?: string) => Map<string, Counts>;
  breakThreshold: (root?: string) => Promise<number>;
  shardArtifact: (shard: number) => string;
  aggregate: (options: {
    readReport: (shard: number) => unknown;
    shards?: number;
    root?: string;
  }) => Promise<AggregateResult>;
  renderMarkdown: (result: AggregateResult, context?: { runUrl?: string; ref?: string; sha?: string }) => string;
};
type ShardsModule = {
  DEFAULT_SHARDS: number;
  mutationShardPlan: (count?: number, root?: string) => Promise<{ globs: string[]; files: ScopeFile[]; shards: Shard[] }>;
};

const load = async <T>(script: string): Promise<T> =>
  (await import(pathToFileURL(join(REPO_ROOT, 'scripts', script)).href)) as T;

const agg = await load<AggregateModule>('mutation-aggregate.mjs');
const shards = await load<ShardsModule>('mutation-shards.mjs');
const plan = await shards.mutationShardPlan(shards.DEFAULT_SHARDS, REPO_ROOT);

/** A Stryker JSON report for one shard: `spread` mutant statuses over the files it owns. */
function reportFor(files: string[], perFile: Counts): unknown {
  const entry = Object.entries(perFile).flatMap(([status, n]) => Array.from({ length: n }, () => ({ status })));
  return { schemaVersion: '2', thresholds: { high: 90, low: 80, break: 80 }, files: Object.fromEntries(files.map((path) => [path, { source: '', mutants: entry }])) };
}

/** The whole plan reported healthily — the baseline every negative case below deviates from. */
const healthy = (shard: number) => reportFor(plan.shards[shard - 1]!.files, { Killed: 9, Survived: 1 });

describe("Stryker's own arithmetic, reproduced", () => {
  it('lands on the recorded full run: 81.39 % over 11 292 tested mutants (coverage-gaps.md § 10.8)', () => {
    // Not a synthetic sanity check — these are the measured counts of the 2026-09-12 run at
    // `ac726df`, the run the 80 floor was set against. If this file's formula ever stopped
    // matching Stryker's, this is the case that would say so.
    const m = agg.metrics({
      Killed: 7928,
      Timeout: 1261,
      Survived: 1426,
      NoCoverage: 675,
      RuntimeError: 2,
      CompileError: 0,
      Ignored: 1238,
      Pending: 0,
    });
    expect(m.detected).toBe(9189);
    expect(m.valid).toBe(11290);
    expect(m.score).toBeCloseTo(81.39, 2);
    expect(m.total).toBe(12530);
  });

  it('counts a timeout as detected and keeps ignored and errored mutants out of the score', () => {
    // Three separate rules, each of which changes the number if it slips: a timeout that stopped
    // counting as detected would drop the real score by ~11 points, and a static mutant that
    // started counting as undetected would drop it by ~10.
    expect(agg.metrics({ ...agg.emptyCounts(), Killed: 1, Timeout: 1 }).score).toBe(100);
    expect(agg.metrics({ ...agg.emptyCounts(), Killed: 1, Ignored: 99 }).score).toBe(100);
    expect(agg.metrics({ ...agg.emptyCounts(), Killed: 1, CompileError: 5, RuntimeError: 5 }).score).toBe(100);
    expect(agg.metrics({ ...agg.emptyCounts(), Killed: 1, NoCoverage: 1 }).score).toBe(50);
    expect(agg.metrics({ ...agg.emptyCounts(), Killed: 1, Survived: 1 }).score).toBe(50);
  });

  it('scores an empty run as null, never as NaN — the one input that passes a `< break` test', () => {
    expect(agg.metrics(agg.emptyCounts()).score).toBeNull();
    expect(agg.metrics({ ...agg.emptyCounts(), Ignored: 5000 }).score).toBeNull();
  });

  it('reads the floor out of the real config instead of repeating it', async () => {
    const config = await import(pathToFileURL(join(REPO_ROOT, 'packages/xezar/stryker.config.mjs')).href);
    expect(await agg.breakThreshold(REPO_ROOT)).toBe(config.default.thresholds.break);
    expect(await agg.breakThreshold(REPO_ROOT)).toBe(80);
  });
});

describe('reading one shard report', () => {
  it('normalises the file keys Stryker may write', () => {
    expect(agg.normaliseFileKey('packages/xezar/src/mcp/index.ts', REPO_ROOT)).toBe('packages/xezar/src/mcp/index.ts');
    expect(agg.normaliseFileKey('./packages/xezar/src/mcp/index.ts', REPO_ROOT)).toBe('packages/xezar/src/mcp/index.ts');
    expect(agg.normaliseFileKey(join(REPO_ROOT, 'packages/xezar/src/mcp/index.ts'), REPO_ROOT)).toBe(
      'packages/xezar/src/mcp/index.ts',
    );
  });

  it('refuses anything that is not a report, and any status it does not understand', () => {
    expect(() => agg.countReport({}, REPO_ROOT)).toThrow(/no `files` object/);
    expect(() => agg.countReport(null, REPO_ROOT)).toThrow(/no `files` object/);
    expect(() => agg.countReport({ files: { 'a.ts': { mutants: [{ status: 'Melted' }] } } }, REPO_ROOT)).toThrow(
      /unknown mutant status "Melted"/,
    );
  });
});

describe('summing the shards into one verdict (#377)', () => {
  it('passes when every shard reported and the whole scope clears the floor', async () => {
    const result = await agg.aggregate({ readReport: healthy, root: REPO_ROOT });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.metrics.score).toBe(90);
    expect(result.perShard).toHaveLength(shards.DEFAULT_SHARDS);
    expect(result.perFile.length).toBe(plan.files.length);
    expect(agg.renderMarkdown(result)).toContain('PASSED');
  });

  it('fails on a score below the floor, and passes on one exactly at it', async () => {
    const below = await agg.aggregate({
      readReport: (s) => reportFor(plan.shards[s - 1]!.files, { Killed: 79, Survived: 21 }),
      root: REPO_ROOT,
    });
    expect(below.ok).toBe(false);
    expect(below.problems.join('\n')).toMatch(/79\.00 % is below the 80 % floor/);
    expect(agg.renderMarkdown(below)).toContain('FAILED');

    const exactly = await agg.aggregate({
      readReport: (s) => reportFor(plan.shards[s - 1]!.files, { Killed: 80, Survived: 20 }),
      root: REPO_ROOT,
    });
    expect(exactly.problems).toEqual([]);
    expect(exactly.metrics.score).toBe(80);
  });

  it('fails when a shard did not report — a job that died is not a smaller measurement', async () => {
    const result = await agg.aggregate({
      readReport: (s) => {
        if (s === 3) throw new Error('ENOENT: no such file or directory');
        return healthy(s);
      },
      root: REPO_ROOT,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/shard 3: no usable report/);
    // And the files that shard owned are named, so the summary says WHAT stopped being measured.
    for (const path of plan.shards[2]!.files) {
      expect(result.problems.join('\n')).toContain(`${path} is in the mutation scope but no shard reported it`);
    }
  });

  it('fails when every shard reported and none tested a mutant — the empty-input control', async () => {
    // THE case this file exists for. Stryker scores this run `NaN`, `NaN < 80` is false, and a
    // gate that only asked "is the score under the floor" would call six empty shards a pass.
    // "We measured nothing" and "we measured everything and it was perfect" must not read alike.
    const empty = await agg.aggregate({
      readReport: (s) => reportFor(plan.shards[s - 1]!.files, {}),
      root: REPO_ROOT,
    });
    expect(empty.ok).toBe(false);
    expect(empty.metrics.score).toBeNull();
    expect(empty.problems.join('\n')).toContain('no mutants were tested across any shard');
    for (const shard of plan.shards) {
      expect(empty.problems.join('\n')).toContain(`shard ${shard.index} tested no mutants`);
    }

    // The control on the other side: the identical shape with mutants in it passes, so the
    // refusal above is about emptiness and not about the fixture.
    const populated = await agg.aggregate({ readReport: healthy, root: REPO_ROOT });
    expect(populated.ok).toBe(true);
  });

  it('fails when one shard alone measured nothing, even though the rest clear the floor', async () => {
    const result = await agg.aggregate({
      readReport: (s) => reportFor(plan.shards[s - 1]!.files, s === 2 ? {} : { Killed: 10 }),
      root: REPO_ROOT,
    });
    expect(result.metrics.score, 'the five that ran were perfect').toBe(100);
    expect(result.ok, 'and the gate still fails, because a sixth of the scope was not measured').toBe(false);
    expect(result.problems.join('\n')).toMatch(/shard 2 tested no mutants/);
  });

  it('fails when a file is missing from the partition, or counted by two shards', async () => {
    const dropped = await agg.aggregate({
      readReport: (s) => reportFor(s === 1 ? plan.shards[0]!.files.slice(1) : plan.shards[s - 1]!.files, { Killed: 10 }),
      root: REPO_ROOT,
    });
    expect(dropped.ok).toBe(false);
    expect(dropped.problems.join('\n')).toContain(
      `${plan.shards[0]!.files[0]} is in the mutation scope but no shard reported it`,
    );

    const stowaway = plan.shards[0]!.files[0]!;
    const doubled = await agg.aggregate({
      readReport: (s) => reportFor(s === 2 ? [...plan.shards[1]!.files, stowaway] : plan.shards[s - 1]!.files, { Killed: 10 }),
      root: REPO_ROOT,
    });
    expect(doubled.ok).toBe(false);
    expect(doubled.problems.join('\n')).toContain(`shard 2 reported ${stowaway}, which is not in its slice`);
    expect(doubled.problems.join('\n')).toContain(`${stowaway} was reported by shard 1 and shard 2`);
  });

  it('names the weakest files first, so the report is readable without opening the HTML', async () => {
    const weak = plan.shards[0]!.files[0]!;
    const result = await agg.aggregate({
      readReport: (s) =>
        reportFor(plan.shards[s - 1]!.files, { Killed: 10 }) as unknown,
      root: REPO_ROOT,
    });
    // One file is made weak; it must sort to the front of the table.
    const skewed = await agg.aggregate({
      readReport: (s) => {
        const report = reportFor(plan.shards[s - 1]!.files, { Killed: 10 }) as {
          files: Record<string, { source: string; mutants: { status: string }[] }>;
        };
        if (s === 1) report.files[weak] = { source: '', mutants: [{ status: 'Survived' }] };
        return report;
      },
      root: REPO_ROOT,
    });
    expect(result.perFile[0]!.score).toBe(100);
    expect(skewed.perFile[0]!.path).toBe(weak);
    expect(skewed.perFile[0]!.score).toBe(0);
    const markdown = agg.renderMarkdown(skewed, { sha: 'abc1234', ref: 'main', runUrl: 'https://example.invalid/run/1' });
    expect(markdown).toContain('abc1234');
    expect(markdown).toContain('https://example.invalid/run/1');
    expect(markdown).toContain(weak.replace('packages/xezar/src/mcp/', ''));
  });

  it('points a reader at the issues that already track known survivors', async () => {
    const below = await agg.aggregate({
      readReport: (s) => reportFor(plan.shards[s - 1]!.files, { Killed: 1, Survived: 9 }),
      root: REPO_ROOT,
    });
    expect(agg.renderMarkdown(below)).toContain('#338 and #353');
  });

  it('names the artifact each shard uploads, which is how the report job finds them', () => {
    expect(agg.shardArtifact(1)).toBe('mutation-report-1');
    expect(agg.shardArtifact(shards.DEFAULT_SHARDS)).toBe(`mutation-report-${shards.DEFAULT_SHARDS}`);
  });
});
