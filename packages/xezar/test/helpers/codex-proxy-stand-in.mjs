#!/usr/bin/env node
// Stand-in for `codex app-server proxy --sock <path>` on Windows (#977), where a test's Codex
// app-server cannot listen on an AF_UNIX path: `listenCodexControl` (codex-control.ts) leaves a
// plain file at the socket path naming the named pipe it listens on instead. Like the real relay,
// this copies bytes between its stdio and that endpoint, and exits when either side closes.
import { appendFileSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';

const [command, sub, flag, socketPath] = process.argv.slice(2);
if (command !== 'app-server' || sub !== 'proxy' || flag !== '--sock' || socketPath === undefined) {
  process.stderr.write(`codex stand-in: unexpected arguments ${JSON.stringify(process.argv.slice(2))}\n`);
  process.exit(2);
}
let pipe;
try {
  pipe = readFileSync(socketPath, 'utf8').trim();
} catch {
  // The real relay cannot connect to a missing socket either.
  process.stderr.write('codex stand-in: no control socket\n');
  process.exit(1);
}
// Every relay that ran, so a test can check that xezar stopped each one.
appendFileSync(`${socketPath}.relay-pids`, `${process.pid}\n`);
const socket = connect(pipe);
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));
process.stdin.pipe(socket);
socket.pipe(process.stdout);
process.stdin.on('end', () => socket.end());
