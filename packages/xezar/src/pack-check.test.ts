import { describe, expect, it } from 'vitest';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  findArchiveGaps,
  findContentLeaks,
  findPackGaps,
  readTarEntries,
  REQUIRED_ARCHIVE_ENTRIES,
  type ArchiveEntry,
} from './pack-check.ts';
import {
  NATIVE_INSTRUCTION_FILE_RULE,
  PROJECT_SPECIFIC_RULES,
  RELEASE_ARCHIVE_EXCEPTION_CEILING,
  RELEASE_ARCHIVE_EXCEPTIONS,
  kitNames,
  releaseArchiveRules,
} from './release/instruction-hygiene.testkit.ts';

// The decision behind `npm run check:pack` (scripts/check-pack.mjs): would the
// npm tarball ship a working cockpit? Pins the R1 "npm pack shipped no UI" bug.
describe('findPackGaps', () => {
  const goodPack = [
    'README.md',
    'dist/index.js',
    'scripts/mock-claude.mjs',
    'web/xezar.svg',
    'web/dist/index.html',
    'web/dist/assets/index-Ck3fQ2ab.js',
    'web/dist/assets/index-B9dL0xyz.css',
  ];

  it('accepts a tarball with the built shell and at least one asset', () => {
    expect(findPackGaps(goodPack)).toEqual([]);
  });

  it('rejects a tarball without web/dist/index.html', () => {
    const gaps = findPackGaps(goodPack.filter((f) => f !== 'web/dist/index.html'));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('web/dist/index.html');
  });

  it('rejects a tarball whose shell has no hashed bundles', () => {
    const gaps = findPackGaps(['dist/index.js', 'web/dist/index.html']);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('web/dist/assets');
  });

  it('does not count a bare "web/dist/assets/" prefix as a bundle', () => {
    const gaps = findPackGaps(['web/dist/index.html', 'web/dist/assets/']);
    expect(gaps).toHaveLength(1);
  });

  it('reports both gaps for the pre-redesign file list (the R1 bug)', () => {
    // What `files` shipped before the packaging flip: sources, no Vite build.
    const legacy = ['README.md', 'dist/index.js', 'web/index.html', 'web/app.js', 'web/style.css'];
    expect(findPackGaps(legacy)).toHaveLength(2);
  });

  it('rejects a tarball that ships src/index.ts — the development-build marker (#442)', () => {
    const gaps = findPackGaps([...goodPack, 'src/index.ts']);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('src/index.ts');
  });

  it('does not accept nested lookalikes for the shell (exact path match)', () => {
    const gaps = findPackGaps(['web/dist/nested/index.html', 'web/dist/assets/a.js']);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('web/dist/index.html');
  });
});

