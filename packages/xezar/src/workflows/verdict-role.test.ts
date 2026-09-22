import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { workflowStepDefSchema } from '@qodeca/xezar-contract';

import { skillStackOf, workflowFileSchema, workflowStepSchema } from './types.ts';

/**
 * #851 C — `verdictRole` is the step's declaration of the reviewer role it reports as, and the
 * only thing the engine will record a packet against.
 *
 * Named break: drop the key from either step schema (the persisted `workflowDef` then strips it and
 * every kit verdict is refused), let the compact `skills:` form swallow it, or remove it from a kit
 * verdict workflow.
 */
describe('#851 — the verdictRole step key', () => {
  const schemas = [
    { name: 'the service step schema', schema: workflowStepSchema },
    { name: 'the contract step schema', schema: workflowStepDefSchema },
  ] as const;

  it.each(schemas)('$name keeps a declared role on an agent step', ({ schema }) => {
    const parsed = schema.parse({ id: 'review', prompt: '{{task}}', verdictRole: 'architecture-review' });

    expect(parsed.verdictRole).toBe('architecture-review');
  });

  it.each(schemas)('$name refuses a role that is not on the list', ({ schema }) => {
    expect(schema.safeParse({ id: 'review', prompt: '{{task}}', verdictRole: 'security-review' }).success).toBe(false);
  });

  it.each(schemas)('$name refuses a role on a check step, which never has a packet collected', ({ schema }) => {
    const parsed = schema.safeParse({ id: 'gates', command: 'npm test', verdictRole: 'qa' });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
      'verdictRole applies to an agent step; a check step (command) reports no verdict',
    );
  });

  it('keeps a reviewer step out of the compact skills form, which cannot carry the role', () => {
    expect(skillStackOf([{ id: 'x', name: 'x', skill: 'x', prompt: '{{task}}' }])).toEqual(['x']);
    expect(skillStackOf([{ id: 'x', name: 'x', skill: 'x', prompt: '{{task}}', verdictRole: 'qa' }])).toBeNull();
  });

  it.each([
    ['code-review.yaml', 'code-review'],
    ['design-review.yaml', 'design-review'],
    ['qa.yaml', 'qa'],
  ] as const)('the kit verdict workflow %s declares %s on its verdict step', (file, role) => {
    const workflow = workflowFileSchema.parse(
      parseYaml(readFileSync(join(process.cwd(), '.xezar', 'workflows', file), 'utf8')),
    );
    const declared = (workflow.steps ?? []).filter((step) => step.verdictRole !== undefined);

    expect(declared.map((step) => [step.id, step.verdictRole])).toEqual([['review', role]]);
  });
});
