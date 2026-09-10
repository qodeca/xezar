# @qodeca/xezar-api-client

The typed client for a [xezar](https://github.com/qodeca/xezar) service, and the shared
contract types behind it.

xezar is a local cockpit for running AI agent tasks in your repo. It runs as an HTTP service,
and this package is how anything else talks to it — the cockpit UI is just its first consumer.

## Status

**Not published yet.** The package is `private`: it is consumed inside the xezar
workspace (the cockpit bundles it, the service's tests import it) and will be
released once its surface settles. Every shape it hands out is now inferred from a
zod schema in `@qodeca/xezar-contract`: the hand-written `dto/*` mirror this barrel
used to carry is gone, and so is the last hand-written response interface in the
service's own `server.ts`.

## Use

```ts
import { createXezarClient } from '@qodeca/xezar-api-client'
import type { AppType } from '@qodeca/xezar/app-type'

const xez = createXezarClient<AppType>({ baseUrl: 'http://127.0.0.1:4321' })

const res = await xez.api.v1['agent-config'].$get()
const files = await res.json() // shape inferred from the server's own handler
```

The type argument is what makes the client typed: it is the service's own app type, so paths,
request bodies and response shapes are checked at compile time against the routes that actually
exist. It is supplied by you rather than imported here, so this package installs and runs
without the service package present — `createXezarClient()` with no type argument is a working,
untyped client.

There is one surface and it is versioned: everything answers under `/api/v1`, and the
unversioned `/api/*` spelling was removed rather than frozen.

## Also exported

- **Protocol types** (`UiEvent`, `UiItem`, `ToolDisplay`, …) — the agent event vocabulary the
  service streams over SSE, plus the pure `toolDisplay()` renderer for it.
- **Scope helpers** (`apiPath`, `apiBase`, `queryScope`, `resolveApiUrl`, `API_PREFIX`, and the
  `apiScope` / `apiBaseUrl` getters and setters) — the `/api/v1` ↔ `/api/v1/p/:projectId`
  project-scope prefixing.
- **The whole contract**, re-exported (`export * from '@qodeca/xezar-contract'`), so a consumer
  needs one import for both the schema it validates with and the type it compiles against.

Everything here is Node-free: it bundles into a browser as readily as it imports into a Node
process.

## License

MIT
