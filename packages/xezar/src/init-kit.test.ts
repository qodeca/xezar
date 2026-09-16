import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverProjectCheck, fixAndVerifyWorkflow, PROJECT_CONVENTIONS_SKILL } from './init-kit.ts';
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
});
