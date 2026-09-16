import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// `packages/xezar/mutation/survivors.mjs` answers the question the nightly MCP mutation gate's score
// cannot (#377, PR 2): is tonight's survivor one the starting list already knows, one the previous
// main run already had, or new? The owner's rule (2026-09-15): KNOWN if the starting list has it,
// ALREADY SEEN if only the previous main run had it, NEW otherwise, and #338 / #353 tags stay.
//
// Two ways this goes wrong quietly, both pinned here: a key that moves with its line number turns
// every survivor below an edit into a "new" one, and a missing previous list that reads like an
// empty one says "nothing was seen before" when the truth is "we could not compare".

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type Survivor = { key: string; file: string; line: number; mutator: string; status: string; tracked?: number[] };
type SurvivorList = { schema: 1; source?: Record<string, unknown>; tracked?: Record<string, string>; survivors: Survivor[] };
type Groups = { new: Survivor[]; seen: Survivor[]; known: Survivor[]; previousAvailable: boolean };
type SurvivorsModule = {
  BASELINE: string;
  ARTIFACT: string;
  SURVIVOR_STATUSES: string[];
  survivorsFromReport: (report: unknown, root?: string) => Survivor[];
  parseSurvivorList: (value: unknown) => SurvivorList;
  groupSurvivors: (input: { current: Survivor[]; baseline: SurvivorList; previous: SurvivorList | null }) => Groups;
  carryTags: (survivors: Survivor[], old: SurvivorList | null, extra?: { issue: number; file: string; line: number; mutator?: string }[]) => Survivor[];
  formatSurvivorList: (list: SurvivorList) => string;
  renderSurvivorMarkdown: (groups: Groups, context?: { missingShards?: number[]; repoUrl?: string; limit?: number }) => string;
  pickPreviousRun: (answer: unknown, runId: string | number) => number | null;
};

const s = (await import(pathToFileURL(join(REPO_ROOT, 'packages/xezar/mutation/survivors.mjs')).href)) as SurvivorsModule;

const FILE = 'packages/xezar/src/mcp/tools/example.ts';

type Mutant = { mutatorName: string; replacement: string; status: string; line: number; column: number; length: number };
const mutant = (m: Partial<Mutant> & { line: number; column: number; length: number }) => ({
  id: String(Math.random()),
  mutatorName: m.mutatorName ?? 'EqualityOperator',
  replacement: m.replacement ?? '!==',
  status: m.status ?? 'Survived',
  location: { start: { line: m.line, column: m.column }, end: { line: m.line, column: m.column + m.length } },
});
const report = (source: string, mutants: ReturnType<typeof mutant>[], file = FILE) => ({ files: { [file]: { source, mutants } } });

// Line 2 holds the `===` the mutants replace, at column 7 (1-based), three characters long.
const SOURCE = ['export const a = 1;', 'if (a === 1) run();', 'if (a === 1) run();'].join('\n');
const list = (survivors: Survivor[]): SurvivorList => ({ schema: 1, survivors });

