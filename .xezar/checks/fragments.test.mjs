// Behaviour tests for the changelog/dogfooding fragment mechanism (issue #668).
//
// The two append-only documents — `CHANGELOG.md` and `.xezar/docs/dogfooding.md` — used to be
// edited at the top by every pull request, so the first merge conflicted every other open pull
// request (and a content conflict stops GitHub from running CI at all). A pull request now writes
// its own fragment file, and the release role folds them. Four behaviours carry that:
//
//   - a direct `# Unreleased` edit is REFUSED while it is still the state at HEAD, naming the
//     fragment path to use; a branch that reverted the edit and moved the bullet into a fragment
//     passes, because the only other way out would be rewriting history;
//   - a valid fragment parses, an unknown heading or prose does not;
//   - the fold produces the `# <version> (<date>)` section and deletes the fragments;
//   - a dogfooding fragment is folded above the newest existing entry without touching it.
//
// Fixtures are throwaway git repositories under the kit's own scratch root, and they drive the
// REAL scripts — a regression fails here rather than in a release that silently lost a bullet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const checks = dirname(fileURLToPath(import.meta.url));
const CHECK = join(checks, 'changelog-check.sh');
const CHANGELOG = join(checks, 'changelog-fragments.mjs');
const DOGFOOD = join(checks, 'dogfooding-fragments.mjs');

const dirs = [];
test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const run = (command, args, cwd) => spawnSync(command, args, { encoding: 'utf8', cwd });

// Fixture scratch, exactly where `fixture_scratch_root()` in `lib/common.sh` puts it:
// `<primary>/.local/xezar/tests`. NOT `/tmp` — outside the repository, outside every retention
// rule, and invisible to anyone auditing what a run did — and not this worktree's own `.local/`,
// which retention, the boot orphan sweep and the cockpit's Delete action remove without warning.
// `--git-common-dir` is what resolves the PRIMARY checkout from a linked worktree; the fallback
// is for a checkout git cannot answer from at all.
const scratchRoot = (() => {
  const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], checks);
  const primary = common.status === 0 && common.stdout.trim() !== ''
    ? dirname(common.stdout.trim())
    : resolve(checks, '..', '..');
  return join(primary, '.local', 'xezar', 'tests');
})();
mkdirSync(scratchRoot, { recursive: true });

