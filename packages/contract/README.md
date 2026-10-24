# `packages/contract` — the API contract, as zod

Every request and response shape the HTTP API speaks, defined ONCE as a zod schema with its
TypeScript type inferred from it (`z.infer`), never written by hand.

Three consumers, one definition:

- **the server** (`packages/xezar/src/server/server.ts`) validates requests with these schemas and
  types each handler's payload by the matching response schema, so the schema is the source of the
  route type rather than a second opinion about it. No response interface is hand-written there
  any more: the four `/projects` responses that were are the contract's inferred types now,
  re-exported by `server.ts`;
- **`@qodeca/xezar-api-client`** depends on this package and re-exports it wholesale
  (`export * from '@qodeca/xezar-contract'` in `packages/api-client/src/index.ts`), so a
  consumer gets the schemas and the inferred types from one import;
- **the cockpit** imports both from the api-client — the types to compile against, the schemas
  when it wants to validate before sending.

## Rules

1. **Node-free.** No `node:*`, no `fs`, no `process`. These files are compiled into the api-client,
   which is bundled into a browser. This package's own tsconfig sets `lib: ["ES2022"]` and
   `types: []`, and the api-client that bundles it also sets `types: []` — so a Node import fails to
   compile here first and downstream second. The invariant is enforced, not documented.
2. **No imports outside this directory** except `zod`. A copied file has to compile in a package
   that has none of the server's module graph.
3. **Exactly what the server sends.** A response schema that is wider than the handler is a
   defect, not a convenience: the per-route guards in
   `packages/xezar/src/server/contract-parity*.test.ts` – eight files, split by route family – assert
   `z.infer<schema>` and the route's own inferred type are MUTUALLY assignable, so a schema that
   drifts either way fails to compile.

## The one exception: the agent-event protocol

`ui-events.ts` (the v2 `UiEvent` vocabulary) and `tool-display.ts` (its pure `toolDisplay()`
display model) are plain TypeScript, not zod. They are SSE frame payloads that no route validates,
and the wire they describe is frozen. The owner approved keeping them here as hand-written types so
they exist once – the runners import them from this package and the cockpit gets them through the
api-client re-export – instead of as a server original plus a hand-kept api-client mirror. Rules 1
and 2 still apply to both files. Do not add another hand-written shape on the strength of this one.
