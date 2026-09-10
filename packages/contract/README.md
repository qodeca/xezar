# `packages/contract` — the API contract, as zod

Every request and response shape the HTTP API speaks, defined ONCE as a zod schema with its
TypeScript type inferred from it (`z.infer`), never written by hand.

Three consumers, one definition:

- **the server** (`packages/xezar/src/server/server.ts`) validates requests with these schemas and
  types each handler's payload by the matching response schema, so the schema is the source of the
  route type rather than a second opinion about it. Four `/projects` routes still carry a
  hand-written response interface in `server.ts`; those are not exempt —
  `contract-parity.workspace.test.ts` asserts each against its schema in both directions;
- **`@qodeca/xezar-api-client`** depends on this package and re-exports it wholesale
  (`export * from '@qodeca/xezar-contract'` in `packages/api-client/src/index.ts`), so a
  consumer gets the schemas and the inferred types from one import;
- **the cockpit** imports both from the api-client — the types to compile against, the schemas
  when it wants to validate before sending.

## Rules

1. **Node-free.** No `node:*`, no `fs`, no `process`. These files are compiled into the api-client,
   which is bundled into a browser. This package's own tsconfig sets `lib: ["ES2022"]` and
   `types: []`, and the api-client that bundles it does the same — so a Node import fails to
   compile here first and downstream second. The invariant is enforced, not documented.
2. **No imports outside this directory** except `zod`. A copied file has to compile in a package
   that has none of the server's module graph.
3. **Exactly what the server sends.** A response schema that is wider than the handler is a
   defect, not a convenience: the per-route guards in
   `packages/xezar/src/server/contract-parity*.test.ts` – six files, split by route family – assert
   `z.infer<schema>` and the route's own inferred type are MUTUALLY assignable, so a schema that
   drifts either way fails to compile.
