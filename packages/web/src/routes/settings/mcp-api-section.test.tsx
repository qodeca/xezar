import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import type { McpApiReference } from '@qodeca/xezar-api-client'
import { McpApiReferenceView, McpApiSection } from './mcp-api-section'
// Test-only reach into the committed artifact: the exact `tools/list` the server answers today,
// held to the live registry by `packages/xezar/src/mcp/mcp-api-doc.test.ts`.
import realTools from '../../../../../docs/features/mcp-server/mcp-api.json'

/**
 * #284 — Settings → MCP API, the read-only reference (spec `mcp-api-reference-spec.md` § 12, § 18).
 *
 * Rendered from a ROUTE FIXTURE that holds tools the real registry does not have
 * (`zz_invented_probe`, `weird_tool`): if the page had a hard-coded list, they would not appear
 * (DR-05). jsdom computes no layout, so the narrow-screen checks are structural; the 375 px,
 * light/dark, keyboard-only walkthrough is QA evidence on the pull request.
 */

type Available = Extract<McpApiReference, { available: true }>

const REAL_TOOLS = realTools as Available['tools']

const ACTIONS = Array.from({ length: 16 }, (_, i) => `act_${String(i + 1).padStart(2, '0')}`)
const MODES = Array.from({ length: 12 }, (_, i) => `mode_${i + 1}`)

