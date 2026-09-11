import { TriangleAlertIcon } from 'lucide-react'
import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'

import type {
  McpApiReference,
  McpRefusedAction,
  McpRefusedArgument,
  McpToolAnnotations,
  McpToolListing,
} from '@qodeca/xezar-api-client'
import { useMcpApiReference } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Link } from '@/lib/project-router'

/**
 * Project settings → MCP API (#284): the browsable, READ-ONLY reference of what the MCP server
 * exposes. It implements spec `docs/features/mcp-api-reference/mcp-api-reference-spec.md` § 12 and
 * Part 6 (§ 18) for everything the running code can state; see the pull request for what waits on
 * a shipped coverage declaration.
 *
 * Every tool, action, argument and refusal comes from `GET /api/v1/mcp/reference`, whose `tools`
 * field is exactly what `tools/list` answers. Nothing here names a tool (CV-02).
 *
 * THE HARD BOUNDARY: this page has no control that runs, simulates or prepares a tool call — no
 * "Try it", no "Send", no request builder, no copy-as-command, and no disabled stand-in for any of
 * them (CV-06, § 18.6). Running a tool from the cockpit would make it a second leader on the
 * project, bypass single ownership and session binding, and forge the server-derived audit
 * origin (spec § 13). If a safe way to execute seems to exist, it does not: report it instead.
 */

type Available = Extract<McpApiReference, { available: true }>

const MCP_CONNECTION_PATH = '/settings/mcp-connection'
const ENUM_PREVIEW = 10
const DISCRIMINATORS = ['action', 'view', 'read'] as const
const FOCUS_RING = 'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

export function McpApiSection() {
  const reference = useMcpApiReference()

  if (reference.isPending) {
    return (
      <p data-slot="mcp-api-loading" role="status" aria-live="polite" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading the tool list…
      </p>
    )
  }
  if (reference.isError) {
    return (
      <CenteredState
        icon={<TriangleAlertIcon />}
        tone="danger"
        heading="h2"
        title="Could not load the MCP API reference"
        subtitle={reference.error.message}
      />
    )
  }
  if (!reference.data.available) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4 md:p-6">
        <p data-slot="mcp-api-unavailable" role="status" className="rounded-md border border-border bg-card p-3 text-[13px] leading-relaxed text-foreground">
          <span className="font-medium">The MCP API reference is not available.</span> {reference.data.reason}{' '}
          The rest of the cockpit keeps working; <McpConnectionLink>MCP connection</McpConnectionLink> still shows the
          connection and client setup.
        </p>
      </div>
    )
  }
  return <McpApiReferenceView reference={reference.data} />
}

function McpConnectionLink({ children }: { children: ReactNode }) {
  return (
    <Link to={MCP_CONNECTION_PATH} className={`rounded-sm font-medium underline underline-offset-2 ${FOCUS_RING}`}>
      {children}
    </Link>
  )
}

// ---- reading the listing -----------------------------------------------------------------------

type Json = Record<string, unknown>
type Effect = 'read-only' | 'changes'

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The discriminator argument (`action`, `view` or `read`) and its values, or null for a tool with none. */
function discriminatorOf(tool: McpToolListing): { name: string; values: string[] } | null {
  const properties = isObject(tool.inputSchema.properties) ? tool.inputSchema.properties : {}
  for (const name of DISCRIMINATORS) {
    const schema = properties[name]
    if (isObject(schema) && Array.isArray(schema.enum)) {
      return { name, values: schema.enum.filter((v): v is string => typeof v === 'string') }
    }
  }
  return null
}

/** Which filter a tool falls under. A tool that does not state `readOnlyHint` is treated the way a
 *  client treats it — as one that may change state (the protocol default, spec § 18.3). */
const effectOf = (a: McpToolAnnotations | undefined): Effect => (a?.readOnlyHint === true ? 'read-only' : 'changes')

