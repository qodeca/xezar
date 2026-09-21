import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, ExternalLinkIcon, IdCardIcon } from 'lucide-react'
import { Fragment, useState } from 'react'

import { ApiError, putWorkspaceConfig } from '@/api/client'

import {
  useAgentAccountDetails,
  useAgentProfiles,
  useHealth,
  useAgentAccountStatus,
  useConnectAgentAccount,
  useRecheckAgentAccount,
  useOpenAgentAccountFile,
  useOpenTargets,
  useProviderStatus,
  useRemoveAgentProfile,
  useRunnerModelCatalogs,
  useSelectAgentProfile,
  useUpdateAgentProfile,
  useWorkspaceConfig,
  workspaceQueryKeys,
} from '@/api/queries'
import {
  agentAccountRouteId,
  looksLikeAccountIdentity,
  unavailableAgentAccountReason,
  type AgentAccountProblem,
  type AgentProfile,
  type AgentProfilesResponse,
  type BackendCheck,
  type ProviderId,
  type Runner,
  type SetWorkspaceConfigInput,
} from '@qodeca/xezar-api-client'
import { CenteredState } from '@/components/centered-state'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { nativeFieldClass } from '@/components/ui/input'
import { RUNNER_LABEL } from '@/lib/runner-label'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'
import { Link } from '@/lib/project-router'
import { inSingleProjectRoot } from '@/lib/project-mode'
import { OpenInMenu, cliTargetRunner } from '@/components/open-in-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { DefaultAgentPicker, agentPickerRows } from '@/components/default-agent-picker'
import { modelCatalogStatus, modelsForRunner, RUNNERS } from '@/routes/new-task-form'
import { AddAccountDialog } from './add-account-dialog'
import { useReturnFocus } from './remove-project'

/**
 * Global settings → Agent accounts.
 *
 * Every agent stacked on one page (#819 PR 9, designs/agent-accounts-onboarding): the questions a
 * reader has are per agent — is it installed, which version, am I signed in, which folder, which
 * logins, and which one tasks use — and one tab at a time hid three of the four answers, which after
 * an import read as "the import lost my accounts". Each agent opens with a one-line fact heading so
 * "what's up with Codex" is still answered at a glance, and a saved choice that names a missing
 * account is reported at the top and in its agent's group, with its fix.
 *
 * The pane derives nothing it is sent: `selected` (the "In use" / "Default" marker) and `problems`
 * come from the server, which resolves them the way a run does. An absent field renders nothing.
 *
 * Global, for the same reason Projects and Resources are: a config dir describes the person and
 * the machine, never a repo.
 *
 * ## Identity is opt-in, and "hidden" means absent
 *
 * "Show details" reveals the email, organization and plan an account is signed in as. That is a
 * deliberate, narrow exception to the boundary `provider-auth.ts` keeps — "credentials, account
 * identity, and raw CLI output never cross this boundary" — so it is built to stay narrow: the data
 * is NOT a field on the accounts listing, it comes from its own on-demand route
 * (`useAgentAccountDetails`, `enabled` only once the row is expanded), and it is refused in hosted
 * mode. Nothing fetches it until a person asks, which is what makes "hidden by default" mean the
 * data is absent from the page rather than merely unrendered.
 *
 * Rename and Remove live in that same panel rather than on the collapsed row. A row is a reading
 * surface — which account, where, signed in or not — and Remove sitting on it put a destructive
 * action one stray click from a list you scan. Behind "Show details" it is one deliberate click,
 * beside the folder and identity it actually applies to.
 *
 * ## Three decisions worth reading
 *
 * 1. **The discovered account is listed but not editable.** It is what `agentHomePaths()` finds —
 *    which honours the vendors' own env vars — so it is a fact, not a setting.
 * 2. **A folder that does not exist yet is not an error.** The documented flow is *add the account
 *    → Connect → the CLI creates the folder*. What must NOT happen is falling back to another
 *    account at run time, and that refusal lives server-side.
 * 3. **Remove only ever DEREGISTERS.** No directory is touched, no session deleted. The confirm
 *    says so out loud, because "Remove" next to a path reads as "delete my folder".
 */

/** The vendor's own install/login instruction, shown when the CLI is not on this machine. */
const PROVIDER_INSTALL: Record<ProviderId, string> = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
  opencode: 'https://opencode.ai',
  pi: 'https://github.com/badlogic/pi-mono',
}

