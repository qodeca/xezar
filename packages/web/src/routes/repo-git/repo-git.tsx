import { GitBranchIcon, TriangleAlertIcon } from 'lucide-react'

import { useRepo } from '@/api/queries'
import type { RepoInfo, RepoResponse } from '@qodeca/xezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { TabLink } from '@/components/tab-link'

import { BranchChip } from '../task-git/diff-controls'
import { RepoBranchesSection } from './repo-branches'
import { RepoChangesSection } from './repo-changes'
import { RepoCommitsSection } from './repo-commits'
import { RepoGitLoading } from './repo-git-loading'

/**
 * `/git` — the repo view rebuilt on the task git view's own components (spec §"Session git
 * view — Changes & Files tabs (#390)" last bullet, R5 Step 1.7): the MAIN working tree's
 * structured diff through the same `<Diff>` facade and tree, the recent-commit log with a
 * structured per-commit diff, and the branch list with switch/create + the agents'
 * base-branch picker. Forge-specific rows (PR links, checks) render only when
 * `/api/health` says the forge driver is available.
 *
 * The sections are underline segments — the same `TabLink` grammar as the run header's
 * Session | Changes | Files row — and each one is a URL (`/git`, `/git/commits[/:sha]`,
 * `/git/branches`), so every surface deep-links and survives a refresh.
 */
export type RepoTab = 'changes' | 'commits' | 'branches'

export function RepoGitRoute({ tab }: { tab: RepoTab }) {
  const repo = useRepo()

  if (repo.isPending) return <RepoGitLoading />
  if (repo.isError) {
    return (
      <div data-route="repo-git" className="flex min-h-full flex-col">
        <CenteredState
          icon={<TriangleAlertIcon />}
          tone="danger"
          title="Could not load the repository"
          subtitle={repo.error.message}
        />
      </div>
    )
  }
  const info = repo.data.info
  if (!info) {
    return (
      <div data-route="repo-git" className="flex min-h-full flex-col">
        <CenteredState
          icon={<GitBranchIcon />}
          tone="neutral"
          title="Not a git repository"
          subtitle="xezar is running outside a git repository — start it inside one to browse changes, commits and branches."
        />
      </div>
    )
  }
  return <RepoView repo={repo.data} info={info} tab={tab} />
}

function RepoView({ repo, info, tab }: { repo: RepoResponse; info: RepoInfo; tab: RepoTab }) {
  return (
    <div data-route="repo-git" className="flex min-h-full flex-col">
      {/* The run header's spacing (`md:px-section md:pt-group`, tabs `mt-stack`) and the canonical
          page title (`text-base font-semibold`, G-01): the phone top bar already names the page, so
          the heading is visible from `md` and stays a heading for assistive tech below it. It is
          not hidden like the list pages' header because the tabs live in it. */}
      <header
        data-slot="repo-header"
        className="sticky top-0 z-20 border-b border-border bg-background px-4 pt-stack md:px-section md:pt-group"
      >
        <div className="flex min-w-0 items-center gap-row">
          <h1 className="sr-only text-base font-semibold md:not-sr-only">Git</h1>
          <BranchChip branch={info.branch} />
          {info.remote ? (
            <span data-slot="repo-remote" className="hidden min-w-0 truncate text-[11px] text-soft-foreground md:inline">
              {info.remote}
            </span>
          ) : null}
        </div>

        <div data-slot="repo-tabs" className="mt-stack flex items-end gap-1">
          <TabLink to="/git" active={tab === 'changes'}>
            Changes
          </TabLink>
          <TabLink to="/git/commits" active={tab === 'commits'}>
            Commits
          </TabLink>
          <TabLink to="/git/branches" active={tab === 'branches'}>
            Branches
          </TabLink>
        </div>
      </header>

      {tab === 'changes' ? (
        <RepoChangesSection />
      ) : tab === 'commits' ? (
        <RepoCommitsSection log={repo.log} />
      ) : (
        <RepoBranchesSection repo={repo} info={info} />
      )}
    </div>
  )
}
