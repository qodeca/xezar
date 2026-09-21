import {
  BellIcon,
  BookOpenIcon,
  BookmarkIcon,
  BotIcon,
  CompassIcon,
  FileCogIcon,
  FolderGit2Icon,
  FoldersIcon,
  GaugeIcon,
  IdCardIcon,
  PackageCheckIcon,
  KeyboardIcon,
  NotebookPenIcon,
  PaletteIcon,
  PlugIcon,
  TerminalIcon,
} from 'lucide-react'
import type { ComponentType, ReactNode, SVGProps } from 'react'

import { inSingleProjectRoot, projectsLocked, type ProjectModeCapabilities } from '@/lib/project-mode'
import { CenteredState } from '@/components/centered-state'
import { AccountsSection } from './accounts-section'
import { AgentConfigSection } from './agent-config-section'
import { AgentsSection } from './agents-section'
import { AppearanceSection } from './appearance'
import { BookmarkletsSection } from './bookmarklets-section'
import { McpApiSection } from './mcp-api-section'
import { McpConnectionSection } from './mcp-connection-section'
import { NotificationsSection } from './notifications-section'
import { ProjectSetupSection } from './project-setup-section'
import { ProjectsSection } from './projects-section'
import { PromptTemplatesSection } from './prompt-templates-section'
import { ResourcesSection } from './resources-section'
import { SkillsSection } from './skills-section'
import { TerminalSection } from './terminal-section'
import { WorktreesSection } from './worktrees-section'

/**
 * The Settings section registry (R6 Step 1.3, spec §"Settings"): the ONE place a section is
 * declared. The shell renders the section nav and the routes from this list, so adding a
 * section later is one entry here — no layout work, no route wiring.
 *
 * Since the multi-project split (step 3.5, spec §"Settings split") every entry also declares
 * its `scope`, and that single field decides everything downstream — which URL the section
 * lives at (`/p/<id>/settings/<id>` vs `/settings/global/<id>`), which nav lists it, and which
 * store it writes. The rule of thumb: does the setting describe THIS REPO (agents, worktrees,
 * bookmarklets, prompt templates) or the person/machine (appearance, notifications, host
 * resources, the project registry)?
 *
 * `hidden` sections are declared but not routed and not listed: keyboard remains a later
 * phase; MCP now lives inside Agent config as a per-agent subsection.
 */

export type SettingsSectionId =
  | 'bookmarklets'
  | 'appearance'
  | 'accounts'
  | 'agents'
  | 'agent-config'
  | 'project-setup'
  | 'resources'
  | 'worktrees'
  | 'projects'
  | 'notifications'
  | 'prompt-templates'
  | 'keyboard'
  | 'skills'
  | 'terminal'
  | 'mcp-connection'
  | 'mcp-api'

/** Which settings area a section belongs to — and therefore which store it writes. */
export type SettingsScope = 'project' | 'global'

export interface SettingsSection {
  id: SettingsSectionId
  title: string
  /** The one-liner under the title — the shell's desktop header and the index cards share it. */
  description: string
  /** Single-project mode only (#600): replaces `description` where it would claim several projects. */
  singleProjectDescription?: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  component: ComponentType
  /** `project` → `/p/<projectId>/settings/<id>`, `global` → `/settings/global/<id>`. */
  scope: SettingsScope
  /** Declared but not yet implemented: no nav entry, no route (the URL is honestly a 404). */
  hidden?: boolean
  /**
   * Single-project mode only (#600, FR-9.3): the file this section's saves land in, named on the
   * pane so "will this travel with the repository?" is answerable without reading the docs.
   * Absent means the section writes no xezar file (a read-only reference, an action, or the
   * agents' own config files, which that pane names itself) and shows no line. Global mode
   * never renders it.
   */
  fileNote?: SettingsFileNote
}

/**
 * One file note: `lead`, the file as code, then `tail`. The file names are the ones the server's
 * single-project layout resolves (`packages/xezar/src/state-layout.ts` → `projectStateLayout`,
 * and `ui-state.ts` for the per-repo runtime file) — this table is the cockpit's ONE copy of that
 * mapping, so a key that moves between files is one edit here (designs/single-project-mode §10.2).
 */
