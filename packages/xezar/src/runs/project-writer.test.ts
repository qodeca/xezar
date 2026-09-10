import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { openSync, closeSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ownProjectData } from './project-writer.ts';
import { RunStore } from './store.ts';
import { RunManager } from '../workflows/run.ts';
import { ProjectContexts } from '../server/project-context.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

let root: string;
const children: ChildProcess[] = [];
const source = new URL('./project-writer.ts', import.meta.url).href;
const cli = fileURLToPath(new URL('../index.ts', import.meta.url));
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'xez-writer-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit');
      child.kill('SIGKILL');
      await ended;
    }
  }
  rmSync(root, { recursive: true, force: true });
});

async function owner(dataDir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { ownProjectData } from ${JSON.stringify(source)}; ownProjectData(process.argv[1]); console.log('OWNED'); setInterval(() => {}, 1000);`, dataDir],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('writer did not start')), 5000);
    child.stdout!.on('data', (chunk) => { if (String(chunk).includes('OWNED')) { clearTimeout(timer); resolve(); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`writer exited ${code}`)); });
  });
  return child;
}

function peer(pid: number, body = JSON.stringify({ pid, host: hostname() })): string {
  const directory = join(root, 'writer-claims');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${pid}-${randomUUID()}.json`);
  writeFileSync(path, body);
  return path;
}

it('keeps one process claim across repeat access and canonical symlink aliases', () => {
  ownProjectData(root);
  const alias = `${root}-alias`;
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    ownProjectData(alias);
    expect(readdirSync(join(root, 'writer-claims'))).toHaveLength(1);
  } finally { rmSync(alias, { force: true }); }
});

it('a live process refuses a second writer and retains only the original claim', async () => {
  const child = await owner(root);
  expect(() => ownProjectData(root)).toThrow(`live writer PID ${child.pid}`);
  expect(readdirSync(join(root, 'writer-claims'))).toHaveLength(1);
});

it('reclaims a genuinely dead owner without configuration or loss of run data', async () => {
  const child = await owner(root);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  writeFileSync(join(root, 'runs.json'), '[]');
  ownProjectData(root);
  expect(readFileSync(join(root, 'runs.json'), 'utf8')).toBe('[]');
  expect(readdirSync(join(root, 'writer-claims'))).toHaveLength(1);
});

it.each(['EPERM', 'EIO'])('uncertain liveness (%s) refuses and preserves the peer claim', (code) => {
  const path = peer(123456);
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
  expect(() => ownProjectData(root)).toThrow(code);
  expect(readFileSync(path, 'utf8')).toContain('123456');
  expect(readdirSync(join(root, 'writer-claims'))).toHaveLength(1);
});

it('a live partial claim refuses; a confirmed dead partial claim can be reclaimed', () => {
  peer(123456, '{');
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  expect(() => ownProjectData(root)).toThrow('invalid');
  kill.mockImplementation(() => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); });
  expect(() => ownProjectData(root)).not.toThrow();
});

it('a foreign-host claim refuses even when its PID is absent locally', () => {
  peer(123456, JSON.stringify({ pid: 123456, host: 'another-host' }));
  const kill = vi.spyOn(process, 'kill');
  expect(() => ownProjectData(root)).toThrow('foreign-host');
  expect(kill).not.toHaveBeenCalled();
});

it('a deleted active claim is not silently treated as continuing ownership', () => {
  ownProjectData(root);
  rmSync(join(root, 'writer-claims'), { recursive: true });
  expect(() => ownProjectData(root)).toThrow('active claim changed');
});

it('a busy secondary project stays unopened while another project remains usable', async () => {
  const busy = join(root, 'busy');
  const available = join(root, 'available');
  mkdirSync(busy); mkdirSync(available);
  await owner(join(busy, '.local/xezar'));
  const contexts = new ProjectContexts({ listProjects: async () => [
    { id: 'busy', root: busy, status: 'not-git' },
    { id: 'available', root: available, status: 'not-git' },
  ] });
  try {
    await expect(contexts.context('busy')).rejects.toMatchObject({ name: 'ProjectWriterError' });
    expect(readdirSync(join(busy, '.local/xezar'))).toEqual(['writer-claims']);
    expect((await contexts.context('available')).id).toBe('available');
  } finally { contexts.disposeAll(); }
});

