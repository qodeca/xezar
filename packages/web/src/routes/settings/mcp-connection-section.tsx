import { ServerIcon, ShieldCheckIcon, TriangleAlertIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { useHealth, useProjects } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { useActiveProjectId } from '@/lib/project-router'
import { SettingsField } from './settings-field'

/**
 * Project settings → MCP connection (issue #111, Phase 7 of epic #67): the one place a user
 * learns what the MCP leader connection is bound to, that the client and xezar must be on the
 * same machine, that xezar writes the local connection configuration automatically, and how to
 * do the ONE-TIME per-client setup for Claude Code, Codex and OpenCode.
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

/** The per-client setup facts, from D-04 § 3. Kept as data so the three cards cannot drift. */
const CLIENTS: readonly ClientSetup[] = [
  {
    name: 'Claude Code',
    automatic:
      'Writing the connection configuration inside this project\u2019s `.local/xezar/`; regenerating it if deleted; keeping it out of Git.',
    userAction: (
      <>
        Run this once, from the project root:
        <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed">
          claude mcp add --scope local xezar -- npx -y @qodeca/xezar mcp
        </pre>
      </>
    ),
    notAutomatic:
      'Claude Code does not discover `.local/xezar/mcp-connection.json`. Nothing in it is read by Claude Code at any point \u2014 the command above is what tells Claude Code that a xezar MCP server exists.',
    caveat:
      'Local scope writes outside the repository. The project-scope alternative (`--scope project`) writes a tracked `.mcp.json` and needs a per-user approval step before it connects.',
  },
  {
    name: 'Codex',
    automatic:
      'Writing the connection configuration inside this project\u2019s `.local/xezar/`; regenerating it if deleted; keeping it out of Git.',
    userAction: (
      <>
        Create the project <span className="font-mono">.codex/config.toml</span> block, and trust the project once. Two steps, both required:
        <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed">
          {`[mcp_servers.xezar]
command = "npx"
args = ["-y", "@qodeca/xezar", "mcp"]`}
        </pre>
        <span className="mt-2 block">
          Then either accept Codex’s trust prompt the first time you run it in this folder, or add a{' '}
          <span className="font-mono">[projects."&lt;absolute path&gt;"] trust_level = "trusted"</span> entry to your user config.
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
        Add the <span className="font-mono">mcp.xezar</span> block to the project <span className="font-mono">opencode.json</span>:
        <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed">
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
]

export function McpConnectionSection() {
  const health = useHealth()
  const projects = useProjects()

  if (health.isPending || projects.isPending) {
    return (
      <p data-slot="mcp-connection-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading MCP connection…
      </p>
    )
  }
  if (health.isError) {
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

  return <McpConnectionPanel health={health.data} projects={projects.data?.projects ?? []} />
}

function McpConnectionPanel({
  health,
  projects,
}: {
  health: NonNullable<ReturnType<typeof useHealth>['data']>
  projects: readonly { id: string; name: string; root: string }[]
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
        hint="The MCP leader connection is bound to exactly one project. This is the project it is bound to, as the server reports it."
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
                The leader application must run on the same machine. A client on another machine cannot
                connect, and no part of the MCP surface is exposed to a remote host.
              </p>
            </>
          ) : (
            <>
              <p className="flex items-center gap-2 text-[13px] text-foreground">
                <ServerIcon aria-hidden="true" className="size-4 shrink-0 text-warning" />
                This xezar is not running in local mode, so the MCP connection is not available.
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                The MCP client and xezar must be on the same machine. Run the cockpit locally to make the
                connection available for this project.
              </p>
            </>
          )}
        </div>
      </SettingsField>

      {/* Configuration readiness — server-derived, never from the presence of a file. */}
      <SettingsField
        title="Configuration readiness"
        hint="xezar writes the local connection configuration automatically. Nothing here reads that file — the status is what the server reports."
      >
        <div data-slot="mcp-readiness" className="rounded-md border border-border bg-card p-3">
          <p className="text-[13px] leading-relaxed text-foreground">
            {local
              ? 'xezar writes this project\u2019s connection configuration automatically into its `.local/xezar/`, regenerates it if deleted, and keeps it out of Git. The one-time client setup below is the only step left.'
              : 'Configuration is written automatically, but the connection is unavailable in this mode because the client and xezar must be on the same machine.'}
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            The generated file is not read by any client — each one is configured by hand, once, below.
          </p>
        </div>
      </SettingsField>

      {/* One-time setup, per client — D-04 § 3, automatic vs user action kept separate. */}
      <SettingsField
        title="One-time setup"
        hint="Configure the leader application once, per client. The generated project file is not discovered automatically."
      >
        <div className="flex flex-col gap-3">
          {CLIENTS.map((client) => (
            <ClientSetupCard key={client.name} client={client} />
          ))}
        </div>
      </SettingsField>

      {/* Capabilities and limitations — truthfully, with no invented timeout or disconnect control. */}
      <SettingsField
        title="Capabilities and limitations"
        hint="What the MCP leader connection can do, and the boundaries it stays inside."
      >
        <ul data-slot="mcp-limits" className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] leading-relaxed text-muted-foreground">
          <li>Local only: the client and xezar run on the same machine; remote access is out of scope.</li>
          <li>One active logical client may own a project at a time; the cockpit stays usable alongside it.</li>
          <li>Project-level operations are autonomous; global administration and quality gates are not part of the MCP surface.</li>
        </ul>
      </SettingsField>
    </div>
  )
}

/** One client's setup card: the automatic column, the user action, and the NOT-automatic line
 *  that U-M01 requires stated plainly. No credential is rendered here \u2014 only a command and a
 *  non-secret file location. */
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
          {client.automatic}
        </p>
        <div data-slot="mcp-client-user" className="text-foreground">
          <span className="font-medium">One-time — you do this by hand:</span>
          <div className="mt-1">{client.userAction}</div>
        </div>
        <p data-slot="mcp-client-not-automatic" className="rounded-md bg-muted p-2 text-muted-foreground">
          <span className="font-medium text-foreground">NOT automatic — stated plainly:</span>{' '}
          {client.notAutomatic}
        </p>
        {client.caveat ? (
          <p className="text-[12px] text-soft-foreground">{client.caveat}</p>
        ) : null}
      </div>
    </div>
  )
}
