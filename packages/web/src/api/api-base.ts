/**
 * Where the API lives, resolved before anything can fetch.
 *
 * Empty — same origin — is the bundled cockpit's case and the default: the service serves this
 * page and owns `/api/v1/*` under the same authority. The two overrides exist for the case this
 * whole split was for, a cockpit talking to a service somewhere else:
 *
 * - `VITE_XEZ_API_BASE` bakes it in at build time, for a bundle shipped separately.
 * - `<meta name="xez-api-base" content="…">` sets it at RUN time, so an operator can point a
 *   deployed bundle at a different service without rebuilding it. It wins, because the HTML is
 *   served per deployment while the bundle is baked once. A blank or whitespace-only meta tag
 *   counts as absent, so an empty template slot never overrides the build-time value.
 *
 * Both inputs are parameters so the precedence can be tested without a module reload; `main.tsx`
 * calls it with the defaults.
 */
export function resolveApiBase(
  doc: Document = document,
  buildTime: string | undefined = import.meta.env.VITE_XEZ_API_BASE,
): string {
  const meta = doc.querySelector('meta[name="xez-api-base"]')?.getAttribute('content')
  return meta?.trim() || buildTime || ''
}
