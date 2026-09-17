import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// The MCP mutation gate runs nightly against `main` (#377): `.github/workflows/mutation.yml` splits
// it across eight jobs because one job cannot finish inside GitHub's 6-hour kill.
// `packages/xezar/mutation/shards.mjs` is the split.
//
// A split is only safe if it is COMPLETE and DISJOINT. A file that falls out of the partition is a
// file the gate silently stops measuring — the same failure shape as #375, where a release-only
// gate's configuration drifted from the code it filtered and nothing in the per-PR suite noticed.
// This file is that per-PR notice.
//
// It scans the REAL scope through the REAL `mutate` globs, so the first case is a populated-input
// control: without it, "no file escaped the partition" and "we found no files" are the same green.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type ScopeFile = { path: string; size: number };
type Shard = { index: number; files: string[]; bytes: number; weight: number };
type ShardsModule = {
  DEFAULT_SHARDS: number;
  WEIGHTS_FILE: string;
  repoRoot: string;
  globToRegExp: (glob: string) => RegExp;
  mutateGlobs: (root?: string) => Promise<string[]>;
  scopeFiles: (globs: string[], root?: string) => ScopeFile[];
  loadWeights: (root?: string) => Map<string, number> | null;
  planShards: (files: ScopeFile[], count?: number, weights?: Map<string, number> | null) => Shard[];
  mutationShardPlan: (count?: number, root?: string) => Promise<{ globs: string[]; files: ScopeFile[]; shards: Shard[] }>;
};

const shards = (await import(
  pathToFileURL(join(REPO_ROOT, 'packages/xezar/mutation/shards.mjs')).href
)) as ShardsModule;

const globs = await shards.mutateGlobs(REPO_ROOT);
const scope = shards.scopeFiles(globs, REPO_ROOT);
// The plan the workflow actually runs: balanced on the committed measured-cost snapshot when it
// covers a file, byte size otherwise — the same thing `mutationShardPlan` derives for both the
// `plan` job (the matrix) and the `report` job (re-deriving the same partition to check nothing
// went missing).
const weights = shards.loadWeights(REPO_ROOT);
const plan = shards.planShards(scope, shards.DEFAULT_SHARDS, weights);

describe('the MCP mutation shard plan (#377)', () => {
  it('lives outside the shipped `scripts/` folder, and still finds the repository root', () => {
    // A wrong `repoRoot` walks from the wrong directory and finds nothing, which the populated
    // control below would then report — this names the cause instead.
    expect(shards.repoRoot).toBe(REPO_ROOT);
  });

  it('scanned the real mutation scope — the control that stops an empty scan from passing', () => {
    // Without this, every "nothing escaped" assertion below is satisfied by finding nothing at
    // all. The four named files are ordinary MCP modules with no special role here; they are
    // named so that a scope that silently collapsed to one directory cannot read as healthy.
    expect(globs, 'the globs come from stryker.config.mjs, not from a copy').toContain(
      'packages/xezar/src/mcp/**/*.ts',
    );
    expect(scope.length, 'the MCP scope is ~39 source files').toBeGreaterThan(30);
    for (const named of [
      'packages/xezar/src/mcp/index.ts',
      'packages/xezar/src/mcp/bridge.ts',
      'packages/xezar/src/mcp/tools/task-reads.ts',
      'packages/xezar/src/mcp/adapters/pi.ts',
    ]) {
      expect(
        scope.map((f) => f.path),
        `${named} is in the mutation scope and must be in the plan`,
      ).toContain(named);
    }
    expect(scope.every((f) => f.size > 0), 'every scope file has a size to balance on').toBe(true);
  });

  it('covers the whole scope exactly once — no file dropped, no file counted twice', () => {
    const assigned = plan.flatMap((shard) => shard.files);
    expect(new Set(assigned).size, 'a file may not be in two shards').toBe(assigned.length);
    expect([...assigned].sort()).toEqual(scope.map((f) => f.path).sort());
  });

  it('leaves no shard empty and keeps them within reach of each other', () => {
    expect(plan).toHaveLength(shards.DEFAULT_SHARDS);
    for (const shard of plan) expect(shard.files.length, `shard ${shard.index} is empty`).toBeGreaterThan(0);
    const total = plan.reduce((sum, shard) => sum + shard.weight, 0);
    const heaviest = Math.max(...plan.map((shard) => shard.weight));
    // Loose on purpose: the aggregate is correct whatever the split, and an unlucky split only
    // costs wall clock. Twice the fair share is where a job starts risking the 6-hour kill.
    expect(heaviest).toBeLessThanOrEqual((total / plan.length) * 2);
  });

  it('reads the committed measured-cost snapshot and balances on it, not on byte size', () => {
    // The populated-input control for the weighted split: without this, a snapshot that failed to
    // load would silently read the same as "balance on byte size", which is the pre-#443 bug.
    expect(weights, `${shards.WEIGHTS_FILE} must parse and cover most of the scope`).not.toBeNull();
    expect(weights!.size).toBeGreaterThan(scope.length / 2);
    // event-controller.ts is the heaviest MEASURED file (#443) — byte size alone (36 347 bytes,
    // the smallest of the four hottest files) would never put it alone in its own shard.
    const heaviest = 'packages/xezar/src/mcp/event-controller.ts';
    expect(weights!.get(heaviest)).toBeGreaterThan(100_000);
    const itsShard = plan.find((shard) => shard.files.includes(heaviest))!;
    expect(itsShard.weight).toBeGreaterThanOrEqual(weights!.get(heaviest)!);
    // Balancing on bytes alone would produce a materially different, worse-balanced split — the
    // regression this fix repairs. Proven, not asserted: compute the byte-only split and show its
    // heaviest shard (by real measured weight) is heavier than the weighted split's.
    const byteOnly = shards.planShards(scope, shards.DEFAULT_SHARDS, null);
    const weightOf = (path: string) => weights!.get(path) ?? scope.find((f) => f.path === path)!.size;
    const byteOnlyHeaviest = Math.max(...byteOnly.map((shard) => shard.files.reduce((sum, p) => sum + weightOf(p), 0)));
    const weightedHeaviest = Math.max(...plan.map((shard) => shard.weight));
    expect(weightedHeaviest).toBeLessThan(byteOnlyHeaviest);
  });

  it('honours the config negations — and the scope really does contain what they exclude', () => {
    // The pairing that matters: the second half proves the first is not vacuous. There ARE
    // `*.test.ts` and `*.testkit.ts` files sitting in `src/mcp`, so "the plan holds none" is a
    // decision the code made, not an accident of the directory being tidy.
    const excludedGlobs = globs.filter((glob) => glob.startsWith('!'));
    expect(excludedGlobs).toEqual(['!**/*.test.ts', '!**/*.testkit.ts']);
    const everything = shards.scopeFiles(['packages/xezar/src/mcp/**/*.ts'], REPO_ROOT).map((f) => f.path);
    expect(everything.filter((p) => p.endsWith('.test.ts')).length).toBeGreaterThan(10);
    expect(everything.filter((p) => p.endsWith('.testkit.ts')).length).toBeGreaterThan(0);
    const planned = plan.flatMap((shard) => shard.files);
    expect(planned.filter((p) => p.endsWith('.test.ts') || p.endsWith('.testkit.ts'))).toEqual([]);
  });

  it('is deterministic — the plan job and the report job must derive the same partition', () => {
    // The two jobs run on different runners minutes apart. If the split were not reproducible,
    // the aggregate would see files "missing" that a shard never had. Both read the same committed
    // snapshot, so both must be given it explicitly here too — `mutationShardPlan` below proves
    // that in practice they get it from the same place without either caller passing it by hand.
    expect(shards.planShards(scope, shards.DEFAULT_SHARDS, weights)).toEqual(plan);
    expect(shards.planShards([...scope].reverse(), shards.DEFAULT_SHARDS, weights)).toEqual(plan);
  });

  it('`mutationShardPlan` derives the same weighted split on its own, with no weights argument to forget', async () => {
    const derived = await shards.mutationShardPlan(shards.DEFAULT_SHARDS, REPO_ROOT);
    expect(derived.shards).toEqual(plan);
  });

  it('refuses to plan a gate it cannot fill', () => {
    expect(() => shards.planShards([], 6)).toThrow(/zero files/);
    expect(() => shards.planShards(scope.slice(0, 3), 6)).toThrow(/without leaving one empty/);
    expect(() => shards.planShards(scope, 0)).toThrow(/positive integer/);
    // `--mutate` splits on commas, so a comma in a path would turn one file into two globs that
    // match nothing — a hole in the gate that reports no error at all.
    expect(() => shards.planShards([...scope, { path: 'src/od,d.ts', size: 1 }], 6)).toThrow(
      /may not contain a comma/,
    );
  });
});

