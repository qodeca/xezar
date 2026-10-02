#!/usr/bin/env node
// A child that starts a grandchild, then – like a hung agent CLI – ignores stdin EOF and never
// exits on its own. The grandchild does the same and outlives the child unless a tree stop
// reaches it (#963 AC-6).
//
// The grandchild is DETACHED on purpose. On Windows, Node (libuv) puts every child it starts
// without `detached` into a job object that is closed – killing the child – when the parent dies,
// so a plain Node grandchild would die with this process and a tree-stop test would pass without
// any tree stop. A detached process is outside that job, like a dev server a shell started in the
// background, and only an explicit stop ends it.
//
// Prints one JSON line once both run: {"child": <pid>, "grandchild": <pid>}.
import { spawn } from 'node:child_process';

// Each process ends itself after two minutes, so a test that dies before its cleanup leaves nothing.
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 120_000); process.stdin.resume(); setInterval(() => {}, 60_000);'], {
  stdio: 'ignore',
  detached: true,
});

grandchild.once('spawn', () => {
  process.stdout.write(`${JSON.stringify({ child: process.pid, grandchild: grandchild.pid })}\n`);
});

process.stdin.resume();
process.stdin.on('end', () => {});
setInterval(() => {}, 60_000);
setTimeout(() => process.exit(0), 120_000);
