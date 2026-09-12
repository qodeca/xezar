import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import mutationConfig from '../vitest.mutation.config.ts';

// The MCP mutation gate (`npm run test:mutation:mcp`, #333) is run by no pull request, by no CI job
// and — since the release check step was removed — by no workflow at all: it is a manual command
// until #377 gives it a schedule. So a config that has drifted from the code it filters is never
// found by the change that caused the drift. It was worse when the gate ran only at release, because
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

type Case = { readonly file: string; readonly describe: string; readonly name: string; readonly full: string; readonly readsSourceText: boolean };

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
        'src/mcp/adapters/opencode.test.ts',
        'src/mcp/adapters/pi.test.ts',
        'src/server/mcp-reference-route.test.ts',
        'src/server/stale-write-routes.test.ts',
      ]),
    );
  });

  it('leaves out every guard that reads source as text and forbids `process.` — both of them, by class', () => {
    const guards = cases.filter((c) => c.readsSourceText && c.describe.startsWith('AGENTS.md — '));
    // Pinned so the scan cannot quietly stop finding them; a third guard is covered by the loop.
    expect(guards.map((c) => `${c.file} :: ${c.describe}`)).toEqual([
      'src/mcp/adapters/opencode.test.ts :: AGENTS.md — no XDG_CONFIG_HOME, no environment, no file writes',
      'src/mcp/adapters/pi.test.ts :: AGENTS.md — no environment, no file writes, no process',
    ]);
    for (const guard of guards) {
      expect(excluded(guard.full), `${guard.file} would run in the sandbox and fail the dry run: ${guard.full}`).toBe(true);
    }
  });

  it('leaves out nothing else — the siblings of those guards still run, and so does the suite', () => {
    // The exclusion must stay narrow. These three sit in the SAME describes and assert on runtime
    // behaviour, not on source text, so they can kill a mutant and must reach the mutation run.
    const siblings = cases.filter((c) => c.describe.startsWith('AGENTS.md — ') && !c.readsSourceText);
    expect(siblings.map((c) => c.name)).toEqual([
      'never names XDG_CONFIG_HOME (or any XDG variable) anywhere in the adapter, comments included',
      'leaves process.env exactly as it found it across a full delivery, reaction and heartbeat',
      "never names pi's home variable: relocating pi's config and credentials is not this module's business (#329)",
      'leaves process.env exactly as it found it across a delivery, a reaction and a heartbeat',
    ]);
    for (const sibling of siblings) {
      expect(excluded(sibling.full), `wrongly excluded from the mutation run: ${sibling.full}`).toBe(false);
    }
    expect(cases.filter((c) => excluded(c.full)).length, 'the pattern must skip a class, never a suite').toBe(2);
  });
});
