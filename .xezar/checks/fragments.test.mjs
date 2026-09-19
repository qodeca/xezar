// Behaviour tests for the changelog/dogfooding fragment mechanism (issue #668).
//
// The two append-only documents — `CHANGELOG.md` and `.xezar/docs/dogfooding.md` — used to be
// edited at the top by every pull request, so the first merge conflicted every other open pull
// request (and a content conflict stops GitHub from running CI at all). A pull request now writes
// its own fragment file, and the release role folds them. Four behaviours carry that:
//
//   - a direct `# Unreleased` edit is REFUSED, naming the fragment path to use;
//   - a valid fragment parses, an unknown heading or prose does not;
//   - the fold produces the `# <version> (<date>)` section and deletes the fragments;
//   - a dogfooding fragment is folded above the newest existing entry without touching it.
//
// Fixtures are throwaway git repositories under the system temp dir, and they drive the REAL
// scripts — a regression fails here rather than in a release that silently lost a bullet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checks = dirname(fileURLToPath(import.meta.url));
const CHECK = join(checks, 'changelog-check.sh');
const CHANGELOG = join(checks, 'changelog-fragments.mjs');
const DOGFOOD = join(checks, 'dogfooding-fragments.mjs');

const dirs = [];
test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const run = (command, args, cwd) => spawnSync(command, args, { encoding: 'utf8', cwd });

function fixture() {
  const dir = mkdtempSync(join('/tmp', 'xez-fragments-'));
  dirs.push(dir);
  return dir;
}

/** A git repository holding CHANGELOG.md, committed as the base revision. */
function changelogRepo(text) {
  const dir = fixture();
  const git = (...args) => assert.equal(run('git', ['-C', dir, ...args]).status, 0);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'fixture');
  writeFileSync(join(dir, 'CHANGELOG.md'), text);
  git('add', 'CHANGELOG.md');
  git('commit', '-qm', 'base');
  const base = run('git', ['-C', dir, 'rev-parse', 'HEAD']).stdout.trim();
  return {
    dir,
    base,
    write: (next) => writeFileSync(join(dir, 'CHANGELOG.md'), next),
    commit: (next, message = 'branch edit') => {
      writeFileSync(join(dir, 'CHANGELOG.md'), next);
      git('add', 'CHANGELOG.md');
      git('commit', '-qm', message);
    },
  };
}

const FRAGMENT_DIR = (dir) => {
  const path = join(dir, 'changelog.d');
  mkdirSync(path, { recursive: true });
  return path;
};

const BASE = '# Unreleased\n\n## 🐛 Fixes\n\n- old bullet\n\n# 0.1.0 (2026-01-01)\n\n- x\n';

// --- The direct-edit refusal ---------------------------------------------------------------------
test('a direct # Unreleased edit is refused and names the fragment path', () => {
  const { dir, base, commit } = changelogRepo(BASE);
  commit('# Unreleased\n\n## 🐛 Fixes\n\n- old bullet\n- new bullet\n\n# 0.1.0 (2026-01-01)\n\n- x\n');
  const result = run('bash', [CHECK, '--file', join(dir, 'CHANGELOG.md'), '--diff-base', base]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /edited directly/);
  assert.match(result.stderr, /changelog\.d\/<pr-or-branch>\.md/);
});

test('an uncommitted direct # Unreleased edit is refused too', () => {
  const { dir, base, write } = changelogRepo(BASE);
  write('# Unreleased\n\n## 🐛 Fixes\n\n- old bullet\n- new bullet\n\n# 0.1.0 (2026-01-01)\n\n- x\n');
  const result = run('bash', [CHECK, '--file', join(dir, 'CHANGELOG.md'), '--diff-base', base]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /uncommitted edit/);
});

