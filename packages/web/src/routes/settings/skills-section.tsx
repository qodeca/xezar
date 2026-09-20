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
import { useNow } from '@/lib/use-now'
import { SettingsField } from './settings-field'

/** The updater's reason for a missing lock file (`skills-update.ts`, `checkScope`). */
const NOT_TRACKED = 'installation is not tracked'

/**
 * One word per state, and "Version unknown" belongs to ONE of them (#747, design review B-1):
 * the case where there is no local copy and therefore no version to print. When the two versions
 * ARE printed, the badge never contradicts them — a stale check says so about the CHECK, and two
 * versions that cannot be lined up say so about the COMPARISON.
 *
 * "Not checked yet" is the same rule applied to `never-checked` (#752, code review M1 / design
 * review B-1): the two printed versions are known and identical, so a badge saying the COMPARISON
 * is unknown contradicts them just as "Version unknown" would. What is missing is the check, and
 * the badge says that — the author's call the design review left open, recorded in the PR body.
 */
export function catalogStateLabel(entry: SkillsCatalogVersion): string {
  switch (entry.state) {
    case 'up-to-date':
      return 'Up to date'
    case 'update-available':
      return 'Update available'
    case 'stale-check':
      return 'Check is stale'
    case 'never-checked':
      return 'Not checked yet'
    default:
      return entry.installed || entry.available ? 'Comparison unknown' : 'Version unknown'
  }
}