/** A minimal ustar writer: enough to hand `readTarEntries` the bytes npm produces. */
function tar(files: Array<{ path: string; text: string }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const file of files) {
    const data = enc.encode(file.text);
    const header = new Uint8Array(512);
    const put = (value: string, at: number, length: number) => header.set(enc.encode(value).subarray(0, length), at);
    put(file.path, 0, 100);
    put('0000644\0', 100, 8);
    put('0000000\0', 108, 8);
    put('0000000\0', 116, 8);
    put(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    put('00000000000\0', 136, 12);
    put('0', 156, 1);
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    header.fill(32, 148, 156);
    const sum = header.reduce((a, b) => a + b, 0);
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const RULES = releaseArchiveRules(REPO_ROOT);
const clean = () => REQUIRED_ARCHIVE_ENTRIES.map((path) => ({ path, text: path.endsWith('.js') ? 'export const ok = 1;\n' : '{}\n' }));
const entriesOf = (files: Array<{ path: string; text: string }>): ArchiveEntry[] => readTarEntries(gunzipSync(gzipSync(tar(files))));

// #466: `check:pack` also reads a real packed archive and fails on instructions specific to the
// project xezar is developed in. These pin the pure half; the script owns `npm pack`.
describe('release content check', () => {
  it('reads every file back out of a packed archive', () => {
    const entries = entriesOf([{ path: 'package/dist/index.js', text: 'hello' }, { path: 'package/README.md', text: '# hi' }]);
    expect(entries.map((e) => e.path)).toEqual(['package/dist/index.js', 'package/README.md']);
    expect(new TextDecoder().decode(entries[0]!.data)).toBe('hello');
  });

  it('refuses a malformed or truncated archive instead of reporting it clean', () => {
    const bytes = tar([{ path: 'package/dist/index.js', text: 'x'.repeat(2000) }]);
    const corrupt = bytes.slice();
    corrupt[10] = 0x41;
    expect(() => readTarEntries(corrupt)).toThrow(/malformed/);
    expect(() => readTarEntries(bytes.subarray(0, 700))).toThrow(/truncated/);
  });

  it('fails an empty archive and one missing what it must ship', () => {
    expect(findArchiveGaps([])).toEqual(['the packed archive has no files — nothing could be checked']);
    const gaps = findArchiveGaps(entriesOf(clean().filter((f) => f.path !== 'package/web/dist/index.html')));
    expect(gaps).toEqual(['package/web/dist/index.html is missing from the packed archive']);
    expect(findArchiveGaps(entriesOf(clean()))).toEqual([]);
  });

  it.each([
    'package/dist/contract/events.test.d.ts',
    'package/dist/contract/events.spec.js',
    'package/dist/contract/events.testkit.d.ts',
    'package/dist/contract/__tests__/events.d.ts',
  ])('rejects test artifacts from the packed archive: %s', (path) => {
    const problems = findArchiveGaps(entriesOf([...clean(), { path, text: 'export {}\n' }]));
    expect(problems).toEqual([`${path} is a test artifact and must not ship`]);
  });

  it('passes a clean archive, and refuses to judge with no rules', () => {
    const entries = entriesOf(clean());
    expect(findContentLeaks(entries, RULES, []).leaks).toEqual([]);
    expect(() => findContentLeaks(entries, [], [])).toThrow(/no content rules/);
  });

  it.each([
    ['own-readme-leak', 'package/README.md', 'Run the checks: bash .xezar/checks/repo-gates.sh --fast', ['own-kit-checks', 'own-gate-script', 'own-kit-name']],
    ['build-hint-return', 'package/dist/server/static-ui.js', 'export const H = `Run <code>npm run build:web</code>`;', ['own-build-command']],
    ['source path in minified JS, escaped', 'package/web/dist/assets/index-abc.js', 'var a="see packages\\/xezar\\/src\\/index.ts";', ['own-source-path']],
    ['process doc in a declaration', 'package/dist/core/x.d.ts', 'export declare const a = "follow SDLC.md";', ['own-process-doc']],
    ['kit-copy-leak (renamed file, distinctive name)', 'package/scripts/helper.mjs', "run('xezar-implementation')", ['own-kit-name']],
    ['kit evidence path, the frozen historical root', 'package/dist/a.js', 'const p = ".local/xezar-tasks/run";', ['own-local-path']],
    ['kit evidence path, the current root', 'package/dist/a.js', 'const p = ".local/xezar/tasks/run";', ['own-local-path']],
    ['kit snapshot path, the current root (#660)', 'package/dist/a.js', 'const p = ".local/xezar/kit/snapshot.json";', ['own-local-path']],
    ['campaign notes path, the current root (#661)', 'package/dist/a.js', 'const p = ".local/xezar/campaigns/release-0.17.0/README.md";', ['own-local-path']],
    ['campaign notes path, the frozen historical root', 'package/dist/a.js', 'const p = ".local/xezar-campaign/run";', ['own-local-path']],
    ['demo project in a mock', 'package/scripts/mock-claude.mjs', 'https://github.com/qodeca/demo/pull/1', ['demo-project']],
    ['own repository as a working location', 'package/dist/a.js', 'clone qodeca/xezar and run it', ['own-repository']],
  ])('%s is reported with file, line and fragment', (_name, path, text, rules) => {
    const files = [...clean().filter((f) => f.path !== path), { path, text: `line one\n${text}` }];
    const { leaks } = findContentLeaks(entriesOf(files), RULES, []);
    expect(leaks.map((l) => l.rule).sort()).toEqual([...rules].sort());
    expect(leaks[0]).toMatchObject({ file: path.replace(/^package\//, ''), line: 2 });
    expect(leaks[0]!.fragment.length).toBeGreaterThan(0);
  });

  it("leaves the engine's own .local/xezar/ state directories alone", () => {
    // The published CLI writes and documents these itself (`.local/xezar/worktrees`, `.local/xezar/tmp`),
    // so widening `own-local-path` to `.local/xezar/` would fail every release. A guard that passes
    // with and without the fix — it pins the boundary the rule must NOT cross.
    const text = 'const dir = ".local/xezar/worktrees/abc"; const tmp = ".local/xezar/tmp/abc";';
    const { leaks } = findContentLeaks(entriesOf([...clean(), { path: 'package/dist/b.js', text }]), RULES, []);
    expect(leaks.filter((l) => l.rule === 'own-local-path')).toEqual([]);
  });

  it('allows the package identity, support URLs and the default skills provider', () => {
    const text = [
      'npm install -g @qodeca/xezar@latest',
      'https://github.com/qodeca/xezar/issues',
      'https://raw.githubusercontent.com/qodeca/xezar/main/docs/a.png',
      "{ repo: 'qodeca/xezar-skills' }",
      'Codex reads AGENTS.md; Claude Code reads CLAUDE.md',
      // The engine's OWN state directory in the USER's repository. `own-local-path` names the
      // kit's evidence root (`.local/xezar/tasks`) and must not widen to `.local/xezar/`, which
      // the published CLI writes and documents.
      'const dir = ".local/xezar/worktrees/abc"; const tmp = ".local/xezar/tmp/abc";',
    ].join('\n');
    const { leaks } = findContentLeaks(entriesOf([...clean(), { path: 'package/dist/b.js', text }]), RULES, []);
    expect(leaks).toEqual([]);
  });

  it('allowlist-too-wide: an exception covers one fragment in one file, never its neighbours', () => {
    const exception = { rule: 'owner-name', file: 'LICENSE', fragment: 'Copyright (c) 2026 Patryk Lewczuk', reason: 'r', ref: 'x' };
    const license = 'Copyright (c) 2026 Patryk Lewczuk\nAsk Patryk Lewczuk before you change SDLC.md';
    const { leaks, staleExceptions } = findContentLeaks(entriesOf([...clean(), { path: 'package/LICENSE', text: license }]), RULES, [exception]);
    expect(staleExceptions).toEqual([]);
    expect(leaks.map((l) => `${l.line}:${l.rule}`).sort()).toEqual(['2:own-process-doc', '2:owner-name', '2:owner-name']);
    // The same fragment in another file is not covered.
    const other = findContentLeaks(entriesOf([...clean(), { path: 'package/dist/c.js', text: 'Copyright (c) 2026 Patryk Lewczuk' }]), RULES, [exception]);
    expect(other.leaks.map((l) => l.rule)).toEqual(['owner-name', 'owner-name']);
    expect(other.staleExceptions).toEqual([exception]);
  });

  it('keeps the reviewed exception list under its ceiling, each with a reason and a reference', () => {
    expect(RELEASE_ARCHIVE_EXCEPTIONS.length).toBeLessThanOrEqual(RELEASE_ARCHIVE_EXCEPTION_CEILING);
    for (const e of RELEASE_ARCHIVE_EXCEPTIONS) {
      expect(e.reason.length).toBeGreaterThan(0);
      expect(e.ref).toMatch(/#466/);
    }
  });

  it("derives the kit's names from the repository kit, and never ends up empty", () => {
    const names = kitNames(REPO_ROOT);
    expect(names).toContain('xezar-implementation');
    expect(names).toContain('xezar-quality-gates');
    expect(kitNames('/nonexistent-root')).toContain('worktree-preflight');
    expect(PROJECT_SPECIFIC_RULES.length).toBeGreaterThan(0);
    expect(NATIVE_INSTRUCTION_FILE_RULE.id).toBe('native-instruction-file');
  });
});
