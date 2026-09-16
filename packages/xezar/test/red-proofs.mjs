#!/usr/bin/env node
/**
 * Prove every new regression test RED before it was green (#467, PR 3).
 *
 * A test written after the diagnosis passes against the bug more often than anyone expects, and
 * a green-either-way test is how the same regression ships twice (AGENTS.md § Changing a
 * mechanism that already works). So each named break from the spec's § 11 acceptance criteria
 * is applied here as ONE deliberate defect in the real source, the test that owns it is run, and
 * the file is put back with `git restore` — never `git stash`, whose stack is shared with every
 * other worktree on this machine.
 *
 * A case that does NOT go red is reported as such rather than quietly dropped: some of these
 * tests are guards that pin behaviour this change did not touch, and knowing which is which is
 * the whole point of running this.
 *
 * Usage:  node packages/xezar/test/red-proofs.mjs [name...]     (no names = every case)
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../../..');
const T = 'packages/xezar/src/terminal';

/**
 * Each case: the named break, the one defect, and the test that must notice it.
 *
 * `kind: 'guard'` marks a test that pins behaviour this change deliberately did NOT alter. It is
 * expected to pass both ways and is reported as a guard, never as a red proof.
 */
const CASES = [
{
    "name": "recovery-replayed-for-later-projects",
    "ac": "AC-06",
    "why": "recovery replayed for later projects",
    "file": "packages/xezar/src/terminal/index.ts",
    "find": "builtUnsubscribe = contexts.onContextBuilt((ctx) => sources.get(ctx.id)?.endRecovery());",
    "replace": "builtUnsubscribe = contexts.onContextBuilt((ctx) => sources.get(ctx.id)?.endRecovery());\n      contexts.onStoreCreated((_store, id) => sources.get(id)?.endRecovery());",
    "test": "packages/xezar/src/terminal/index.test.ts"
},
{
    "name": "later-project-attribution",
    "ac": "AC-06",
    "why": "later-project activity attributed to the boot project",
    "file": "packages/xezar/src/terminal/activity-source.ts",
    "find": "      ...(options.projectId ? { projectId: options.projectId } : {}),",
    "replace": "      ...(false ? { projectId: options.projectId } : {}),",
    "test": "packages/xezar/src/terminal/index.test.ts"
},
{
    "name": "unsanitized-step-name",
    "ac": "AC-11",
    "why": "unsanitized step name",
    "file": "packages/xezar/src/terminal/activity-source.ts",
    "find": "options.emit(entry({",
    "replace": "options.emit(({",
    "test": "packages/xezar/src/terminal/activity-source.test.ts"
},
{
    "name": "unsanitized-step-cell",
    "ac": "AC-11",
    "why": "unsanitized step cell",
    "file": "packages/xezar/src/terminal/activity.ts",
    "find": "cutToWidth(sanitizeText(row.step),",
    "replace": "cutToWidth(row.step,",
    "test": "packages/xezar/src/terminal/activity.test.ts"
},
{
    "name": "recovered-banner-erased",
    "ac": "AC-08",
    "why": "recovered banner erased",
    "file": "packages/xezar/src/terminal/index.ts",
    "find": "liveRegion: false,",
    "replace": "liveRegion: true,",
    "test": "node:packages/xezar/test/unit/serve-pty.test.ts"
},
{
    "name": "quiet-live-region",
    "ac": "AC-09",
    "why": "quiet live region",
    "file": "packages/xezar/src/terminal/index.ts",
    "find": "!options.settings.quiet && isCapableTty(facts)",
    "replace": "isCapableTty(facts)",
    "test": "packages/xezar/src/terminal/index.test.ts"
},
{
    "name": "existing-context-missed",
    "ac": "AC-06",
    "why": "existing context missed",
    "file": "packages/xezar/src/terminal/index.ts",
    "find": "for (const id of contexts.ids())",
    "replace": "for (const id of [] as string[])",
    "test": "packages/xezar/src/terminal/index.test.ts"
},
{
    "name": "step-name-instead-of-id",
    "ac": "AC-08",
    "why": "step name instead of id",
    "file": "packages/xezar/src/terminal/activity-source.ts",
    "find": "{ step: step.id }",
    "replace": "{ step: step.name }",
    "test": "packages/xezar/src/terminal/activity-source.test.ts"
},
{
    "name": "missing-initial-step",
    "ac": "AC-06",
    "why": "missing initial step",
    "file": "packages/xezar/src/terminal/activity-source.ts",
    "find": "currentStep(run) ?? run.steps.find((s) => s.status === 'pending')",
    "replace": "currentStep(run)",
    "test": "packages/xezar/src/terminal/activity-source.test.ts"
},
{
    "name": "plain-stop-missing",
    "ac": "AC-08",
    "why": "plain stop missing",
    "file": "packages/xezar/src/terminal/index.ts",
    "find": "event: 'xezar.stopping'",
    "replace": "event: 'xezar.other'",
    "test": "packages/xezar/src/terminal/index.test.ts"
},
{
    "name": "singular-stop-pronoun",
    "ac": "AC-08",
    "why": "singular stop pronoun",
    "file": "packages/xezar/src/terminal/index.ts",
    "find": "${stillRunning === 1 ? 'it' : 'them'}",
    "replace": "them",
    "test": "packages/xezar/src/terminal/index.test.ts"
},
{
    "name": "colour-forced-in-pipe",
    "ac": "AC-09",
    "why": "colour forced in pipe",
    "file": "packages/xezar/src/terminal/mode.ts",
    "find": "mode !== 'plain' && capable && !ci && color !== 'never'",
    "replace": "mode !== 'plain' && color !== 'never'",
    "test": "packages/xezar/src/terminal/mode.test.ts"
},
{
    "name": "untrusted-logfmt-field",
    "ac": "AC-11",
    "why": "untrusted logfmt field",
    "file": "packages/xezar/src/terminal/renderer.ts",
    "find": "typeof value === 'string' ? sanitizeText(value) : value",
    "replace": "value",
    "test": "packages/xezar/src/terminal/logfmt.test.ts"
},
  {
    name: 'terminal-injection',
    ac: 'AC-11',
    why: 'untrusted text reaches the terminal with its escape sequences intact',
    file: `${T}/sanitize.ts`,
    find: `let text = raw.replace(ESCAPE_SEQUENCES, '');`,
    replace: `let text = raw;`,
    test: `${T}/sanitize.test.ts`,
  },
  {
    name: 'secret-in-debug',
    ac: 'AC-11',
    why: 'a credential shape survives into a line a person screenshots',
    file: `${T}/sanitize.ts`,
    find: `text = redactSecrets(text, options.secretValues ?? defaultSecretValues());`,
    replace: `text = text.slice(0);`,
    test: `${T}/sanitize.test.ts`,
  },
  {
    name: 'colour-only-state',
    ac: 'AC-08',
    why: 'a level is told apart by colour alone, so NO_COLOR and a screen reader lose it',
    file: `${T}/paint.ts`,
    find: `    // \`info\` and \`debug\` print in the default foreground — NOT dim. See the contrast rule.
    default:
      return (s: string) => s;`,
    replace: `    default:
      return colors.dim;`,
    test: `${T}/paint.test.ts`,
  },
  {
    name: 'narrow-overflow',
    ac: 'AC-08',
    why: 'the table is drawn at a width it cannot fit, so every row runs off the edge',
    file: `${T}/activity.ts`,
    find: `  return null;`,
    replace: `  return { task: 8, state: 12, step: 10, agent: 11, time: 5, title: 12 };`,
    test: `${T}/activity.test.ts`,
  },
  {
    name: 'unbounded-redraw',
    ac: 'AC-12',
    why: 'a busy store redraws the terminal once per update instead of four times a second',
    file: `${T}/renderer.ts`,
    find: `export const REDRAW_INTERVAL_MS = 250;`,
    replace: `export const REDRAW_INTERVAL_MS = 0;`,
    test: `${T}/renderer.test.ts`,
  },
  {
    name: 'broken-pipe-kills-runs',
    ac: 'AC-12',
    why: 'a closed output throws out of the renderer instead of stopping the drawing',
    file: `${T}/renderer.ts`,
    find: `    try {
      this.stream.write(chunk);
      this.writes++;
    } catch {
      this.detach();
    }`,
    replace: `    this.stream.write(chunk);
    this.writes++;`,
    test: `${T}/renderer.test.ts`,
  },
  {
    name: 'cursor-left-hidden',
    ac: 'AC-08',
    why: 'the terminal is left with an invisible cursor after xezar exits',
    file: `${T}/renderer.ts`,
    find: `    if (this.cursorHidden) {
      this.write(SHOW_CURSOR);
      this.cursorHidden = false;
    }`,
    replace: `    this.cursorHidden = false;`,
    test: `${T}/renderer.test.ts`,
  },
  {
    name: 'listener-leak',
    ac: 'AC-12',
    why: 'a disposed context leaves its store listeners and timers behind',
    file: `${T}/activity-source.ts`,
    find: `      store.off('run', onRun);
      store.off('event', onEvent);
      store.off('deleted', onDeleted);`,
    replace: `      // deliberately leaked`,
    test: `${T}/activity-source.test.ts`,
  },
  {
    name: 'late-subscribe',
    ac: 'AC-06',
    why: 'records that already existed at attach are not baselined, so recovery prints as news',
    file: `${T}/activity-source.ts`,
    find: `      recovering: true,`,
    replace: `      recovering: false,`,
    test: `${T}/activity-source.test.ts`,
  },
  {
    name: 'duplicate-summary',
    ac: 'AC-06',
    why: 'a token-count update prints the status again, so one start becomes many',
    file: `${T}/activity-source.ts`,
    find: `    if (previous === run.status) {
      if (previousActivity !== run.activity) return;
      return;
    }`,
    replace: `    if (false) return;`,
    test: `${T}/activity-source.test.ts`,
  },
  {
    name: 'session-equals-task',
    ac: 'AC-06',
    why: 'an agent step ending is reported as the task ending',
    file: `${T}/activity-source.ts`,
    find: `        if (!step || step.kind !== 'check') return;`,
    replace: `        if (!step) return;`,
    test: `${T}/activity-source.test.ts`,
  },
  {
    name: 'invented-exit-zero',
    ac: 'AC-07',
    why: 'an exit code nobody observed is reported as 0',
    file: `${T}/activity-source.ts`,
    find: `  return { text: \`\${agent} stopped \${dot} exit code not reported\`, reason, exit: 'unknown' };`,
    replace: `  return { text: \`\${agent} stopped \${dot} exit 0\`, reason, exit: 0 };`,
    test: `${T}/activity-source.test.ts`,
  },
  {
    name: 'returned-error-invisible',
    ac: 'AC-07',
    why: 'a refusal the server RETURNED leaves no trace at all',
    file: `${T}/http-diagnostics.ts`,
    find: `    if (!res || res.status < 400) return;`,
    replace: `    if (!res || res.status < 400 || res.status < 1000) return;`,
    test: `${T}/http-diagnostics.test.ts packages/xezar/src/server/http-diagnostics-api.test.ts`,
  },
  {
    name: 'double-error-log',
    ac: 'AC-07',
    why: 'a thrown error and the 500 it becomes are reported as two separate failures',
    file: `${T}/http-diagnostics.ts`,
    find: `      throw err;`,
    replace: `      c.res = new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } });`,
    test: `${T}/http-diagnostics.test.ts`,
  },
  {
    name: 'ansi-in-pipe',
    ac: 'AC-09',
    why: 'an explicit --output rich puts cursor movement into a file or a pipe',
    file: `${T}/mode.ts`,
    find: `      mode = 'plain';
      fallback = {`,
    replace: `      mode = 'rich';
      fallback = {`,
    test: `${T}/mode.test.ts`,
  },
  {
    name: 'quiet-hides-failure',
    ac: 'AC-09',
    why: 'quiet swallows a warning, so a bind or exposure failure can go unseen',
    file: `${T}/renderer.ts`,
    find: `    if (!passesLevel(entry.level, this.level)) return false;`,
    replace: `    if (!passesLevel(entry.level, this.level) || entry.level === 'warn') return false;`,
    test: `${T}/renderer.test.ts`,
  },
  {
    name: 'activity-on-stdout',
    ac: 'AC-09',
    why: 'the new activity goes to stdout, breaking every script that pipes it',
    file: `${T}/index.ts`,
    find: `options.stream ?? (process.stderr as unknown as RenderStream)`,
    replace: `options.stream ?? (process.stdout as unknown as RenderStream)`,
    test: 'node:packages/xezar/test/unit/serve-streams.test.ts',
  },
];

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8', ...opts });
}

