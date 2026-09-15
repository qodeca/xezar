/**
 * The 0.15.0 screenshot contract — one row per cockpit state, with the theme × width variants
 * each state is captured in.
 *
 * Source: the #448 plan's § 3.2 table (19 states). The plan's prose says "40 files", but its own
 * variants column adds up to 36; this list follows the column, because the column is the only
 * place the exact names are written down. `docs-screenshots.test.ts` (packages/web/src) reads
 * this file to prove every name exists on disk within its size budget, and the capture harness
 * reads it to decide what to shoot, so the two cannot disagree.
 *
 * Plain data with no imports on purpose: the unit test imports it from the jsdom project, and
 * the harness imports it from the node e2e project.
 */

export type Theme = 'dark' | 'light'
export type Width = 1280 | 375

export interface ShotState {
  /** File-name stem: `<name>-<theme>-<width>.png`. */
  name: string
  /** What the picture shows, in words — copied into docs/screenshots/0.15.0/README.md. */
  shows: string
  variants: ReadonlyArray<readonly [Theme, Width]>
}

const both1280 = [['dark', 1280], ['light', 1280]] as const
const all4 = [['dark', 1280], ['light', 1280], ['dark', 375], ['light', 375]] as const
const dark1280 = [['dark', 1280]] as const

export const SHOT_STATES: readonly ShotState[] = [
  { name: 'tasks-list', shows: 'Tasks overview with running, queued, review, done and failed tasks and a variant group', variants: all4 },
  { name: 'task-thread', shows: 'A running task thread: earlier tool calls opened, command output, the screenshot the agent took, and a test run in progress', variants: all4 },
  { name: 'task-changes', shows: 'The Changes tab of a task with a multi-file diff', variants: both1280 },
  { name: 'compare-variants', shows: 'Two variants of one task that took different approaches, side by side', variants: both1280 },
  { name: 'new-task', shows: 'The new-task composer: Worktree on and Autonomous visible; at 1280 the workflow picker is open too', variants: [['dark', 1280], ['light', 1280], ['dark', 375]] },
  { name: 'review-gate', shows: 'A task parked at review with the review panel and the Draft PR action', variants: dark1280 },
  { name: 'all-tasks', shows: 'All tasks across two projects, grouped', variants: both1280 },
  { name: 'repo-git', shows: 'The repository Git view: the branch, its GitHub remote and the commit history', variants: dark1280 },
  { name: 'github-issues', shows: 'GitHub issues with the hand-to-agent controls', variants: both1280 },
  { name: 'automations', shows: 'Automations: a scheduled GitHub watch that starts a task for new issues', variants: dark1280 },
  { name: 'inbox', shows: 'The follow-up Inbox with three entries', variants: both1280 },
  { name: 'skills', shows: 'Skills with a skill preview open', variants: both1280 },
  { name: 'workflows', shows: 'The workflow builder with a multi-step workflow', variants: both1280 },
  { name: 'settings-appearance-roomy', shows: 'Settings → Appearance with the Roomy density selected', variants: [['dark', 1280], ['light', 1280], ['dark', 375]] },
  { name: 'settings-agents', shows: 'Project Settings → Agents', variants: dark1280 },
  { name: 'settings-accounts', shows: 'Global Settings → Agent accounts', variants: dark1280 },
  { name: 'settings-resources', shows: 'Global Settings → Resources: parallel tasks, monitoring sessions and limits', variants: dark1280 },
  { name: 'settings-mcp-connection', shows: 'Project Settings → MCP connection with the leader status', variants: dark1280 },
  { name: 'command-palette', shows: 'The ⌘K command palette open', variants: dark1280 },
]

/** Where the PNGs and the GIF live, relative to the repository root. */
export const SCREENSHOT_DIR = 'docs/screenshots/0.15.0'

/** Per-file budget for a still, in bytes (the plan's "≤ 300 KB"). */
export const SHOT_MAX_BYTES = 300 * 1024

/** Budget for the tour GIF, in bytes (owner decision: "≤ 5 MB"). */
export const TOUR_MAX_BYTES = 5 * 1024 * 1024

export const TOUR_FILE = 'tour.gif'

/** The tour's play time, in milliseconds (design review B-4: "≤ 20 s"). */
export const TOUR_MAX_MS = 20_000

export function shotFileName(name: string, theme: Theme, width: Width): string {
  return `${name}-${theme}-${width}.png`
}

export function allShotFiles(): string[] {
  return SHOT_STATES.flatMap((state) =>
    state.variants.map(([theme, width]) => shotFileName(state.name, theme, width)),
  )
}