/** `Sep 20, 2026` — a date a reader reads, in their own locale (`writing.md` §12). */
function catalogDateText(date: string): string {
  const at = new Date(`${date}T00:00:00`)
  if (Number.isNaN(at.getTime())) return date
  return at.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * `v1.1.0 (de525c6, Sep 20, 2026)`, the distance in words when the tag is not exact
 * (`1 commit after v1.1.0 (…)`), or the short sha alone when no tag is reachable.
 *
 * Never `git describe`'s own `v1.1.0-1-g769ebc7` (#747, design review NB-1): it prints the hash
 * twice and its `-1-g` suffix is git's notation, not the page's.
 */
export function catalogVersionText(commit: SkillsCatalogCommit | undefined): string {
  if (!commit) return '—'
  const when = catalogDateText(commit.date)
  if (!commit.tag) return `${commit.shortCommit} (${when})`
  const after = commit.commitsSinceTag ?? 0
  const version = after > 0 ? `${after} commit${after === 1 ? '' : 's'} after ${commit.tag}` : commit.tag
  return `${version} (${commit.shortCommit}, ${when})`
}

/**
 * One sentence PER STATE (#747, design review B-1 and B-2): what is tracked, how fresh the answer
 * is, and — where there is one — what to do next. "Available" is upstream as THIS MACHINE last saw
 * it: there is no live upstream read (#744), so the copy says "last checked", never anything that
 * claims to know upstream right now.
 */
export function catalogExplanation(entry: SkillsCatalogVersion, now = Date.now()): string {
  if (!entry.installed && !entry.available) {
    // No promise the page cannot keep (#747, NB-4): a source this machine can never reach stays
    // exactly here, and the sentence says so rather than announcing an arrival.
    return `xezar has not read ${entry.repo} yet, so there is no version to show — it fills in the first time these skills load, and stays here while the source cannot be reached.`
  }
  const tracking = `Tracking ${entry.repo} ${entry.ref}`
  const age = entry.fetchedAt ? `${shortAge(entry.fetchedAt, now)} ago` : ''
  if (entry.state === 'stale-check') {
    // #752, L-5: the state names its next step, the way "Update available" does — the same
    // Refresh re-checks upstream, and a sentence that stops at the problem leaves the reader
    // looking for the button (`writing.md`).
    return `${tracking} — the last upstream check is older than six hours${age ? ` (${age})` : ''}, so the versions above are as of then. Use Refresh on the Skills page to re-check upstream.`
  }
  const checked = age ? `last checked ${age}` : 'this machine has not checked upstream yet'
  if (entry.state === 'update-available') {
    return `${tracking} — ${checked}. Use Refresh on the Skills page to start serving the newer version.`
  }
  // #752, code review M1 / design review B-1: no successful check on record, and the two commits
  // this machine CAN read are the same one. The old sentence told the reader that a commit shares
  // no history with itself. The commit test is deliberately here as well as in `compareState`:
  // "share no history" must be unreachable for one commit compared with itself, whatever state a
  // future server sends. It names the same next step the other sentences do (L-5).
  if (
    entry.state === 'never-checked' ||
    (entry.state === 'unknown' &&
      entry.installed &&
      entry.available &&
      entry.installed.commit === entry.available.commit)
  ) {
    return `${tracking} — this machine has not checked upstream yet, so it cannot say whether these versions are current. Use Refresh on the Skills page to check.`
  }
  if (entry.state === 'unknown') {
    // Two ways to have a version and still no comparison, and they are not the same sentence:
    // one side could not be read at all, or both were read and share no history.
    return !entry.installed || !entry.available
      ? `${tracking} — ${checked}, and only one of the two versions could be read, so there is nothing to compare.`
      : `${tracking} — ${checked}, and these two versions share no history, so they cannot be compared.`
  }
  return `${tracking} — ${checked}.`
}

/**
 * What a screen reader hears when this block changes, and nothing else (#752, L-1).
 *
 * The announcement is the STATE, never the age: the visible sentence carries a "last checked 1m
 * ago" that `useNow` re-renders every 30 s, and while that text sat inside the live region a
 * screen reader re-read the whole sentence once a minute for as long as the page was open.
 * `behaviour.md` §2 keeps polite announcements for a changed count or a background completion,
 * which is exactly the cold-boot transition this region exists for (#747, NB-6).
 */
export function catalogAnnouncement(
  catalog: SkillsCatalogVersion[] | undefined,
  error: Error | null,
): string {
  // Never word for word what is already on screen: the announcer is a second copy of the same
  // fact, and two identical texts read twice to anyone browsing the region rather than hearing it.
  if (error && !catalog) return 'Skill catalog: the version is unavailable right now.'
  if (!catalog) return 'Skill catalog: checking the version…'
  if (catalog.length === 0) return 'Skill catalog: no team skill source is configured.'
  return catalog.map((entry) => `${entry.repo}: ${catalogStateLabel(entry)}.`).join(' ')
}

/**
 * The block keeps its place on the page from the first paint (#747, design review NB-5): the
 * heading and hint render while the request is in flight and when it fails, so nothing below it
 * moves under the pointer, and the pending body reserves about one card's height (#752, L-3) so
 * the automatic-update switch below does not jump when the catalog answer lands.
 *
 * The polite live region is the `sr-only` announcer alone (#752, L-1) — a cold boot turns
 * "Version unknown" into a real state with no interaction to announce it (#747, NB-6), and the
 * announcer says which state that is without carrying the ticking age into the announcement.
 */
function CatalogFields({
  catalog,
  error,
}: {
  catalog: SkillsCatalogVersion[] | undefined
  error: Error | null
}) {
  const now = useNow(30_000)
  return (
    <SettingsField
      title="Skill catalog"
      hint="The team skills this cockpit serves, and the version it last saw upstream — the automatic-update switch below does not apply to it."
    >
      <div data-slot="skills-catalog-version" className="flex flex-col gap-stack">
        {/* Two hardenings, both #752 design review NB-3. `aria-atomic` so the behaviour is defined
            rather than left to the reader: with more than one source this is ONE text node, and a
            partial-node announcement of a multi-source change is not something screen readers
            agree on. `role="status"` gives the region a defined role to go with it, so a reader
            browsing line by line meets a status message rather than an unexplained second copy of
            the card's own words — the duplicate reading the review recorded as acceptable. */}
        <span
          data-slot="skills-catalog-announcement"
          className="sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {catalogAnnouncement(catalog, error)}
        </span>
        {/* A failed BACKGROUND refetch keeps the last good answer on screen: the error body is for
            the case where there is nothing else to show, not for every error the hook has held. */}
        {error && !catalog ? (
          <p data-slot="skills-catalog-error" className="text-[13px] text-soft-foreground">
            The skill catalog version is unavailable right now.
          </p>
        ) : !catalog ? (
          // One card's height, on the numeric spacing scale so the density lever still moves it:
          // the switch below must not shift when the answer lands (#752, L-3).
          <p data-slot="skills-catalog-pending" className="min-h-28 text-[13px] text-soft-foreground">
            Checking…
          </p>
        ) : catalog.length === 0 ? (
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
                <span className="font-mono text-xs font-medium text-foreground">{entry.repo}</span>
                <Badge variant="outline" data-slot="skills-catalog-state">
                  {catalogStateLabel(entry)}
                </Badge>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <dt>Installed</dt>
                <dd data-slot="skills-catalog-installed" className="font-mono">
                  {catalogVersionText(entry.installed)}
                </dd>
                <dt>Available</dt>
                <dd data-slot="skills-catalog-available" className="font-mono">
                  {catalogVersionText(entry.available)}
                </dd>
              </dl>
              <p className="text-[11px] text-soft-foreground">{catalogExplanation(entry, now)}</p>
            </div>
          ))
        )}
      </div>
    </SettingsField>
  )
}

export function SkillsSection() {
  const config = useWorkspaceConfig()
  const projects = useProjects()
  const projectId = projects.data?.bootProject ?? ''
  const update = useSkillsUpdate(projectId, Boolean(projectId))

  if (config.isPending) {
    return (
      <p data-slot="skills-settings-loading" className="mx-auto w-full max-w-2xl p-list text-[13px] text-soft-foreground md:p-group">
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
      <CatalogFields catalog={update?.catalog} error={updateError} />
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