export interface SettingsFileNote {
  /** Defaults to "Saved in this project — ". */
  lead?: string
  /** The project-relative path, rendered as code. */
  file: string
  /** What follows the file name, starting after its full stop. */
  tail?: ReactNode
}

/** `<project>/.xezar/config.json` — the project config, committed. */
export const PROJECT_CONFIG_FILE = '.xezar/config.json'
/** `<project>/.xezar/workspace.json` — the workspace config (limits, defaults, skills), committed. */
export const WORKSPACE_CONFIG_FILE = '.xezar/workspace.json'
/** `<project>/.xezar/workspace-ui.json` — workspace GUI preferences, committed (#600 Q2). */
export const WORKSPACE_UI_FILE = '.xezar/workspace-ui.json'
/** `<project>/.xezar/agent-accounts.json` — which agent accounts the project uses, committed. */
export const AGENT_ACCOUNTS_FILE = '.xezar/agent-accounts.json'
/** `<project>/.local/xezar/ui-state.json` — the per-repo runtime file, gitignored. */
export const PROJECT_UI_STATE_FILE = '.local/xezar/ui-state.json'

const COMMITTED_SETTINGS = 'It is committed, so a clone starts with these settings.'

/** A registry entry whose real section arrives in a later Step — routable, honest about it. */
function comingSoon(title: string, Icon: ComponentType<SVGProps<SVGSVGElement>>): ComponentType {
  return function ComingSoonSection() {
    return (
      <CenteredState
        icon={<Icon />}
        tone="neutral"
        title={title}
        subtitle="This section arrives in a later phase of the redesign."
        heading="h2"
      />
    )
  }
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  // ---- project scope (`/p/<projectId>/settings/…`) — settings that describe THIS repo -------
  {
    id: 'agents',
    title: 'Agents',
    description: 'Default runner, models and system prompt.',
    icon: BotIcon,
    component: AgentsSection,
    scope: 'project',
    fileNote: { file: PROJECT_CONFIG_FILE, tail: COMMITTED_SETTINGS },
  },
  {
    id: 'agent-config',
    title: 'Agent config',
    description: 'Edit the coding agents’ own config files, per scope.',
    icon: FileCogIcon,
    component: AgentConfigSection,
    scope: 'project',
  },
  {
    id: 'project-setup',
    title: 'Project setup',
    description: 'Let an agent prepare this project, and see what was checked and when.',
    icon: CompassIcon,
    component: ProjectSetupSection,
    scope: 'project',
  },
  {
    id: 'worktrees',
    title: 'Worktrees',
    description: 'How many finished task worktrees this project keeps on disk.',
    icon: FolderGit2Icon,
    component: WorktreesSection,
    scope: 'project',
    fileNote: { file: PROJECT_CONFIG_FILE, tail: COMMITTED_SETTINGS },
  },
  {
    id: 'bookmarklets',
    title: 'Bookmarklets',
    description: 'Launch skills from a GitHub PR or issue.',
    icon: BookmarkIcon,
    component: BookmarkletsSection,
    scope: 'project',
  },
  {
    id: 'prompt-templates',
    title: 'Prompt templates',
    description: 'Reusable snippets for follow-up instructions.',
    icon: NotebookPenIcon,
    component: PromptTemplatesSection,
    scope: 'project',
    fileNote: {
      file: PROJECT_UI_STATE_FILE,
      tail: 'It is not committed, so these templates stay on this machine.',
    },
  },
  {
    id: 'mcp-connection',
    title: 'MCP connection',
    description: 'Which project the MCP leader is bound to, and one-time client setup.',
    icon: PlugIcon,
    component: McpConnectionSection,
    scope: 'project',
  },
  {
    // #284: the read-only reference of every tool the MCP server exposes. Beside MCP connection,
    // never inside it: connection is setup, this is review (spec § 12.1, § 18.1).
    id: 'mcp-api',
    title: 'MCP API',
    description: 'Every tool the MCP server exposes, read-only. Nothing here runs a tool.',
    icon: BookOpenIcon,
    component: McpApiSection,
    scope: 'project',
  },
  // ---- global scope (`/settings/global/…`) — the user and the machine, in mockup order -----
  {
    id: 'appearance',
    title: 'Appearance',
    description: 'Theme, accent and density.',
    icon: PaletteIcon,
    component: AppearanceSection,
    scope: 'global',
    fileNote: {
      lead: 'The theme is remembered in this browser; accent, density and reading width are saved in this project — ',
      file: WORKSPACE_UI_FILE,
    },
  },
  {
    id: 'notifications',
    title: 'Notifications',
    description: 'Browser notifications when an agent needs you.',
    icon: BellIcon,
    component: NotificationsSection,
    scope: 'global',
    fileNote: { file: WORKSPACE_UI_FILE },
  },
  {
    id: 'resources',
    title: 'Resources',
    description: 'Limits for tasks, memory and gate runs, across every project.',
    singleProjectDescription: 'Limits for tasks, memory and gate runs for this project.',
    icon: GaugeIcon,
    component: ResourcesSection,
    scope: 'global',
    fileNote: { file: WORKSPACE_CONFIG_FILE, tail: 'It is committed, so a clone starts with these limits.' },
  },
  {
    // #467 PR 5: START-UP choices, not concurrency limits — a row inside Resources would bury
    // "which projects does my cockpit open" under memory ceilings. The instance mode and, by the
    // owner's decision D-5, the `cli.output`, `cli.color` and `cli.logLevel` keys stored beside it.
    id: 'terminal',
    title: 'Terminal',
    description: 'How xezar behaves when you start it in a terminal.',
    icon: TerminalIcon,
    component: TerminalSection,
    scope: 'global',
    // Not "in the same mode": a folder that owns its state always serves one project, so the
    // instance mode is read-only there (design review B-2 on PR #798); what a clone inherits is
    // the terminal presentation.
    fileNote: { file: WORKSPACE_CONFIG_FILE, tail: 'It is committed, so a clone prints the same way.' },
  },
  {
    id: 'skills',
    title: 'Skills',
    description: 'Updates for skills installed on this machine.',
    icon: PackageCheckIcon,
    component: SkillsSection,
    scope: 'global',
    fileNote: {
      file: WORKSPACE_CONFIG_FILE,
      tail: 'The downloaded skills themselves stay on this machine and are not committed.',
    },
  },
  {
    id: 'accounts',
    title: 'Agent accounts',
    description: 'Second logins, and the agent and models a project uses when it has chosen none.',
    icon: IdCardIcon,
    component: AccountsSection,
    scope: 'global',
    fileNote: {
      file: AGENT_ACCOUNTS_FILE,
      tail: (
        <>
          The logins themselves stay on this machine; only which accounts to use travels. The
          defaults are saved in <code className="font-mono">{WORKSPACE_CONFIG_FILE}</code>.
        </>
      ),
    },
  },
  {
    id: 'projects',
    title: 'Projects',
    description: 'The workspace registry and where GitHub checkouts land.',
    icon: FoldersIcon,
    component: ProjectsSection,
    scope: 'global',
  },
  {
    id: 'keyboard',
    title: 'Keyboard',
    description: 'Shortcuts.',
    icon: KeyboardIcon,
    component: comingSoon('Keyboard', KeyboardIcon),
    scope: 'global',
    hidden: true,
  },
]

/** The one-liner a section shows: its single-project wording in that mode, when it has one. */
export function settingsSectionDescription(
  section: SettingsSection,
  capabilities?: Partial<ProjectModeCapabilities>,
): string {
  return (inSingleProjectRoot(capabilities) && section.singleProjectDescription) || section.description
}

/**
 * What one settings area's nav and route table actually show — hidden sections drop out
 * entirely, and so does everything belonging to the OTHER scope. The two areas are rendered by
 * the same shell, so this filter is the only thing keeping them apart.
 */
export function visibleSettingsSections(
  scope: SettingsScope,
  capabilities?: Partial<ProjectModeCapabilities>,
): SettingsSection[] {
  return SETTINGS_SECTIONS.filter(
    (section) =>
      !section.hidden &&
      section.scope === scope &&
      !(projectsLocked(capabilities) && section.id === 'projects'),
  )
}