/** Same vocabulary the Providers card uses — one wording for "is this logged in?". */
const STATUS_PRESENTATION = {
  connected: { label: 'Connected', tone: 'success' },
  disconnected: { label: 'Not connected', tone: 'pending' },
  'not-installed': { label: 'Not installed', tone: 'neutral' },
  unknown: { label: 'Could not verify', tone: 'danger' },
} as const satisfies Record<string, { label: string; tone: StatusDotTone }>

export function AccountsSection() {
  const profiles = useAgentProfiles()

  if (profiles.isPending) {
    return (
      <p data-slot="accounts-loading" className="mx-auto w-full max-w-2xl p-list text-[13px] text-soft-foreground md:p-group">
        Loading agent accounts…
      </p>
    )
  }
  if (profiles.isError) {
    return (
      <CenteredState
        icon={<IdCardIcon />}
        tone="danger"
        title="Could not load agent accounts"
        subtitle={profiles.error.message}
        heading="h2"
      />
    )
  }
  return <AccountsPane data={profiles.data} />
}

/** Every agent gets a group, including one that cannot carry a second login: the group is where
 *  its install state and config folder live, and hiding OpenCode would just move the question
 *  "is OpenCode set up?" somewhere else. */
const PROVIDERS: readonly ProviderId[] = ['claude', 'codex', 'opencode', 'pi']

/** The id of an agent group's heading — the target of the problem summary's jump links. */
const groupHeadingId = (provider: ProviderId) => `accounts-agent-${provider}`

/** What the collapsed row calls an account (#819 PR 9 design § 7). The built-in login is named for
 *  what it is rather than "Default", and a label that reads as an identity is never printed. */
export function accountDisplayName(account: Pick<AgentProfile, 'isDefault' | 'label'>): string {
  if (account.isDefault) return 'Built-in login'
  return looksLikeAccountIdentity(account.label) ? 'Name hidden' : account.label
}

