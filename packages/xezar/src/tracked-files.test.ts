import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What this repository is allowed to have under version control.
 *
 * The rename produced a trap worth guarding permanently. Runtime state lived at `.ai/cezar/`
 * and `.ai/qa/cez-home/`, and `.gitignore` named those paths. Renaming the ignore rules to
 * `.ai/xezar/` and `.ai/qa/xez-home/` moved them OFF the directories a developer already had on
 * disk — so a `git add -A` swept four files of local machine state into a commit, including an
 * absolute home-directory path, on a repository about to be made public.
 *
 * Ignore rules are the fix; this is the check that they are still doing their job. It reads
 * `git ls-files`, not the filesystem, so it fails on what is TRACKED rather than what merely
 * exists.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const trackedFiles = (): string[] =>
  execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);

const ignored = (file: string, cwd = repoRoot): boolean => {
  const result = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', file], { cwd });
  if (result.status !== 0 && result.status !== 1) throw new Error(`git check-ignore failed: ${result.stderr}`);
  return result.status === 0;
};

const maintained = [
  '.ai/xezar/CLAUDE.md', '.ai/xezar/config.json', '.ai/xezar/.gitignore',
  '.ai/xezar/workflows/new.yaml', '.ai/xezar/skills/new.md', '.ai/xezar/checks/new.sh',
  '.ai/xezar/docs/new.md', '.ai/xezar/future-guide.md', '.ai/xezar/helpers/future.mjs',
  '.ai/agentic.config.json', '.ai/scripts/migrate-local-state.mjs', 'docs/specs/new.md',
  '.ai/xezar/docs/runs/guide.md', '.ai/xezar/docs/cache/guide.md',
];
const kitRoot = '.xezar';
const maintainedLayouts = maintained.map(file => file.replace('.ai/xezar/', `${kitRoot}/`));

const localRuntime = [
  'runs.json', 'runs.json.tmp', 'runs/a.ndjson', 'worktrees/a/file', 'tmp/a/file',
  'todos.json', 'todos.json.tmp', 'launch-key', 'ui-state.json', 'ui-state.json.tmp',
  'automations.json', 'automations.json.tmp', 'automation-state.json', 'automation-state.json.tmp',
  'automation-receipts.ndjson', 'automation-receipts.ndjson.tmp', 'automation-log.ndjson',
  'automation-log.ndjson.tmp', 'automation-poll.lock', 'cache/a', '.cache/a',
  'credentials/token', 'credentials.json', 'auth.json', 'tokens.json', 'agent-home/token',
  'evidence/result.json', 'snapshots/a.json', '.local/note', '.kit-snapshot.json',
  '.kit-bootstrap-lock/file', '.kit-stage-123/file', '.env', '.env.local',
].map((file) => `${kitRoot}/${file}`);

describe('tracked files', () => {
  it('tracks no per-machine runtime state, under either product name', () => {
    // `.ai/qa/agent-home/` is the most credential-adjacent of these: the e2e boot points the
    // agents' OWN config vars at it, so a `codex login` or `claude` login run while that env is
    // active writes real credentials there. It is the newest directory and the one a future
    // ignore-rule tidy-up would be likeliest to move a rule off — which is exactly how the
    // incident in this file's header happened.
    const stateDirs = [
      /^\.ai\/cezar\//,
      /^\.ai\/qa\/(xez|cez)-home\//,
      /^\.ai\/qa\/agent-home\//,
      /^\.ai\/tmp\//,
    ];
    const leaked = trackedFiles().filter((file) =>
      stateDirs.some((dir) => dir.test(file)) || ((file.startsWith('.xezar/') || file.startsWith('.ai/xezar/')) && ignored(file)),
    );
    expect(leaked, 'local runtime state must never be committed').toEqual([]);
  });

  it('tracks no agent work-record archive', () => {
    // Removed with the rename and gitignored; the pipeline still writes them locally.
    const leaked = trackedFiles().filter((file) => /^\.ai\/(runs|specs|analysis)\//.test(file));
    expect(leaked).toEqual([]);
  });

  it('tracks no environment file — only the documented example', () => {
    const tracked = trackedFiles().filter((file) => /(^|\/)\.env($|\.)/.test(file));
    expect(tracked).toEqual(['.env.example']);
  });

  it('tracks no local agent scratch', () => {
    expect(trackedFiles().filter((file) => file.startsWith('.local/'))).toEqual([]);
  });
});

describe('maintained Xezar project kit versus local runtime', () => {
  it('allows every ordinary maintained file, including future docs/helpers', () => {
    for (const file of maintainedLayouts) expect(ignored(file), file).toBe(false);
  });
  it('ignores local state without hiding maintained directories', () => {
    for (const file of [...localRuntime, '.local/qa/agent-home/token', '.local/test-tmp/fixture', '.local/xezar/runs.json']) expect(ignored(file), file).toBe(true);
  });
  it('startup ignores every engine-written path without touching the maintained kit', () => {
    // Execute only the actual helper body; importing the CLI would boot a real process.
    const source = readFileSync(join(repoRoot, 'packages/xezar/src/index.ts'), 'utf8');
    const body = /function ensureDataGitignore\(repoRoot: string\): void \{([\s\S]*?)\n\}/.exec(source)?.[1];
    expect(body).toBeDefined();
    const ensure = new Function('repoRoot', 'join', 'existsSync', 'readFileSync', 'writeFileSync', 'mkdirSync', body!);
    const temp = mkdtempSync(join(tmpdir(), 'xezar-ignore-'));
    try {
      execFileSync('git', ['init', '-q', temp]);
      // A fresh install has no ignore file at all: the helper still protects engine state.
      ensure(temp, join, existsSync, readFileSync, writeFileSync, mkdirSync);
      ensure(temp, join, existsSync, readFileSync, writeFileSync, mkdirSync);
      expect(readFileSync(join(temp, '.local/.gitignore'), 'utf8')).toBe('\n*\n');
      for (const file of maintainedLayouts) expect(ignored(file, temp), file).toBe(false);
      for (const file of localRuntime) expect(ignored(file.replace(`${kitRoot}/`, '.local/xezar/'), temp), file).toBe(true);
      // The old location is no longer engine state, so nothing blanket-ignores it either.
      expect(ignored('.ai/xezar/config.json', temp)).toBe(false);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
