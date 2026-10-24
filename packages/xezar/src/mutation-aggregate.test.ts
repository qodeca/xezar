import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { TEST_DIR_RM_OPTIONS } from '../test/helpers/platform.ts';

// `packages/xezar/mutation/aggregate.mjs` is what makes the sharded schedule (#377,
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
type LockResult = Omit<AggregateResult, 'perShard'>;
type AggregateModule = {
  LOCK_CONFIG: string;
  LOCK_REPORT: string;
  emptyCounts: () => Counts;
  addCounts: (a: Counts, b: Counts) => Counts;
  metrics: (counts: Counts) => Metrics;
  normaliseFileKey: (key: string, root?: string) => string;
  countReport: (report: unknown, root?: string) => Map<string, Counts>;
  breakThreshold: (root?: string, config?: string) => Promise<number>;
  shardArtifact: (shard: number) => string;
  aggregate: (options: {
    readReport: (shard: number) => unknown;
    shards?: number;
    root?: string;
  }) => Promise<AggregateResult>;
  aggregateLock: (options: { readReport: () => unknown; root?: string }) => Promise<LockResult>;
  renderMarkdown: (result: AggregateResult, context?: { runUrl?: string; ref?: string; sha?: string }, lock?: LockResult) => string;
  main: (args: string[], env?: Record<string, string>) => Promise<{ exitCode: number; markdown: string }>;
};
type ShardsModule = {
  mutationShardPlan: (count?: number, root?: string) => Promise<{ globs: string[]; files: ScopeFile[]; shards: Shard[] }>;
};

const load = async <T>(script: string): Promise<T> =>
  (await import(pathToFileURL(join(REPO_ROOT, 'packages/xezar/mutation', script)).href)) as T;

const agg = await load<AggregateModule>('aggregate.mjs');
const shards = await load<ShardsModule>('shards.mjs');
const plan = await shards.mutationShardPlan(undefined, REPO_ROOT);

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
    expect(result.perShard).toHaveLength(plan.shards.length);
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

  it('fails when a shard report is not valid JSON — a truncated upload is not a measurement', async () => {
    const result = await agg.aggregate({
      readReport: (s) => (s === 4 ? JSON.parse('{"files": {"packages/xezar/src/mcp/ipc.ts": [') : healthy(s)),
      root: REPO_ROOT,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/shard 4: no usable report \(.*JSON/);
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
    // Every shard DID report, so the likeliest cause is named — once, not once per file.
    expect(dropped.problems.filter((p) => p.includes('type declarations only'))).toHaveLength(1);

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
    const markdown = agg.renderMarkdown(below);
    expect(markdown).toContain('#338');
    expect(markdown).toContain('#443');
    // #353 is closed: the report must not send a reader to a finished issue.
    expect(markdown).not.toContain('#353');
  });

  it('names the artifact each shard uploads, which is how the report job finds them', () => {
    expect(agg.shardArtifact(1)).toBe('mutation-report-1');
    expect(agg.shardArtifact(plan.shards.length)).toBe(`mutation-report-${plan.shards.length}`);
  });
});

