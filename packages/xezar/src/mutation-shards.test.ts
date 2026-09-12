import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// The MCP mutation gate no longer runs in the release path (#377): `.github/workflows/mutation.yml`
// runs it weekly against `main`, split across six jobs because one job cannot finish inside
// GitHub's 6-hour kill. `scripts/mutation-shards.mjs` is the split.
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
type Shard = { index: number; files: string[]; bytes: number };
type ShardsModule = {
  DEFAULT_SHARDS: number;
  repoRoot: string;
  globToRegExp: (glob: string) => RegExp;
  mutateGlobs: (root?: string) => Promise<string[]>;
  scopeFiles: (globs: string[], root?: string) => ScopeFile[];
  planShards: (files: ScopeFile[], count?: number) => Shard[];
  mutationShardPlan: (count?: number, root?: string) => Promise<{ globs: string[]; files: ScopeFile[]; shards: Shard[] }>;
};

const shards = (await import(
  pathToFileURL(join(REPO_ROOT, 'scripts', 'mutation-shards.mjs')).href
)) as ShardsModule;

const globs = await shards.mutateGlobs(REPO_ROOT);
const scope = shards.scopeFiles(globs, REPO_ROOT);
const plan = shards.planShards(scope, shards.DEFAULT_SHARDS);

describe('the MCP mutation shard plan (#377)', () => {
  it('scanned the real mutation scope — the control that stops an empty scan from passing', () => {
    // Without this, every "nothing escaped" assertion below is satisfied by finding nothing at
    // all. The four named files are ordinary MCP modules with no special role here; they are
    // named so that a scope that silently collapsed to one directory cannot read as healthy.
    expect(globs, 'the globs come from stryker.config.mjs, not from a copy').toContain(
      'packages/xezar/src/mcp/**/*.ts',
    );
    expect(scope.length, 'the MCP scope is ~38 source files').toBeGreaterThan(30);
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
    const total = plan.reduce((sum, shard) => sum + shard.bytes, 0);
    const heaviest = Math.max(...plan.map((shard) => shard.bytes));
    // Loose on purpose: the aggregate is correct whatever the split, and an unlucky split only
    // costs wall clock. Twice the fair share is where a job starts risking the 6-hour kill.
    expect(heaviest).toBeLessThanOrEqual((total / plan.length) * 2);
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
    // the aggregate would see files "missing" that a shard never had.
    expect(shards.planShards(scope, shards.DEFAULT_SHARDS)).toEqual(plan);
    expect(shards.planShards([...scope].reverse(), shards.DEFAULT_SHARDS)).toEqual(plan);
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