function AccountsPane({ data }: { data: AgentProfilesResponse }) {
  const health = useHealth()
  const projectRoot = inSingleProjectRoot(health.data?.capabilities)
  const [adding, setAdding] = useState<ProviderId | null>(null)
  const [confirming, setConfirming] = useState<AgentProfile | null>(null)
  const returnFocus = useReturnFocus(confirming !== null)
  const remove = useRemoveAgentProfile()
  // ABSENT is not "no problems": an older engine that never sent the key gets no summary, no
  // blocks and no counts, rather than a fabricated "all clear" (design § 6, stale and partial).
  const problems = data.problems
  const confirmingHidden = confirming !== null && looksLikeAccountIdentity(confirming.label)

  if (!data.editable) {
    return (
      <div
        data-slot="accounts-section"
        className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-list md:p-group"
      >
        <h2 className="text-sm font-semibold text-foreground">Agent accounts</h2>
        <p data-slot="accounts-hosted" className="text-[13px] text-soft-foreground">
          Agent accounts are managed from the machine that owns the checkout — this cockpit runs in
          hosted mode.
        </p>
      </div>
    )
  }

  return (
    <div
      data-slot="accounts-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-section p-list pb-[calc(90px+env(safe-area-inset-bottom))] md:p-group md:pb-group"
    >
      <div>
        <h2 className="text-sm font-semibold text-foreground">Agent accounts</h2>
        <p data-slot="accounts-lead" className="text-[13px] text-muted-foreground">
          {projectRoot
            ? 'Every agent, whether it is installed, and the logins you have for it. “In use” marks the login tasks in this project run under. The built-in login is the one each agent finds on this machine by itself; tasks use it when no other account is chosen.'
            : 'Every agent, whether it is installed, and the logins you have for it. “Default” marks the login a project runs under when it has not chosen one. The built-in login is the one each agent finds on this machine by itself; xezar uses it when no other account is chosen.'}
        </p>
      </div>

      {problems && problems.length > 0 ? <ProblemSummary problems={problems} /> : null}

      <DefaultsForNewProjects profiles={data} />

      {/* Stacked, not tabbed (#819 PR 9, design OD-1): four tabs showed one agent's list at a time,
          which after an import read as "the import failed". A one-line fact heading per agent keeps
          "what's up with Codex" answerable at a glance, and the jump links above reach a group. */}
      <div data-slot="accounts-tools" className="flex flex-col gap-section">
        {PROVIDERS.map((provider) => (
          <AgentGroup
            key={provider}
            provider={provider}
            projectRoot={projectRoot}
            // `checks` is read defensively: health is also patched in place from the WS topic and
            // seeded by route gates, so a partially-populated cache entry is a real state — and
            // "Checking…" is the honest thing to show for it.
            check={health.data?.checks?.find((c) => c.name === provider)}
            accounts={(data.profiles ?? []).filter((p) => p.provider === provider)}
            problems={problems?.filter((p) => p.provider === provider)}
            canCarryAccounts={(data.profileCapableProviders ?? []).includes(provider)}
            onAdd={() => setAdding(provider)}
            onRemove={setConfirming}
          />
        ))}
      </div>

      {/* Keyed by provider so reopening under a different agent starts from a clean form rather
          than the previous agent's half-typed folder. */}
      {adding !== null ? (
        <AddAccountDialog
          key={adding}
          open
          onOpenChange={(open) => !open && setAdding(null)}
          providers={data.profileCapableProviders}
          initialProvider={adding}
        />
      ) : null}

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent data-slot="accounts-remove-confirm" onCloseAutoFocus={returnFocus}>
          <AlertDialogHeader className="min-w-0">
            {/* An identity-shaped label is not printed even here (design § 7): the dialog opens
                from the collapsed row as often as from the details panel. */}
            <AlertDialogTitle>
              {confirmingHidden ? 'Remove this account?' : `Remove “${confirming?.label ?? ''}”?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This only forgets the account. Nothing in {confirming?.configDir} is deleted — not
              your login, not your sessions. Projects using it fall back to the default account,
              and tasks that ran under it can no longer be resumed from here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              data-action="accounts-remove-confirm"
              className={buttonVariants({ variant: 'danger' })}
              disabled={remove.isPending}
              onClick={() => {
                const target = confirming
                if (!target) return
                remove.mutate(target.id, {
                  onSuccess: () => {
                    setConfirming(null)
                    toast(looksLikeAccountIdentity(target.label) ? 'Account removed' : `Removed ${target.label}`)
                  },
                  // The server's own words: a 409 explains something this pane cannot infer.
                  onError: (error) => toast(error.message, { tone: 'danger' }),
                })
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * One agent: a fact heading (installed, version, how many logins, how many choices to fix), that
 * agent's problems with their fixes, then every login with the one in use marked in words.
 */
function AgentGroup({
  provider,
  projectRoot,
  check,
  accounts,
  problems,
  canCarryAccounts,
  onAdd,
  onRemove,
}: {
  provider: ProviderId
  projectRoot: boolean
  /** The `/api/v1/health` probe for this CLI — the ONE place a version can honestly come from. */
  check: BackendCheck | undefined
  accounts: AgentProfile[]
  /** This agent's problems; `undefined` when the server sent no `problems` key at all. */
  problems: AgentAccountProblem[] | undefined
  canCarryAccounts: boolean
  onAdd: () => void
  onRemove: (account: AgentProfile) => void
}) {
  const installed = check?.available === true
  const name = RUNNER_LABEL[provider]
  const headingId = groupHeadingId(provider)
  const count =
    accounts.length === 0 ? 'no accounts' : accounts.length === 1 ? '1 account' : `${accounts.length} accounts`
  const toFix = problems?.length ?? 0

  return (
    <section
      data-slot="accounts-provider"
      data-provider={provider}
      aria-labelledby={headingId}
      className="flex flex-col gap-stack"
    >
      {/* Facts about the BINARY, not about any one account: a version and an install are shared by
          every login of the same CLI, so they belong on the heading rather than on each row. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3
          id={headingId}
          // Focusable by script only: the problem summary's jump link moves focus HERE, not just
          // the scroll position, so a keyboard user continues from the agent they asked for.
          tabIndex={-1}
          className="text-[13px] font-semibold text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {name}
        </h3>
        <span data-slot="agent-facts" className="text-xs text-muted-foreground">
          {check === undefined ? (
            'Checking…'
          ) : installed ? (
            <>
              <span data-slot="agent-installed">Installed</span>
              {check.version ? (
                // The version is the first thing cut on a phone (design § 10).
                <span data-slot="agent-version" className="hidden md:inline">
                  {' · '}
                  <span className="font-mono">{check.version}</span>
                </span>
              ) : null}
              {` · ${count}`}
            </>
          ) : (
            <>
              <span data-slot="agent-installed">Not installed</span>
              {` · ${count}`}
            </>
          )}
        </span>
        {toFix > 0 ? (
          <span data-slot="agent-problem-count" className="flex items-center gap-1.5 text-xs text-foreground">
            <StatusDot tone="pending" />
            {toFix === 1 ? '1 choice to fix' : `${toFix} choices to fix`}
          </span>
        ) : null}
        {canCarryAccounts ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="accounts-add"
            data-provider={provider}
            onClick={onAdd}
            className="w-full md:ml-auto md:w-auto"
          >
            Add account
          </Button>
        ) : null}
      </div>

      {problems?.map((problem) => (
        <ProblemBlock
          key={`${problem.where}:${problem.handle}`}
          problem={problem}
          projectRoot={projectRoot}
        />
      ))}

      {accounts.length > 0 ? (
        <ul className="divide-y divide-border/60 rounded-md border border-border bg-card">
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              marker={projectRoot ? 'In use' : 'Default'}
              onRemove={() => onRemove(account)}
            />
          ))}
        </ul>
      ) : (
        // Inline, not a CenteredState tile: three other agents sit on the same page, and a tile per
        // empty agent would push them down for no information (design § 5).
        <p
          data-slot="accounts-provider-empty"
          className="rounded-md border border-border bg-card px-3.5 py-3 text-[13px] text-muted-foreground"
        >
          <span className="block font-medium text-foreground">No {name} accounts yet</span>
          {check !== undefined && !installed ? (
            <>
              {name} is not installed on this machine. Install it —{' '}
              <code className="text-[12px] break-all">{PROVIDER_INSTALL[provider]}</code> — and the
              login it finds appears here.
            </>
          ) : (
            `xezar lists the login ${name} finds on this machine and any account you add.${canCarryAccounts ? ' Use Add account to add one.' : ''}`
          )}
        </p>
      )}

      {!canCarryAccounts ? (
        <p data-slot="accounts-single-only" className="text-[11.5px] text-soft-foreground">
          {name} can only hold one account here: it keeps its credentials
          outside its config folder, so a second folder would change settings without changing the
          login — which would say “work account” while billing the other one.
        </p>
      ) : null}
    </section>
  )
}

/**
 * The pane-level line (#819 PR 9, design § 5 item 3): the agents are stacked and the affected one
 * may be screens away on a phone, so the count and a jump to each agent sit at the top.
 *
 * A polite live region, so a fix that changes the count is read out and the first render is not.
 */
function ProblemSummary({ problems }: { problems: AgentAccountProblem[] }) {
  const agents = PROVIDERS.filter((provider) => problems.some((p) => p.provider === provider))
  const n = problems.length
  return (
    <p
      data-slot="accounts-problems"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="flex items-start gap-2 text-[13px] text-foreground"
    >
      <StatusDot tone="pending" className="mt-1.5" />
      <span>
        {n === 1
          ? '1 account choice names an account that is not in this list.'
          : `${n} account choices name accounts that are not in this list.`}{' '}
        Tasks still run, with the built-in login. See{' '}
        {agents.map((provider, index) => (
          <Fragment key={provider}>
            {index > 0 ? ', ' : null}
            <a
              href={`#${groupHeadingId(provider)}`}
              data-action="accounts-problem-jump"
              data-provider={provider}
              className="inline-flex min-h-tap items-center text-foreground underline underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:min-h-0"
              onClick={(event) => {
                event.preventDefault()
                const heading = document.getElementById(groupHeadingId(provider))
                heading?.scrollIntoView?.({ block: 'start' })
                heading?.focus()
              }}
            >
              {RUNNER_LABEL[provider]}
            </a>
          </Fragment>
        ))}
        .
      </span>
    </p>
  )
}

