#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const requestedRoot = process.argv[2];
if (process.argv.length > 3) {
  console.error('usage: documented-output.mjs [repository-root]');
  process.exit(2);
}

// On native Windows a bare `bash` is WSL's on a stock machine, so the fixture script starts in Git
// Bash, by its full path (lib/windows-programs.mjs, loaded on Windows only, #122).
const WINDOWS = process.platform === 'win32' ? await import('./lib/windows-programs.mjs') : null;
const BASH = WINDOWS ? WINDOWS.gitBash() : 'bash';
if (BASH === null) {
  console.error(`documented-output: ${WINDOWS.GIT_BASH_MISSING}`);
  process.exit(1);
}

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repositoryRoot = realpathSync(requestedRoot ? path.resolve(requestedRoot) : scriptRoot);
const allowlistPath = path.join(repositoryRoot, '.xezar/checks/documented-output.allowlist.json');
const failures = [];
let checked = 0;

class FixtureSetupError extends Error {}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

// The same result shape as `run`, without blocking: the fixture's guard cases are independent
// read-only runs of one script, so they start together. On Windows each Git Bash start costs about
// half a second, and nine in a row were most of this check's time (#132 speed bar).
function runAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const child = spawn(command, args, options);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => done({ status: null, stdout, stderr, error }));
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

function loadAllowlist() {
  let rows;
  try {
    rows = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  } catch (error) {
    failures.push(`allowlist cannot be read: ${error.message}`);
    return new Map();
  }
  if (!Array.isArray(rows)) {
    failures.push('allowlist must be a JSON array');
    return new Map();
  }

  const allowlist = new Map();
  for (const [index, row] of rows.entries()) {
    const location = `allowlist row ${index + 1}`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      failures.push(`${location} must be an object`);
      continue;
    }
    const keys = Object.keys(row).sort().join(',');
    if (keys !== 'expectedOutputProducer,fixture,id,script') {
      failures.push(`${location} must contain only id, script, fixture, and expectedOutputProducer`);
      continue;
    }
    if (typeof row.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(row.id)) {
      failures.push(`${location} has an invalid script id`);
      continue;
    }
    if (
      typeof row.script !== 'string'
      || !/^\.xezar\/checks\/[A-Za-z0-9][A-Za-z0-9._-]*\.sh$/.test(row.script)
    ) {
      failures.push(`${location} has an invalid kit script path`);
      continue;
    }
    if (row.fixture !== 'leader-context') {
      failures.push(`${location} names an unknown fixture: ${String(row.fixture)}`);
      continue;
    }
    if (row.expectedOutputProducer !== 'leader-context-session-start') {
      failures.push(
        `${location} names an unknown expected-output producer: ${String(row.expectedOutputProducer)}`,
      );
      continue;
    }
    if (allowlist.has(row.id)) {
      failures.push(`${location} duplicates script id: ${row.id}`);
      continue;
    }
    allowlist.set(row.id, row);
  }
  return allowlist;
}

function trackedMarkdown() {
  const result = run('git', ['-C', repositoryRoot, 'ls-files', '-z', '--', '*.md']);
  if (result.status !== 0) {
    failures.push(`could not enumerate committed Markdown: ${result.stderr.trim() || 'git failed'}`);
    return [];
  }
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .filter((file) => !file.split('/').some((segment) => (
      segment === '.local' || segment === 'node_modules' || segment === 'changelog.d'
    )))
    .sort();
}

function fenceStart(text) {
  const match = text.match(/^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$/);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return { marker: match[1][0], length: match[1].length, info: match[2].trim() };
}

function fenceEnd(text, fence) {
  const match = text.match(/^ {0,3}(`{3,}|~{3,})[ \t]*(?:\r?\n)?$/);
  return Boolean(match && match[1][0] === fence.marker && match[1].length >= fence.length);
}

function markerValue(text) {
  const match = text.match(/^ {0,3}<!-- documented-output:(.*?)-->[ \t]*(?:\r?\n)?$/);
  return match ? match[1].trim() : null;
}

function markerRefusal(value) {
  if (!value) return 'empty marker';
  if (/\s/.test(value) || /[;&|$`()<>]/.test(value)) {
    return `marker names a command, not a script id: ${value}`;
  }
  if (/[\\/]/.test(value) || value.startsWith('.') || value.endsWith('.sh')) {
    return `marker names a path, not a script id: ${value}`;
  }
  if (!/^[a-z][a-z0-9-]*$/.test(value)) return `marker has an invalid script id: ${value}`;
  return null;
}

