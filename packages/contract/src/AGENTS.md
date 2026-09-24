# Guidance for `packages/contract/src/`

These rules are the full task-routing guidance moved from the repository root. Root `AGENTS.md` retains the routing index and canonical cross-repository rules.

## API request/response shapes (any new field, route or payload)

**One zod definition per shape, type inferred — never a hand-written interface.** Add the schema here FIRST, then chain the route and validate through the trio; `contract-parity*.test.ts` proves the schema and the route agree in both directions, and `typed-bodies.test.ts` proves the route reached `AppType` at all. See the HTTP API section above for why a loose `app.get(…)` disappears.