describe('keying a survivor (#377)', () => {
  it('counts Survived and NoCoverage, and nothing a test detected', () => {
    const found = s.survivorsFromReport(
      report(SOURCE, [
        mutant({ line: 2, column: 7, length: 3, status: 'Survived' }),
        mutant({ line: 2, column: 7, length: 3, status: 'NoCoverage', mutatorName: 'ConditionalExpression', replacement: 'true' }),
        mutant({ line: 2, column: 7, length: 3, status: 'Killed', mutatorName: 'BooleanLiteral' }),
        mutant({ line: 2, column: 7, length: 3, status: 'Timeout', mutatorName: 'StringLiteral' }),
      ]),
      REPO_ROOT,
    );
    expect(found.map((f) => f.status)).toEqual(['Survived', 'NoCoverage']);
    expect(s.SURVIVOR_STATUSES).toEqual(['Survived', 'NoCoverage']);
  });

  it('keeps the same key when code above the mutant moves it down — a line shift is not a new survivor', () => {
    // Named break: key the survivor by its line number (e.g. `${hash}#${line}`) and this turns red.
    const before = s.survivorsFromReport(report(SOURCE, [mutant({ line: 2, column: 7, length: 3 })]), REPO_ROOT);
    const shifted = s.survivorsFromReport(report(`// a comment added above\n\n${SOURCE}`, [mutant({ line: 4, column: 7, length: 3 })]), REPO_ROOT);
    expect(shifted[0]!.key).toBe(before[0]!.key);
    expect(shifted[0]!.line).toBe(4);
    // Editing the line around the mutated text keeps the key too; only the text it replaces counts.
    const edited = s.survivorsFromReport(report(SOURCE.replace('if (a === 1) run();', 'if (b === 1) run();'), [mutant({ line: 2, column: 7, length: 3 })]), REPO_ROOT);
    expect(edited[0]!.key).toBe(before[0]!.key);
    // Control: a different mutated text is a different mutant, and so a different key.
    const otherText = s.survivorsFromReport(report(SOURCE, [mutant({ line: 1, column: 18, length: 1, replacement: '0' })]), REPO_ROOT);
    expect(otherText[0]!.key).not.toBe(before[0]!.key);
  });

  it('tells apart the same text mutated the same way twice in one file', () => {
    const twins = s.survivorsFromReport(report(SOURCE, [mutant({ line: 3, column: 7, length: 3 }), mutant({ line: 2, column: 7, length: 3 })]), REPO_ROOT);
    expect(twins.map((t) => t.line)).toEqual([2, 3]);
    expect(new Set(twins.map((t) => t.key)).size).toBe(2);
  });

  it('refuses a report with no source text rather than keying survivors on nothing', () => {
    expect(() => s.survivorsFromReport({ files: { [FILE]: { mutants: [] } } }, REPO_ROOT)).toThrow(/no source text/);
    expect(() => s.survivorsFromReport({}, REPO_ROOT)).toThrow(/not a Stryker JSON report/);
  });
});

describe('grouping new, already seen and known (#377, owner decision 2026-09-15)', () => {
  const [known, seen, fresh] = ['k', 's', 'n'].map((key, i): Survivor => ({ key: `${key}#0`, file: FILE, line: i + 1, mutator: 'EqualityOperator', status: 'Survived' }));
  const baseline = list([{ ...known!, line: 99, tracked: [338] }]);

  it('puts a starting-list survivor in KNOWN with its tag, a previous-run one in ALREADY SEEN, and the rest in NEW', () => {
    // Named break: ignore `previous` (treat every non-baseline survivor as new) and `seen` stays empty.
    const groups = s.groupSurvivors({ current: [known!, seen!, fresh!], baseline, previous: list([seen!]) });
    expect(groups.known.map((g) => g.key)).toEqual(['k#0']);
    expect(groups.known[0]!.tracked).toEqual([338]);
    // Tonight's line, not the starting list's.
    expect(groups.known[0]!.line).toBe(1);
    expect(groups.seen.map((g) => g.key)).toEqual(['s#0']);
    expect(groups.new.map((g) => g.key)).toEqual(['n#0']);
    expect(groups.previousAvailable).toBe(true);
  });

  it('checks the starting list before the previous run — a known survivor never reads as merely seen', () => {
    const groups = s.groupSurvivors({ current: [known!], baseline, previous: list([known!]) });
    expect(groups.known).toHaveLength(1);
    expect(groups.seen).toHaveLength(0);
  });

  it('matches by file AND key, so the same key in another file is not known', () => {
    const elsewhere = { ...known!, file: 'packages/xezar/src/mcp/other.ts' };
    expect(s.groupSurvivors({ current: [elsewhere], baseline, previous: null }).new).toHaveLength(1);
  });

  it('says it could not compare when there is no previous list, and that is not the same as an empty one', () => {
    // Named break: `previousAvailable: true` regardless, and the report claims a comparison it never made.
    const missing = s.groupSurvivors({ current: [fresh!], baseline, previous: null });
    const empty = s.groupSurvivors({ current: [fresh!], baseline, previous: list([]) });
    expect(missing.previousAvailable).toBe(false);
    expect(empty.previousAvailable).toBe(true);
    expect(s.renderSurvivorMarkdown(missing)).toMatch(/could not be checked/);
    expect(s.renderSurvivorMarkdown(empty)).not.toMatch(/could not be checked/);
    expect(s.renderSurvivorMarkdown(missing)).toMatch(/Already seen — in the previous main run \| n\/a/);
  });

  it('lists the new survivors, caps a long group, and names missing shards', () => {
    const many = Array.from({ length: 5 }, (_, i): Survivor => ({ ...fresh!, key: `n#${i}`, line: 10 + i }));
    const md = s.renderSurvivorMarkdown(s.groupSurvivors({ current: [known!, ...many], baseline, previous: list([]) }), { limit: 3, missingShards: [4] });
    expect(md).toMatch(/\| \*\*New\*\*.* \| 5 \|/);
    expect(md).toContain('#### New');
    expect(md).toContain('`tools/example.ts:10`');
    expect(md).toContain('…and 2 more');
    expect(md).toContain('Shard 4 reported nothing');
    expect(md).toContain('#### Known and tracked');
    expect(md).toContain('#338');
  });
});

