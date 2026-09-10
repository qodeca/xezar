import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadWorkflows, projectWorkflowsDir, WORKFLOWS_DIR } from './load.ts';

/**
 * The LOADER's own behaviour (#46): discovery, per-file degradation and the
 * built-ins. The schema shape itself belongs to
 * `packages/xezar/test/unit/workflow-types.test.ts` (node:test) and is not
 * re-asserted here.
 *
 * `BACKWARD_COMPATIBILITY.md` §"Workflow YAML" protects this format and names
 * the exact failure these cases guard: a bad file must be reported in `issues`
 * and skipped, never thrown — a throw makes every OTHER committed workflow
 * disappear from the user's cockpit at once, with no crash to notice.
 */
describe('loadWorkflows', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-wf-load-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Write one file under the repo root, creating its parents. */
  function write(relPath: string, value: string) {
    const target = join(root, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value);
  }
  /** Write one workflow file into the discovered `.xezar/workflows` directory. */
  function workflow(fileName: string, value: string) {
    write(`${WORKFLOWS_DIR}/${fileName}`, value);
    return join(root, WORKFLOWS_DIR, fileName);
  }
  const valid = (name: string) => `name: ${name}\nsteps:\n  - id: work\n    prompt: '{{task}}'\n`;

  it('resolves the workflows directory inside the project kit', () => {
    expect(projectWorkflowsDir(root)).toBe(join(root, '.xezar/workflows'));
    expect(WORKFLOWS_DIR).toBe('.xezar/workflows');
  });

  // ---- per-file degradation -------------------------------------------------------------

  it('loads the good files and reports the malformed one, instead of throwing', async () => {
    workflow('alpha.yaml', valid('alpha'));
    workflow('beta.yml', valid('beta'));
    const broken = workflow('broken.yaml', 'name: [unclosed\nsteps:\n  - id: work\n');

    const { workflows, issues } = await loadWorkflows(root);

    // The two valid workflows survive their neighbour. This is the whole point:
    // one bad file must not evict the user's working workflows from the list.
    expect(workflows.map((w) => w.name)).toEqual(['alpha', 'beta', 'quick-task']);
    expect(issues.map((i) => i.path)).toEqual([broken]);
    expect(issues[0]?.message).toBeTruthy();
  });

  it('records the failing file by path, with its source and path on the loaded ones', async () => {
    const alpha = workflow('alpha.yaml', valid('alpha'));
    const { workflows } = await loadWorkflows(root);

    const loaded = workflows.find((w) => w.name === 'alpha');
    expect(loaded?.source).toBe('file');
    expect(loaded?.path).toBe(alpha);
  });

  it('reports a file whose YAML parses but breaks the step schema refinement', async () => {
    workflow('ok.yaml', valid('ok'));
    // Parses as YAML, and every key is individually well typed — it is the
    // agent-XOR-check refinement that refuses it.
    const both = workflow(
      'both.yaml',
      "name: both\nsteps:\n  - id: work\n    prompt: '{{task}}'\n    command: npm test\n",
    );

    const { workflows, issues } = await loadWorkflows(root);

    expect(workflows.map((w) => w.name)).toEqual(['ok', 'quick-task']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe(both);
    expect(issues[0]?.message).toContain('either an agent step');
  });

  it('reports a file whose onFail.retry points at a LATER step', async () => {
    workflow('ok.yaml', valid('ok'));
    // The schema accepts this file; `stepsIssue` is the second gate, and its
    // rejection must degrade the same way a schema rejection does.
    const backwards = workflow(
      'backwards.yaml',
      [
        'name: backwards',
        'steps:',
        '  - id: verify',
        '    command: npm test',
        '    onFail:',
        '      retry: implement',
        '      max: 2',
        '  - id: implement',
        "    prompt: '{{task}}'",
        '',
      ].join('\n'),
    );

    const { workflows, issues } = await loadWorkflows(root);

    expect(workflows.map((w) => w.name)).toEqual(['ok', 'quick-task']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe(backwards);
    expect(issues[0]?.message).toContain('must reference an earlier step');
  });

  it('reports an unreadable entry rather than failing the whole load', async () => {
    workflow('ok.yaml', valid('ok'));
    // A directory that happens to be named like a workflow file: `readFile`
    // throws EISDIR, which is the loader's outer catch, not its zod branch.
    mkdirSync(join(root, WORKFLOWS_DIR, 'nested.yaml'), { recursive: true });

    const { workflows, issues } = await loadWorkflows(root);

    expect(workflows.map((w) => w.name)).toEqual(['ok', 'quick-task']);
    expect(issues.map((i) => i.path)).toEqual([join(root, WORKFLOWS_DIR, 'nested.yaml')]);
  });

  // ---- discovery ------------------------------------------------------------------------

  it('loads cleanly when the workflows directory is absent', async () => {
    const { workflows, issues } = await loadWorkflows(root);
    expect(workflows.map((w) => w.name)).toEqual(['quick-task']);
    expect(issues).toEqual([]);
  });

  it('loads cleanly when the workflows directory exists but is empty', async () => {
    mkdirSync(join(root, WORKFLOWS_DIR), { recursive: true });
    const { workflows, issues } = await loadWorkflows(root);
    expect(workflows.map((w) => w.name)).toEqual(['quick-task']);
    expect(issues).toEqual([]);
  });

  it('reads only .yaml and .yml, case-insensitively, and ignores everything else', async () => {
    workflow('lower.yaml', valid('lower'));
    workflow('short.yml', valid('short'));
    workflow('shouty.YAML', valid('shouty'));
    // Neighbours users really do keep in that directory. They are not workflow
    // files, so they are neither loaded NOR reported as problems.
    workflow('README.md', '# how these workflows work\n');
    workflow('notes.txt', 'name: notes\n');
    workflow('draft.yaml.bak', valid('draft'));

    const { workflows, issues } = await loadWorkflows(root);

    expect(workflows.map((w) => w.name)).toEqual(['lower', 'quick-task', 'short', 'shouty']);
    expect(issues).toEqual([]);
  });

  it('keeps the description and expands the portable skills shorthand', async () => {
    workflow('portable.yaml', 'name: portable\ndescription: two skills\nskills:\n  - implement\n  - review\n');

    const { workflows, issues } = await loadWorkflows(root);
    const portable = workflows.find((w) => w.name === 'portable');

    expect(issues).toEqual([]);
    expect(portable?.description).toBe('two skills');
    expect(portable?.steps.map((s) => s.skill)).toEqual(['implement', 'review']);
  });

  it('sorts the catalog by name, built-in and file entries together', async () => {
    workflow('z.yaml', valid('zebra'));
    workflow('a.yaml', valid('apple'));
    // 'quick-task' sorts between them, so a list that merely appended the
    // built-in would come out in a different order than this.
    const { workflows } = await loadWorkflows(root);
    expect(workflows.map((w) => w.name)).toEqual(['apple', 'quick-task', 'zebra']);
  });

  // ---- the built-ins --------------------------------------------------------------------

  it('always offers the built-in quick-task, and brings it back when a user file is deleted', async () => {
    mkdirSync(join(root, WORKFLOWS_DIR), { recursive: true });
    const builtInOnly = await loadWorkflows(root);
    expect(builtInOnly.workflows.map((w) => w.name)).toEqual(['quick-task']);
    expect(builtInOnly.workflows[0]?.source).toBe('built-in');

    const override = workflow('quick-task.yaml', valid('quick-task'));
    const shadowed = await loadWorkflows(root);
    expect(shadowed.workflows.map((w) => w.name)).toEqual(['quick-task']);
    expect(shadowed.workflows[0]?.source).toBe('file');

    // AGENTS.md: "built-ins always come back after delete".
    rmSync(override);
    const restored = await loadWorkflows(root);
    expect(restored.workflows.map((w) => w.name)).toEqual(['quick-task']);
    expect(restored.workflows[0]?.source).toBe('built-in');
    expect(restored.workflows[0]?.path).toBeUndefined();
  });

  it('lets a user file of the same name win over the built-in while it exists', async () => {
    const override = workflow(
      'quick-task.yaml',
      "name: quick-task\ndescription: mine\nsteps:\n  - id: mine\n    prompt: '{{task}}'\n",
    );

    const { workflows } = await loadWorkflows(root);
    const quick = workflows.filter((w) => w.name === 'quick-task');

    // Exactly one entry: the built-in is filtered out, not listed twice.
    expect(quick).toHaveLength(1);
    expect(quick[0]?.source).toBe('file');
    expect(quick[0]?.path).toBe(override);
    expect(quick[0]?.description).toBe('mine');
    expect(quick[0]?.steps.map((s) => s.id)).toEqual(['mine']);
  });

  it('keeps the built-in when the user file of the same name is the BROKEN one', async () => {
    // A rejected file must not shadow the built-in it collides with: the
    // fallback has to stay reachable, or the user is left with no quick-task.
    const broken = workflow('quick-task.yaml', 'name: quick-task\nsteps: []\n');

    const { workflows, issues } = await loadWorkflows(root);

    expect(issues.map((i) => i.path)).toEqual([broken]);
    expect(workflows.map((w) => w.name)).toEqual(['quick-task']);
    expect(workflows[0]?.source).toBe('built-in');
  });
});