it('a second CLI with nested repo, different port/home refuses before recovering a live record', async () => {
  // A truly external fixture: its own Git root cannot ascend into the developer checkout.
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'fixture']);
  const nested = join(root, 'nested'); mkdirSync(nested);
  expect(execFileSync('git', ['-C', nested, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()).toBe(root);
  const dataDir = join(root, '.local/xezar');
  const store = RunStore.open(dataDir);
  const run = store.createRun({ title: 'owned task', task: 'must not be recovered by a peer', workflow: 'quick-task', runner: 'claude', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] });
  store.updateRun(run.id, { status: 'running' });
  store.appendEvent(run.id, { type: 'note', message: 'genuine owner evidence' });
  store.flush();
  const index = readFileSync(join(dataDir, 'runs.json'));
  const events = readFileSync(join(dataDir, 'runs', `${run.id}.ndjson`));
  await owner(dataDir);
  const second = spawn(process.execPath, ['--import', 'tsx', cli, 'serve', '--repo', nested, '--port', '0', '--no-open'], {
    env: { ...process.env, XEZ_HOME: join(root, 'other-home'), XEZ_DRY_RUN: '1', XEZ_SKILLS_AUTO_UPDATE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(second);
  let output = '';
  second.stderr!.on('data', (chunk) => { output += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('second CLI did not refuse before boot')), 5000);
    second.once('exit', (value) => { clearTimeout(timer); resolve(value); });
  });
  expect(code).toBe(1);
  expect(output).toContain('project data is already in use');
  expect(readFileSync(join(dataDir, 'runs.json'))).toEqual(index);
  expect(readFileSync(join(dataDir, 'runs', `${run.id}.ndjson`))).toEqual(events);
  expect(readdirSync(join(dataDir, 'runs'))).toEqual([`${run.id}.ndjson`]);
}, 15000);

it('simultaneous contenders publish before scanning and cannot both become writers', async () => {
  const data = join(root, 'data');
  const barrier = join(root, 'barrier');
  mkdirSync(data); mkdirSync(barrier);
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const [data, barrier] = process.argv.slice(1);
    const list = fs.readdirSync;
    const remove = fs.unlinkSync;
    let claimsAtScan = -1;
    fs.readdirSync = (path, ...args) => {
      if (!String(path).endsWith('writer-claims')) return list(path, ...args);
      fs.writeFileSync(barrier + '/' + process.pid, 'ready');
      const deadline = Date.now() + 4000;
      while (list(barrier).length < 2) {
        if (Date.now() > deadline) throw new Error('barrier timeout');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      const entries = list(path, ...args);
      claimsAtScan = entries.length;
      return entries;
    };
    // Hold refusal cleanup until the other contender has observed the same published set.
    fs.unlinkSync = (path) => { if (!String(path).includes('writer-claims')) remove(path); };
    syncBuiltinESMExports();
    const { ownProjectData } = await import(${JSON.stringify(source)});
    let result;
    try { ownProjectData(data); result = 'owned'; } catch { result = 'refused'; }
    console.log(JSON.stringify({ result, claimsAtScan }));
    setInterval(() => {}, 1000);
  `;
  const answers = await Promise.all([0, 1].map(() => new Promise<{ result: string; claimsAtScan: number }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, data, barrier], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const timer = setTimeout(() => reject(new Error('contenders did not finish')), 6000);
    child.stdout!.once('data', (chunk) => { clearTimeout(timer); resolve(JSON.parse(String(chunk))); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`contender exited ${code}`)); });
  })));
  expect(answers).toEqual([{ result: 'refused', claimsAtScan: 2 }, { result: 'refused', claimsAtScan: 2 }]);
}, 10000);

// Claim reclamation must still reach the ordinary crash-recovery path.
it('a dead owner lets its successor recover a queued task with preserved evidence', async () => {
  const data = join(root, '.local/xezar');
  const original = RunStore.open(data, { keepLive: true });
  const run = original.createRun({ title: 'recover me', task: 'original task', workflow: '(planned)', steps: [] });
  original.updateRun(run.id, {
    status: 'queued',
    workflowDef: { name: '(planned)', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] },
    queuedMessages: [{ id: 'm1', text: 'preserved follow-up', createdAt: new Date().toISOString() }],
  });
  original.appendEvent(run.id, { type: 'note', message: 'genuine evidence before crash' });
  original.flush();
  const child = await owner(data);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  ownProjectData(data);
  const successor = RunStore.open(data, { keepLive: true });
  const manager = new RunManager(successor, root);
  try {
    await manager.recover();
    const jobs = (manager as unknown as { pendingJobs: Map<string, { input: { task: string } }> }).pendingJobs;
    expect(jobs.get(run.id)?.input.task).toBe('original task\n\npreserved follow-up');
    expect(successor.readEvents(run.id).some((event) => event.message === 'genuine evidence before crash')).toBe(true);
    expect(successor.getRun(run.id)?.task).toBe('original task');
  } finally { await manager.dispose(); successor.flush(); }
});

it('a post-open write failure removes only its own claim and allows a repaired retry', () => {
  vi.mocked(writeFileSync).mockImplementationOnce((file) => {
    // Model fs.writeFileSync(path, ...) opening successfully before its write fails.
    // The corrected path passes an already-open descriptor instead.
    if (typeof file !== 'number') closeSync(openSync(file, 'wx', 0o600));
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  });
  expect(() => ownProjectData(root)).toThrow('disk full');
  expect(readdirSync(join(root, 'writer-claims'))).toEqual([]);
  expect(() => ownProjectData(root)).not.toThrow();
});
