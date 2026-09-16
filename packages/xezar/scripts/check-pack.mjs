#!/usr/bin/env node
// Tarball bundle check (`npm run check:pack`, last leg of `npm run build`):
// fail loudly when the published package would ship without the built UI —
// phase R1 of the cockpit redesign once published a tarball with no cockpit
// in it, and this pins that bug class before every publish (prepublishOnly →
// build → check:pack).
//
// Asks npm itself what it would pack (`npm pack --dry-run --json`) and hands
// the file list to the pure, unit-tested decision in src/pack-check.ts.
// Imports from dist/, so it must run AFTER `tsc` — `npm run build` orders
// tsc → the cockpit build → check:pack, which also guarantees web/dist exists in a
// fresh checkout by the time the check looks for it.
//
// Second half (#466): pack a REAL archive into a scratch directory this process creates and
// removes, read every entry out of it, and scan the decoded text for instructions specific to the
// project xezar is developed in. It reads nothing outside that archive. The rules come from a
// test-only module the build excludes (so the banned names never ship), which is why this script
// runs under `node --import tsx`.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { findArchiveGaps, findContentLeaks, findPackGaps, formatLeak, readTarEntries } from '../dist/pack-check.js';
import {
  RELEASE_ARCHIVE_EXCEPTION_CEILING,
  RELEASE_ARCHIVE_EXCEPTIONS,
  releaseArchiveRules,
} from '../src/release/instruction-hygiene.testkit.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Under `npm run`, npm_execpath is npm's own cli.js — running it through
// process.execPath works on every platform (no .cmd shim needed on Windows).
const npmExecpath = process.env.npm_execpath;
const packArgs = ['pack', '--dry-run', '--json'];
const npmCli = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npm = (args) =>
  npmExecpath
    ? execFileSync(process.execPath, [npmExecpath, ...args], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    : execFileSync(npmCli, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
const stdout = npm(packArgs);

/** @type {{ files?: { path: string }[] }[]} */
const reports = JSON.parse(stdout);
const files = (reports[0]?.files ?? []).map((f) => f.path);
if (files.length === 0) {
  console.error('check:pack: `npm pack --dry-run --json` reported no files — refusing to publish an empty package');
  process.exit(1);
}

const gaps = findPackGaps(files);
if (gaps.length > 0) {
  console.error('check:pack: the npm tarball would ship a broken cockpit:');
  for (const gap of gaps) console.error(`  - ${gap}`);
  process.exit(1);
}

const uiFiles = files.filter((f) => f.startsWith('web/dist/')).length;
console.log(`check:pack ok — ${files.length} files, ${uiFiles} under web/dist (shell + assets present)`);

// ---- release content (#466) ---------------------------------------------------------------------
const monorepoRoot = path.resolve(repoRoot, '../..');
const scratch = mkdtempSync(path.join(tmpdir(), 'xezar-check-pack-'));
let failed = false;
try {
  /** @type {{ filename?: string }[]} */
  const packed = JSON.parse(npm(['pack', '--json', '--pack-destination', scratch]));
  const filename = packed[0]?.filename;
  if (!filename) throw new Error('`npm pack --json` named no archive');
  const archive = path.join(scratch, path.basename(filename.replace(/^@/, '').replace('/', '-')));
  const entries = readTarEntries(gunzipSync(readFileSync(archive)));
  const problems = findArchiveGaps(entries);
  const rules = releaseArchiveRules(monorepoRoot);
  const { leaks, staleExceptions, scannedFiles } = findContentLeaks(entries, rules, RELEASE_ARCHIVE_EXCEPTIONS);
  if (RELEASE_ARCHIVE_EXCEPTIONS.length > RELEASE_ARCHIVE_EXCEPTION_CEILING) {
    problems.push(`${RELEASE_ARCHIVE_EXCEPTIONS.length} content exceptions exceed the ceiling of ${RELEASE_ARCHIVE_EXCEPTION_CEILING} — fix the leak instead`);
  }
  for (const stale of staleExceptions) {
    problems.push(`exception no longer matches (remove it and lower the ceiling): ${stale.file} [${stale.rule}] "${stale.fragment}"`);
  }
  if (scannedFiles === 0) problems.push('no text file in the archive was scanned');
  for (const leak of leaks) problems.push(`project-specific instruction: ${formatLeak(leak)}`);
  if (problems.length > 0) {
    failed = true;
    console.error('check:pack: the packed archive fails the release content check (#466):');
    for (const problem of problems) console.error(`  - ${problem}`);
  } else {
    console.log(`check:pack ok — release content: ${scannedFiles} text files scanned against ${rules.length} rules, ${RELEASE_ARCHIVE_EXCEPTIONS.length} reviewed exceptions`);
  }
} catch (err) {
  failed = true;
  console.error(`check:pack: could not check the packed archive's content — ${err instanceof Error ? err.message : String(err)}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
if (failed) process.exit(1);