function fixture() {
  const dir = mkdtempSync(join(scratchRoot, 'xez-fragments-'));
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

test('a direct # Unreleased edit that was reverted and moved into a fragment passes', () => {
  // The natural repair of the refusal above: the direct edit lands, is then undone, and the bullet
  // moves into the fragment the refusal names. A per-commit-only rule refuses this branch for good
  // — the only way out would be rewriting history, which the refusal never says and which a
  // review-response round must not do. The refusal is about the state at HEAD, not about history.
  const { dir, base, commit } = changelogRepo(BASE);
  commit('# Unreleased\n\n## 🐛 Fixes\n\n- old bullet\n- new bullet\n\n# 0.1.0 (2026-01-01)\n\n- x\n', 'direct edit');
  commit(BASE, 'revert the direct edit');
  const fragments = FRAGMENT_DIR(dir);
  writeFileSync(join(fragments, '668.md'), '## 🐛 Fixes\n\n- new bullet (#668)\n');
  const result = run('bash', [CHECK, '--file', join(dir, 'CHANGELOG.md'), '--diff-base', base, '--fragments', fragments]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /the direct edit of CHANGELOG\.md was reverted/);
  assert.match(result.stdout, /1 fragment/);
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

// --- The fold is fence-aware (issue #684) --------------------------------------------------------
// `changelog-check.sh` already refuses a `# ` line inside a fence as a section boundary. The fold
// must use the same rule, or a release inserts its new `# <version>` section — heading, groups and
// `---` separator — between an opening and a closing fence marker, i.e. inside a code block.
test('the fold never inserts the new section inside a fenced code block (#684)', () => {
  const dir = fixture();
  writeFileSync(
    join(dir, 'CHANGELOG.md'),
    '# Unreleased\n\n- pending\n\n```\n# not-a-real-heading\n```\n\n# 0.1.0 (2026-01-01)\n\n- x\n',
  );
  const fragments = FRAGMENT_DIR(dir);
  writeFileSync(join(fragments, '900.md'), '## 🐛 Fixes\n\n- folded bullet (#900)\n');

  const result = run('node', [
    CHANGELOG, '--fold', '--version', '0.2.0', '--date', '2026-09-19',
    '--file', join(dir, 'CHANGELOG.md'), '--fragments', fragments,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const after = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
  const fence = '```\n# not-a-real-heading\n```\n';
  assert.ok(after.includes(fence), `the fenced block must survive intact, got:\n${after}`);
  const inserted = after.indexOf('# 0.2.0 (2026-09-19)');
  assert.ok(after.indexOf('# Unreleased') < inserted, `the new section sits below Unreleased, got:\n${after}`);
  assert.ok(inserted > after.indexOf(fence), `the new section must land AFTER the fence, got:\n${after}`);
  assert.ok(
    inserted < after.indexOf('# 0.1.0 (2026-01-01)'),
    `and BEFORE the older dated release, got:\n${after}`,
  );
});

test('a file that ends inside an open fence is refused, not folded into (#684)', () => {
  // The fence MODEL: a fence that opens and is never closed swallows the rest of the file, so no
  // `# ` line below it is a top-level heading and the fold has no anchor. The previous name
  // ("a fence that opens and never closes is content to the end of the file") described that model
  // while asserting only that the section landed after the fenced text — an ordering that holds
  // WHILE the section sits inside the open fence, which is the harm. What it pins now is the
  // consequence: no anchor means no fold.
  const before = '# Unreleased\n\n- pending\n\n```\n# not-a-real-heading\n';
  const dir = fixture();
  writeFileSync(join(dir, 'CHANGELOG.md'), before);
  const fragments = FRAGMENT_DIR(dir);
  writeFileSync(join(fragments, '900.md'), '## 🐛 Fixes\n\n- folded bullet (#900)\n');

  const result = run('node', [
    CHANGELOG, '--fold', '--version', '0.2.0', '--date', '2026-09-19',
    '--file', join(dir, 'CHANGELOG.md'), '--fragments', fragments,
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /ends inside an unclosed code fence/);
  assert.equal(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), before, 'a refused fold leaves the file untouched');
});

test('an unclosed fence above a dated release is refused, never appended inside (#684)', () => {
  // The reviewer's fixture (PR #696 review, Major M1). The unclosed fence swallows `# 0.1.0`, so
  // the fold found no anchor and appended the whole `# 0.2.0` section — heading, `## 🐛 Fixes`
  // group and `---` separator — at end of file, INSIDE the still-open fence, and exited 0. The
  // section must never be inserted inside a fence, and a file that cannot host it safely is not
  // rewritten at all: the fold refuses and leaves both the changelog and the fragment as they were.
  const before = '# Unreleased\n\n- pending\n\n```\noops unclosed\n\n# 0.1.0 (2026-01-01)\n\n- x\n';
  const dir = fixture();
  writeFileSync(join(dir, 'CHANGELOG.md'), before);
  const fragments = FRAGMENT_DIR(dir);
  writeFileSync(join(fragments, '900.md'), '## 🐛 Fixes\n\n- folded bullet (#900)\n');

  const result = run('node', [
    CHANGELOG, '--fold', '--version', '0.2.0', '--date', '2026-09-19',
    '--file', join(dir, 'CHANGELOG.md'), '--fragments', fragments,
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /ends inside an unclosed code fence/);
  const after = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
  assert.equal(after, before, 'the file is left untouched');
  assert.ok(!after.includes('# 0.2.0'), `no new section is written anywhere, got:\n${after}`);
  assert.ok(existsSync(join(fragments, '900.md')), 'a refused fold does not consume the fragment');
});

test('a changelog with no fence folds to exactly the same bytes as before (#684 guard)', () => {
  // The fence rule must change nothing about the DEFAULT path: a file whose sections hold no fence
  // folds byte-for-byte as it did before the fix. This case is green with and without the fix on
  // purpose — it pins the behaviour the fix must NOT change.
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

  const result = run('node', [
    CHANGELOG, '--fold', '--version', '0.2.0', '--date', '2026-02-01',
    '--file', join(dir, 'CHANGELOG.md'), '--fragments', fragments,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'),
    '# Unreleased\n\n## 🐛 Fixes\n\n- unreleased bullet\n\n'
      + '# 0.2.0 (2026-02-01)\n\n## ✨ Features\n\n- ✨ **a feature.** (#7)\n\n'
      + '## 🐛 Fixes\n\n- 🐛 **from a fragment.** wrapped\n  continuation (#668)\n\n---\n\n'
      + '# 0.1.0 (2026-01-01)\n\n- x\n',
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

// --- An unknown group heading is never sorted above a known one (issue #685) --------------------
// `mergeIntoSection` re-emits the target section and sorts its groups. The sort key used to be
// `HOUSE_HEADINGS.indexOf(heading)`, which answers -1 for a heading outside the house set — and
// -1 sorts above `## Highlights` at index 0. The merge path is the NORMAL release path (the
// release role writes the section, then folds the fragments into it), so the fold rewrote prose
// the role had just authored. An unknown heading now keeps its relative order and goes after
// every known heading; a known heading keeps its house order.
test('an unknown group heading is not sorted above Highlights (#685)', () => {
  // The issue's exact reproduction: a section the release role already wrote, reading
  // Highlights → 🧪 Experimental → 🐛 Fixes, plus one fragment holding 🔧 Changed.
  // `## 🧪 Experimental` is NOT in HOUSE_HEADINGS (read the list at the top of the module), so it
  // is the unknown heading here: it does not keep its third position, it lands after every known
  // one. That is why the expected order is Highlights, Fixes, Changed, Experimental.
  const dir = fixture();
  writeFileSync(
    join(dir, 'CHANGELOG.md'),
    '# Unreleased\n\n# 0.2.0 (2026-09-19)\n\n## Highlights\n\n- highlight prose\n\n'
      + '## 🧪 Experimental\n\n- experimental prose\n\n## 🐛 Fixes\n\n- fix prose\n\n'
      + '---\n\n# 0.1.0 (2026-01-01)\n\n- x\n',
  );
  const fragments = FRAGMENT_DIR(dir);
  writeFileSync(join(fragments, '901.md'), '## 🔧 Changed\n\n- folded change\n');

  const result = run('node', [
    CHANGELOG, '--fold', '--version', '0.2.0', '--date', '2026-09-19',
    '--file', join(dir, 'CHANGELOG.md'), '--fragments', fragments,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const after = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
  assert.equal(
    after,
    '# Unreleased\n\n# 0.2.0 (2026-09-19)\n\n## Highlights\n\n- highlight prose\n\n'
      + '## 🐛 Fixes\n\n- fix prose\n\n## 🔧 Changed\n\n- folded change\n\n'
      + '## 🧪 Experimental\n\n- experimental prose\n\n---\n\n# 0.1.0 (2026-01-01)\n\n- x\n',
    'the unknown heading keeps its prose and lands after every known one',
  );
  // Named separately from the byte comparison above, because this is the harm the issue reports:
  // the fold moved the group the release role had already placed.
  const section = after.slice(after.indexOf('# 0.2.0'), after.indexOf('# 0.1.0'));
  assert.ok(
    section.indexOf('## Highlights') < section.indexOf('## 🧪 Experimental'),
    `an unknown heading must never sort above Highlights, got:\n${section}`,
  );
});

test('two unknown group headings keep their relative order (#685)', () => {
  // The stable-sort half of the decision: both unknowns rank the same, so the order the section
  // already had them in is the order they come out in — and both stay below every known heading.
  const dir = fixture();
  writeFileSync(
    join(dir, 'CHANGELOG.md'),
    '# Unreleased\n\n# 0.2.0 (2026-09-19)\n\n## Highlights\n\n- highlight prose\n\n'
      + '## 🧪 Experimental\n\n- experimental prose\n\n## 🧭 Notes\n\n- note prose\n\n'
      + '---\n\n# 0.1.0 (2026-01-01)\n\n- x\n',
  );
  const fragments = FRAGMENT_DIR(dir);
  writeFileSync(join(fragments, '901.md'), '## 🐛 Fixes\n\n- folded fix (#901)\n');

  const result = run('node', [
    CHANGELOG, '--fold', '--version', '0.2.0', '--date', '2026-09-19',
    '--file', join(dir, 'CHANGELOG.md'), '--fragments', fragments,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const after = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
  assert.equal(
    after,
    '# Unreleased\n\n# 0.2.0 (2026-09-19)\n\n## Highlights\n\n- highlight prose\n\n'
      + '## 🐛 Fixes\n\n- folded fix (#901)\n\n## 🧪 Experimental\n\n- experimental prose\n\n'
      + '## 🧭 Notes\n\n- note prose\n\n---\n\n# 0.1.0 (2026-01-01)\n\n- x\n',
    'both unknowns keep the order the section had them in, after the known headings',
  );
});

test('a section of only house headings folds to the same bytes as before (#685 guard)', () => {
  // This case is green with and without the fix on purpose: it pins the behaviour the fix must NOT
  // change. A section whose headings are all known — and already in house order, which is what the
  // release role writes — folds byte-for-byte as it did before, house order preserved.
  const dir = fixture();
  writeFileSync(
    join(dir, 'CHANGELOG.md'),
    '# Unreleased\n\n# 0.2.0 (2026-09-19)\n\n## Highlights\n\nProse highlight.\n\n'
      + '## 🐛 Fixes\n\n- generated bullet\n\n## 📝 Specs & Documentation\n\n- docs\n\n'
      + '---\n\n# 0.1.0 (2026-01-01)\n\n- x\n',
  );
  const fragments = FRAGMENT_DIR(dir);
  writeFileSync(join(fragments, '901.md'), '## 🐛 Fixes\n\n- folded fix (#901)\n');

  const result = run('node', [
    CHANGELOG, '--fold', '--version', '0.2.0', '--date', '2026-09-19',
    '--file', join(dir, 'CHANGELOG.md'), '--fragments', fragments,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  assert.equal(
    readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'),
    '# Unreleased\n\n# 0.2.0 (2026-09-19)\n\n## Highlights\n\nProse highlight.\n\n'
      + '## 🐛 Fixes\n\n- generated bullet\n- folded fix (#901)\n\n'
      + '## 📝 Specs & Documentation\n\n- docs\n\n---\n\n# 0.1.0 (2026-01-01)\n\n- x\n',
  );
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

test('the real repository ships the fragment folders and a parseable changelog.d', () => {
  // The change's own pull request uses the mechanism, but the fragment file itself is DELETED by
  // the release fold this change adds. Asserting that `changelog.d/668.md` exists would turn the
  // next release red for doing exactly the right thing, in the role whose repair budget is
  // tightest. What must hold at every point of the release cycle is the two folders with their
  // README.md, and that the check parses whatever is present — which after a fold is a
  // README-only directory, and must still exit 0.
  const repo = join(checks, '..', '..');
  assert.ok(existsSync(join(repo, 'changelog.d', 'README.md')));
  assert.ok(existsSync(join(repo, '.xezar', 'docs', 'dogfooding.d', 'README.md')));
  const result = run('node', [CHANGELOG, '--check', join(repo, 'changelog.d')]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // A fresh copy of the folder's own bytes, so this cannot pass by reading some other checkout.
  const copy = fixture();
  cpSync(join(repo, 'changelog.d'), join(copy, 'changelog.d'), { recursive: true });
  assert.equal(run('node', [CHANGELOG, '--check', join(copy, 'changelog.d')]).status, 0);
  // The post-fold state this case has to survive: every fragment folded away, README.md kept.
  for (const name of readdirSync(join(copy, 'changelog.d'))) {
    if (name !== 'README.md') rmSync(join(copy, 'changelog.d', name));
  }
  const afterFold = run('node', [CHANGELOG, '--check', join(copy, 'changelog.d')]);
  assert.equal(afterFold.status, 0, afterFold.stdout + afterFold.stderr);
  assert.match(afterFold.stdout, /0 fragment/);
});
