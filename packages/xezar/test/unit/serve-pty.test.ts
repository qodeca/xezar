import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { RunStore } from '../../src/runs/store.ts';

/**
 * AC-08, on a REAL terminal (#467, PR 3).
 *
 * Everything the live region does is invisible through a pipe, because the renderer correctly
 * refuses to draw it into one. So this suite gives the CLI an actual pseudo-terminal of a stated
 * size (`pty-capture.py`) and reads the raw byte stream back, escape sequences and all.
 *
 * What it pins, and the break each one is named after:
 *
 * - at 80 columns a person sees boot, a status line with WORDS, the table and the end summary —
 *   and every state is readable with the colour stripped off (`colour-only-state`);
 * - an empty table says `No active tasks`, out loud. Silence is not an empty state;
 * - the region is redrawn IN PLACE (cursor-up then clear), not appended;
 * - the cursor is hidden while the region lives and given back on the way out, including after
 *   Ctrl-C — a terminal left with an invisible cursor is `cursor-left-hidden`;
 * - at 40 columns there is no table at all, only lines (`narrow-overflow`), and no printed line
 *   runs past the terminal's width at either size.
 *
 * The capture needs a pseudo-terminal, which Node has none of, so the helper is Python's `pty`.
 * Where python3 is absent locally the suite SKIPS: the check is unknown, never a pass.
 * CI fails immediately instead of silently accepting missing terminal evidence.
 */

