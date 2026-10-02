#!/usr/bin/env node
// Stub `claude` binary for the Windows tree stop (#963 AC-6): it starts a grandchild – the way a
// CLI starts a tool or a dev server – emits one assistant turn naming both pids, then, like the
// #703 hang, ignores stdin EOF and never exits on its own. The grandchild does the same.
//
// The grandchild is DETACHED on purpose. On Windows, Node (libuv) puts every child it starts
// without `detached` into a job object that is closed – killing the child – when the parent dies,
// so a plain Node grandchild would die with this process and the test would pass without any tree
// stop. A detached process is outside that job, and only an explicit stop ends it.
//
// The assistant text is one JSON object: {"child": <pid>, "grandchild": <pid>}.
import { spawn } from 'node:child_process';

// Each process ends itself after two minutes, so a test that dies before its cleanup leaves nothing.
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 120_000); process.stdin.resume(); setInterval(() => {}, 60_000);'], {
  stdio: 'ignore',
  detached: true,
});

grandchild.once('spawn', () => {
  const text = JSON.stringify({ child: process.pid, grandchild: grandchild.pid });
  process.stdout.write(
    `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })}\n`,
  );
});

// Keep the event loop alive and stay deaf to EOF, exactly like the real hang.
process.stdin.resume();
process.stdin.on('end', () => {});
setInterval(() => {}, 60_000);
setTimeout(() => process.exit(0), 120_000);
