import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import mutationConfig from '../vitest.mutation.config.ts';
import { STRYKER_HEADER } from './mcp/adapters/source-guard.testkit.ts';

// The MCP mutation gate (`npm run test:mutation:mcp`, #333) is run by no pull request and by no
// per-PR CI job: since #377 it runs only nightly against `main` (`.github/workflows/mutation.yml`).
// So a config that has drifted from the code it filters is found the night AFTER the change that
// caused the drift has merged, never by that change's own pull request. It was worse when the gate ran only at release, because
// then the first real exercise was the most expensive moment there is: #375 is what that cost —
// `vitest.mutation.config.ts` left ONE guard out by its exact full name, #358 added a second
// guard of the same class under a different describe name, and the release died at the dry run
// before a single mutant ran.
//
// The class: an `AGENTS.md — …` guard that reads its adapter's own source as TEXT and asserts the
// text never says `process.`. Stryker instruments every mutated file with a `stryNS_9fa48` header
// that does say it, so in the sandbox the guard fails on the instrumentation rather than on the
// code. Such a guard cannot kill a mutant either way, so the mutation run excludes it and `npm test`
// still runs it against the real source.
//
// This file fails when a guard of that class escapes `testNamePattern` — i.e. it re-breaks the gate
// at the dry run. It is deliberately OUTSIDE the mutation run's own `include` globs, so it scans
// that suite rather than sitting in it.

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

const pattern = mutationConfig.test?.testNamePattern;