describe('the read-only lock scope in the same verdict', () => {
  const LOCK_FILES = ['packages/xezar/src/core/qwen-tool-policy.ts', 'packages/xezar/src/core/read-only-lock.ts'];
  const lockReport = (perFile: Counts, files = LOCK_FILES) => reportFor(files, perFile);

  it('reads its own floor out of its own config, which is not the MCP gate’s', async () => {
    const config = await import(pathToFileURL(join(REPO_ROOT, agg.LOCK_CONFIG)).href);
    const floor = await agg.breakThreshold(REPO_ROOT, agg.LOCK_CONFIG);
    expect(floor).toBe(config.default.thresholds.break);
    expect(floor).toBe(68);
    expect(config.default.mutate).toEqual(LOCK_FILES.slice().reverse());
  });

  it('passes a report that names both files and clears the floor, and fails one under it', async () => {
    const healthyLock = await agg.aggregateLock({ readReport: () => lockReport({ Killed: 72, Survived: 28 }), root: REPO_ROOT });
    expect(healthyLock.problems).toEqual([]);
    expect(healthyLock.metrics.score).toBe(72);
    const below = await agg.aggregateLock({ readReport: () => lockReport({ Killed: 60, Survived: 40 }), root: REPO_ROOT });
    expect(below.ok).toBe(false);
    expect(below.problems.join('\n')).toMatch(/read-only lock: mutation score 60\.00 % is below its 68 % floor/);
  });

  it('fails closed: a missing, an empty, a partial or a foreign report is not a measurement', async () => {
    const missing = await agg.aggregateLock({ readReport: () => { throw new Error('ENOENT'); }, root: REPO_ROOT });
    expect(missing.problems).toEqual(['read-only lock: no usable report (ENOENT)']);
    // The empty-input control: `{ files: {} }` parses, tests nothing, and must not read as a pass.
    const empty = await agg.aggregateLock({ readReport: () => ({ files: {} }), root: REPO_ROOT });
    expect(empty.ok).toBe(false);
    expect(empty.problems).toContain('read-only lock: no mutants were tested');
    const partial = await agg.aggregateLock({ readReport: () => lockReport({ Killed: 10 }, [LOCK_FILES[1]!]), root: REPO_ROOT });
    expect(partial.problems).toEqual([`read-only lock: ${LOCK_FILES[0]} is in its scope but the report does not name it`]);
    const foreign = await agg.aggregateLock({ readReport: () => lockReport({ Killed: 10 }, [...LOCK_FILES, 'packages/xezar/src/mcp/ipc.ts']), root: REPO_ROOT });
    expect(foreign.problems).toEqual([`read-only lock: the report names packages/xezar/src/mcp/ipc.ts, which is not in ${agg.LOCK_CONFIG}`]);
  });

  it('turns the whole night red when only the lock scope is under its floor', async () => {
    const mcp = await agg.aggregate({ readReport: healthy, root: REPO_ROOT });
    const lock = await agg.aggregateLock({ readReport: () => lockReport({ Killed: 1, Survived: 9 }), root: REPO_ROOT });
    expect(mcp.ok).toBe(true);
    const markdown = agg.renderMarkdown(mcp, {}, lock);
    expect(markdown).toContain('MCP mutation gate — FAILED');
    expect(markdown).toContain('read-only lock: mutation score 10.00 % is below its 68 % floor');
    expect(markdown).toContain('### Read-only lock scope');
    expect(markdown).toContain('`core/read-only-lock.ts`');
    // The control: the same MCP result with a healthy lock scope passes.
    const fine = await agg.aggregateLock({ readReport: () => lockReport({ Killed: 9, Survived: 1 }), root: REPO_ROOT });
    expect(agg.renderMarkdown(mcp, {}, fine)).toContain('MCP mutation gate — PASSED');
  });

  describe('the CLI the report job runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xez-mutation-aggregate-'));
    afterAll(async () => {
      await rm(dir, TEST_DIR_RM_OPTIONS);
    });
    for (const shard of plan.shards) {
      mkdirSync(join(dir, 'shards', agg.shardArtifact(shard.index)), { recursive: true });
      writeFileSync(join(dir, 'shards', agg.shardArtifact(shard.index), 'report.json'), JSON.stringify(healthy(shard.index)));
    }
    mkdirSync(join(dir, 'lock'), { recursive: true });

    it('always holds the lock scope too — no flag to forget, a missing report is red', async () => {
      const { exitCode, markdown } = await main(['--reports', join(dir, 'shards'), '--lock-report', join(dir, 'lock', 'report.json')]);
      expect(markdown).toContain('read-only lock: no usable report');
      expect(exitCode).toBe(1);
      // Without the flag it looks where the workflow downloads the artifact, and still checks.
      expect(agg.LOCK_REPORT).toBe('.local/mutation/lock-report/report.json');
    });

    it('passes when every shard and the lock scope cleared their floors, and writes the summary', async () => {
      writeFileSync(join(dir, 'lock', 'report.json'), JSON.stringify(lockReport({ Killed: 9, Survived: 1 })));
      const out = join(dir, 'summary.md');
      const { exitCode, markdown } = await main(['--reports', join(dir, 'shards'), '--lock-report', join(dir, 'lock', 'report.json'), '--out', out]);
      expect(markdown).toContain('MCP mutation gate — PASSED');
      expect(exitCode).toBe(0);
      expect((await import('node:fs')).readFileSync(out, 'utf8')).toBe(markdown);
    });
  });
});

const main = (args: string[]) => agg.main(args, {});