/** The effect as words, spec § 18.3. Always words; colour only reinforces them. */
function EffectLabel({ annotations }: { annotations: McpToolAnnotations | undefined }) {
  const a = annotations ?? {}
  if (a.readOnlyHint === true) {
    return <span data-slot="mcp-api-effect" className="font-medium text-foreground">Read-only</span>
  }
  const base =
    a.readOnlyHint === false ? (
      <span className="font-medium text-foreground">Changes project state</span>
    ) : (
      <span className="font-medium text-foreground">
        Read-only: not stated <span className="font-normal text-muted-foreground">– clients assume it may change state</span>
      </span>
    )
  // An omitted destructive hint on a tool that may change state is read as destructive (S7).
  const destructive =
    a.destructiveHint === false ? null : (
      <span className="font-medium text-warning">
        {a.destructiveHint === true ? 'Destructive' : 'Destructive: not stated'}{' '}
        <span className="font-normal text-muted-foreground">
          {a.destructiveHint === true ? '– may delete or overwrite' : '– clients assume it may delete or overwrite'}
        </span>
      </span>
    )
  return (
    <span data-slot="mcp-api-effect" className="flex flex-wrap gap-x-1.5">
      {base}
      {destructive ? (
        <>
          <span aria-hidden="true" className="text-soft-foreground">·</span>
          {destructive}
        </>
      ) : null}
    </span>
  )
}

/** One hint as words: its stated value, or what a client assumes when it is not stated (S7). */
function hintWords(a: McpToolAnnotations | undefined, key: keyof McpToolAnnotations): string {
  const value = a?.[key]
  const readOnly = a?.readOnlyHint === true
  if ((key === 'destructiveHint' || key === 'idempotentHint') && readOnly) return 'not applicable (read-only)'
  if (value === true) return 'yes'
  if (value === false) return 'no'
  const assumed = key === 'destructiveHint' || key === 'openWorldHint' ? 'yes' : 'no'
  return `not stated – clients assume ${assumed}`
}

/** How a tool takes one of the two MCP-only guards: required, accepted, or not at all. */
function guardWords(tool: McpToolListing, name: string): string {
  const properties = isObject(tool.inputSchema.properties) ? tool.inputSchema.properties : {}
  if (!(name in properties)) return 'not taken'
  const required = Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.includes(name)
  return required ? 'required' : 'accepted, not required'
}

// ---- arguments, spec § 18.4 --------------------------------------------------------------------

class UnsupportedSchema extends Error {}
const UNSUPPORTED_KEYWORDS = ['$ref', 'oneOf', 'allOf', 'not', 'if', 'patternProperties'] as const

interface ArgumentRow {
  path: string
  required: boolean
  type: string
  values: string[] | null
  description: string | null
}

/** A JSON Schema type in words ("text", "whole number", "list of text", "object – 5 fields"). */
function typeWords(schema: unknown): string {
  if (!isObject(schema)) throw new UnsupportedSchema('a schema that is not an object')
  for (const keyword of UNSUPPORTED_KEYWORDS) if (keyword in schema) throw new UnsupportedSchema(keyword)
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map(typeWords).join(' or ')
  if ('const' in schema) return `exactly ${JSON.stringify(schema.const)}`
  if (Array.isArray(schema.enum)) return 'one of the values below'
  const type = schema.type
  if (Array.isArray(type)) return type.map((t) => typeWords({ ...schema, type: t })).join(' or ')
  switch (type) {
    case 'string':
      return 'text'
    case 'integer':
      return 'whole number'
    case 'number':
      return 'number'
    case 'boolean':
      return 'yes/no'
    case 'null':
      return 'nothing (null)'
    case 'array':
      return schema.items === undefined ? 'list' : `list of ${typeWords(schema.items)}`
    case 'object': {
      if (isObject(schema.properties)) return `object – ${plural(Object.keys(schema.properties).length, 'field')}`
      if (isObject(schema.additionalProperties)) return `map of text to ${typeWords(schema.additionalProperties)}`
      return 'object'
    }
    case undefined:
      return Object.keys(schema).every((k) => k === 'description' || k === 'default') ? 'any value' : unsupported(schema)
    default:
      return unsupported(schema)
  }
}

