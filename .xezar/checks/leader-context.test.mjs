// Behaviour tests for `.xezar/checks/leader-context.sh`, the committed SessionStart hook that
// loads the leader guide, model routing, and the live campaign notes into a project leader session.
//
// The contract has two halves, and both are load-bearing:
//   - the leader session in the primary checkout gets ONE JSON payload holding the guide, routing,
//     and newest campaign folder's README and decisions, bounded to each note's last bytes;
//   - a xezar task agent gets NOTHING, because the guide is irrelevant to it. Every way a task can
//     present itself is pinned here: a linked worktree, a path under `.local/xezar/worktrees/`,
//     and the `XEZ_HANDOFF_FILE` / `XEZ_TODOS_FILE` / `XEZ_TASK_ID` variables xezar sets for the
//     agent process.
//
// Fixtures are throwaway git repositories under the task's own git-ignored `.local/xezar/tests/`.
// Each copies the real hook, so a regression in its guards fails here rather than in a leader
// session that silently loaded the wrong context (or a task session that silently loaded this one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checks = dirname(fileURLToPath(import.meta.url));
const hook = join(checks, 'leader-context.sh');
// The committed settings file, copied into each fixture so the command Claude Code really runs is
// what the subdirectory case exercises — not a copy of it retyped in this test.
const settings = join(checks, '..', '..', '.claude', 'settings.json');
// Scratch lives in the system temp dir, NOT under this task's own `.local/xezar/tests/`.
// The hook's guards are the subject here, and one of them is the path rule: anything under a
// checkout's `.local/xezar/worktrees/` is a task worktree and gets no leader context. A fixture
// created inside this task's worktree would therefore be silent for the path reason alone and
// could never prove the primary case. `/tmp` is outside every checkout, which is what a real
// primary checkout looks like to the hook. Same reason the QA guidance gives for a no-git
// fixture (`.xezar/docs/dogfooding.md`, 2026-09-11).
const scratch = '/tmp';
const dirs = [];
test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const GUIDE_SENTINEL = 'GUIDE-SENTINEL: the leader coordinates tasks through the MCP only.';
const ROUTING_SENTINEL = 'ROUTING-SENTINEL: choose the model for the task.';
const README_SENTINEL = 'CAMPAIGN-README-SENTINEL: main = deadbeef.';
const DECISIONS_SENTINEL = 'DECISIONS-SENTINEL: "all new tasks run on pi" (owner 2026-09-18).';

const git = (dir, ...args) => {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
};

// A clean environment: the test itself runs inside a xezar task, so the real process env carries
// XEZ_HANDOFF_FILE. Leaving it in would make every case silent and prove nothing.
const cleanEnv = () => {
  const env = { ...process.env };
  delete env.XEZ_HANDOFF_FILE;
  delete env.XEZ_TODOS_FILE;
  delete env.XEZ_TASK_ID;
  return env;
};

