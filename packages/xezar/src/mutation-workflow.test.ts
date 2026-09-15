import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The shape of `.github/workflows/mutation.yml` — the nightly MCP mutation gate (#377) — pinned
// where it is cheap to notice. The workflow itself only runs at night on `main`, so a pull request
// that loosens it (a `push` trigger, a per-shard floor, a lost `include-hidden-files`) would pass
// its own CI and fail, or stop measuring, weeks later. Every rule below is one the owner decided or
// one a real run needs; none is a style preference.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKFLOW = join(REPO_ROOT, '.github/workflows/mutation.yml');
const MUTATION_DIR = join(REPO_ROOT, 'packages/xezar/mutation');

type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  'timeout-minutes'?: number;
  strategy?: { 'fail-fast'?: boolean; matrix?: unknown };
  steps: Step[];
};
type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
};

const text = readFileSync(WORKFLOW, 'utf8');
const wf = parse(text) as Workflow;
const steps = (job: string) => wf.jobs[job]!.steps;
const step = (job: string, name: RegExp) => {
  const found = steps(job).find((s) => name.test(s.name ?? ''));
  expect(found, `${job} has a step matching ${name}`).toBeDefined();
  return found!;
};

describe('the nightly MCP mutation workflow (#377)', () => {
  it('fires only on one nightly schedule and a manual dispatch — never on push, PR or release', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    const schedule = wf.on.schedule as { cron: string }[];
    expect(schedule).toHaveLength(1);
    // Minute and hour are single fixed numbers, and day-of-month, month and day-of-week are all `*`:
    // exactly once a day. A `*` or a list in the first two fields would run more often than nightly.
    expect(schedule[0]!.cron).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
  });

  it('queues instead of cancelling, and lets every shard finish', () => {
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
    expect(wf.jobs.mutants!.strategy?.['fail-fast']).toBe(false);
  });

  it('keeps every job under GitHub’s 6-hour kill', () => {
    for (const [name, job] of Object.entries(wf.jobs)) {
      expect(job['timeout-minutes'], `${name} sets its own timeout`).toBeTypeOf('number');
      expect(job['timeout-minutes']!, name).toBeLessThan(360);
    }
  });

  it('uploads the shard report from the dot-directory Stryker writes to', () => {
    const upload = step('mutants', /upload/i);
    expect(upload.if).toBe('always()');
    expect(upload.with?.path).toBe('.local/mutation/mcp/');
    expect(upload.with?.['include-hidden-files']).toBe(true);
    // The artifact name is how the aggregate finds the report: `mutation-report-<shard>`.
    expect(upload.with?.name).toBe('mutation-report-${{ matrix.shard }}');
  });

  it('passes the shard file list through the environment, not into the command line', () => {
    const run = step('mutants', /stryker/i);
    expect(run.env?.SHARD_MUTATE).toBe('${{ matrix.mutate }}');
    expect(run.run).not.toContain('${{');
    expect(run.run).toContain('npm run test:mutation:mcp:shard');
  });

  it('grants write access to issues on the report job only, and read everywhere else', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(wf.jobs.report!.permissions).toEqual({ contents: 'read', issues: 'write', actions: 'read' });
    for (const name of ['plan', 'mutants']) expect(wf.jobs[name]!.permissions, name).toBeUndefined();
    expect(text).not.toMatch(/id-token|NPM_TOKEN|NODE_AUTH_TOKEN|npm\s+publish/);
  });

  it('reaches the report job when a shard fails and when the planner fails', () => {
    const report = wf.jobs.report!;
    expect(report.needs).toEqual(['plan', 'mutants']);
    // A success condition on `plan` is what the draft had, and it meant a planner failure filed
    // nothing. `!cancelled()` is the condition that lets both failures through.
    expect(report.if).toBe('${{ !cancelled() }}');
    expect(step('report', /sum the shards/i).run).toMatch(/PLAN_RESULT" != "success"/);
  });

  it('touches the tracking issue only from main, and ends red on anything but green', () => {
    const issue = step('report', /tracking issue/i);
    expect(issue.if).toBe("github.ref == 'refs/heads/main'");
    expect(issue.run).toContain('npm run --silent test:mutation:mcp:issue');
    const last = steps('report').at(-1)!;
    expect(last.if).toContain("steps.aggregate.outputs.verdict != 'green'");
    expect(last.run).toContain('exit 1');
  });

  it('calls only npm scripts that exist', () => {
    const scripts = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    const called = [...text.matchAll(/npm run (?:--silent )?([\w:-]+)/g)].map((m) => m[1]!);
    expect(called.length).toBeGreaterThan(3);
    for (const name of new Set(called)) expect(scripts[name], `package.json names ${name}`).toBeDefined();
    for (const name of ['test:mutation:mcp:plan', 'test:mutation:mcp:shard', 'test:mutation:mcp:report', 'test:mutation:mcp:issue']) {
      expect(called, name).toContain(name);
    }
  });

  it('pins every action to a full commit SHA', () => {
    const uses = Object.values(wf.jobs).flatMap((job) => job.steps.map((s) => s.uses).filter(Boolean)) as string[];
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref, ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it('writes the floor nowhere in the scheduled path — stryker.config.mjs is its only home', async () => {
    // The floor is read at run time. A second copy of the number in the workflow or its scripts is
    // how the two drift apart: somebody raises the floor in the config and the nightly keeps the old.
    const { default: config } = (await import(pathToFileURL(join(REPO_ROOT, 'packages/xezar/stryker.config.mjs')).href)) as {
      default: { thresholds: { break: number } };
    };
    const floor = new RegExp(`(?<![\\d.])${config.thresholds.break}(?![\\d.])`);
    const files = [WORKFLOW, ...readdirSync(MUTATION_DIR).map((name) => join(MUTATION_DIR, name))];
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(floor);
  });
});

describe('the shard config', () => {
  it('differs from the gate’s own config in `thresholds.break` alone', async () => {
    const load = async (path: string) =>
      ((await import(pathToFileURL(join(REPO_ROOT, path)).href)) as { default: Record<string, unknown> & { thresholds: Record<string, unknown> } }).default;
    const base = await load('packages/xezar/stryker.config.mjs');
    const shard = await load('packages/xezar/mutation/stryker.shard.config.mjs');
    expect(typeof base.thresholds.break).toBe('number');
    expect(shard.thresholds.break).toBeNull();
    const withoutBreak = (config: typeof base) => ({ ...config, thresholds: { ...config.thresholds, break: 'x' } });
    expect(withoutBreak(shard)).toEqual(withoutBreak(base));
  });
});