function unsupported(schema: Json): never {
  throw new UnsupportedSchema(`type ${JSON.stringify(schema.type)}`)
}

/** The object schemas nested directly in `schema` — its own fields, a list's items, a union's objects. */
function nestedObjects(schema: Json, path: string): { schema: Json; prefix: string }[] {
  if (isObject(schema.properties)) return [{ schema, prefix: `${path}.` }]
  if (schema.type === 'array' && isObject(schema.items)) return nestedObjects(schema.items, `${path}[]`)
  if (Array.isArray(schema.anyOf)) return schema.anyOf.filter(isObject).flatMap((s) => nestedObjects(s, path))
  return []
}

function rowFor(path: string, schema: unknown, required: boolean): ArgumentRow {
  const values = isObject(schema) && Array.isArray(schema.enum) ? schema.enum.map((v) => String(v)) : null
  const description = isObject(schema) && typeof schema.description === 'string' ? schema.description : null
  return { path, required, type: typeWords(schema), values, description }
}

/** Every field below a top-level argument, path-prefixed at any depth (§ 18.4 item 5). */
function nestedRows(schema: unknown, path: string): ArgumentRow[] {
  if (!isObject(schema)) return []
  return nestedObjects(schema, path).flatMap(({ schema: object, prefix }) => {
    const properties = object.properties as Json
    const required = Array.isArray(object.required) ? object.required : []
    return Object.entries(properties).flatMap(([name, child]) => [
      rowFor(`${prefix}${name}`, child, required.includes(name)),
      ...nestedRows(child, `${prefix}${name}`),
    ])
  })
}