function documentedObjects(file) {
  let text;
  try {
    text = readFileSync(path.join(repositoryRoot, file), 'utf8');
  } catch (error) {
    failures.push(`${file}: cannot be read: ${error.message}`);
    return [];
  }
  const lines = text.match(/.*(?:\n|$)/g).filter(Boolean);
  const found = [];
  let ordinaryFence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (ordinaryFence) {
      if (fenceEnd(line, ordinaryFence)) ordinaryFence = null;
      continue;
    }

    const value = markerValue(line);
    if (value !== null) {
      const lineNumber = index + 1;
      const refusal = markerRefusal(value);
      if (refusal) {
        failures.push(`${file}:${lineNumber}: ${refusal}`);
        continue;
      }
      const next = lines[index + 1];
      const fence = next ? fenceStart(next) : null;
      if (!fence || fence.info !== 'json') {
        failures.push(`${file}:${lineNumber}: marker must be immediately followed by a JSON fence`);
        continue;
      }
      const content = [];
      let closed = false;
      index += 2;
      for (; index < lines.length; index += 1) {
        if (fenceEnd(lines[index], fence)) {
          closed = true;
          break;
        }
        content.push(lines[index]);
      }
      if (!closed) {
        failures.push(`${file}:${lineNumber}: documented-output JSON fence is not closed`);
        continue;
      }
      let expected;
      try {
        expected = JSON.parse(content.join(''));
      } catch (error) {
        failures.push(`${file}:${lineNumber}: documented output is not valid JSON: ${error.message}`);
        continue;
      }
      if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).length === 0) {
        failures.push(`${file}:${lineNumber}: documented output must claim at least one JSON object key`);
        continue;
      }
      found.push({ id: value, expected, file, line: lineNumber });
      continue;
    }

    ordinaryFence = fenceStart(line);
  }
  return found;
}

function setupLeaderContextFixture(row, scratch) {
  const root = path.join(scratch, 'leader-context');
  mkdirSync(path.join(root, '.xezar/checks'), { recursive: true });
  mkdirSync(path.join(root, '.xezar/docs'), { recursive: true });
  const sourceScript = path.join(repositoryRoot, row.script);
  try {
    cpSync(sourceScript, path.join(root, row.script));
  } catch (error) {
    throw new FixtureSetupError(`could not copy ${row.script}: ${error.message}`);
  }
  writeFileSync(path.join(root, '.xezar/docs/leader-guide.md'), '# Fixture leader guide\n');
  // A live campaign whose timeline is longer than the loader keeps, so the loud case also runs the
  // entry cut and its pointer line.
  const campaign = path.join(root, '.xezar/campaigns/20260101-fixture');
  mkdirSync(campaign, { recursive: true });
  writeFileSync(path.join(campaign, 'README.md'), '# Fixture campaign\n');
  writeFileSync(path.join(campaign, 'decisions.md'), '# Decisions\n');
  writeFileSync(
    path.join(campaign, 'timeline-2026-01-01.md'),
    Array.from({ length: 45 }, (_, index) => `- 2026-01-01 09:${String(index).padStart(2, '0')} - fixture event\n`).join(''),
  );
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'add', '-A'],
    ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture'],
  ]) {
    const result = run('git', args, { cwd: root });
    if (result.status !== 0) {
      throw new FixtureSetupError(`git ${args[0]} failed: ${result.stderr.trim() || 'unknown error'}`);
    }
  }
  return root;
}

// The loader speaks only in a session the launcher started (`XEZAR_LEADER=1`); every other Claude
// Code session in the checkout gets nothing. So the fixture runs AS the leader, and each guard below
// must still silence it with the flag set – plus one case proving it is silent without the flag.
function cleanEnvironment() {
  const env = { ...process.env, XEZAR_LEADER: '1' };
  delete env.XEZ_HANDOFF_FILE;
  delete env.XEZ_TODOS_FILE;
  delete env.XEZ_TASK_ID;
  return env;
}

// One run of the fixture script, started without waiting: every case runs beside the others in its round.
function startFixtureScript(root, row, { cwd = root, env = cleanEnvironment() } = {}) {
  return runAsync(BASH, [path.join(root, row.script)], { cwd, env });
}

function assertSilent(result, name) {
  if (result.status !== 0 || result.stdout !== '' || result.stderr !== '') {
    throw new Error(
      `${name} should print nothing and exit 0 (status=${result.status}, stdout=${JSON.stringify(result.stdout)}, stderr=${JSON.stringify(result.stderr)})`,
    );
  }
}

