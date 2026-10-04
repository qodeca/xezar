# Guidance for `packages/contract/src/`

Cross-repository rules and the task-routing index are in the root `AGENTS.md`.

## API request/response shapes (any new field, route or payload)

**One zod definition per shape, type inferred — never a hand-written interface.** Add the schema here FIRST, then chain the route and validate through the trio; `contract-parity*.test.ts` proves the schema and the route agree in both directions, and `typed-bodies.test.ts` proves the route reached `AppType` at all. See root `AGENTS.md` § The HTTP API for why a loose `app.get(…)` disappears.
