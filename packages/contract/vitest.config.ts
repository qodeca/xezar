import '../../scripts/test-local-state.mjs'
import { defineConfig } from 'vitest/config'

// Node environment, exactly as the api-client next door: this package must stay Node-free AND
// DOM-free (`types: []`, `lib: ["ES2022"]` in its tsconfig), so a jsdom here would hide an
// accidental browser-only dependency in the one package both halves of xezar import.
//
// The package is imported by every other suite, which is what made it look covered while owning
// no test of its own (#61) — a `packages/contract/src/*.test.ts` file simply never ran. This
// config, plus its entry in the root `projects` array, is what makes such a file execute.
export default defineConfig({
  test: {
    name: 'contract',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
