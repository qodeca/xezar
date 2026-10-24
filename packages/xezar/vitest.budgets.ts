import serverConfig from './vitest.config.ts'

// The time budgets every vitest run over the server suite uses, read from `vitest.config.ts`, which
// owns them and explains each one. The mutation configs (`vitest.mutation.config.ts`,
// `vitest.mutation.lock.config.ts`) cannot extend that config – `mergeConfig` would concatenate
// `include` instead of narrowing it – so they spread these instead. Before they did, the Stryker dry
// run ran the same MCP and lock tests on vitest's bare 5 s test and 1 s poll defaults, the budgets
// `vitest.config.ts` raised because they produced meaningless timeouts under load.
//
// Only keys `vitest.config.ts` actually sets are copied: an explicit `undefined` would replace
// vitest's own default (for example `hookTimeout` off Windows) instead of leaving it alone.
const test = serverConfig.test ?? {}

export const SERVER_TEST_BUDGETS = {
  ...(test.testTimeout !== undefined ? { testTimeout: test.testTimeout } : {}),
  ...(test.hookTimeout !== undefined ? { hookTimeout: test.hookTimeout } : {}),
  ...(test.expect?.poll !== undefined ? { expect: { poll: { ...test.expect.poll } } } : {}),
}
