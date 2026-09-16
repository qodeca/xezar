import type { CreateRunInput, Runner, Skill } from '@qodeca/xezar-api-client'

// A RELATIVE import, not the `@/` alias the rest of the cockpit uses. The MCP parity test loads
// this module by path from the server package, where that alias does not resolve — and a parity
// test that cannot load the cockpit's own rule would have to restate it, which is the drift the
// test exists to catch. `new-task-form.ts` keeps relative imports for the same reason.
import { buildCreateRunBody } from '../new-task-form'

/**
 * What "New issue" starts, as pure functions — the half the dialog, its tests and the MCP
 * parity test all read.
 *
 * THE CONTROL STARTS AN ORDINARY TASK. It reuses `POST /runs` with a skill selected; there is no
 * issue-mutation route, no forge write and no new server capability anywhere in this feature.
 * Starting is not filing: the skill shows the exact title, body and labels and asks the person to
 * create or revise through the task's own question flow.
 */

/**
 * The naming convention a skill that files ONE issue follows.
 *
 * Matched as a SUFFIX rather than one fixed name, and deliberately so. The procedure ships in the
 * default skills collection as `xez-issue-create`, and a project that wants its own tracker,
 * template and label policy on top keeps a wrapper of its own beside it — the wrapper is the one
 * to run where it exists. A suffix finds both without a setting to author, and a project that has
 * neither gets the honest "not installed" explanation instead of a silent install.
 */
export const ISSUE_CREATE_SUFFIX = 'issue-create'

/**
 * Which copy wins when a project keeps more than one. Lower is nearer: the repository's own
 * files first, then the team collection, then the user's home catalog — the same nearest-wins
 * order skill discovery itself follows, narrowed to one answer instead of a display order.
 */
const SOURCE_RANK: Readonly<Record<Skill['source'], number>> = {
  ai: 0,
  xezar: 0,
  agents: 0,
  team: 1,
  global: 2,
}

/**
 * The skill this project files issues with, or `null` when it has none.
 *
 * By NAME, never by path: a project skill shadows a global one and both are valid, so a path
 * would pin the wrong copy. The nearest copy wins, because a project's own wrapper exists
 * precisely to add the tracker, template and label policy the shared procedure cannot know.
 */
export function findIssueCreateSkill(skills: readonly Skill[]): Skill | null {
  const matches = skills.filter(
    (skill) => skill.name === ISSUE_CREATE_SUFFIX || skill.name.endsWith(`-${ISSUE_CREATE_SUFFIX}`),
  )
  // A stable sort, so two copies of equal rank keep the catalog's own (alphabetical) order.
  return [...matches].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source])[0] ?? null
}

/** The resolved backend fields the body needs — `useResolvedEngine`'s answer, narrowed. */
export interface IssueRunEngine {
  runner: Runner
  runnerExplicit: boolean
  defaultRunner?: Runner
  model: string
  modelsLocked?: boolean
  account: string | null
}

/**
 * The `POST /runs` body for one issue draft.
 *
 * Built by the composer's own `buildCreateRunBody`, not by a second copy of its rules, so the
 * three doors into this capability — the New task form, this dialog and the MCP `task_create`
 * tool — cannot drift: a skill runs as the one-step inline chain
 * `steps: [{ id: 'task', name, skill, prompt: '{{task}}' }]`, and `quick-task` is what "no skill"
 * means. `skillName` of `null` is the ordinary-task fallback the unavailable state offers.
 *
 * Two omissions are the design, not an oversight:
 *
 *  - **never `autonomous: true`.** The composer's untouched default for a SKILL source is
 *    autonomous (`resolveComposerRunMode`, source-dependent), and that is the wrong default here:
 *    an autonomous run would file without ever asking, while the button's whole promise is that
 *    the person approves the exact text first. Omitting the key is a non-autonomous run — the
 *    server reads an absent `autonomous` as false. The MCP counterpart reaches the same run by
 *    sending `autonomous: false`, which serializes to the same absent key.
 *  - **no `worktree`.** Filing needs no checkout of its own and the workspace default is right;
 *    `worktree` rides the request only when it is explicitly off.
 */
export function newIssueRunBody(
  brief: string,
  skillName: string | null,
  engine: IssueRunEngine,
  /** What `capabilities.followups` says. A server with the inbox off pins the field to false
   *  anyway; sending it is the composer's own rule, and keeps the two bodies identical. */
  followupsAvailable = true,
): CreateRunInput {
  return buildCreateRunBody({
    task: brief,
    source: skillName === null ? null : { source: 'skill', ref: skillName },
    model: engine.model,
    modelsLocked: engine.modelsLocked,
    runner: engine.runner,
    runnerExplicit: engine.runnerExplicit,
    defaultRunner: engine.defaultRunner,
    agentProfile: engine.account,
    variants: 1,
    images: [],
    generateFollowups: followupsAvailable,
  })
}
