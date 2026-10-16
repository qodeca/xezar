#!/usr/bin/env node
// Test stub for `qwen-runner.test.ts`: what the real `qwen` command is – a launcher that runs the
// program (here `stub-qwen.mjs`) as its own child, waits for it, and passes its exit on.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const program = join(dirname(fileURLToPath(import.meta.url)), 'stub-qwen.mjs');
const result = spawnSync(process.execPath, [program, ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.signal) process.kill(process.pid, result.signal);
else process.exit(result.status ?? 1);