function testPasses(spec) {
  if (spec.startsWith('node:')) {
    const file = spec.slice('node:'.length);
    const loader = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(import.meta.resolve("tsx"))'],
      { cwd: resolve(repoRoot, 'packages/xezar'), encoding: 'utf8' },
    );
    const r = run(process.execPath, ['--import', loader, '--test', '--test-timeout', '180000', file]);
    return r.status === 0;
  }
  const r = run('npm', ['test', '--silent', '--', ...spec.split(' ')]);
  return r.status === 0;
}

const wanted = process.argv.slice(2);
const results = [];

for (const c of CASES) {
  if (c.skip) continue;
  if (wanted.length > 0 && !wanted.includes(c.name)) continue;

  const path = resolve(repoRoot, c.file);
  const original = readFileSync(path, 'utf8');
  if (!original.includes(c.find)) {
    results.push({ ...c, outcome: 'DEFECT-NOT-APPLICABLE' });
    console.log(`?? ${c.name}: the seam this defect edits is not in ${c.file} any more`);
    continue;
  }

  writeFileSync(path, original.replace(c.find, c.replace));
  let passed;
  try {
    passed = testPasses(c.test);
  } finally {
    // Put the exact bytes back from memory. NOT `git restore`, which reads the index and so does
    // nothing at all for a file this change ADDS, and not `git stash`, whose stack is shared with
    // every other worktree on this machine.
    writeFileSync(path, original);
  }
  const after = readFileSync(path, 'utf8');
  if (after !== original) throw new Error(`restore failed for ${c.file}`);

  const outcome = passed ? 'STILL-GREEN (guard)' : 'RED';
  results.push({ ...c, outcome });
  console.log(`${passed ? '⚠ ' : '✓ '}${c.name} (${c.ac}) — ${outcome}`);
}

console.log('\n| Break | AC | What it breaks | Test | Result |');
console.log('|---|---|---|---|---|');
for (const r of results) {
  console.log(`| \`${r.name}\` | ${r.ac} | ${r.why} | \`${r.test}\` | ${r.outcome} |`);
}
const stillGreen = results.filter((r) => r.outcome !== 'RED');
process.exit(stillGreen.length === 0 ? 0 : 1);