const packageRoot = resolve(import.meta.dirname, '../..');
const entry = join(packageRoot, 'src', 'index.ts');
const capture = join(import.meta.dirname, 'pty-capture.py');
const tsxLoader = import.meta.resolve('tsx');

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const CURSOR_UP = /\u001b\[\d+A/;
const CLEAR_BELOW = '\u001b[0J';

function hasPython(): boolean {
  try {
    execFileSync('python3', ['-c', 'import pty'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const pythonAvailable = hasPython();
assert.ok(pythonAvailable || !process.env.CI, 'CI requires python3 with the pty module');
const fixtureRoot = await mkdtemp(join(realpathSync('/tmp'), 'xez-pty-'));
after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

async function makeRepo(name: string): Promise<string> {
  const repo = join(fixtureRoot, name);
  execFileSync('git', ['init', '-q', repo], { cwd: fixtureRoot });
  await writeFile(join(repo, 'README.md'), '# fixture\n');
  execFileSync('git', ['-c', 'user.email=t@e.x', '-c', 'user.name=T', 'add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@e.x', '-c', 'user.name=T', 'commit', '-qm', 'init'], { cwd: repo });
  return repo;
}

/** Boot `serve` on a terminal `columns` wide, let it settle, send one Ctrl-C, return the bytes. */
function captureServe(repo: string, home: string, columns: number, args: string[] = []): string {
  return execFileSync(
    'python3',
    [
      capture,
      String(columns),
      '24',
      '6',
      process.execPath,
      '--import',
      tsxLoader,
      entry,
      'serve',
      '--no-open',
      '--repo',
      repo,
      '--port',
      '0',
      ...args,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        XEZ_DRY_RUN: '1',
        XEZ_HOME: home,
        XEZ_NO_BANNER: '1',
        XEZ_SKILLS_AUTO_UPDATE: '0',
      },
    },
  );
}

/** The text a person reads: escapes removed, carriage returns dropped. */
function visible(raw: string): string[] {
  return raw
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
    .split('\n')
    .map((line) => line.replace(/\r/g, ''));
}


/**
 * Only the lines this change is responsible for: everything after the `cockpit` line.
 *
 * The banner above it is the pre-existing stdout contract, written before the renderer exists
 * and unchanged by #467 PR 3. It carries an absolute repository path, so it is exactly as wide
 * as that path is — measuring it here would be measuring somebody else's line.
 */
function rendererLines(lines: readonly string[]): string[] {
  const boot = lines.findIndex((line) => /cockpit/.test(line));
  return lines.slice(boot + 1);
}

test('80 columns: boot, a status line in words, the table and the end summary', { skip: !pythonAvailable && 'python3 with the pty module is not available' }, async () => {
  const repo = await makeRepo('pty-80');
  const raw = captureServe(repo, join(fixtureRoot, 'home-80'), 80);
  const lines = visible(raw);
  const text = lines.join('\n');

  // Boot — the banner and the real bound URL, on stdout, exactly as before.
  assert.match(text, /xezar v\d/, 'the banner is there');
  assert.match(text, /cockpit .* http:\/\/localhost:\d+/, 'the cockpit URL is there');

  // Status — a level word and a subject word, not a colour. `colour-only-state`: this whole
  // assertion runs on text with every escape byte already stripped out.
  assert.match(text, /\binfo\b/, 'the level is a word');
  assert.match(text, /\bmcp\b.*\bready\b/, 'the subject and what happened are words');

  // The table, and its EMPTY state said out loud.
  assert.match(text, /active tasks/, 'the live table has its rule line');
  assert.match(text, /No active tasks/, 'an empty table says so');

  // The end summary, after Ctrl-C.
  assert.match(text, /Session summary/, 'stopping prints the session summary');

  // Nothing the renderer wrote runs past 80 columns.
  for (const line of rendererLines(lines)) {
    assert.ok(
      [...line].length <= 80,
      `a line ran past 80 columns (${[...line].length}): ${JSON.stringify(line)}`,
    );
  }
});

test('80 columns: the region is redrawn in place, and the cursor comes back', { skip: !pythonAvailable && 'python3 with the pty module is not available' }, async () => {
  // named break: `cursor-left-hidden`
  const repo = await makeRepo('pty-cursor');
  const raw = captureServe(repo, join(fixtureRoot, 'home-cursor'), 80);

  assert.ok(raw.includes(HIDE_CURSOR), 'the cursor is hidden while the live region is drawn');
  assert.match(raw, CURSOR_UP, 'the region is redrawn in place, not appended');
  assert.ok(raw.includes(CLEAR_BELOW), 'the old region is cleared before the new one is written');

  // And the LAST thing that happens to the cursor is that it comes back. A terminal left with
  // an invisible cursor is the bug this break is named after, and it survives the session.
  assert.ok(raw.includes(SHOW_CURSOR), 'the cursor is restored');
  assert.ok(
    raw.lastIndexOf(SHOW_CURSOR) > raw.lastIndexOf(HIDE_CURSOR),
    'the cursor is restored AFTER the last time it was hidden',
  );
});

test('40 columns: lines, not a table, and still no line past the edge', { skip: !pythonAvailable && 'python3 with the pty module is not available' }, async () => {
  // named break: `narrow-overflow`
  const repo = await makeRepo('pty-40');
  const raw = captureServe(repo, join(fixtureRoot, 'home-40'), 40);
  const lines = visible(raw);
  const text = lines.join('\n');

  // Under 60 columns the table is not worth the space it would cost, so `auto` drops to lines.
  assert.ok(!text.includes('active tasks ─'), `a rule line survived at 40 columns:\n${text}`);
  assert.ok(!/\bState\b.*\bAgent\b/.test(text), 'no table header at 40 columns');
  // The one fact that is never dropped, however narrow the terminal gets.
  assert.match(text, /No active tasks/, 'the empty state still says so');
  assert.match(text, /\bmcp\b[\s\S]*\bready\b/, 'activity lines still arrive, stacked');

  for (const line of rendererLines(lines)) {
    assert.ok(
      [...line].length <= 40,
      `a line ran past 40 columns (${[...line].length}): ${JSON.stringify(line)}`,
    );
  }

  assert.ok(raw.includes(SHOW_CURSOR), 'the cursor is restored at 40 columns too');
});

test('recovered boot keeps the banner above the first live region', { skip: !pythonAvailable && 'python3 with pty unavailable' }, async () => {
  const repo = await makeRepo('pty-recovered');
  const store = RunStore.open(join(repo, '.local', 'xezar'));
  for (let i = 0; i < 12; i++) {
    const run = store.createRun({ title: `Recovered task ${i}`, task: 'A task', workflow: 'quick-task', steps: [] });
    store.updateRun(run.id, { status: 'waiting' });
  }
  store.flush();
  const raw = captureServe(repo, join(fixtureRoot, 'home-recovered'), 80);
  const banner = raw.indexOf('cockpit');
  const region = raw.indexOf(HIDE_CURSOR);
  assert.ok(banner >= 0, 'cockpit URL is printed');
  assert.ok(region > banner, 'recovered boot must print the cockpit banner before the first live region');
  assert.match(raw, /Session summary/);
});
test('quiet recovered boot has only the URL on stdout and no live region', { skip: !pythonAvailable && 'python3 with pty unavailable' }, async () => {
  const repo = await makeRepo('pty-quiet-recovered');
  const store = RunStore.open(join(repo, '.local', 'xezar'));
  const run = store.createRun({ title: 'Recovered task', task: 'A task', workflow: 'quick-task', steps: [] });
  store.updateRun(run.id, { status: 'waiting' });
  store.flush();
  const raw = captureServe(repo, join(fixtureRoot, 'home-quiet-recovered'), 80, ['--quiet']);
  assert.match(raw, /cockpit/);
  assert.doesNotMatch(raw, /recovered \d|active tasks|Session summary|\u001b\[[0-9;?]*[AHJhl]/);
});
