#!/usr/bin/env node
// #67 real-model legs: a transparent stdio pass-through between an MCP client and the real `xez mcp`
// bridge. Usage: node mcp-stdio-tee.mjs <log.ndjson> <command> [args...]
// Every newline-delimited JSON-RPC frame is forwarded unchanged and appended to the log as
// { at, dir: 'client' | 'bridge', line }. The log is the transport-side record of what the client's
// model asked the service to do; it never alters, drops or invents a frame.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const [log, command, ...args] = process.argv.slice(2);
if (!log || !command) {
  process.stderr.write('usage: mcp-stdio-tee.mjs <log.ndjson> <command> [args...]\n');
  process.exit(2);
}
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });

function tee(source, sink, dir) {
  let pending = '';
  source.on('data', (chunk) => {
    sink.write(chunk);
    pending += chunk.toString('utf8');
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (line.trim()) appendFileSync(log, `${JSON.stringify({ at: Date.now(), dir, line })}\n`);
    }
  });
}

tee(process.stdin, child.stdin, 'client');
tee(child.stdout, process.stdout, 'bridge');
process.stdin.on('end', () => child.stdin.end());
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