function ArgumentsView({
  tool,
  discriminator,
  refusedArguments,
}: {
  tool: McpToolListing
  discriminator: { name: string; values: string[] } | null
  refusedArguments: McpRefusedArgument[]
}) {
  const schema = tool.inputSchema
  if (schema.type !== 'object') throw new UnsupportedSchema('a top level that is not an object')
  for (const keyword of UNSUPPORTED_KEYWORDS) if (keyword in schema) throw new UnsupportedSchema(keyword)
  const properties = isObject(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required : []
  const refused = new Set(refusedArguments.map((r) => r.argument))
  const names = Object.keys(properties).filter((name) => !refused.has(name))
  if (names.length === 0 && refused.size === 0) {
    return <p data-slot="mcp-api-no-arguments" className="text-[13px] text-muted-foreground">Takes no arguments.</p>
  }
  // Required first, then optional, each in schema order (§ 18.4 item 2).
  const ordered = [...names.filter((n) => required.includes(n)), ...names.filter((n) => !required.includes(n))]
  const rows = ordered.map((name) => ({
    row: rowFor(name, properties[name], required.includes(name)),
    nested: nestedRows(properties[name], name),
  }))
  return (
    <ul aria-label={`Arguments of ${tool.name}`} className="flex flex-col gap-2">
      {rows.map(({ row, nested }) => (
        <li key={row.path} data-slot="mcp-api-argument" className="rounded-md border border-border bg-card p-2.5">
          <ArgumentDetail row={row} discriminator={discriminator?.name === row.path ? discriminator : null} />
          {nested.length ? (
            <details className="mt-2">
              <summary className={`cursor-pointer rounded-sm text-[12px] font-medium text-foreground ${FOCUS_RING}`}>
                Its {plural(nested.length, 'nested field')}
              </summary>
              <ul className="mt-2 flex flex-col gap-2 border-l border-border pl-3">
                {nested.map((child) => (
                  <li key={child.path} data-slot="mcp-api-nested-argument">
                    <ArgumentDetail row={child} discriminator={null} />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </li>
      ))}
      {refusedArguments.map((r) => (
        <li key={r.argument} data-slot="mcp-api-refused-argument" className="rounded-md border border-border bg-muted p-2.5 text-[13px]">
          <span className="font-mono break-all text-foreground">{r.argument}</span>{' '}
          <span className="font-medium text-foreground">Refused – never accepted.</span>{' '}
          <span className="text-muted-foreground">{r.reason}</span>
        </li>
      ))}
    </ul>
  )
}

function ArgumentDetail({ row, discriminator }: { row: ArgumentRow; discriminator: { values: string[] } | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 text-[13px]">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono font-medium break-all text-foreground">{row.path}</span>
        <span className="text-[12px] font-medium text-foreground">{row.required ? 'Required' : 'Optional'}</span>
        <span className="text-[12px] text-muted-foreground">{discriminator ? 'text' : row.type}</span>
      </div>
      {row.description !== null ? (
        <p data-slot="mcp-api-description" className="leading-relaxed whitespace-pre-line text-muted-foreground">
          {row.description}
        </p>
      ) : null}
      {discriminator ? (
        <p className="text-muted-foreground">One of the {plural(discriminator.values.length, 'action')} above.</p>
      ) : row.values ? (
        <EnumValues values={row.values} />
      ) : null}
    </div>
  )
}

function EnumValues({ values }: { values: string[] }) {
  const [all, setAll] = useState(false)
  const shown = all ? values : values.slice(0, ENUM_PREVIEW)
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((v) => (
        <code key={v} className="rounded bg-muted px-1 font-mono text-[12px] break-all text-foreground">
          {v}
        </code>
      ))}
      {values.length > ENUM_PREVIEW ? (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll(!all)}
          className={`rounded-sm text-[12px] font-medium text-foreground underline underline-offset-2 ${FOCUS_RING}`}
        >
          {all ? `Show the first ${ENUM_PREVIEW}` : `Show all ${values.length} values`}
        </button>
      ) : null}
    </div>
  )
}

/** One tool's failure never blanks another tool or the page (§ 18.7). */
class ToolErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function RawSchema({ tool, open = false }: { tool: McpToolListing; open?: boolean }) {
  return (
    <details open={open} data-slot="mcp-api-raw-schema">
      <summary className={`cursor-pointer rounded-sm text-[12px] font-medium text-foreground ${FOCUS_RING}`}>JSON Schema</summary>
      <div className="mt-2 max-w-full overflow-x-auto rounded-md border border-border bg-muted">
        <pre className="p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-foreground">
          {JSON.stringify(tool.inputSchema, null, 2)}
        </pre>
      </div>
    </details>
  )
}

// ---- one tool ----------------------------------------------------------------------------------

function ToolEntry({
  tool,
  refusedActions,
  refusedArguments,
}: {
  tool: McpToolListing
  refusedActions: McpRefusedAction[]
  refusedArguments: McpRefusedArgument[]
}) {
  const discriminator = discriminatorOf(tool)
  const refused = new Map(refusedActions.map((r) => [r.action, r]))
  const total = discriminator ? discriminator.values.length : 1
  const performing = total - refused.size
  const a = tool.annotations
  const actionWord = effectOf(a) === 'read-only' ? 'Reads' : 'Reads or changes'
  const unsupportedFallback = (
    <div data-slot="mcp-api-unsupported" className="flex flex-col gap-2">
      <p className="text-[13px] text-foreground">
        This schema uses a form the page does not lay out as a table. The exact schema is below.
      </p>
      <RawSchema tool={tool} open />
    </div>
  )

  return (
    <details id={`tool-${tool.name}`} data-slot="mcp-api-tool" className="group rounded-md border border-border bg-card">
      <summary className={`cursor-pointer list-none rounded-md p-3 ${FOCUS_RING}`}>
        <h3 className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
          <span aria-hidden="true" className="text-soft-foreground group-open:rotate-90">›</span>
          <span className="font-mono font-semibold break-all text-foreground">{tool.name}</span>
          {tool.title ? <span className="font-normal text-muted-foreground">{tool.title}</span> : null}
        </h3>
        <span className="mt-1 flex flex-col gap-0.5 text-[12px] sm:flex-row sm:flex-wrap sm:gap-x-3">
          <EffectLabel annotations={a} />
          <span data-slot="mcp-api-counts" className="text-muted-foreground">
            {plural(performing, 'action')}
            {refused.size ? ` · ${refused.size} refused` : ''}
          </span>
        </span>
      </summary>

      <div className="flex min-w-0 flex-col gap-4 border-t border-border p-3">
        <p data-slot="mcp-api-purpose" className="text-[13px] leading-relaxed whitespace-pre-line text-foreground">
          {tool.description}
        </p>

        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-2">
          {(
            [
              ['Read-only', 'readOnlyHint'],
              ['Destructive', 'destructiveHint'],
              ['Idempotent', 'idempotentHint'],
              ['Open world', 'openWorldHint'],
            ] as const
          ).map(([label, key]) => (
            <div key={key} className="flex gap-1.5">
              <dt className="font-medium text-foreground">{label}:</dt>
              <dd className="text-muted-foreground">{hintWords(a, key)}</dd>
            </div>
          ))}
          <div className="flex gap-1.5">
            <dt className="font-mono font-medium text-foreground">expectedVersion:</dt>
            <dd data-slot="mcp-api-expected-version" className="text-muted-foreground">{guardWords(tool, 'expectedVersion')}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="font-mono font-medium text-foreground">operationId:</dt>
            <dd data-slot="mcp-api-operation-id" className="text-muted-foreground">{guardWords(tool, 'operationId')}</dd>
          </div>
        </dl>

        {discriminator ? (
          <section className="flex flex-col gap-2">
            <h4 className="text-[13px] font-semibold text-foreground">
              Actions <span className="font-normal text-muted-foreground">(the <code className="font-mono">{discriminator.name}</code> argument)</span>
            </h4>
            <ul aria-label={`Actions of ${tool.name}`} className="flex flex-col gap-1 text-[13px]">
              {discriminator.values.map((value) => {
                const refusal = refused.get(value)
                return (
                  <li key={value} data-slot="mcp-api-action" className="flex min-w-0 flex-wrap gap-x-2">
                    <code className="font-mono break-all text-foreground">{value}</code>
                    {refusal ? (
                      <span className="text-foreground">
                        <span className="font-medium">Refused – {refusal.boundary}.</span>{' '}
                        <span className="text-muted-foreground">{refusal.reason}</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{actionWord}</span>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}

        <section className="flex flex-col gap-2">
          <h4 className="text-[13px] font-semibold text-foreground">Arguments</h4>
          <ToolErrorBoundary fallback={unsupportedFallback}>
            <ArgumentsView tool={tool} discriminator={discriminator} refusedArguments={refusedArguments} />
          </ToolErrorBoundary>
        </section>

        <p data-slot="mcp-api-cockpit-door" className="text-[12px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Do this in the cockpit:</span> every project action this tool
          performs has its own control in the cockpit, where it is recorded as done by a person (<code className="font-mono">ui</code>).
        </p>

        <RawSchema tool={tool} />
      </div>
    </details>
  )
}

// ---- the page ----------------------------------------------------------------------------------

type Filter = 'all' | Effect
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'changes', label: 'Changes project state' },
  { value: 'read-only', label: 'Read-only' },
]

export function McpApiReferenceView({ reference }: { reference: Available }) {
  const [filter, setFilter] = useState<Filter>('all')
  const listRef = useRef<HTMLUListElement>(null)
  const { hash } = useLocation()
  const tools = reference.tools
  const shown = filter === 'all' ? tools : tools.filter((t) => effectOf(t.annotations) === filter)

  // `#tool-<name>` opens that tool and moves focus to its heading row (spec § 12.3).
  useEffect(() => {
    if (!hash.startsWith('#tool-')) return
    setFilter('all')
    const id = decodeURIComponent(hash.slice(1))
    const frame = requestAnimationFrame(() => {
      const details = document.getElementById(id)
      if (!(details instanceof HTMLDetailsElement)) return
      details.open = true
      details.querySelector('summary')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [hash])

  const setAllOpen = (open: boolean) => {
    listRef.current?.querySelectorAll<HTMLDetailsElement>('details[data-slot="mcp-api-tool"]').forEach((d) => {
      d.open = open
    })
  }

  const actionTotals = tools.reduce((sum, t) => sum + (discriminatorOf(t)?.values.length ?? 1), 0)
  const refusedTotal = reference.refusedActions.length
  const changing = tools.filter((t) => effectOf(t.annotations) === 'changes')
  const destructive = changing.filter((t) => t.annotations?.destructiveHint === true).length
  const unstated = changing.filter((t) => t.annotations?.readOnlyHint === undefined).length
  const readOnly = tools.length - changing.length
  const onlyHealth = tools.every((t) => t.name === 'health')
  const capabilityNames = Object.keys(reference.capabilities)

  return (
    <div
      data-slot="mcp-api-section"
      className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      {/* Header (§ 12.2 item 1, § 18.6): what this is, and why nothing here runs a tool. */}
      <header data-slot="mcp-api-header" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-foreground">xezar MCP server</h2>
        <p className="text-[13px] text-muted-foreground">
          Version <span className="font-mono">{reference.xezarVersion}</span> · MCP protocol revisions{' '}
          {reference.protocolVersions.map((v, i) => (
            <span key={v}>
              {i ? ', ' : ''}
              <span className="font-mono">{v}</span>
            </span>
          ))}
        </p>
        <p data-slot="mcp-api-exposes" className="text-[13px] leading-relaxed text-foreground">
          It exposes <span className="font-medium">{capabilityNames.join(', ')}</span> only. It does not expose:{' '}
          {reference.notExposed.map((n) => n.what.toLowerCase()).join(', ')}.
        </p>
        <div data-slot="mcp-api-read-only" className="rounded-md border border-border bg-muted p-3 text-[13px] leading-relaxed text-foreground">
          <p>
            <span className="font-semibold">Read-only by design:</span> running a tool from here would make the cockpit
            a second leader on this project, and a project has exactly one. This page is a reference, not a console –
            no tool call is ever sent from it.
          </p>
          <details className="mt-2">
            <summary className={`cursor-pointer rounded-sm font-medium ${FOCUS_RING}`}>Why?</summary>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
              <li>One owner: exactly one MCP client may own a project; a call from here would take over the leader or act beside it as a second owner.</li>
              <li>Session binding: a session is bound to one project and fenced by its owner; the cockpit is not that session.</li>
              <li>Honest records: the audit trail records which door a call came through, so a call from here would be recorded as the leader’s act when a person did it.</li>
            </ul>
          </details>
        </div>
        <p className="text-[12px] text-muted-foreground">
          Connection and client setup live in <McpConnectionLink>MCP connection</McpConnectionLink>.
        </p>
      </header>

      {/* Summary (§ 18.2): the conclusion first, as five plain statements, before anything is expanded. */}
      <section aria-labelledby="mcp-api-summary-title" className="flex flex-col gap-2">
        <h2 id="mcp-api-summary-title" className="text-sm font-semibold text-foreground">Summary</h2>
        <ul data-slot="mcp-api-summary" className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-relaxed text-foreground">
          {onlyHealth ? (
            <li>This server lists no tools besides health.</li>
          ) : (
            <li>
              {plural(tools.length, 'tool')}, {plural(actionTotals - refusedTotal, 'action')} that read or change, and{' '}
              {plural(refusedTotal, 'action')} that {refusedTotal === 1 ? 'is' : 'are'} always refused.
            </li>
          )}
          <li>
            {plural(changing.length, 'tool')} can change project state, {destructive} of them state they may be
            destructive. {plural(readOnly, 'tool')} {readOnly === 1 ? 'is' : 'are'} read-only.
            {unstated ? ` ${plural(unstated, 'tool')} ${unstated === 1 ? 'does' : 'do'} not state whether it is read-only, so clients assume it may change state.` : ''}
          </li>
          <li>
            What it will not do: {plural(reference.notExposed.length, 'thing')} never exposed,{' '}
            {plural(refusedTotal, 'action')} and {plural(reference.refusedArguments.length, 'argument')} always refused –{' '}
            <a href="#mcp-refusals" className={`rounded-sm underline underline-offset-2 ${FOCUS_RING}`}>
              see the refusals
            </a>
            .
          </li>
        </ul>
      </section>

      {/* Tools (§ 18.3): the collapsed list IS the scanning surface. */}
      <section aria-labelledby="mcp-api-tools-title" className="flex min-w-0 flex-col gap-3">
        <h2 id="mcp-api-tools-title" className="text-sm font-semibold text-foreground">Tools</h2>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
            <legend className="sr-only">Show tools by effect</legend>
            {FILTERS.map((f) => (
              <label key={f.value} className="flex items-center gap-1.5 text-foreground">
                <input
                  type="radio"
                  name="mcp-api-effect-filter"
                  value={f.value}
                  checked={filter === f.value}
                  onChange={() => setFilter(f.value)}
                  className={FOCUS_RING}
                />
                {f.label}
              </label>
            ))}
          </fieldset>
          <div className="flex gap-3 text-[12px]">
            <button type="button" onClick={() => setAllOpen(true)} className={`rounded-sm font-medium underline underline-offset-2 ${FOCUS_RING}`}>
              Expand all
            </button>
            <button type="button" onClick={() => setAllOpen(false)} className={`rounded-sm font-medium underline underline-offset-2 ${FOCUS_RING}`}>
              Collapse all
            </button>
          </div>
        </div>
        <p data-slot="mcp-api-filter-status" role="status" aria-live="polite" className="text-[12px] text-muted-foreground">
          Showing {shown.length} of {plural(tools.length, 'tool')}.
        </p>
        {shown.length ? (
          <ul ref={listRef} aria-label="MCP tools" className="flex min-w-0 flex-col gap-2">
            {shown.map((tool) => (
              <li key={tool.name} className="min-w-0">
                <ToolEntry
                  tool={tool}
                  refusedActions={reference.refusedActions.filter((r) => r.tool === tool.name)}
                  refusedArguments={reference.refusedArguments.filter((r) => r.tool === tool.name)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted-foreground">No tools match this filter.</p>
        )}
      </section>

      {/* What this server will not do (§ 18.5). */}
      <section id="mcp-refusals" aria-labelledby="mcp-api-refusals-title" className="flex scroll-mt-4 flex-col gap-3">
        <h2 id="mcp-api-refusals-title" className="text-sm font-semibold text-foreground">What this server will not do</h2>
        <div className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold text-foreground">Never exposed</h3>
          <ul data-slot="mcp-api-not-exposed" className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-relaxed">
            {reference.notExposed.map((n) => (
              <li key={n.what} className="text-foreground">
                <span className="font-medium">{n.what}.</span> <span className="text-muted-foreground">{n.detail}</span>{' '}
                <span className="text-soft-foreground">({n.forbiddenBy.join(', ')})</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold text-foreground">Always refused</h3>
          {reference.refusedActions.length || reference.refusedArguments.length ? (
            <ul data-slot="mcp-api-always-refused" className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-relaxed">
              {reference.refusedArguments.map((r) => (
                <li key={`${r.tool}:${r.argument}`} className="text-foreground">
                  <code className="font-mono break-all">{r.tool}</code> argument <code className="font-mono break-all">{r.argument}</code>{' '}
                  – <span className="text-muted-foreground">{r.reason}</span>
                </li>
              ))}
              {reference.refusedActions.map((r) => (
                <li key={`${r.tool}:${r.action}`} className="text-foreground">
                  <code className="font-mono break-all">{r.tool}</code> action <code className="font-mono break-all">{r.action}</code>{' '}
                  – <span className="font-medium">{r.boundary}.</span> <span className="text-muted-foreground">{r.reason}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted-foreground">No action or argument is refused on principle.</p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold text-foreground">Refused at call time</h3>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Some refusals depend on the state at the moment of the call – a stale <code className="font-mono">expectedVersion</code>{' '}
            answered as a conflict, or a second client refused because the project already has an owner. They arrive as
            tool results; each tool’s description above says how.
          </p>
        </div>
      </section>
    </div>
  )
}
