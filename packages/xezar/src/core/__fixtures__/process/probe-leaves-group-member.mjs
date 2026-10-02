#!/usr/bin/env node
// A sign-in check that answers and exits 0 but leaves a member behind in its process group
// (#894, #892): the member holds none of the probe's pipes, so the probe's `close` arrives at
// once while the member runs on. POSIX only – on Windows there is no group to leave it in.
//
// argv[2]: a file to write the pids to, so a test can clean up whatever survives.
// Prints one JSON line: {"child": <pid>, "member": <pid>}, then exits 0.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const pidFile = process.argv[2];
const member = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000);'], { stdio: 'ignore' });

member.once('spawn', () => {
  const pids = JSON.stringify({ child: process.pid, member: member.pid });
  if (pidFile) writeFileSync(pidFile, pids);
  process.stdout.write(`${pids}\n`);
  member.unref();
});