const REFERENCE: Available = {
  available: true,
  xezarVersion: '0.14.0',
  protocolVersions: ['2025-11-25', '2025-06-18'],
  capabilities: { tools: { listChanged: false } },
  tools: [
    {
      name: 'health',
      title: 'xezar health',
      description: 'Report whether the cockpit is running.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'zz_invented_probe',
      title: 'An invented probe',
      description: 'Changes things the registry has never heard of.',
      inputSchema: {
        type: 'object',
        properties: {
          note: { description: 'note: free text, kept VERBATIM — including  two spaces.', type: 'string' },
          action: { description: 'What to do.', type: 'string', enum: [...ACTIONS, 'refuse_me'] },
          projectId: { description: 'Never accepted: the project is the bound one.' },
          mode: { description: 'The mode.', type: 'string', enum: MODES },
          config: {
            description: 'Nested three levels deep.',
            type: 'object',
            properties: {
              inner: { type: 'object', properties: { leaf: { type: 'integer', description: 'The deepest field.' } }, required: ['leaf'] },
            },
          },
          expectedVersion: { description: 'The token from your last read.', type: 'string' },
        },
        // Flat, like every real action tool: the guard is optional at the TOP LEVEL even though two
        // actions refuse a call without it. Only the route's derived `guards` can say which.
        required: ['action'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    {
      name: 'reader',
      description: 'Reads three views.',
      inputSchema: {
        type: 'object',
        properties: { view: { type: 'string', enum: ['list', 'task', 'history'] }, runId: { type: 'string' } },
        required: ['view'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'unstated_tool',
      description: 'States no read-only hint.',
      inputSchema: { type: 'object', properties: { operationId: { type: 'string' } } },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    {
      name: 'weird_tool',
      description: 'Uses a schema form the page does not lay out.',
      inputSchema: { type: 'object', properties: { thing: { $ref: '#/definitions/thing' } } },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
  ],
  refusedActions: [{ tool: 'zz_invented_probe', action: 'refuse_me', boundary: 'project binding', reason: 'it would leave the bound project.' }],
  refusedArguments: [{ tool: 'zz_invented_probe', argument: 'projectId', reason: 'Never accepted: the project is the bound one.' }],
  guards: [
    { tool: 'zz_invented_probe', argument: 'expectedVersion', everyCall: false, requiredBy: ['act_02', 'act_05'] },
    { tool: 'unstated_tool', argument: 'operationId', everyCall: false, requiredBy: [] },
  ],
  notExposed: [
    { what: 'Resources, prompts and logging', detail: 'Tools only.', forbiddenBy: ['D-05'] },
    { what: 'Secrets', detail: 'No secret in any answer.', forbiddenBy: ['F-15'] },
  ],
}

function renderView(reference: Available = REFERENCE, path = '/p/boot/settings/mcp-api') {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <ProjectScopeProvider projectId={null}>
          <McpApiReferenceView reference={reference} />
        </ProjectScopeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const tool = (name: string) => document.getElementById(`tool-${name}`) as HTMLDetailsElement
const summaryOf = (name: string) => tool(name).querySelector('summary')!.textContent ?? ''

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.documentElement.classList.remove('dark', 'light')
})

describe('MCP API — the tools come from the route, not from the page', () => {
  it('lists every tool in route order, including ones the real registry does not have, all collapsed', () => {
    renderView()
    const names = [...document.querySelectorAll('[data-slot="mcp-api-tool"]')].map((d) => d.id)
    expect(names).toEqual(['tool-health', 'tool-zz_invented_probe', 'tool-reader', 'tool-unstated_tool', 'tool-weird_tool'])
    for (const d of document.querySelectorAll<HTMLDetailsElement>('[data-slot="mcp-api-tool"]')) expect(d.open).toBe(false)
    // Collapsed content stays in the page, so find-in-page can reach it (CV-10, native <details>).
    expect(tool('zz_invented_probe').textContent).toContain('The deepest field.')
  })

  it('puts the effect on every row in words: read-only, changes, destructive, not stated', () => {
    renderView()
    expect(summaryOf('health')).toContain('Read-only')
    expect(summaryOf('health')).not.toContain('Destructive')
    expect(summaryOf('reader')).not.toContain('Destructive')
    expect(summaryOf('zz_invented_probe')).toContain('Changes project state')
    expect(summaryOf('zz_invented_probe')).toContain('Destructive – may delete or overwrite')
    expect(summaryOf('unstated_tool')).toContain('Read-only: not stated – clients assume it may change state')
    expect(summaryOf('weird_tool')).toContain('Changes project state')
    expect(summaryOf('weird_tool')).not.toContain('Destructive')
    // Action counts by kind: 16 that act plus the one refused.
    expect(summaryOf('zz_invented_probe')).toContain('16 actions, 1 refused')
    expect(summaryOf('health')).toContain('1 action')
    // #301, A9: effect words are separated by spacing, never by a character that can wrap alone.
    for (const effect of document.querySelectorAll('[data-slot="mcp-api-effect"]')) expect(effect.textContent).not.toContain('·')
  })

  it('names the tools in the summary instead of counting them, and never merges reads with changes (#301, A4)', () => {
    renderView()
    const summary = document.querySelector('[data-slot="mcp-api-summary"]')!.textContent!.replace(/\s+/g, ' ')
    // health 1 + probe 17 + reader 3 + unstated 1 + weird 1 = 23 actions, 1 of them refused.
    expect(summary).toContain('5 tools, 22 actions, and 1 action that is always refused.')
    expect(summary).not.toContain('read or change')
    expect(document.querySelector('[data-slot="mcp-api-summary-changing"]')!.textContent!.replace(/\s+/g, ' ')).toBe(
      'Can change project state: zz_invented_probe, unstated_tool, weird_tool. Of these, the tools that state they may delete or overwrite: zz_invented_probe, unstated_tool.',
    )
    expect(document.querySelector('[data-slot="mcp-api-summary-unstated"]')!.textContent!.replace(/\s+/g, ' ')).toBe(
      'Not stated whether read-only, so clients assume it may change state: unstated_tool.',
    )
    expect(document.querySelector('[data-slot="mcp-api-summary-read-only"]')!.textContent).toBe('Read-only: health, reader.')
    // Each name opens its tool.
    const reader = within(document.querySelector('[data-slot="mcp-api-summary-read-only"]') as HTMLElement).getByRole('link', { name: 'reader' })
    expect(reader.getAttribute('href')).toBe('#tool-reader')
    expect(summary).toContain('2 things never exposed, 1 action and 1 argument always refused')
  })

  it('says coverage is not shown here and where it is recorded, instead of leaving it out (#301, A8)', () => {
    renderView()
    expect(document.querySelector('[data-slot="mcp-api-summary-coverage"]')!.textContent).toContain('Cockpit coverage is not shown on this page')
    expect(screen.getByRole('link', { name: 'where it is recorded' }).getAttribute('href')).toBe('#mcp-coverage')
    const coverage = document.getElementById('mcp-coverage')!
    expect(within(coverage).getByRole('heading', { name: 'Cockpit coverage' })).toBeTruthy()
    expect(coverage.textContent).toContain('docs/features/mcp-server/mcp-api.md')
  })

  it('says in one line that the page is a reference, not a console, with no box and no second "not exposed" list (#301, A5)', () => {
    renderView()
    const header = document.querySelector('[data-slot="mcp-api-header"]')!.textContent!.replace(/\s+/g, ' ')
    expect(header).toContain('Read-only by design')
    expect(header).toContain('No tool call is ever sent from this page.')
    expect(header).not.toContain('It does not expose')
    expect(document.querySelector('[data-slot="mcp-api-read-only"]')!.getAttribute('class')).not.toMatch(/\bborder\b|\bbg-/)
    expect(within(document.querySelector('[data-slot="mcp-api-header"]') as HTMLElement).getByText('Why?')).toBeTruthy()
    expect(header).toContain('0.14.0')
    expect(header).toContain('2025-11-25')
  })
})

describe('MCP API — an expanded tool', () => {
  it('says so when a tool takes no arguments', () => {
    renderView()
    expect(within(tool('health')).getByText('Takes no arguments.')).toBeTruthy()
  })

  it('lists required arguments first, shows descriptions verbatim, and the discriminator by reference', () => {
    renderView()
    const args = [...tool('zz_invented_probe').querySelectorAll('[data-slot="mcp-api-argument"]')]
    const names = args.map((li) => li.querySelector('.font-mono')!.textContent)
    expect(names).toEqual(['action', 'note', 'mode', 'config', 'expectedVersion'])
    expect(args[0]!.textContent).toContain('Required')
    expect(args[1]!.textContent).toContain('Optional')
    const note = args[1]!.querySelector('[data-slot="mcp-api-description"]')!.textContent
    expect(note).toBe('note: free text, kept VERBATIM — including  two spaces.')
    expect(args[0]!.textContent).toContain('One of the 17 actions above.')
    expect(args[0]!.querySelectorAll('code')).toHaveLength(0)
  })

  it('cuts an enum of more than ten values short, with a disclosure that says how many it reveals', () => {
    renderView()
    const mode = [...tool('zz_invented_probe').querySelectorAll('[data-slot="mcp-api-argument"]')][2]!
    expect(mode.querySelectorAll('code')).toHaveLength(10)
    const more = within(mode as HTMLElement).getByRole('button', { name: 'Show all 12 values' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    expect(mode.querySelectorAll('code')).toHaveLength(12)
    expect(more.getAttribute('aria-expanded')).toBe('true')
  })

  it('shows nesting beyond one level as path-prefixed fields, types in words', () => {
    renderView()
    const nested = [...tool('zz_invented_probe').querySelectorAll('[data-slot="mcp-api-nested-argument"]')].map((li) =>
      li.textContent!.replace(/\s+/g, ' '),
    )
    expect(nested[0]).toContain('config.inner')
    expect(nested[0]).toContain('object – 1 field')
    expect(nested[1]).toContain('config.inner.leaf')
    expect(nested[1]).toContain('Required')
    expect(nested[1]).toContain('whole number')
  })

  it('says which actions need expectedVersion from the route’s derived guards, not from the flat schema (#301, A3)', () => {
    renderView()
    const probe = tool('zz_invented_probe')
    // The schema lists the guard as optional at its top level; the route knows two actions refuse
    // a call without it, and the page says exactly that, naming them.
    expect(probe.querySelector('[data-slot="mcp-api-expected-version"]')!.textContent).toBe('required by 2 of 16 actions: act_02, act_05')
    expect(probe.querySelector('[data-slot="mcp-api-operation-id"]')!.textContent).toBe('not taken')
    expect(tool('unstated_tool').querySelector('[data-slot="mcp-api-operation-id"]')!.textContent).toBe('optional')
    expect(document.body.textContent).not.toContain('accepted, not required')

    cleanup()
    const everyCall = { ...REFERENCE.guards[0]!, everyCall: true, requiredBy: ACTIONS }
    renderView({ ...REFERENCE, guards: [everyCall] })
    expect(tool('zz_invented_probe').querySelector('[data-slot="mcp-api-expected-version"]')!.textContent).toBe('required on every call')
    // A guard the route does not describe is never guessed.
    expect(tool('unstated_tool').querySelector('[data-slot="mcp-api-operation-id"]')!.textContent).toBe(
      'optional in the schema – which actions need it is not stated',
    )
  })

  it('never tells a reviewer organise_work’s expectedVersion is optional: it refuses ten actions without it (#301, A3)', () => {
    // The real listing, as committed, with the guard the server derives for it
    // (`mcp-reference-route.test.ts` pins that derivation to the tool's own schema).
    const organise = REAL_TOOLS.find((t) => t.name === 'organise_work')!
    const needed = ['set_title', 'edit_brief', 'edit_queued_message', 'remove_queued_message', 'pin', 'unpin', 'archive', 'restore', 'delete', 'pick_variant']
    renderView({
      ...REFERENCE,
      tools: [organise],
      refusedActions: [],
      refusedArguments: [],
      guards: [{ tool: 'organise_work', argument: 'expectedVersion', everyCall: false, requiredBy: needed }],
    })
    const words = tool('organise_work').querySelector('[data-slot="mcp-api-expected-version"]')!.textContent!
    expect(words).toBe(`required by 10 of 17 actions: ${needed.join(', ')}`)
    expect(words).not.toMatch(/accepted|not required/)
  })

  it('shows every hint as words, with the protocol default where a hint is not stated', () => {
    renderView()
    const text = tool('unstated_tool').textContent!.replace(/\s+/g, ' ')
    expect(text).toContain('Read-only:not stated – clients assume no')
    expect(text).toContain('Idempotent:not stated – clients assume no')
    expect(tool('health').textContent).toContain('Destructive:not applicable (read-only)')
  })

  it('shows a refused argument as a refusal, never as an optional input, and a refused action with its boundary', () => {
    renderView()
    const probe = tool('zz_invented_probe')
    const inputs = [...probe.querySelectorAll('[data-slot="mcp-api-argument"]')].map((li) => li.textContent)
    expect(inputs.some((t) => t?.includes('projectId'))).toBe(false)
    expect(probe.querySelector('[data-slot="mcp-api-refused-argument"]')!.textContent).toContain('Refused – never accepted.')
    // #301, A6: inside the tool a refused action shows its name under its boundary; the reason is
    // written once, in the refusals section.
    const actions = [...probe.querySelectorAll('[data-slot="mcp-api-action"]')].map((li) => li.textContent)
    expect(actions).toEqual(ACTIONS)
    const refusedHere = probe.querySelector('[data-slot="mcp-api-refused-actions"]')!.textContent!
    expect(refusedHere).toContain('Project binding: refuse_me')
    expect(refusedHere).not.toContain('it would leave the bound project.')
    // #301, A7: the refusals section groups by boundary, and joins name and reason with a colon.
    const gathered = document.querySelector('[data-slot="mcp-api-always-refused"]')!
    const groups = [...gathered.querySelectorAll('[data-slot="mcp-api-boundary"] h4')].map((h) => h.textContent)
    expect(groups).toEqual(['Project binding', 'Arguments'])
    expect(gathered.textContent!.replace(/\s+/g, ' ')).toContain('zz_invented_probe action refuse_me: it would leave the bound project.')
    expect(gathered.textContent).toContain('projectId')
  })

  it('prints no effect word it cannot back on an action, and says where the effect is written (#301, A1, A2)', () => {
    renderView()
    expect(document.body.textContent).not.toContain('Reads or changes')
    expect(document.body.textContent).not.toContain('Do this in the cockpit')
    expect(tool('zz_invented_probe').querySelector('[data-slot="mcp-api-action-effects"]')!.textContent).toBe(
      'Which of these actions change state is not declared yet. The description above is the source.',
    )
    expect(tool('reader').querySelector('[data-slot="mcp-api-action-effects"]')!.textContent).toBe(
      'The tool states it is read-only, so every action reads.',
    )
  })

  it('closes an open tool from its end and returns focus to its row (#301, A10)', () => {
    renderView()
    const probe = tool('zz_invented_probe')
    probe.open = true
    fireEvent.click(within(probe).getByRole('button', { name: 'Close zz_invented_probe' }))
    expect(probe.open).toBe(false)
    expect(document.activeElement).toBe(probe.querySelector('summary'))
  })

  it('confines a schema it cannot lay out to its own tool, and opens the raw schema there', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderView()
    const weird = tool('weird_tool')
    expect(weird.querySelector('[data-slot="mcp-api-unsupported"]')!.textContent).toContain(
      'This schema uses a form the page does not lay out as a table.',
    )
    expect(weird.querySelector<HTMLDetailsElement>('[data-slot="mcp-api-unsupported"] details')!.open).toBe(true)
    // Every other tool still lays out its arguments.
    expect(tool('reader').querySelectorAll('[data-slot="mcp-api-argument"]')).toHaveLength(2)
    expect(document.querySelectorAll('[data-slot="mcp-api-unsupported"]')).toHaveLength(1)
  })
})

describe('MCP API — the real tool surface', () => {
  it('lays out every real tool from the committed mcp-api.json without falling back to raw JSON', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderView({ ...REFERENCE, tools: REAL_TOOLS, refusedActions: [], refusedArguments: [], guards: [] })
    expect(document.querySelectorAll('[data-slot="mcp-api-tool"]')).toHaveLength(REAL_TOOLS.length)
    expect(document.querySelectorAll('[data-slot="mcp-api-unsupported"]')).toHaveLength(0)
    expect(errors).not.toHaveBeenCalled()
  })
})

describe('MCP API — finding a tool', () => {
  it('filters by effect and announces the new count', () => {
    renderView()
    fireEvent.click(screen.getByRole('radio', { name: 'Read-only' }))
    expect(document.querySelector('[data-slot="mcp-api-filter-status"]')!.textContent).toBe('Showing 2 of 5 tools.')
    expect(document.querySelector('[data-slot="mcp-api-filter-status"]')!.getAttribute('aria-live')).toBe('polite')
    expect([...document.querySelectorAll('[data-slot="mcp-api-tool"]')].map((d) => d.id)).toEqual(['tool-health', 'tool-reader'])
  })

  it('says so when a filter matches nothing, and when only health is listed', () => {
    renderView({ ...REFERENCE, tools: [REFERENCE.tools[0]!], refusedActions: [], refusedArguments: [], guards: [] })
    expect(document.querySelector('[data-slot="mcp-api-summary"]')!.textContent).toContain('This server lists no tools besides health.')
    fireEvent.click(screen.getByRole('radio', { name: 'Changes project state' }))
    expect(screen.getByText('No tools match this filter.')).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Changes project state' })).toBeTruthy()
  })

  it('expands and collapses every tool at once', () => {
    renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    for (const d of document.querySelectorAll<HTMLDetailsElement>('[data-slot="mcp-api-tool"]')) expect(d.open).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    for (const d of document.querySelectorAll<HTMLDetailsElement>('[data-slot="mcp-api-tool"]')) expect(d.open).toBe(false)
  })

  it('opens the tool a #tool-<name> link points at and moves focus to its row', async () => {
    renderView(REFERENCE, '/p/boot/settings/mcp-api#tool-reader')
    await waitFor(() => expect(tool('reader').open).toBe(true))
    expect(document.activeElement).toBe(tool('reader').querySelector('summary'))
    expect(tool('health').open).toBe(false)
  })
})

describe('MCP API — read-only by design (CV-06)', () => {
  it('has no control that runs, sends, prepares or copies a tool call, and no disabled stand-in', () => {
    renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(document.querySelector('form')).toBeNull()
    expect(document.querySelector('textarea, input:not([type="radio"]), select')).toBeNull()
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      expect(el.textContent ?? '', el.outerHTML).not.toMatch(/\b(try|run|send|execute|call|invoke|copy|test)\b/i)
      expect(el.hasAttribute('disabled'), el.outerHTML).toBe(false)
    }
  })
})

describe('MCP API — the route states', () => {
  function serve(answer: () => Response | Promise<Response>) {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input))
        return answer()
      }),
    )
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/p/boot/settings/mcp-api']}>
          <ProjectScopeProvider projectId={null}>
            <McpApiSection />
          </ProjectScopeProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    return calls
  }
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

  it('says it is loading, in a polite live region, with no placeholder rows', () => {
    serve(() => new Promise<never>(() => {}))
    const loading = document.querySelector('[data-slot="mcp-api-loading"]')!
    expect(loading.textContent).toBe('Loading the tool list…')
    expect(loading.getAttribute('aria-live')).toBe('polite')
    expect(document.querySelector('[data-slot="mcp-api-tool"]')).toBeNull()
  })

  it('renders the reference from the one read-only route, and asks nothing else', async () => {
    const calls = serve(() => json(REFERENCE))
    await waitFor(() => expect(document.querySelectorAll('[data-slot="mcp-api-tool"]')).toHaveLength(5))
    expect(calls.every((url) => /\/api\/v1\/(p\/[^/]+\/)?mcp\/reference$/.test(url))).toBe(true)
  })

  it('says in one sentence why the reference is unavailable, and links back to MCP connection', async () => {
    serve(() => json({ available: false, reason: 'The MCP tool list could not be loaded: boom' }))
    await waitFor(() => expect(document.querySelector('[data-slot="mcp-api-unavailable"]')).toBeTruthy())
    const text = document.querySelector('[data-slot="mcp-api-unavailable"]')!.textContent!
    expect(text).toContain('The MCP API reference is not available.')
    expect(text).toContain('could not be loaded: boom')
    expect(screen.getByRole('link', { name: 'MCP connection' }).getAttribute('href')).toContain('/settings/mcp-connection')
  })

  it('shows a readable error when the route itself fails (an older server that has no such route)', async () => {
    // A 4xx is never retried by the query client, so the error shows at once.
    serve(() => json({ error: 'not found' }, 404))
    await waitFor(() => expect(screen.getByText('Could not load the MCP API reference')).toBeTruthy())
  })
})

