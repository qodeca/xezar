import { describe, expect, it } from 'vitest';

import serverConfig from '../vitest.config.ts';
import mutationConfig from '../vitest.mutation.config.ts';
import lockMutationConfig from '../vitest.mutation.lock.config.ts';

// The mutation runs execute the same tests as `npm test`, under Stryker's extra load, so they need
// at least the same time budgets. Their configs are separate files (see vitest.budgets.ts), and
// their budgets once drifted to vitest's bare defaults: 5 s per test and 1 s per `expect.poll`.
describe('the mutation configs use the server suite time budgets', () => {
  const budgets = (config: typeof serverConfig) => ({
    testTimeout: config.test?.testTimeout,
    hookTimeout: config.test?.hookTimeout,
    poll: config.test?.expect?.poll,
  });

  it.each([
    ['vitest.mutation.config.ts', mutationConfig],
    ['vitest.mutation.lock.config.ts', lockMutationConfig],
  ])('%s', (_name, config) => {
    expect(budgets(config)).toEqual(budgets(serverConfig));
    expect(config.test?.testTimeout).toBeGreaterThan(5_000);
    expect(config.test?.expect?.poll?.timeout).toBeGreaterThan(1_000);
  });
});