// The cases run in three rounds. Inside a round every run only reads the fixture; a round that
// changes it (the nested folder, the linked worktree, the removed guide) waits for the round before.
// The two fixtures outside `root` (the repository-path copy and the folder with no git) are built
// while the first round runs, since nothing in that round reads them. The linked worktree and the
// missing guide share the last round: the linked checkout has its own copy of the guide, so
// removing the one in `root` changes nothing it reads (#132 speed bar: each run is a Git Bash start).
// Results are still judged in the original order, and a set-up failure is reported where it used to
// happen, so the first failure reported is the same one.
async function produceLeaderContextOutput(root, row, scratch) {
  const notLeader = cleanEnvironment();
  delete notLeader.XEZAR_LEADER;
  const guardVariables = ['XEZ_HANDOFF_FILE', 'XEZ_TODOS_FILE', 'XEZ_TASK_ID'];
  const firstRoundRuns = Promise.all([
    startFixtureScript(root, row),
    ...guardVariables.map((variable) =>
      startFixtureScript(root, row, { env: { ...cleanEnvironment(), [variable]: 'fixture-value' } })),
    startFixtureScript(root, row, { env: notLeader }),
  ]);
  let guardedRoot;
  let setupError = null;
  const noGit = path.join(scratch, 'no-git');
  try {
    guardedRoot = setupLeaderContextFixture(
      row,
      path.join(scratch, 'repo-path/.local/xezar/worktrees'),
    );
    mkdirSync(path.join(noGit, '.xezar/checks'), { recursive: true });
    mkdirSync(path.join(noGit, '.xezar/docs'), { recursive: true });
    cpSync(path.join(root, row.script), path.join(noGit, row.script));
    writeFileSync(path.join(noGit, '.xezar/docs/leader-guide.md'), '# Fixture leader guide\n');
  } catch (error) {
    setupError = error;
  }
  const [primary, ...firstRound] = await firstRoundRuns;
  if (primary.status !== 0) throw new Error(`script exited ${primary.status}: ${primary.stderr.trim()}`);
  if (primary.stderr !== '') throw new Error(`script wrote stderr: ${primary.stderr.trim()}`);
  const outputLines = primary.stdout.trimEnd().split('\n');
  if (outputLines.length !== 1 || !outputLines[0]) throw new Error('script did not print exactly one JSON object');
  let output;
  try {
    output = JSON.parse(outputLines[0]);
  } catch (error) {
    throw new Error(`script output is not JSON: ${error.message}`);
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('script output is not a JSON object');
  }

  guardVariables.forEach((variable, i) => assertSilent(firstRound[i], `${variable} guard`));
  assertSilent(firstRound[guardVariables.length], 'not-the-leader guard');

  const nested = path.join(root, '.local/xezar/worktrees/fixture-run');
  mkdirSync(nested, { recursive: true });
  if (setupError) throw setupError;
  const [nestedResult, guardedResult, noGitResult] = await Promise.all([
    startFixtureScript(root, row, { cwd: nested }),
    startFixtureScript(guardedRoot, row),
    startFixtureScript(noGit, row, {
      env: { ...cleanEnvironment(), GIT_CEILING_DIRECTORIES: scratch },
    }),
  ]);
  assertSilent(nestedResult, 'task-worktree path guard');
  assertSilent(guardedResult, 'task-worktree repository-path guard');

  const linked = path.join(path.dirname(root), 'linked-worktree');
  const linkedResult = run('git', ['worktree', 'add', '-q', '-b', 'fixture-linked', linked, 'main'], { cwd: root });
  if (linkedResult.status !== 0) {
    throw new FixtureSetupError(`linked worktree setup failed: ${linkedResult.stderr.trim() || 'unknown error'}`);
  }
  rmSync(path.join(root, '.xezar/docs/leader-guide.md'));
  const [linkedRun, missingGuideRun] = await Promise.all([
    startFixtureScript(linked, row),
    startFixtureScript(root, row),
  ]);
  assertSilent(linkedRun, 'linked-worktree git guard');
  assertSilent(noGitResult, 'non-git guard');
  assertSilent(missingGuideRun, 'missing-guide guard');
  return output;
}

function hasDocumentedKeys(actual, expected, prefix = '') {
  for (const [key, value] of Object.entries(expected)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(actual, key)) return keyPath;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!actual[key] || typeof actual[key] !== 'object' || Array.isArray(actual[key])) return keyPath;
      const missing = hasDocumentedKeys(actual[key], value, keyPath);
      if (missing) return missing;
    }
  }
  return null;
}

const allowlist = loadAllowlist();
const markers = trackedMarkdown().flatMap(documentedObjects);

for (const marker of markers) {
  const row = allowlist.get(marker.id);
  if (!row) {
    failures.push(`${marker.file}:${marker.line}: unknown script id: ${marker.id}`);
    continue;
  }
  const scratch = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'documented-output-'));
  try {
    const fixtureRoot = setupLeaderContextFixture(row, scratch);
    const actual = await produceLeaderContextOutput(fixtureRoot, row, scratch);
    const missing = hasDocumentedKeys(actual, marker.expected);
    if (missing) failures.push(`${marker.file}:${marker.line}: documented JSON key is not printed: ${missing}`);
    else checked += 1;
  } catch (error) {
    const reason = error instanceof FixtureSetupError ? 'fixture setup failure' : 'fixture execution failure';
    failures.push(`${marker.file}:${marker.line}: ${reason} for ${marker.id}: ${error.message}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`documented-output: ${failure}`);
  process.exit(1);
}

console.log(`documented-output: OK — ${checked} documented output(s) match`);
