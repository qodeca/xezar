import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverProjectCheck, fixAndVerifyWorkflow, PROJECT_CONVENTIONS_SKILL } from './init-kit.ts';
import { loadWorkflows } from './workflows/load.ts';
import { workflowFileSchema } from './workflows/types.ts';

// #466: `xezar init` writes into any kind of project, so its verify step must be honest — a real
// check the project has, or a review step that says nothing was checked. Never an `echo` that
// exits 0 and makes every run look verified.
describe('init kit', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-init-kit-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const load = (yaml: string) => workflowFileSchema.parse(parse(yaml));

  /**
   * Write one generated example into a fresh project kit and load it the way the engine does, so
   * the assertion is about the file `xezar init` really writes and not about the string alone.
   */
  const loadFromProject = async (yaml: string) => {
    mkdirSync(join(root, '.xezar', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.xezar', 'workflows', 'fix-and-verify.yaml'), yaml);
    const { workflows, issues } = await loadWorkflows(root);
    return { issues, example: workflows.find((w) => w.name === 'fix-and-verify') };
  };

  it('finds no check in an empty folder, and writes a review step that reports missing verification', () => {
    expect(discoverProjectCheck(root)).toBeUndefined();
    const workflow = load(fixAndVerifyWorkflow(undefined));
    const verify = workflow.steps?.find((s) => s.id === 'verify');
    expect(verify?.command).toBeUndefined();
    expect(verify?.prompt).toContain('No verification command is configured');
    expect(verify?.prompt).toContain('not verifiable');
    expect(verify?.prompt).toContain('{{task}}');
    expect(fixAndVerifyWorkflow(undefined)).not.toMatch(/command:\s*"?echo/);
  });

  it('turns an npm test script into a real retrying check', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    const check = discoverProjectCheck(root);
    expect(check).toEqual({ command: 'npm test', source: 'package.json' });
    const verify = load(fixAndVerifyWorkflow(check)).steps?.find((s) => s.id === 'verify');
    expect(verify).toMatchObject({ command: 'npm test', onFail: { retry: 'implement', max: 2 } });
  });

  it("does not mistake npm's placeholder test script for a check", () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(discoverProjectCheck(root)).toBeUndefined();
  });

  it('finds a Makefile check target, but not an unrelated first target', () => {
    writeFileSync(join(root, 'Makefile'), 'all:\n\tcc main.c\ncheck:\n\t./run-checks\n');
    expect(discoverProjectCheck(root)).toEqual({ command: 'make check', source: 'Makefile' });
    writeFileSync(join(root, 'Makefile'), 'all:\n\tcc main.c\n');
    expect(discoverProjectCheck(root)).toBeUndefined();
  });

  it('keeps software commands as labeled examples next to agency and research ones', () => {
    for (const text of [fixAndVerifyWorkflow(undefined), PROJECT_CONVENTIONS_SKILL]) {
      expect(text).toMatch(/software/i);
      expect(text).toMatch(/advertising agency/i);
      expect(text).toMatch(/scientific research/i);
    }
    expect(PROJECT_CONVENTIONS_SKILL).toMatch(/^name: project-conventions$/m);
    expect(PROJECT_CONVENTIONS_SKILL).not.toMatch(/stack, style and testing|in this repo/);
  });

  // #819 item 9a. A run is interactive only when its last agent step is also its last step
  // (`workflows/run.ts`: `const interactive = i === lastAgentIdx && i === workflow.steps.length - 1`),
  // so a generated example that ends with the `verify` COMMAND step silences XEZ:ASK and XEZ:DONE
  // for the whole run. The break this fails against is `init-kit.ts` ending the with-check branch
  // at `verify`; the loader is the real one so the file itself is under test, not just the string.
  it('ends the with-check example with an agent step, so the run stays interactive', async () => {
    const { issues, example } = await loadFromProject(
      fixAndVerifyWorkflow({ command: 'npm test', source: 'package.json' }),
    );
    expect(issues).toEqual([]);
    expect(example).toBeDefined();
    const steps = example!.steps;
    const last = steps[steps.length - 1]!;
    expect(last.command, 'the example ends with a check step, so XEZ:ASK and XEZ:DONE are silenced').toBeUndefined();
    expect(last.prompt ?? last.skill).toBeTruthy();
  });

  // Guard, green with and without the fix: the retry loop the example exists to demonstrate is
  // kept, and its target is still an EARLIER step (the loader refuses a forward or missing one).
  it('keeps the verify -> implement retry loop pointing at an earlier step', async () => {
    const { issues, example } = await loadFromProject(
      fixAndVerifyWorkflow({ command: 'npm test', source: 'package.json' }),
    );
    expect(issues).toEqual([]);
    const steps = example!.steps;
    const verify = steps.find((s) => s.id === 'verify');
    expect(verify).toMatchObject({ command: 'npm test', onFail: { retry: 'implement', max: 2 } });
    expect(steps.findIndex((s) => s.id === 'implement')).toBeLessThan(steps.findIndex((s) => s.id === 'verify'));
  });

  // Guard, green with and without the fix: the branch with no discovered check already ended with
  // its review agent step, and this change must not disturb it.
  it('leaves the no-check example ending with its review agent step', async () => {
    const { issues, example } = await loadFromProject(fixAndVerifyWorkflow(undefined));
    expect(issues).toEqual([]);
    const steps = example!.steps;
    const last = steps[steps.length - 1]!;
    expect(last.command).toBeUndefined();
    expect(last.prompt).toContain('No verification command is configured');
  });
});
