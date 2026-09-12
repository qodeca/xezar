import { ServerIcon, ShieldCheckIcon, TriangleAlertIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import type { HealthResponse } from '@qodeca/xezar-api-client'
import { useHealth, useProjects } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { Link, useActiveProjectId } from '@/lib/project-router'
import { McpOperationFeedback, type McpOperation } from '@/routes/task-thread/mcp-operation-feedback'
import { McpCapabilities } from './mcp-capabilities'
import { McpConnectionState } from './mcp-connection-state'
import { SettingsField } from './settings-field'

/**
 * Project settings → MCP connection (issue #111, Phase 7 of epic #67): the one place a user
 * learns what the MCP leader connection is bound to, that the client and xezar must be on the
 * same machine, that xezar writes the local connection configuration automatically, and how to
 * do the ONE-TIME per-client setup for Claude Code, Codex, OpenCode and pi (pi since #341).
 *
 * The status this screen shows comes from the SERVER — the project registry (`/api/projects`)
 * and `/api/health`'s `localHandoff` capability — never from the presence of a file. The MCP
 * requirements (§8) are explicit that file presence or location alone is not a security
 * boundary, so nothing here probes the connection file or the socket on disk: the section
 * reports what the running server says about this project and this machine, and nothing more.
 *
 * Copy follows D-04 (`docs/features/mcp-server/mcp-d04-connection-file-decision.md`), which
 * fixed U-M01 and F-14: the automatically generated project file is NOT described as
 * automatically discovered by every client. Each client below says plainly what xezar does
 * automatically and what the user does by hand — and that the client does NOT read the
 * generated file.
 *
 * Hard boundaries honored here (F-15, U-M02, U-M03):
 *  - no credential, token, port or secret is ever rendered — the copy names a command and a
 *    non-secret file location, never a value;
 *  - there is no editor for raw secret-bearing configuration;
 *  - there is no "Disconnect other client", "Force takeover" or manual disconnect control;
 *  - there is no lease countdown and no invented timeout — section 13 says exact lease
 *    countdowns must not be designed before timing semantics exist.
 */

/** The one-time setup facts for one client, taken verbatim from D-04 § 3. */
interface ClientSetup {
  /** The client's product name, as a person sees it. */
  name: string
  /** What xezar does automatically — the user does none of this. */
  automatic: string
  /** What the user does once, by hand. */
  userAction: ReactNode
  /** The one thing U-M01 requires stated plainly: this client does NOT discover the file. */
  notAutomatic: string
  /** An optional caveat D-04 records for this client. */
  caveat?: string
}

/**
 * Copy with `backticked` names, rendered as `<code>` instead of literal backticks (#301, C1).
 * The backtick is spelled `\x60`: the design guardian does not lex regex literals, and a literal
 * backtick there opens a template string that hides every later comment from its stripper.
 */
function withCode(text: string): ReactNode {
  return text.split(/\x60([^\x60]+)\x60/).map((part, i) =>
    i % 2 ? (
      <code key={i} className="font-mono break-words">
        {part}
      </code>
    ) : (
      part
    ),
  )
}

/** The per-client setup facts, from D-04 § 3. Kept as data so the four cards cannot drift. */
const CLIENTS: readonly ClientSetup[] = [
  {
    name: 'Claude Code',
    automatic:
      'Writing the connection configuration inside this project\u2019s `.local/xezar/`; regenerating it if deleted; keeping it out of Git.',
    userAction: (
      <>
        Run this once, from the project root:
        <pre className="mt-2 rounded-md border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
          claude mcp add --scope local xezar -- npx -y @qodeca/xezar mcp
        </pre>
      </>
    ),
    notAutomatic:
      'Claude Code does not discover `.local/xezar/mcp-connection.json`. Nothing in it is read by Claude Code at any point \u2014 the command above is what tells Claude Code that a xezar MCP server exists.',
    caveat:
      'Local scope writes outside the repository. The project-scope alternative (`--scope project`) writes a tracked `.mcp.json`, which pi reads too, and needs a per-user approval step before it connects.',
  },
  {
    name: 'Codex',
    automatic:
      'Writing the connection configuration inside this project\u2019s `.local/xezar/`; regenerating it if deleted; keeping it out of Git.',
    userAction: (
      <>
        Create the project <span className="font-mono break-all">.codex/config.toml</span> block, and trust the project once. Two steps, both required:
        <pre className="mt-2 rounded-md border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
          {`[mcp_servers.xezar]
command = "npx"
args = ["-y", "@qodeca/xezar", "mcp"]`}
        </pre>
        <span className="mt-2 block">
          Then either accept Codex’s trust prompt the first time you run it in this folder, or add a{' '}
          <span className="font-mono break-all">[projects."&lt;absolute path&gt;"] trust_level = "trusted"</span> entry to your user config.
        </span>
      </>
    ),
    notAutomatic:
      'Codex does not discover `.local/xezar/mcp-connection.json`. It also does not read a project `.codex/config.toml` at all until that project is trusted \u2014 so a user who writes the file but skips the trust step sees a silent nothing, with no error naming the cause.',
    caveat: 'Do not use `codex mcp add` \u2014 it has no scope flag and writes a machine-scope entry that would apply in every project.',
  },
  {
    name: 'OpenCode',
    automatic:
      'Writing the connection configuration inside this project\u2019s `.local/xezar/`; regenerating it if deleted; keeping it out of Git.',
    userAction: (
      <>
        Add the <span className="font-mono break-all">mcp.xezar</span> block to the project <span className="font-mono break-all">opencode.json</span>:
        <pre className="mt-2 rounded-md border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
          {`{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "xezar": {
      "type": "local",
      "command": ["npx", "-y", "@qodeca/xezar", "mcp"],
      "enabled": true
    }
  }
}`}
        </pre>
      </>
    ),
    notAutomatic:
      'OpenCode does not discover `.local/xezar/mcp-connection.json`. The `opencode.json` block above is what makes the server appear, and it is normally committed \u2014 safe only because it holds no secret.',
    caveat: '`opencode mcp add` is interactive, so the written-file form above is the one to use.',
  },
  // pi (#341, WP3 of #330): the one client whose setup starts with an install, because pi adds MCP
  // through extensions by design. The facts are the pi evidence record's (run against the real
  // bridge): `directTools` and `keep-alive` are the two keys it measured as needed, 2.32.1 the version
  // it ran. The entry goes in the PROJECT's `.pi/mcp.json`, not pi's user-level file: the adapter reads
  // project files from pi's working directory only, while a user-level `keep-alive` entry would
  // start a bridge wherever pi starts (D-04 § 3.4). The card states keep-alive's cost as well as its
  // use: D-04 § 3.4 run `root` measured that a pi started in the project root holds the project from
  // start, and a second client is refused until that pi exits (design review on #343).
  // The `approveTools` line is #369's measured blast radius, and it is deliberately narrow: #330 WP5's
  // QA measured an ordinary pi task UNAFFECTED (the runner's default `--tools` allowlist offers no
  // `xezar_*` tool, so the dialog never fires) and only a step that named `xezar_health` failing, at
  // 121 s. Do not widen this to "every pi task": that is measured false. `approveTools` is the user's
  // own key in the adapter's `mcp.json` — `settings.approveTools` or the per-server one, which
  // overrides it (`tool-approval.ts:42-43`, adapter 2.32.1). Scope any absence claim about it to the
  // files read: `core/pi-runner.ts`, `scripts/pi-leader-extension.ts` and `mcp/adapters/pi.ts` — the
  // three xezar files on this path — never mention `approveTools` or `extension_ui_request` (read
  // 2026-09-12 at `df828a0`); `test/integration/mcp-real-clients.test.ts` DOES set the key, on its own
  // fixture, to produce the block. An unscoped "appears nowhere" rots: this one was true at 301a172
  // and false an hour later when #368 merged.
  // The two unattended cases end differently and the line says both: a pi xezar runs is killed by the
  // runner's timeout, a leader turn nobody is watching has nothing to end it and waits for ever.
  {
    name: 'pi',
    automatic:
      'Writing the connection configuration inside this project\u2019s `.local/xezar/`; regenerating it if deleted; keeping it out of Git.',
    userAction: (
      <>
        pi adds MCP through an extension, by design, so its setup has two steps, both required:
        <ol className="mt-2 flex list-decimal flex-col gap-3 pl-5">
          <li>
            Install the <code className="font-mono break-words">pi-mcp-adapter</code> extension once. It is a third-party extension (
            <a
              href="https://github.com/nicobailon/pi-mcp-adapter"
              target="_blank"
              rel="noreferrer"
              data-slot="mcp-client-pi-adapter-link"
              className="rounded-sm underline underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              source on GitHub
            </a>
            , MIT licence). Version 2.32.1 is the one tested with xezar:
            <pre className="mt-2 rounded-md border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
              pi install npm:pi-mcp-adapter@2.32.1
            </pre>
          </li>
          <li>
            Add the <span className="font-mono break-all">xezar</span> entry to <span className="font-mono break-all">.pi/mcp.json</span> in
            the project root:
            <pre className="mt-2 rounded-md border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
              {`{
  "settings": { "directTools": true },
  "mcpServers": {
    "xezar": {
      "command": "npx",
      "args": ["-y", "@qodeca/xezar", "mcp"],
      "lifecycle": "keep-alive"
    }
  }
}`}
            </pre>
            <span className="mt-2 block">
              <span className="font-mono break-all">directTools</span> shows the model the xezar tools directly.{' '}
              <span className="font-mono break-all">keep-alive</span> connects pi as soon as it starts here and keeps the connection
              while pi is idle; without it, pi gives the project up after 10 idle minutes.
            </span>
            <span data-slot="mcp-client-pi-leader" className="mt-2 block">
              So any pi started in this folder, including a pi task xezar runs here with Worktree off, becomes this project’s leader
              client, and every other client, Claude Code included, is refused until that pi exits. Start pi in another folder for
              other work.
            </span>
            <span data-slot="mcp-client-pi-approve-tools" className="mt-2 block">
              Leave xezar’s tools out of the extension’s <span className="font-mono break-all">approveTools</span> setting, in this file
              or on the <span className="font-mono break-all">xezar</span> entry. A gated tool asks for approval in pi’s own window and
              nothing in xezar answers, so a pi xezar runs waits there until it is killed — measured at two minutes, on a step that named{' '}
              <span className="font-mono break-all">xezar_health</span> — and a leader turn nobody is watching waits for ever, because
              nothing ends that one at all. A pi that is never offered a xezar tool is unaffected. Making
              xezar answer that question is{' '}
              {/* The link text is "issue 369", not "#369": the design guardian's no-raw-hex-colors rule
                  reads a three-digit "#369" as a colour, and the rule is right to. */}
              <a
                href="https://github.com/qodeca/xezar/issues/369"
                target="_blank"
                rel="noreferrer"
                data-slot="mcp-client-pi-approve-tools-issue"
                className="rounded-sm underline underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                issue 369
              </a>
              , which is not in this release.
            </span>
            <span className="mt-2 block">
              The file holds no secret, so it is safe to commit. A committed entry does the same for everyone who starts pi in this
              project.
            </span>
          </li>
        </ol>
      </>
    ),
    notAutomatic:
      'pi does not discover `.local/xezar/mcp-connection.json`. Without the extension, pi does not read the entry above at all: it shows no xezar tool, and no error says why. To check: `pi list` shows `npm:pi-mcp-adapter`, and pi says `MCP: 1 servers connected` when it starts here (a higher number if you have other MCP servers).',
    caveat:
      'If another file also has a `xezar` entry, yours in `.pi/mcp.json` wins: it is the last of the six files pi reads MCP config from. One of the others is the project `.mcp.json`, which Claude Code reads too, so an entry there reaches both clients. The other four apply in every folder pi starts in: `~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, `~/.pi/agent/mcp.json`.',
  },
]

export function McpConnectionSection() {
  const health = useHealth()
  const projects = useProjects()

  if (health.isPending || projects.isPending) {
    return (
      <p data-slot="mcp-connection-loading" role="status" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading MCP connection…
      </p>
    )
  }
  // A failed REFETCH keeps the last answer: that data is last-known, and the state says so
  // (§13 "Server restarting / unavailable") rather than pretending it is fresh or blanking it.
  if (health.isError && !health.data) {
    return (
      <CenteredState
        icon={<TriangleAlertIcon />}
        tone="danger"
        heading="h2"
        title="Could not load the MCP connection"
        subtitle={health.error.message}
      />
    )
  }

  return (
    <McpConnectionSurface
      health={health.data}
      projects={projects.data?.projects ?? []}
      connection={connectionStateFor(health.data, health.isError)}
      // No server route reports MCP operation outcomes to the cockpit yet (see the PR for #114), so
      // no `operations` are passed and the section is not rendered: a list that no route can fill
      // reads as unfinished, not as empty (#301, C3). Pass them the day a route reports them.
    />
  )
}

/**
 * The connection state the cockpit can TRUTHFULLY report from server facts, or `null` when it
 * cannot. The live owner state (`unowned | owned | expired`) is held by the server's MCP side and
 * no HTTP route exposes it yet, so in local mode this answers `null` and the surface says the
 * status is not reported here — it never guesses "ready" or "connected" (§8, §13).
 */
export function connectionStateFor(health: HealthResponse, refetchFailed: boolean): McpConnectionState | null {
  if (refetchFailed) return { kind: 'server-restarting' }
  if (!health.capabilities.localHandoff) {
    return { kind: 'unsupported', missing: 'local connection: the MCP client and xezar must run on the same machine' }
  }
  return null
}

/**
 * The assembled MCP connection surface: #111's setup guidance, #112's connection state, #113's
 * operation outcomes and #114's capabilities and limits. Presentational apart from the
 * capability view's own queries, so every state can be rendered and checked as one page.
 *
 * Order follows the configuring reader's task (#301, C5): what the connection is bound to and
 * where it works, then the one-time setup. The connection state follows the setup; when the server
 * does not report one it is a single line, not a section in second place that says nothing (C4). `operations` absent
 * means no route reports outcomes, and the section is left out (C3); an empty list is a real
 * "nothing yet".
 */
export function McpConnectionSurface({
  health,
  projects,
  connection,
  operations,
}: {
  health: HealthResponse
  projects: readonly { id: string; name: string; root: string }[]
  connection: McpConnectionState | null
  operations?: readonly McpOperation[]
}) {
  // THIS project, as the URL names it. The BOOT project mounts unscoped, so `useActiveProjectId`
  // falls back to the URL's own `/p/<id>` prefix; `bootProject` covers the sliver of time a
  // legacy flat URL is still mid-redirect (the bookmarklet generator's pattern, #422).
  const projectId = useActiveProjectId() ?? health.bootProject ?? null
  const project = projectId === null ? undefined : projects.find((p) => p.id === projectId)
  const local = health.capabilities.localHandoff

  return (
    <div
      data-slot="mcp-connection-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      {/* Bound project identity — from the server's registry, never from a file. */}
      <SettingsField
        title="Bound project"
        hint="The MCP leader connection is bound to exactly one project, and one client may own it at a time. The cockpit stays usable alongside it."
      >
        <div data-slot="mcp-project" className="rounded-md border border-border bg-card p-3">
          {project ? (
            <>
              <span className="block text-sm font-medium text-foreground">{project.name}</span>
              <span className="mt-1 block font-mono text-xs break-all text-soft-foreground">{project.root}</span>
            </>
          ) : (
            <span className="text-[13px] text-soft-foreground">The bound project is not in the registry.</span>
          )}
        </div>
      </SettingsField>

      {/* Local-only scope — the server's `localHandoff` capability is the authority. */}
      <SettingsField
        title="Local-only scope"
        hint="The MCP client and xezar must be on the same machine. Remote access is out of scope."
      >
        <div data-slot="mcp-local-only" className="rounded-md border border-border bg-card p-3">
          {local ? (
            <>
              <p className="flex items-center gap-2 text-[13px] text-foreground">
                <ShieldCheckIcon aria-hidden="true" className="size-4 shrink-0 text-primary" />
                This xezar is running locally, so the MCP connection is available for this project.
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                A client on another machine cannot connect, and no part of the MCP surface is exposed to a
                remote host.
              </p>
            </>
          ) : (
            <>
              <p className="flex items-center gap-2 text-[13px] text-foreground">
                <ServerIcon aria-hidden="true" className="size-4 shrink-0 text-warning" />
                This xezar is not running in local mode, so the MCP connection is not available.
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                Run the cockpit locally to make the connection available for this project.
              </p>
            </>
          )}
        </div>
      </SettingsField>

      {/* One-time setup, per client — D-04 § 3, automatic vs user action kept separate. What is
          true of every client is said once, above the cards (C6); readiness comes from the server,
          never from the presence of a file. */}
      <SettingsField title="One-time setup" hint="Configure the leader application once, per client.">
        <div className="flex flex-col gap-3">
          <p data-slot="mcp-readiness" className="text-[13px] leading-relaxed text-foreground">
            <span className="font-medium">Configuration readiness:</span>{' '}
            {local
              ? withCode(
                  'xezar writes this project’s connection configuration automatically into its `.local/xezar/`, regenerates it if deleted, and keeps it out of Git. No client reads that file, so the step below is the only one left.',
                )
              : 'Configuration is written automatically, but the connection is not available in this mode.'}
          </p>
          {CLIENTS.map((client) => (
            <ClientSetupCard key={client.name} client={client} />
          ))}
        </div>
      </SettingsField>

      {/* Connection state (#112) — only what the server reports, in a polite live region that is
          always mounted, so a state change is announced without moving focus (U-M08). When the
          server reports nothing, one line in the reader's voice says who does (C4). */}
      <div data-slot="mcp-connection-status" aria-live="polite" className="min-w-0">
        {connection ? (
          <SettingsField title="Connection status" hint="What the server reports about the MCP leader connection for this project.">
            <McpConnectionState state={connection} />
          </SettingsField>
        ) : (
          <p data-slot="mcp-connection-status-unreported" className="text-[13px] leading-relaxed text-muted-foreground">
            This page cannot tell whether a client is connected. Your leader client shows it.
          </p>
        )}
      </div>

      {/* Operation outcomes (#113) — rendered from what the server reports, never invented; left
          out entirely while no route reports them (C3). */}
      {operations ? (
        <SettingsField
          title="Operation outcomes"
          hint="What happened to the leader's recent operations: accepted, running, completed, failed, not applied or being verified."
        >
          <div data-slot="mcp-operations" aria-live="polite" className="min-w-0">
            {operations.length ? (
              <ul aria-label="MCP operation outcomes" className="flex flex-col gap-2">
                {operations.map((operation) => (
                  <li key={operation.operationId}>
                    <McpOperationFeedback operation={operation} />
                  </li>
                ))}
              </ul>
            ) : (
              <p data-slot="mcp-operations-empty" className="rounded-md border border-border bg-card p-3 text-[13px] leading-relaxed text-foreground">
                <span className="font-medium">No operations yet.</span> The leader has not run an operation in this project.
              </p>
            )}
          </div>
        </SettingsField>
      ) : null}

      {/* #114: usable functions, unavailable dependencies, read-only shared limits, quality checks.
          It is the one capability section: the three limitation bullets that sat above it restated
          it and Local-only scope (C8). */}
      <McpCapabilities />

      {/* #284: the read-only reference lives in its own section, one step away. */}
      <p className="text-[13px] text-foreground">
        <Link
          to="/settings/mcp-api"
          data-slot="mcp-api-link"
          className="rounded-sm font-medium underline underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          See every tool this server exposes
        </Link>{' '}
        <span className="text-muted-foreground">– a read-only reference, in MCP API.</span>
      </p>
    </div>
  )
}

/** One client's setup card: the automatic column, the user action, and the not-automatic line
 *  U-M01 requires stated per client (D-04 § 3, A-01). No credential is rendered here — only a
 *  command and a non-secret file location. */
function ClientSetupCard({ client }: { client: ClientSetup }) {
  return (
    <div
      data-slot={`mcp-client-${client.name.toLowerCase().replace(/\s+/g, '-')}`}
      className="rounded-md border border-border bg-card p-3"
    >
      <h3 className="text-sm font-semibold text-foreground">{client.name}</h3>
      <div className="mt-2 flex flex-col gap-2 text-[13px] leading-relaxed">
        <p data-slot="mcp-client-automatic" className="text-muted-foreground">
          <span className="font-medium text-foreground">Automatic — xezar does this:</span>{' '}
          {withCode(client.automatic)}
        </p>
        <div data-slot="mcp-client-user" className="text-foreground">
          <span className="font-medium">One-time — you do this by hand:</span>
          <div className="mt-1">{client.userAction}</div>
        </div>
        <p data-slot="mcp-client-not-automatic" className="rounded-md bg-muted p-2 text-muted-foreground">
          <span className="font-medium text-foreground">Not automatic:</span> {withCode(client.notAutomatic)}
        </p>
        {client.caveat ? (
          <p data-slot="mcp-client-caveat" className="text-[12px] text-soft-foreground">
            {withCode(client.caveat)}
          </p>
        ) : null}
      </div>
    </div>
  )
}
