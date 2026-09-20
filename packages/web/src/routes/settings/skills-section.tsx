import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PackageCheckIcon } from 'lucide-react'

import { putWorkspaceConfig } from '@/api/client'
import { useProjects, useSkillsUpdate, useWorkspaceConfig, workspaceQueryKeys } from '@/api/queries'
import type {
  SetWorkspaceConfigInput,
  SkillsCatalogCommit,
  SkillsCatalogVersion,
  WorkspaceConfigResponse,
} from '@qodeca/xezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { shortAge } from '@/lib/format'

/** The updater's reason for a missing lock file (`skills-update.ts`, `checkScope`). */
const NOT_TRACKED = 'installation is not tracked'

const CATALOG_STATE_LABEL: Record<SkillsCatalogVersion['state'], string> = {
  'up-to-date': 'Up to date',
  'update-available': 'Update available',
  unknown: 'Version unknown',
}

/** `1.1.0 (de525c6, 2026-09-20)`, or the short sha alone when no tag is reachable. */
export function catalogVersionText(commit: SkillsCatalogCommit | undefined): string {
  if (!commit) return '—'
  return commit.tag
    ? `${commit.tag} (${commit.shortCommit}, ${commit.date})`
    : `${commit.shortCommit} (${commit.date})`
}

/**
 * One sentence saying what is being tracked and how fresh the answer is. "Available" is
 * upstream as THIS MACHINE last saw it — there is no live upstream read (#744) — so the copy
 * says "last checked", never anything that claims to know upstream right now.
 */
export function catalogExplanation(entry: SkillsCatalogVersion, now = Date.now()): string {
  if (!entry.installed && !entry.available) {
    return 'xezar has not read this catalog clone yet — it appears once the skills are first loaded.'
  }
  if (!entry.fetchedAt) {
    return `Tracking ${entry.repo} ${entry.ref} — this machine has not checked upstream yet.`
  }
  return `Tracking ${entry.repo} ${entry.ref} — last checked ${shortAge(entry.fetchedAt, now)} ago.`
}

function CatalogSection({ catalog }: { catalog: SkillsCatalogVersion[] }) {
  return (
    <section data-slot="skills-catalog-version" className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Skill catalog</h2>
        <p className="text-[13px] text-muted-foreground">
          The team skills this cockpit serves, and the version it last saw upstream.
        </p>
      </div>
      {catalog.length === 0 ? (
        <p data-slot="skills-catalog-empty" className="text-[13px] text-soft-foreground">
          No team skill source is configured.
        </p>
      ) : (
        catalog.map((entry) => (
          <div
            key={`${entry.repo}@${entry.ref}`}
            data-slot="skills-catalog-source"
            className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 px-3 py-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-foreground">{entry.repo}</span>
              <Badge variant="outline" data-slot="skills-catalog-state">
                {CATALOG_STATE_LABEL[entry.state]}
              </Badge>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <dt>Installed</dt>
              <dd data-slot="skills-catalog-installed">{catalogVersionText(entry.installed)}</dd>
              <dt>Available</dt>
              <dd data-slot="skills-catalog-available">{catalogVersionText(entry.available)}</dd>
            </dl>
            <p className="text-[11px] text-soft-foreground">{catalogExplanation(entry)}</p>
          </div>
        ))
      )}
    </section>
  )
}

export function SkillsSection() {
  const config = useWorkspaceConfig()
  const projects = useProjects()
  const projectId = projects.data?.bootProject ?? ''
  const update = useSkillsUpdate(projectId, Boolean(projectId))

  if (config.isPending) {
    return (
      <p data-slot="skills-settings-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading skill settings…
      </p>
    )
  }
  if (config.isError) {
    return (
      <CenteredState
        icon={<PackageCheckIcon />}
        tone="danger"
        title="Could not load skill settings"
        subtitle={config.error.message}
        heading="h2"
      />
    )
  }
  return <SkillsForm config={config.data} update={update.data} updateError={update.error} />
}

function SkillsForm({
  config,
  update,
  updateError,
}: {
  config: WorkspaceConfigResponse
  update?: ReturnType<typeof useSkillsUpdate>['data']
  updateError: Error | null
}) {
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => queryClient.setQueryData(workspaceQueryKeys.config, result),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const inherited = config.skillsAutoUpdate === null
  const status = (() => {
    if (updateError) return 'Installation status is unavailable right now.'
    if (!update) return 'Checking tracked xezar-skills installations…'
    if (update.status === 'unavailable')
      return update.scopes.find((scope) => scope.reason)?.reason ?? 'Automatic skill updates are unavailable.'
    // A `current` scope with a reason is one the updater deliberately left alone. The server's
    // "installation is not tracked" is what the quiet line below already says; any other reason
    // (skills installed from another source) is the one the user needs to read.
    const explained =
      update.status === 'current'
        ? update.scopes.map((scope) => scope.reason).find((reason) => reason && reason !== NOT_TRACKED)
        : undefined
    if (explained) return explained
    if (update.scopes.every((scope) => scope.skills.length === 0))
      return 'No tracked xezar-skills installation found.'
    const count = new Set(update.scopes.flatMap((scope) => scope.skills)).size
    return `${count} tracked xezar-skills skill${count === 1 ? '' : 's'} found.`
  })()

  return (
    <div
      data-slot="skills-settings-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-list pb-[calc(90px+env(safe-area-inset-bottom))] md:p-group md:pb-group"
    >
      {update ? <CatalogSection catalog={update.catalog} /> : null}
      <section className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              <label htmlFor="skills-auto-update">Update xezar-skills automatically</label>
            </h2>
            <p className="text-[13px] text-muted-foreground">
              Checks installed xezar-skills in the background and applies available updates. Other
              skills and untracked folders are never changed.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Switch
              id="skills-auto-update"
              data-slot="skills-auto-update"
              checked={config.effectiveSkillsAutoUpdate}
              disabled={save.isPending}
              onCheckedChange={(checked) => save.mutate({ skillsAutoUpdate: checked })}
            />
            <span className="text-[11px] text-soft-foreground">
              {config.effectiveSkillsAutoUpdate ? 'On' : 'Off'}
              {inherited ? ' (default)' : ''}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span>
            {inherited
              ? 'No override is saved. XEZ_SKILLS_AUTO_UPDATE supplies the inherited default when set; otherwise it is on.'
              : 'An explicit workspace override is saved.'}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-action="skills-use-default"
            disabled={inherited || save.isPending}
            onClick={() => save.mutate({ skillsAutoUpdate: null })}
          >
            Use default
          </Button>
        </div>
        <p
          data-slot="skills-installation-status"
          role={updateError || update?.status === 'unavailable' ? 'status' : undefined}
          className="text-[13px] text-soft-foreground"
        >
          {status}
        </p>
      </section>
    </div>
  )
}