/**
 * One stored choice that names no account, with what tasks do instead and the fix — the writing.md
 * §7 "message then Fix:" block. The pending tone, never danger: nothing is broken, a task still runs.
 *
 * The one-click fix is "Use the built-in login", because it is always valid and it is exactly what
 * tasks already do — it changes no run, it only makes the saved choice say what happens. It goes
 * through the existing selection route, which clears the choice. A project's own selection seen from
 * the global layout gets no button: the problem does not say WHICH project, so there is nothing
 * this pane could honestly clear.
 */
function ProblemBlock({ problem, projectRoot }: { problem: AgentAccountProblem; projectRoot: boolean }) {
  const select = useSelectAgentProfile()
  const name = RUNNER_LABEL[problem.provider]
  // The handle is the stored string; one that reads as an identity is left out of the sentence.
  const handle = looksLikeAccountIdentity(problem.handle) ? null : problem.handle
  const names = handle === null ? (
    <>names an account that is not in this list.</>
  ) : (
    <>
      names <code className="font-mono text-[12px] break-all">{handle}</code>, which is not in this
      list.
    </>
  )
  // `projectId: null` is the machine-wide default (the project's own default in single-project
  // mode); `default` is the boot project — the folder itself in single-project mode.
  const target: string | null | undefined =
    problem.where === 'defaults' ? null : projectRoot ? 'default' : undefined

  return (
    <div
      data-slot="account-problem"
      data-where={problem.where}
      data-provider={problem.provider}
      className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 px-3.5 py-3 text-[13px]"
    >
      <span className="flex items-start gap-2 text-foreground">
        <StatusDot tone="pending" className="mt-1.5" />
        <span>
          {problem.where === 'defaults' ? (
            projectRoot ? (
              <>The project default for {name} {names} Tasks use the built-in login instead.</>
            ) : (
              <>
                The default for new projects for {name} {names} Projects that have not chosen use
                the built-in login instead.
              </>
            )
          ) : projectRoot ? (
            <>This project’s own choice for {name} {names} Tasks use the built-in login instead.</>
          ) : (
            <>A project’s own choice for {name} {names} Its tasks use the built-in login instead.</>
          )}
        </span>
      </span>
      <span data-slot="account-problem-fix" className="text-muted-foreground">
        <b className="font-semibold text-foreground">Fix:</b>{' '}
        {problem.where === 'defaults' ? (
          projectRoot
            ? 'choose an account under Defaults for this project, or use the built-in login.'
            : 'choose an account under Defaults for new projects, or use the built-in login.'
        ) : projectRoot ? (
          <>
            choose an account in this project’s{' '}
            <Link
              to="/settings/agents"
              data-action="account-problem-agents-settings"
              className="text-foreground underline underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              Agents settings
            </Link>
            , or use the built-in login.
          </>
        ) : (
          'choose an account in that project’s Agents settings.'
        )}
      </span>
      {target !== undefined ? (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-action="account-problem-use-built-in"
            disabled={select.isPending}
            className="w-full md:w-auto"
            onClick={() =>
              select.mutate(
                { projectId: target, provider: problem.provider, profileId: null },
                {
                  onSuccess: () => toast(`${name} now uses the built-in login`),
                  onError: (error: Error) => toast(error.message, { tone: 'danger' }),
                },
              )
            }
          >
            {select.isPending ? 'Saving…' : 'Use the built-in login'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}


/**
 * What a project that has chosen nothing runs (spec 2026-07-29-agent-profiles).
 *
 * Lives on THIS page rather than one of its own: it is the same subject — the logins on this
 * machine — and a second page would mean setting up an account here and then going elsewhere to say
 * "use it". Above the tabs because it is a cross-agent answer; splitting it into the per-agent tabs
 * would mean visiting all three to read one fact.
 *
 * DEFAULTS, never overrides. A project's own `.xezar/config.json` still wins key by key, and a
 * project that has already picked an account keeps it — so changing these can never quietly
 * re-point work someone already configured onto another subscription. The copy says so, because
 * "default" alone does not distinguish the two.
 *
 * Two stores for one click, the same split the rest of the feature makes: the runner and models go
 * to `~/.xezar/config.json`, the account to `~/.xezar/agent-accounts.json`. Neither is committable —
 * that is the point of them being here rather than in a repo's settings.
 */
function DefaultsForNewProjects({ profiles }: { profiles: AgentProfilesResponse }) {
  const queryClient = useQueryClient()
  const config = useWorkspaceConfig()
  const providerStatus = useProviderStatus()
  // A row per runner, so every runner's own host catalog is needed at once (#794).
  const catalogs = useRunnerModelCatalogs()
  const select = useSelectAgentProfile()
  const projectRoot = inSingleProjectRoot(useHealth().data?.capabilities)

  const save = useMutation({
    mutationFn: (patch: SetWorkspaceConfigInput) => putWorkspaceConfig(patch),
    onSuccess: (result) => queryClient.setQueryData(workspaceQueryKeys.config, result),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  if (config.data === undefined) return null

  const rows = agentPickerRows(profiles.profiles)
  // Absent means "no opinion", and the built-in fallback is claude — the same answer a project with
  // no config gets today. Showing it checked is honest: it IS what an unconfigured project runs.
  const runner = config.data.agentDefaults.runner ?? 'claude'
  const models = config.data.agentDefaults.models ?? {}

  return (
    <section data-slot="accounts-defaults" className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-3.5">
      <div>
        {/* In single-project mode there are no "new projects" — the workspace IS this folder — so
            the card names what it actually sets (#600 OD-5, a #611 review follow-up). */}
        <h3 className="text-[13px] font-semibold text-foreground">
          {projectRoot ? 'Defaults for this project' : 'Defaults for new projects'}
        </h3>
        <p className="text-[13px] text-muted-foreground">
          {projectRoot
            ? 'What a task in this project runs when it does not choose for itself. Saved with the project, so a clone starts with the same choice.'
            : 'What a project runs when it has not chosen for itself — set once instead of per repository. A project that has chosen keeps its own.'}
        </p>
      </div>

      <DefaultAgentPicker
        rows={rows}
        runner={runner}
        accountFor={(id) => profiles.defaults[id] ?? null}
        providerStatus={providerStatus}
        disabled={save.isPending}
        accountDisabled={select.isPending}
        onPick={(picked, account, hasAccountChoice) => {
          if (picked !== runner) save.mutate({ agentDefaults: { runner: picked } })
          // `projectId: null` targets the machine-wide default rather than one repo. Only for an
          // agent that HAS a choice of accounts: a single-login agent must not write a selection,
          // or the store fills up with rows that say nothing.
          if (hasAccountChoice) {
            select.mutate(
              { projectId: null, provider: picked, profileId: account },
              { onError: (error: Error) => toast(error.message, { tone: 'danger' }) },
            )
          }
        }}
      />

      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted-foreground">Default model per agent</span>
        {RUNNERS.map((entry) => (
          <label key={entry.id} className="flex items-center gap-3">
            <span className="w-24 shrink-0 font-mono text-xs text-muted-foreground">{entry.label}</span>
            <select
              aria-label={`Default model for ${entry.label}`}
              data-slot="accounts-default-model"
              data-runner={entry.id}
              value={models[entry.id] ?? ''}
              disabled={save.isPending}
              onChange={(event) =>
                save.mutate({
                  // `null` clears the key back to "no opinion" — absence cannot say that in a
                  // partial patch, and a stale value would keep seeding every unconfigured project.
                  agentDefaults: {
                    models: { [entry.id]: event.target.value || null } as Partial<
                      Record<Runner, string | null>
                    >,
                  },
                })
              }
              className={cn(nativeFieldClass, 'block max-w-xs')}
            >
              {modelsForRunner(entry.id, catalogs[entry.id].data, [models[entry.id]]).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id === '' ? 'auto (default)' : model.label}
                </option>
              ))}
              {modelCatalogStatus(entry.id, catalogs[entry.id].data, catalogs[entry.id].isError) ? (
                <option disabled>
                  {modelCatalogStatus(entry.id, catalogs[entry.id].data, catalogs[entry.id].isError)}
                </option>
              ) : null}
            </select>
          </label>
        ))}
      </div>
    </section>
  )
}

/**
 * The contract's unavailable sentence with its path in the mono face, as the #604 mockup renders it
 * (`settings.html`, `<span class="mono">`). The text stays byte-identical to
 * `unavailableAgentAccountReason` — only the path's face changes (#612 review m3, design NB-1).
 */
function UnavailableReason({ configDir }: { configDir: string }) {
  const reason = unavailableAgentAccountReason(configDir)
  const at = reason.indexOf(configDir)
  if (at < 0) return <>{reason}</>
  return (
    <>
      {reason.slice(0, at)}
      <span data-slot="account-unavailable-path" className="font-mono">{configDir}</span>
      {reason.slice(at + configDir.length)}
    </>
  )
}

function AccountRow({
  account,
  marker,
  onRemove,
}: {
  account: AgentProfile
  /** The word for `selected`: "In use" for this project, "Default" for the machine-wide choice. */
  marker: 'In use' | 'Default'
  onRemove: () => void
}) {
  const [showDetails, setShowDetails] = useState(false)
  const routeId = agentAccountRouteId(account)
  const connect = useConnectAgentAccount()
  const recheck = useRecheckAgentAccount()
  // The listing carries a status whenever the server has one cached — which, after its boot warm,
  // is the normal case. Only ask for a probe when it does not: an account added mid-session, or a
  // cache that has aged out. Either way the row renders immediately.
  const probed = useAgentAccountStatus(routeId, account.status === undefined)
  const status = account.status ?? probed.data?.status
  const presentation = status ? STATUS_PRESENTATION[status.status] : undefined
  // Single-project mode (#600 FR-6, DP-5): accounts are committed project state, so a folder that
  // does not exist here is a clone naming a login this machine lacks — not an account the user just
  // added. It reads "Unavailable" with the engine's own refusal sentence, and a task asking for it
  // is refused with that sentence too (`unavailableAgentAccountRefusal`). Global mode keeps
  // "folder not created yet; Connect will make it", which is true there.
  const unavailable = inSingleProjectRoot(useHealth().data?.capabilities) && !account.isDefault && !account.exists
  // A label someone typed as their address is identity by another road, and in single-project mode
  // it sits in a committed file: the collapsed row never prints it (design § 7, DA-6).
  const labelHidden = !account.isDefault && looksLikeAccountIdentity(account.label)

  return (
    <li
      data-slot="account-row"
      data-account={account.id}
      data-built-in={account.isDefault}
      data-selected={account.selected === true}
      {...(labelHidden ? { 'data-label-hidden': true } : {})}
      className="flex flex-col gap-2 px-3.5 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              data-slot="account-name"
              className={cn('text-[13px] font-medium', labelHidden ? 'text-muted-foreground' : 'text-foreground')}
            >
              {accountDisplayName(account)}
            </span>
            {/* Words first, the icon only reinforces — "In use" never rests on a tint. */}
            {account.selected === true ? (
              <Badge variant="outline" data-slot="account-in-use" className="shrink-0">
                <CheckIcon aria-hidden="true" />
                {marker}
              </Badge>
            ) : null}
          </div>
          <p
            data-slot="account-path"
            className="mt-0.5 font-mono text-[11.5px] break-all text-soft-foreground"
            title={account.path}
          >
            {account.configDir}
          </p>
          {account.isDefault ? (
            <p data-slot="account-built-in" className="mt-0.5 text-xs text-muted-foreground">
              Found on this machine — xezar does not save it.
            </p>
          ) : labelHidden ? (
            <p data-slot="account-name-hidden" className="mt-0.5 text-xs text-muted-foreground">
              The name looks like an e-mail address, so it is not shown here. Show details to see it or
              rename it.
            </p>
          ) : null}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {/* "Checking…" is a real, distinct state from any probe RESULT: the answer is not in
                yet. Showing `unknown` here would claim a verification that never ran. */}
            {unavailable ? (
              <>
                <StatusDot tone="danger" />
                <span data-slot="account-status">Unavailable</span>
                <span data-slot="account-unavailable">— <UnavailableReason configDir={account.configDir} /></span>
              </>
            ) : (
              <>
                <StatusDot tone={presentation?.tone ?? 'neutral'} pulse={presentation === undefined} />
                <span data-slot="account-status">{presentation?.label ?? 'Checking…'}</span>
              </>
            )}
            {unavailable ? null : !account.exists ? (
              <span data-slot="account-missing">— folder not created yet; Connect will make it</span>
            ) : !account.looksValid ? (
              <span data-slot="account-unrecognised">
                — this folder does not look like {RUNNER_LABEL[account.provider]} config yet
              </span>
            ) : null}
          </div>
        </div>

        {/* The collapsed row is a READING surface — which account, where, is it signed in. Every
            action that CHANGES or DESTROYS something lives one deliberate click away, inside the
            panel below. Connect and Check again are the two exceptions, and deliberately so: they
            are how an account becomes usable at all, and the row's own "folder not created yet"
            copy points at Connect. Burying the only sign-in path behind "Show details" is what left
            an added account with no way to log in. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {status?.status !== 'connected' ? (
            <Button
              type="button"
              size="sm"
              data-action="account-connect"
              disabled={connect.isPending}
              onClick={() =>
                connect.mutate(
                  { provider: account.provider, ...(account.isDefault ? {} : { profileId: account.id }) },
                  {
                    onSuccess: (result) =>
                      toast(result.opened
                        ? 'Finish signing in in the terminal, then Check again.'
                        : 'This account is already connected.'),
                    // The server answers a copyable command when it cannot open a terminal (hosted
                    // mode, no emulator, a folder it refuses to embed). Showing it is the whole
                    // point of failing closed rather than running the bare login.
                    onError: (error: Error) =>
                      toast(error instanceof ApiError && error.command
                        ? `${error.message} — run: ${error.command}`
                        : error.message, { tone: 'danger' }),
                  },
                )
              }
            >
              Connect
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-action="account-recheck"
            disabled={recheck.isPending}
            title="Re-probe this account’s login now, instead of waiting for the cached answer"
            onClick={() =>
              recheck.mutate(routeId, {
                onError: (error: Error) => toast(error.message, { tone: 'danger' }),
              })
            }
          >
            Check again
          </Button>
          {/* Identity is opt-in: nothing is requested until this is pressed, so an email is absent
              from the page rather than merely unrendered. */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-action="account-details-toggle"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((on) => !on)}
          >
            {showDetails ? 'Hide details' : 'Show details'}
          </Button>
        </div>
      </div>

      {showDetails ? (
        <AccountDetails account={account} routeId={routeId} onRemove={onRemove} />
      ) : null}
    </li>
  )
}

/** The opt-in half of a row: who this login is, its own config files, and managing it. */
function AccountDetails({
  account,
  routeId,
  onRemove,
}: {
  account: AgentProfile
  routeId: string
  onRemove: () => void
}) {
  const details = useAgentAccountDetails(routeId, true)
  const open = useOpenAgentAccountFile()
  const targets = useOpenTargets()
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(account.label)
  const rename = useUpdateAgentProfile()

  // Which detected apps can actually act on each thing — the same rule the route enforces, so the
  // menu never offers something that would come back a 400. A `cli:<runner>` handoff opens a task
  // worktree, not a config folder; a terminal runs `cd <path>`, which is meaningless for a file.
  const detected = targets.data?.targets ?? []
  const fileChoices = detected
    .filter((t) => cliTargetRunner(t.id) === undefined && t.id !== 'terminal' && t.id !== 'finder')
    .map((target) => ({ target }))
  const folderChoices = detected
    .filter((t) => cliTargetRunner(t.id) === undefined)
    .map((target) => ({ target }))

  const openPath = (file: string, label: string, target?: string) =>
    open.mutate(
      { routeId, file, ...(target ? { target } : {}) },
      {
        // The server's own words: "this account has no settings.json yet", "could not open …".
        onError: (error) => toast(error.message, { tone: 'danger' }),
        onSuccess: () => toast(`Opened ${label}`),
      },
    )

  return (
    <div data-slot="account-details" className="rounded-md border border-border/60 bg-muted/30 p-3">
      {details.isPending ? (
        <p className="text-xs text-muted-foreground">Reading account details…</p>
      ) : details.isError ? (
        <p data-slot="account-details-error" className="text-xs text-danger">
          {details.error.message}
        </p>
      ) : details.data.available ? (
        <dl data-slot="account-identity" className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {details.data.fields.map((field) => (
            <Fragment key={field.label}>
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="min-w-0 truncate text-foreground" title={field.value}>
                {field.value}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        // Honest about WHY there is nothing, rather than an empty panel.
        <p data-slot="account-identity-unavailable" className="text-xs text-muted-foreground">
          {details.data.reason ?? 'No account details to show.'}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2.5">
        <span className="mr-1 text-xs text-muted-foreground">Config files</span>
        {account.files.map((file) => (
          <OpenInMenu
            key={file.id}
            slot="account-open-file"
            label={file.label}
            triggerVariant="outline"
            disabled={open.isPending}
            // A file the agent has not written yet is offered but says so, because "Connect then
            // it appears" is the normal path and a hidden button would look like a missing feature.
            title={file.exists ? file.path : `${file.path} — not created yet`}
            choices={fileChoices}
            onPick={(target) => openPath(file.id, file.label, target)}
            leading={
              <DropdownMenuItem
                data-target="system"
                onSelect={() => openPath(file.id, file.label)}
              >
                <ExternalLinkIcon aria-hidden="true" />
                System default
              </DropdownMenuItem>
            }
          />
        ))}
        <OpenInMenu
          slot="account-open-folder"
          label="Folder"
          disabled={open.isPending}
          title={account.path}
          choices={folderChoices}
          onPick={(target) => openPath('folder', 'folder', target)}
          leading={
            <DropdownMenuItem data-target="system" onSelect={() => openPath('folder', 'folder')}>
              <ExternalLinkIcon aria-hidden="true" />
              System default
            </DropdownMenuItem>
          }
        />
      </div>

      {/* The discovered account carries no Rename/Remove at all — it is what xezar found, so either
          would imply a setting that does not exist. Nothing is rendered for it, not a disabled
          control, because a greyed-out Remove reads as "not allowed yet" rather than "not a thing". */}
      {account.isDefault ? null : (
        <div
          data-slot="account-manage"
          className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-2.5"
        >
          <span className="mr-1 text-xs text-muted-foreground">Account</span>
          {renaming ? (
            <>
              <input
                type="text"
                autoFocus
                aria-label={`Name for ${account.label}`}
                data-slot="account-rename-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className={cn(nativeFieldClass, 'w-48')}
              />
              <Button
                type="button"
                size="sm"
                data-action="account-rename-save"
                disabled={rename.isPending || draft.trim() === '' || draft.trim() === account.label}
                onClick={() =>
                  rename.mutate(
                    { id: account.id, label: draft.trim() },
                    {
                      onSuccess: () => setRenaming(false),
                      onError: (error) => toast(error.message, { tone: 'danger' }),
                    },
                  )
                }
              >
                Save
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDraft(account.label)
                  setRenaming(false)
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-action="account-rename"
                onClick={() => setRenaming(true)}
              >
                Rename
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-action="account-remove"
                onClick={onRemove}
              >
                Remove
              </Button>
              {/* The label is xezar's own; the folder is the account. Saying so here is what keeps
                  Rename from reading as "point this at a different directory". */}
              <span className="text-xs text-muted-foreground">
                Renaming changes what xezar calls this account, not its folder.
              </span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