/** `src/mcp/**\/*.test.ts` and friends, as the config spells them — no glob dependency. */
function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('/')
    .map((segment) => (segment === '**' ? '\u0000' : segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')))
    .join('/')
    .replace(/\u0000\//g, '(?:[^/]+/)*')
    .replace(/\/\u0000/g, '(?:/[^/]+)*')
    .replace(/\u0000/g, '(?:[^/]+/)*[^/]+');
  return new RegExp(`^${body}$`);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

type Case = {
  readonly file: string;
  readonly describe: string;
  readonly name: string;
  readonly full: string;
  readonly readsSourceText: boolean;
  /** The `it` call's own text, up to the next `describe`/`it`. */
  readonly body: string;
  /** Whether the enclosing `describe` reads a file as text. */
  readonly blockReadsFile: boolean;
};

/**
 * Every `describe`/`it` name in the mutation run's own test files, with the body each `it` owns.
 *
 * A nested `describe` yields the NEAREST enclosing name rather than the whole chain, so a computed
 * full name is a suffix of vitest's. That is safe for what is asserted here: `testNamePattern` is
 * `^(?!.*…)` — an unanchored lookahead — so a phrase found in the suffix is found in the real name
 * too, and an exclusion proved on the suffix holds on the real name.
 */
function casesIn(file: string): Case[] {
  const source = readFileSync(file, 'utf8');
  const marks = [...source.matchAll(/\b(describe|it)(?:\.\w+)?\(\s*(['"])((?:\\.|(?!\2)[^\n])*)\2/g)];
  const cases: Case[] = [];
  let current = '';
  let describeStart = 0;
  for (const [index, mark] of marks.entries()) {
    const name = mark[3]!.replace(/\\(.)/g, '$1');
    const start = mark.index;
    const end = marks[index + 1]?.index ?? source.length;
    if (mark[1] === 'describe') {
      current = name;
      describeStart = start;
      continue;
    }
    const body = source.slice(start, end);
    const block = source.slice(describeStart, end);
    cases.push({
      file: relative(PACKAGE_ROOT, file).split('\\').join('/'),
      describe: current,
      name,
      full: current ? `${current} ${name}` : name,
      // The class in one sentence: it reads a file as text and forbids `process.` in what it read.
      readsSourceText: /\.not\.toMatch\(/.test(body) && /process\\\./.test(body) && /readFileSync/.test(block),
      body,
      blockReadsFile: /readFileSync/.test(block),
    });
  }
  return cases;
}

const includes = (mutationConfig.test?.include ?? []).map(globToRegExp);
const files = walk(join(PACKAGE_ROOT, 'src')).filter((file) => {
  const rel = relative(PACKAGE_ROOT, file).split('\\').join('/');
  return includes.some((re) => re.test(rel));
});
const cases = files.flatMap(casesIn);
const excluded = (full: string): boolean => !(pattern as RegExp).test(full);

describe("the MCP mutation run's test-name exclusion (#375)", () => {
  it('scanned the real mutation suite — the control that stops an empty scan from passing', () => {
    // Without this, "no guard escaped the pattern" and "we found no guards" read the same.
    expect(pattern, 'the config must still carry a testNamePattern').toBeInstanceOf(RegExp);
    expect(includes.length).toBe(3);
    expect(files.length, 'the mutation suite is ~45 test files').toBeGreaterThan(40);
    expect(cases.length, 'the mutation suite is ~930 tests').toBeGreaterThan(500);
    expect(files.map((f) => relative(PACKAGE_ROOT, f).split('\\').join('/'))).toEqual(
      expect.arrayContaining([
        'src/mcp/adapters/codex.test.ts',
        'src/mcp/adapters/qwen-code.test.ts',
        'src/server/mcp-reference-route.test.ts',
        'src/server/stale-write-routes.test.ts',
      ]),
    );
  });

  it('leaves out every guard that reads source as text and forbids `process.` — both of them, by class', () => {
    const guards = cases.filter((c) => c.readsSourceText && c.describe.startsWith('AGENTS.md — '));
    // Pinned so the scan cannot quietly change what it finds. The two guards of this class lived in
    // the tests of two adapters removed with their backends (#1046); a new guard is covered
    // by the loop.
    expect(guards.map((c) => `${c.file} :: ${c.describe}`)).toEqual([]);
    for (const guard of guards) {
      expect(excluded(guard.full), `${guard.file} would run in the sandbox and fail the dry run: ${guard.full}`).toBe(true);
    }
  });

  it('leaves out nothing else — the siblings of those guards still run, and so does the suite', () => {
    // The exclusion must stay narrow. These three sit in the SAME describes and assert on runtime
    // behaviour, not on source text, so they can kill a mutant and must reach the mutation run.
    const siblings = cases.filter((c) => c.describe.startsWith('AGENTS.md — ') && !c.readsSourceText);
    // The siblings lived in the tests of two adapters removed with their backends (#1046).
    expect(siblings.map((c) => c.name)).toEqual([]);
    for (const sibling of siblings) {
      expect(excluded(sibling.full), `wrongly excluded from the mutation run: ${sibling.full}`).toBe(false);
    }
    expect(cases.filter((c) => excluded(c.full)).length, 'the pattern must skip a class, never a suite').toBe(0);
  });
});

/**
 * Every pattern a case forbids in text it read: `.not.toMatch(/…/)` literals, and
 * `.not.toMatch(NAME)` where the file declares `const NAME = /…/`.
 */
function forbiddenPatterns(body: string, fileText: string): RegExp[] {
  const patterns: RegExp[] = [];
  for (const [, literal, flags] of body.matchAll(/\.not\.toMatch\(\s*\/((?:\\.|\[(?:\\.|[^\]\n])*\]|[^/\\\n[])+)\/([dgimsuy]*)\s*[,)]/g)) {
    patterns.push(new RegExp(literal!, flags));
  }
  for (const [, name] of body.matchAll(/\.not\.toMatch\(\s*([A-Z_][A-Z0-9_]*)\s*[,)]/g)) {
    const declared = fileText.match(new RegExp(`const ${name} = \\/((?:\\\\.|\\[(?:\\\\.|[^\\]\\n])*\\]|[^/\\\\\\n[])+)\\/([dgimsuy]*);`));
    if (declared) patterns.push(new RegExp(declared[1]!, declared[2]));
  }
  return patterns;
}

/** The patterns a raw-text guard forbids that Stryker's own instrumentation header contains. */
function brokenBySandbox(body: string, fileText: string): string[] {
  if (/guardedCode\(/.test(body)) return [];
  return forbiddenPatterns(body, fileText).filter((re) => re.test(STRYKER_HEADER)).map(String);
}

describe("source guards read Stryker's instrumented copy in the mutation run (#443)", () => {
  // In the sandbox every mutated file starts with Stryker's header, which reads `g.process.env`. A
  // test that reads a mutated file as text and forbids a word that header contains fails the dry
  // run, and the shard holding that file measures nothing — the Qwen Code adapter's guard did that
  // on every night from the day it landed, and nothing per PR noticed, because its describe is not
  // one of the `AGENTS.md — …` guards the name pattern above excludes.
  const fileTexts = new Map(files.map((file) => [relative(PACKAGE_ROOT, file).split('\\').join('/'), readFileSync(file, 'utf8')]));
  const guards = cases
    .filter((c) => c.blockReadsFile && !excluded(c.full))
    .map((c) => ({ c, patterns: forbiddenPatterns(c.body, fileTexts.get(c.file)!) }))
    .filter(({ patterns }) => patterns.length > 0);

  it('found the guards it judges, and its check bites — the controls that stop an empty pass', () => {
    // Populated input: real raw-text guards are in scope, through both a literal and a named pattern.
    const found = guards.map(({ c }) => c.file);
    expect(found).toEqual(expect.arrayContaining(['src/mcp/tools/execution-control.test.ts', 'src/mcp/adapters/qwen-code.test.ts']));
    // The check bites: the Qwen Code guard as it was, over the raw text, is refused…
    const before = "expect(source).not.toMatch(/process\\.env|child_process|spawn\\(/);";
    expect(brokenBySandbox(before, '')).toEqual(['/process\\.env|child_process|spawn\\(/']);
    // …through a named pattern too, and stripping the instrumentation first is what lets it pass.
    const named = 'const FORBIDDEN = /process\\.env/;';
    expect(brokenBySandbox('expect(source).not.toMatch(FORBIDDEN);', named)).toEqual(['/process\\.env/']);
    expect(brokenBySandbox('const source = guardedCode(text);\nexpect(source).not.toMatch(FORBIDDEN);', named)).toEqual([]);
  });

  it("lets no guard in the mutation run forbid a word Stryker's header contains in text it did not strip", () => {
    const broken = guards.flatMap(({ c }) => brokenBySandbox(c.body, fileTexts.get(c.file)!).map((re) => `${c.file} :: ${c.full} :: ${re}`));
    expect(broken, 'read the file through guardedCode (mcp/adapters/source-guard.testkit.ts)').toEqual([]);
  });
});
