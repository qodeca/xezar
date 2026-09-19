import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { workflowFileSchema } from './types.ts';

describe('T-15 — bundled workflow check significance', () => {
  it('classifies every bundled check explicitly by its actual role', () => {
    const dir = join(process.cwd(), '.xezar', 'workflows');
    const checks = readdirSync(dir)
      .filter((name) => name.endsWith('.yaml'))
      .flatMap((name) => {
        const workflow = workflowFileSchema.parse(parseYaml(readFileSync(join(dir, name), 'utf8')));
        return (workflow.steps ?? [])
          .filter((step) => step.command !== undefined)
          .map((step) => ({ file: name, id: step.id, resultScope: step.resultScope }));
      });

    expect(checks.length).toBeGreaterThan(0);
    expect(checks.filter((step) => step.resultScope === undefined)).toEqual([]);
    for (const check of checks) {
      if (['kit', 'preflight', 'setup'].includes(check.id)) expect(check.resultScope, `${check.file}:${check.id}`).toBe('routine');
      // `ci-watch` (#667) is the integration workflow's bounded, token-free observation of merge CI on the
      // base branch. Its pass is the answer to "did what we just merged stay green", which is exactly the
      // kind of conclusion the leader is waiting for — `stage`, not `routine`.
      else if (['readiness', 'gates', 'evidence', 'ci-watch'].includes(check.id)) expect(check.resultScope, `${check.file}:${check.id}`).toBe('stage');
      else throw new Error(`bundled check ${check.file}:${check.id} needs an explicit significance decision`);
    }
  });
});
