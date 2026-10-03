#!/usr/bin/env node
// A stand-in `claude` (set as XEZ_CLAUDE_BIN) whose agent starts a dev server in the background
// and walks away from it – the #943 case. It starts a launcher; the launcher starts a long-lived
// server DETACHED, with the inherited environment (so it carries the run's XEZ_TASK_ID), writes
// `{"launcher": <pid>, "server": <pid>}` to `$TMPDIR/detached.pid`, waits for a `release` file
// the test writes once xezar has seen the server, and exits – leaving the server orphaned, as a
// shell that ran `npm run dev &` would. Then this process behaves as the bundled mock claude.
//
// DETACHED on purpose (see spawns-grandchild.mjs): on Windows a non-detached Node child dies
// with its parent's job object, so only a detached server outlives the agent the way a real
// background server does.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const dir = process.env.TMPDIR ?? process.env.TEMP ?? tmpdir();

const LAUNCHER = `
const { spawn } = require('node:child_process');
const { existsSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const dir = process.argv[1];
// The server ends itself after two minutes, so a test that dies before its cleanup leaves nothing.
const server = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 120000); setInterval(() => {}, 60000); // xez-943-dev-server'], {
  stdio: 'ignore',
  detached: true,
  env: process.env,
});
server.unref();
server.once('spawn', () => {
  const file = join(dir, 'detached.pid');
  writeFileSync(file + '.tmp', JSON.stringify({ launcher: process.pid, server: server.pid }));
  renameSync(file + '.tmp', file);
  const wait = setInterval(() => {
    if (existsSync(join(dir, 'release'))) {
      clearInterval(wait);
      process.exit(0);
    }
  }, 50);
});
`;

spawn(process.execPath, ['-e', LAUNCHER, dir], { stdio: 'ignore', env: process.env });

await import(new URL('../../../../scripts/mock-claude.mjs', import.meta.url).href);