describe('MCP API — accessibility and narrow screens (the #114 bar)', () => {
  it('labels every control, keeps it reachable by keyboard, and replaces any removed outline', () => {
    renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    const controls = [...document.querySelectorAll('a[href], button, input, summary')]
    expect(controls.length).toBeGreaterThan(10)
    for (const el of controls) {
      const name = el.tagName === 'INPUT' ? el.closest('label')?.textContent : el.getAttribute('aria-label') ?? el.textContent
      expect((name ?? '').trim(), el.outerHTML.slice(0, 160)).not.toBe('')
      expect(el.getAttribute('tabindex'), el.outerHTML.slice(0, 160)).not.toBe('-1')
      const cls = el.getAttribute('class') ?? ''
      if (/\boutline-none\b/.test(cls)) expect(cls, el.outerHTML.slice(0, 160)).toMatch(/focus-visible:/)
    }
    expect(document.querySelector('fieldset legend')!.textContent).toBe('Show tools by effect')
  })

  it.each(['light', 'dark'] as const)('uses theme tokens only in %s theme, and wraps long names', (theme) => {
    document.documentElement.classList.add(theme)
    const { container } = renderView()
    const hardCoded =
      /(?:^|\s)(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke)-(?:white|black|(?:gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b|#[0-9a-f]{3,8}\b/i
    for (const el of container.querySelectorAll('*')) {
      expect(el.getAttribute('class') ?? '', el.outerHTML.slice(0, 160)).not.toMatch(hardCoded)
      expect(el.getAttribute('style') ?? '').toBe('')
    }
    // Monospace names and paths break anywhere rather than pushing the page sideways at 375 px;
    // the raw schema is the one block allowed to scroll, inside its own container.
    for (const mono of container.querySelectorAll('[data-slot="mcp-api-tool"] summary .font-mono')) {
      expect(mono.getAttribute('class')).toContain('break-all')
    }
    for (const pre of container.querySelectorAll('pre')) {
      expect(pre.getAttribute('class')).toContain('whitespace-pre-wrap')
      expect(pre.parentElement!.getAttribute('class')).toContain('overflow-x-auto')
    }
  })
})
