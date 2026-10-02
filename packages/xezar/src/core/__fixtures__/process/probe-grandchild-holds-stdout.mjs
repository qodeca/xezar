#!/usr/bin/env node
// A sign-in check that hangs (#894): the CLI starts a background grandchild that inherits its
// stdout, then neither exits nor answers. Both ignore SIGTERM and stdin EOF, so only a stop that
// reaches the whole tree ends them – and while the grandchild lives, the probe's stdout never
// closes, so waiting for `close` alone hangs for ever.
//
// On Windows the grandchild is DETACHED on purpose: Node (libuv) puts every child it starts
// without `detached` into a job object that kills it when this process dies, so a plain Node
// grandchild would die with the CLI and the test would pass without any tree stop. Elsewhere it
// stays in the CLI's process group, like a background job a shell script started with `&`.
//
// argv[2]: a file to write the pids to, so a test can clean up even when the probe never settles.
// Prints one JSON line once both run: {"child": <pid>, "grandchild": <pid>}.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const pidFile = process.argv[2];
// Each process ends itself after two minutes, so a test that dies before its cleanup leaves nothing.
const grandchild = spawn(
  process.execPath,
  ['-e', "setTimeout(() => process.exit(0), 120_000); process.on('SIGTERM', () => {}); setInterval(() => {}, 60_000);"],
  { stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform === 'win32' },
);

grandchild.once('spawn', () => {
  const pids = JSON.stringify({ child: process.pid, grandchild: grandchild.pid });
  if (pidFile) writeFileSync(pidFile, pids);
  process.stdout.write(`${pids}\n`);
});

process.on('SIGTERM', () => {});
process.stdin.resume();
process.stdin.on('end', () => {});
setInterval(() => {}, 60_000);
setTimeout(() => process.exit(0), 120_000);