function fixture({ withGuide = true, withRouting = true, withGit = true } = {}) {
  const root = mkdtempSync(join(scratch, 'leader-context-'));
  dirs.push(root);
  writeFileSync(join(root, '.gitignore'), '.local/\n');
  mkdirSync(join(root, '.xezar/checks'), { recursive: true });
  cpSync(hook, join(root, '.xezar/checks/leader-context.sh'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  cpSync(settings, join(root, '.claude/settings.json'));
  if (withGuide || withRouting) {
    mkdirSync(join(root, '.xezar/docs'), { recursive: true });
  }
  if (withGuide) {
    writeFileSync(join(root, '.xezar/docs/leader-guide.md'), `${GUIDE_SENTINEL}\n`);
  }
  if (withRouting) {
    writeFileSync(join(root, '.xezar/docs/model-routing.md'), `${ROUTING_SENTINEL}\n`);
  }
  mkdirSync(join(root, '.local/xezar/campaigns/release-9.9.9'), { recursive: true });
  writeFileSync(join(root, '.local/xezar/campaigns/release-9.9.9/README.md'), `${README_SENTINEL}\n`);
  writeFileSync(join(root, '.local/xezar/campaigns/release-9.9.9/decisions.md'), `${DECISIONS_SENTINEL}\n`);
  if (withGit) {
    git(root, 'init', '-q', '-b', 'main');
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture');
  }
  return root;
}

const run = (cwd, env = cleanEnv()) => spawnSync('bash', [join(cwd, '.xezar/checks/leader-context.sh')], { cwd, encoding: 'utf8', env });

// The command Claude Code runs, read from the fixture's committed settings file.
const hookCommand = (root) => {
  const parsed = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
  return parsed.hooks.SessionStart[0].hooks[0].command;
};

test('prints one JSON payload with leader guidance and the newest campaign folder in a primary checkout', () => {
  const root = fixture();
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
  const context = payload.hookSpecificOutput.additionalContext;
  assert.match(context, /GUIDE-SENTINEL/);
  assert.match(context, /ROUTING-SENTINEL/);
  assert.match(context, /CAMPAIGN-README-SENTINEL/);
  assert.match(context, /DECISIONS-SENTINEL/);
  // Routing follows the guide; campaign files follow both, and each source is named.
  assert.ok(context.indexOf('leader-guide.md') < context.indexOf('GUIDE-SENTINEL'));
  assert.ok(context.indexOf('GUIDE-SENTINEL') < context.indexOf('model-routing.md'));
  assert.ok(context.indexOf('model-routing.md') < context.indexOf('ROUTING-SENTINEL'));
  assert.ok(context.indexOf('ROUTING-SENTINEL') < context.indexOf('CAMPAIGN-README-SENTINEL'));
  assert.ok(context.indexOf('CAMPAIGN-README-SENTINEL') < context.indexOf('DECISIONS-SENTINEL'));
});

test('runs from a subdirectory of the primary checkout, as Claude Code invokes it', () => {
  const root = fixture();
  const subdir = join(root, 'packages/xezar');
  mkdirSync(subdir, { recursive: true });
  // Claude Code runs the settings command with the session's own cwd — the subdirectory, when the
  // session was opened there — and provides CLAUDE_PROJECT_DIR for the project root. A relative
  // command resolves against the subdirectory and fails, so the committed command must use it.
  const command = hookCommand(root);
  assert.match(command, /CLAUDE_PROJECT_DIR/);
  const result = spawnSync('bash', ['-c', command], {
    cwd: subdir,
    encoding: 'utf8',
    env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /GUIDE-SENTINEL/);
  assert.match(context, /ROUTING-SENTINEL/);
  assert.match(context, /CAMPAIGN-README-SENTINEL/);
});

test('prints only the leader guidance when no campaign folder exists', () => {
  const root = fixture();
  rmSync(join(root, '.local/xezar/campaigns'), { recursive: true, force: true });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /GUIDE-SENTINEL/);
  assert.match(context, /ROUTING-SENTINEL/);
  assert.doesNotMatch(context, /CAMPAIGN-README-SENTINEL/);
});

test('stays silent in a linked worktree', () => {
  const root = fixture();
  const wt = join(root, 'linked-wt');
  git(root, 'worktree', 'add', '-q', '-b', 'wt-branch', wt, 'main');
  const result = run(wt);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('stays silent when the path contains /.local/xezar/worktrees/', () => {
  const root = fixture();
  const nested = join(root, '.local/xezar/worktrees/fake-run');
  mkdirSync(nested, { recursive: true });
  const result = spawnSync('bash', [join(root, '.xezar/checks/leader-context.sh')], { cwd: nested, encoding: 'utf8', env: cleanEnv() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('stays silent for a xezar task agent: XEZ_HANDOFF_FILE set', () => {
  const root = fixture();
  const result = run(root, { ...cleanEnv(), XEZ_HANDOFF_FILE: '/tmp/handoff.md' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('stays silent for a xezar task agent: XEZ_TODOS_FILE set', () => {
  const root = fixture();
  const result = run(root, { ...cleanEnv(), XEZ_TODOS_FILE: '/tmp/todos.json' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('stays silent for a xezar task agent: XEZ_TASK_ID set', () => {
  // The one agent signal that is unconditional and never empty: `XEZ_TODOS_FILE` is an empty
  // string when follow-ups are off, so it cannot carry the guard on its own (`run.ts` `agentEnv`).
  const root = fixture();
  const result = run(root, { ...cleanEnv(), XEZ_TASK_ID: 'dff076f5-8696-4d68-bb94-30eebc96fdda' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('bounds each campaign note to its last bytes and names the note it truncated', () => {
  const root = fixture();
  const decisions = join(root, '.local/xezar/campaigns/release-9.9.9/decisions.md');
  // The head sits outside the last 8000 bytes, so an unbounded cat would carry it into the
  // payload. `decisions.md` is append-only by contract, so it only ever grows.
  writeFileSync(decisions, `HEAD-SENTINEL\n${'x'.repeat(9000)}\nTAIL-SENTINEL\n`);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /TAIL-SENTINEL/);
  assert.doesNotMatch(context, /HEAD-SENTINEL/);
  assert.match(context, /\[note truncated: .*decisions\.md is \d+ bytes; showing only its last 8000 bytes\]/);
});

test('chooses the newest campaign folder by name, not by modification time', () => {
  const root = fixture();
  const campaigns = join(root, '.local/xezar/campaigns');
  rmSync(join(campaigns, 'release-9.9.9'), { recursive: true, force: true });
  mkdirSync(join(campaigns, '2026-09-17'), { recursive: true });
  writeFileSync(join(campaigns, '2026-09-17/README.md'), 'OLDER-NAME-SENTINEL\n');
  mkdirSync(join(campaigns, '2026-09-18'), { recursive: true });
  writeFileSync(join(campaigns, '2026-09-18/README.md'), 'NEWER-NAME-SENTINEL\n');
  // A restore or a `cp -r` can make the older-named folder look newest by mtime; the hook must
  // still choose by name.
  const future = new Date(Date.now() + 3600_000);
  utimesSync(join(campaigns, '2026-09-17'), future, future);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /NEWER-NAME-SENTINEL/);
  assert.doesNotMatch(context, /OLDER-NAME-SENTINEL/);
});

test('stays silent when the guide file is missing', () => {
  const root = fixture({ withGuide: false });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('stays silent when the model-routing file is missing', () => {
  const root = fixture({ withRouting: false });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('stays silent when git cannot find a repository', () => {
  // No `.git` at all, and `/tmp` has no repository above it: `git rev-parse` fails, and the hook
  // must degrade to no output rather than an error. This is the case of a checkout that is not a
  // Git repository, which the kit supports.
  const root = fixture({ withGit: false });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
