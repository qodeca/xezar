import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { onWindows } from '../../test/helpers/platform.ts';

/**
 * #963, real Windows: the first PowerShell a process starts holds the calling thread inside
 * process creation for one to two seconds. `defaultTableRunner` starts it from a worker thread, so
 * the main thread – the server – keeps answering. Measured in a fresh process, because only the
 * first start of a program in a process pays it.
 */
const table = pathToFileURL(join(import.meta.dirname, 'process-table.ts')).href;
const probe = `
import { defaultTableRunner, powershellArgs } from ${JSON.stringify(table)};
import { join } from 'node:path';
const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
let last = performance.now(), worst = 0;
const tick = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 10); last = now; }, 10);
const text = await defaultTableRunner(ps, powershellArgs("'answered'"), { maxBuffer: 65536, hide: true });
clearInterval(tick);
console.log(JSON.stringify({ text: text?.trim() ?? null, worst: Math.round(worst) }));
`;

// win32-skip(#976): the worker-thread start exists for Windows process creation only; elsewhere the runner is the plain execFile
describe.runIf(onWindows)('defaultTableRunner on Windows (#963)', () => {
  it('starts the first PowerShell without freezing the main thread, and returns its output', () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 60_000 });
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { text: string | null; worst: number };
    expect(result.text).toBe('answered');
    expect(result.worst, `the main thread stalled ${result.worst} ms`).toBeLessThan(500);
  }, 60_000);
});