describe('the glob semantics the plan depends on', () => {
  const fixture = join(tmpdir(), `xez-mutation-shards-${process.pid}-${Date.now()}`);
  mkdirSync(join(fixture, 'src', 'mcp', 'tools'), { recursive: true });
  writeFileSync(join(fixture, 'src', 'mcp', 'a.ts'), 'const a = 1\n');
  writeFileSync(join(fixture, 'src', 'mcp', 'a.test.ts'), 'const b = 22\n');
  writeFileSync(join(fixture, 'src', 'mcp', 'tools', 'deep.ts'), 'const c = 333\n');
  writeFileSync(join(fixture, 'src', 'other.ts'), 'const d = 4444\n');
  afterAll(async () => {
    await (await import('node:fs/promises')).rm(fixture, { recursive: true, force: true });
  });

  it('lets `**/` cross directories and keeps `*` inside one', () => {
    expect(shards.globToRegExp('a/**/*.ts').test('a/b/c/d.ts')).toBe(true);
    expect(shards.globToRegExp('a/**/*.ts').test('a/d.ts')).toBe(true);
    expect(shards.globToRegExp('a/*.ts').test('a/b/c.ts')).toBe(false);
    expect(shards.globToRegExp('**/*.test.ts').test('a/b/c.test.ts')).toBe(true);
    expect(shards.globToRegExp('**/*.test.ts').test('a/b/c.ts')).toBe(false);
  });

  it('walks nested directories, applies negations and never leaves the positive glob', () => {
    const found = shards.scopeFiles(['src/mcp/**/*.ts', '!**/*.test.ts'], fixture);
    expect(found.map((f) => f.path)).toEqual(['src/mcp/a.ts', 'src/mcp/tools/deep.ts']);
    expect(found.map((f) => f.size)).toEqual([12, 14]);
  });

  it('returns nothing for a glob whose directory is absent, which planShards then refuses', () => {
    // Fail-CLOSED, and the pair is the point: an absent scope must not read the same as a scope
    // that is simply small. `scopeFiles` is allowed to come back empty; nothing downstream is
    // allowed to treat that as a plan.
    expect(shards.scopeFiles(['src/nowhere/**/*.ts'], fixture)).toEqual([]);
    expect(() => shards.planShards(shards.scopeFiles(['src/nowhere/**/*.ts'], fixture), 6)).toThrow(
      /zero files/,
    );
  });
});