describe('the committed starting list', () => {
  const committed = s.parseSurvivorList(JSON.parse(readFileSync(join(REPO_ROOT, s.BASELINE), 'utf8')));

  it('is the complete run 34999068325 on fe33541, with tags for #338 and #353', () => {
    expect(committed.source).toMatchObject({ run: '34999068325', revision: 'fe335417fe759264bae112baa6c47a7ff4d86a8b' });
    expect(Object.keys(committed.tracked ?? {}).sort()).toEqual(['338', '353']);
    // 1 549 survived + 622 no coverage, from the run's own summary on #443.
    expect(committed.survivors.filter((e) => e.status === 'Survived')).toHaveLength(1549);
    expect(committed.survivors.filter((e) => e.status === 'NoCoverage')).toHaveLength(622);
    const tags = new Set(committed.survivors.flatMap((e) => e.tracked ?? []));
    expect([...tags].sort()).toEqual([338, 353]);
  });

  it('has one entry per survivor identity, and reads back byte-identically through its own formatter', () => {
    const identities = committed.survivors.map((e) => `${e.file}#${e.key}`);
    expect(new Set(identities).size).toBe(identities.length);
    expect(s.formatSurvivorList(committed)).toBe(readFileSync(join(REPO_ROOT, s.BASELINE), 'utf8'));
  });

  it('refuses something that is not a survivor list', () => {
    for (const bad of [null, {}, { schema: 2, survivors: [] }, { schema: 1, survivors: [{ line: 1 }] }]) {
      expect(() => s.parseSurvivorList(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('keeps tags across a refresh by identity, and adds a named one only on its mutator', () => {
    const old = list([{ key: 'a#0', file: FILE, line: 5, mutator: 'LogicalOperator', status: 'Survived', tracked: [353] }]);
    const refreshed = s.carryTags(
      [
        { key: 'a#0', file: FILE, line: 7, mutator: 'LogicalOperator', status: 'Survived' },
        { key: 'b#0', file: FILE, line: 9, mutator: 'EqualityOperator', status: 'Survived' },
        { key: 'c#0', file: FILE, line: 9, mutator: 'BooleanLiteral', status: 'Survived' },
      ],
      old,
      [{ issue: 338, file: FILE, line: 9, mutator: 'EqualityOperator' }],
    );
    expect(refreshed.map((e) => e.tracked)).toEqual([[353], [338], undefined]);
  });
});

describe('finding the previous main run', () => {
  const artifact = (id: number, branch: string, created: string, extra: Record<string, unknown> = {}) => ({
    name: s.ARTIFACT,
    expired: false,
    created_at: created,
    workflow_run: { id, head_branch: branch },
    ...extra,
  });

  it('picks the newest unexpired list from another main run', () => {
    const answer = {
      artifacts: [
        artifact(7, 'main', '2026-09-17T03:00:00Z'),
        artifact(9, 'main', '2026-09-18T03:00:00Z', { expired: true }),
        artifact(8, 'xez/feature', '2026-09-18T02:00:00Z'),
        artifact(6, 'main', '2026-09-16T03:00:00Z'),
        artifact(10, 'main', '2026-09-19T03:00:00Z'),
      ],
    };
    expect(s.pickPreviousRun(answer, 10)).toBe(7);
    expect(s.pickPreviousRun(answer, '11')).toBe(10);
    expect(s.pickPreviousRun({ artifacts: [] }, 1)).toBeNull();
  });

  it('refuses an unreadable answer instead of reading it as "no previous run"', () => {
    for (const bad of [undefined, null, {}, { artifacts: 'x' }]) expect(() => s.pickPreviousRun(bad, 1)).toThrow(/not an array/);
  });
});