test('a merge that brings another branch\'s # Unreleased change is not this branch editing it', () => {
  const { dir, base, commit } = changelogRepo(BASE);
  const git = (...args) => assert.equal(run('git', ['-C', dir, ...args]).status, 0);
  // main moves on: a direct edit lands there, as it could before the fragments rule.
  git('checkout', '-qb', 'side', base);
  commit('# Unreleased\n\n## 🐛 Fixes\n\n- old bullet\n- a bullet from main\n\n# 0.1.0 (2026-01-01)\n\n- x\n', 'main edit');
  const side = run('git', ['-C', dir, 'rev-parse', 'HEAD']).stdout.trim();
  // This branch merges it without touching CHANGELOG.md itself. --no-ff, because the real case is
  // a task branch that already has its own commits and merges the base into them.
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '--no-edit', side);
  const result = run('bash', [CHECK, '--file', join(dir, 'CHANGELOG.md'), '--diff-base', base]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('removing the # Unreleased heading — the release fold — is allowed', () => {
  const { dir, base, commit } = changelogRepo(BASE);
  commit('# 0.2.0 (2026-02-01)\n\n## 🐛 Fixes\n\n- old bullet\n\n---\n\n# 0.1.0 (2026-01-01)\n\n- x\n');
  const result = run('bash', [CHECK, '--file', join(dir, 'CHANGELOG.md'), '--diff-base', base]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('a change outside # Unreleased is not the fragments rule\'s business', () => {
  const { dir, base, commit } = changelogRepo(BASE);
  commit('# Unreleased\n\n## 🐛 Fixes\n\n- old bullet\n\n# 0.1.0 (2026-01-01)\n\n- x\n- y\n');
  const result = run('bash', [CHECK, '--file', join(dir, 'CHANGELOG.md'), '--diff-base', base]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('adding an # Unreleased section where the base had none is refused', () => {
  const { dir, base, commit } = changelogRepo('# 0.1.0 (2026-01-01)\n\n- x\n');
  commit('# Unreleased\n\n- new bullet\n\n# 0.1.0 (2026-01-01)\n\n- x\n');
  const result = run('bash', [CHECK, '--file', join(dir, 'CHANGELOG.md'), '--diff-base', base]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /edited directly/);
});

test('a base that cannot be resolved is reported, never silently passed', () => {
  // No `main` and no `origin/main`: the rule has no input, and says so instead of passing quietly.
  const dir = fixture();
  const git = (...args) => assert.equal(run('git', ['-C', dir, ...args]).status, 0);
  git('init', '-q', '-b', 'trunk');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'fixture');
  writeFileSync(join(dir, 'CHANGELOG.md'), BASE);
  git('add', 'CHANGELOG.md');
  git('commit', '-qm', 'base');
  const result = run('bash', [CHECK, '--file', join(dir, 'CHANGELOG.md'), '--diff-base', 'auto']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /NOT checked/);
});

// --- The fragment grammar ------------------------------------------------------------------------
test('a valid fragment parses, including a wrapped bullet continuation', () => {
  const dir = fixture();
  const fragments = FRAGMENT_DIR(dir);
  writeFileSync(
    join(fragments, '668.md'),
    '## 🐛 Fixes\n\n- 🐛 **a bullet.** that wraps\n  onto a continuation line (#668)\n\n## 📝 Specs & Documentation\n\n- docs (#668)\n',
  );
  const result = run('node', [CHANGELOG, '--check', fragments]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 fragment/);
});

test('a fragment with an unknown heading is refused', () => {
  const dir = fixture();
  const fragments = FRAGMENT_DIR(dir);
  writeFileSync(join(fragments, '668.md'), '## Nonsense\n\n- a bullet (#668)\n');
  const result = run('node', [CHANGELOG, '--check', fragments]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /is not one of the changelog's group headings/);
});

test('a fragment with prose before its first bullet is refused', () => {
  const dir = fixture();
  const fragments = FRAGMENT_DIR(dir);
  writeFileSync(join(fragments, '668.md'), '## 🐛 Fixes\n\nSome prose.\n\n- a bullet (#668)\n');
  const result = run('node', [CHANGELOG, '--check', fragments]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /only a "## <heading>" line and "- " bullets/);
});

test('a fragment with a top-level heading is refused', () => {
  const dir = fixture();
  const fragments = FRAGMENT_DIR(dir);
  writeFileSync(join(fragments, '668.md'), '# Unreleased\n\n- a bullet (#668)\n');
  const result = run('node', [CHANGELOG, '--check', fragments]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /no top-level heading/);
});

test('a fragment with no bullet is refused', () => {
  const dir = fixture();
  const fragments = FRAGMENT_DIR(dir);
  writeFileSync(join(fragments, '668.md'), '## 🐛 Fixes\n');
  const result = run('node', [CHANGELOG, '--check', fragments]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /has no bullet/);
});

test('README.md documents the folder and is not a fragment', () => {
  const dir = fixture();
  const fragments = FRAGMENT_DIR(dir);
  writeFileSync(join(fragments, 'README.md'), '# Not a fragment\n\nProse that would never parse.\n');
  const result = run('node', [CHANGELOG, '--check', fragments]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /0 fragment/);
});

test('changelog-check.sh carries the fragment parse', () => {
  const dir = fixture();
  writeFileSync(join(dir, 'CHANGELOG.md'), BASE);
  const fragments = FRAGMENT_DIR(dir);
  writeFileSync(join(fragments, '668.md'), '## Nonsense\n\n- a bullet (#668)\n');
  const result = run('bash', [CHECK, '--file', join(dir, 'CHANGELOG.md'), '--fragments', fragments]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /is not one of the changelog's group headings/);
});

// --- The fold ------------------------------------------------------------------------------------
test('the fold creates the version section and removes the fragments', () => {
  const dir = fixture();
  writeFileSync(
    join(dir, 'CHANGELOG.md'),
    '# Unreleased\n\n## 🐛 Fixes\n\n- unreleased bullet\n\n# 0.1.0 (2026-01-01)\n\n- x\n',
  );
  const fragments = FRAGMENT_DIR(dir);
  writeFileSync(join(fragments, '7.md'), '## ✨ Features\n\n- ✨ **a feature.** (#7)\n');
  writeFileSync(
    join(fragments, '668.md'),
    '## 🐛 Fixes\n\n- 🐛 **from a fragment.** wrapped\n  continuation (#668)\n',
  );
  writeFileSync(join(fragments, 'README.md'), 'docs\n');

  const result = run('node', [
    CHANGELOG, '--fold', '--version', '0.2.0', '--date', '2026-02-01',
    '--file', join(dir, 'CHANGELOG.md'), '--fragments', fragments,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const after = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(after, /^# Unreleased\n/);
  assert.match(after, /# 0\.2\.0 \(2026-02-01\)/);
  assert.match(after, /## ✨ Features\n\n- ✨ \*\*a feature\.\*\* \(#7\)/);
  assert.match(after, /## 🐛 Fixes\n\n- 🐛 \*\*from a fragment\.\*\* wrapped\n  continuation \(#668\)/);
  // Newest section above the older dated one, and the Unreleased heading survives for the release
  // fold to remove.
  assert.ok(after.indexOf('# 0.2.0 (2026-02-01)') < after.indexOf('# 0.1.0 (2026-01-01)'));
  assert.ok(after.indexOf('# Unreleased') < after.indexOf('# 0.2.0 (2026-02-01)'));
  assert.deepEqual(
    readdirSync(fragments).sort(),
    ['README.md'],
    'every folded fragment file is deleted',
  );
});

test('the fold puts the new section at the top when there is no # Unreleased left', () => {
  const dir = fixture();
  writeFileSync(join(dir, 'CHANGELOG.md'), '# 0.1.0 (2026-01-01)\n\n- x\n');
  const fragments = FRAGMENT_DIR(dir);
  writeFileSync(join(fragments, '668.md'), '## 🐛 Fixes\n\n- a bullet (#668)\n');
  const result = run('node', [
    CHANGELOG, '--fold', '--version', '0.2.0', '--date', '2026-02-01',
    '--file', join(dir, 'CHANGELOG.md'), '--fragments', fragments,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const after = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(after, /^# 0\.2\.0 \(2026-02-01\)\n/);
  assert.ok(after.indexOf('# 0.2.0 (2026-02-01)') < after.indexOf('# 0.1.0 (2026-01-01)'));
});

test('the fold merges into a section the release role already created', () => {
  const dir = fixture();
  writeFileSync(
    join(dir, 'CHANGELOG.md'),
    '# Unreleased\n\n# 0.2.0 (2026-02-01)\n\n## Highlights\n\nProse highlight.\n\n## 🐛 Fixes\n\n- generated bullet\n\n---\n\n# 0.1.0 (2026-01-01)\n\n- x\n',
  );
  const fragments = FRAGMENT_DIR(dir);
  writeFileSync(join(fragments, '668.md'), '## 🐛 Fixes\n\n- fragment bullet (#668)\n\n## 📝 Specs & Documentation\n\n- docs bullet (#668)\n');
  const result = run('node', [
    CHANGELOG, '--fold', '--version', '0.2.0', '--date', '2026-02-01',
    '--file', join(dir, 'CHANGELOG.md'), '--fragments', fragments,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const after = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(after, /## 🐛 Fixes\n\n- generated bullet\n- fragment bullet \(#668\)\n/);
  assert.match(after, /## 📝 Specs & Documentation\n\n- docs bullet \(#668\)\n\n---\n/);
  assert.match(after, /Prose highlight\./);
});

// --- Dogfooding ----------------------------------------------------------------------------------
test('a dogfooding fragment folds above the newest existing entry without touching it', () => {
  const dir = fixture();
  const existing =
    '# Ledger\n\nIntro.\n\n## Real-task entries\n\n### 2026-09-18 — older task\n- Input: old\n- Observed: old\n\n### 2026-09-01 — oldest task\n- Input: oldest\n';
  writeFileSync(join(dir, 'dogfooding.md'), existing);
  const fragments = join(dir, 'dogfooding.d');
  mkdirSync(fragments);
  writeFileSync(
    join(fragments, 'e3c4f765.md'),
    '### 2026-09-19 — newer task, `feature-implementation` step `Implement`, `xezar-implementation`, pi — real-task observed\n- Input: new\n- Observed: new\n- Remaining limit: new\n',
  );
  writeFileSync(join(fragments, 'README.md'), 'docs\n');

  const result = run('node', [
    DOGFOOD, '--fold', '--file', join(dir, 'dogfooding.md'), '--fragments', fragments,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const after = readFileSync(join(dir, 'dogfooding.md'), 'utf8');
  const marker = after.indexOf('## Real-task entries');
  const inserted = after.indexOf('### 2026-09-19 — newer task');
  const older = after.indexOf('### 2026-09-18 — older task');
  assert.ok(marker < inserted && inserted < older, 'newest first, above the existing entries');
  // Every existing byte survives: the fold inserts and never rewrites a record.
  assert.equal(after.slice(after.indexOf('### 2026-09-18')), existing.slice(existing.indexOf('### 2026-09-18')));
  assert.ok(!existsSync(join(fragments, 'e3c4f765.md')), 'the folded fragment is deleted');
  assert.ok(existsSync(join(fragments, 'README.md')), 'README.md is documentation, not a fragment');
});

test('a dogfooding fragment without a dated heading is refused', () => {
  const dir = fixture();
  writeFileSync(join(dir, 'dogfooding.md'), '# Ledger\n\n## Real-task entries\n\n### 2026-09-01 — oldest\n- Input: oldest\n');
  const fragments = join(dir, 'dogfooding.d');
  mkdirSync(fragments);
  writeFileSync(join(fragments, 'e3c4f765.md'), '- Input: no heading\n');
  const result = run('node', [
    DOGFOOD, '--fold', '--file', join(dir, 'dogfooding.md'), '--fragments', fragments,
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /starts with "### <YYYY-MM-DD>/);
});

test('the real repository ships the fragment folders and a parseable 668 fragment', () => {
  // The change's own pull request uses the mechanism: a fragment at the repo root and the folder
  // that documents it. The check the gate runs is the proof, not a copy of its rules here.
  const repo = join(checks, '..', '..');
  assert.ok(existsSync(join(repo, 'changelog.d', '668.md')));
  assert.ok(existsSync(join(repo, 'changelog.d', 'README.md')));
  assert.ok(existsSync(join(repo, '.xezar', 'docs', 'dogfooding.d', 'README.md')));
  const result = run('node', [CHANGELOG, '--check', join(repo, 'changelog.d')]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // A fresh copy of the folder's own bytes, so this cannot pass by reading some other checkout.
  const copy = fixture();
  cpSync(join(repo, 'changelog.d'), join(copy, 'changelog.d'), { recursive: true });
  assert.equal(run('node', [CHANGELOG, '--check', join(copy, 'changelog.d')]).status, 0);
});
