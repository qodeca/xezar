import type { OnboardingIssueFiling } from '@qodeca/xezar-contract';
import { GH_NOT_AUTHENTICATED_HINT, type BackendCheck } from '../core/backend-detect.ts';
import { forgeKindOfRemote } from '../server/forge/index.ts';
import { getRepoInfo } from '../server/git.ts';
import { discoverSkills, type Skill } from '../skills.ts';
import { waitForTeamSkills } from '../skills-remote.ts';
import { loadWorkflows } from '../workflows/load.ts';

/**
 * "Can this project file a tracker issue?" — discovered, never configured (#468, step 3).
 *
 * Issue filing is a task that selects an issue-filing skill and publishes through the GitHub CLI.
 * A project set up by the 3.0.3 onboarding files through its own kit role (in `.xezar/skills/`),
 * usually by way of its `issue-filing` workflow; any other project uses the shared
 * `xez-issue-create` skill. Both are found by the `-issue-create` naming convention the cockpit's
 * "New issue" already follows (`web/src/routes/github/new-issue-task.ts`), so no shipped string
 * names a kit role. It works exactly when three facts hold, and each is discovered the way the
 * rest of the engine already discovers it:
 *
 * - `gh` is installed and signed in — `detectEnvironment()`'s own probe, passed in by the caller;
 * - the repository has a GitHub remote — `getRepoInfo` + `forgeKindOfRemote`, the forge resolver's
 *   own host table;
 * - one of those is in this project's catalog — `discoverSkills`, which already applies local-first
 *   precedence and the person's import curation of the shared collection, or `loadWorkflows` for
 *   the `issue-filing` workflow.
 *
 * Nothing here writes, and nothing throws: a missing CLI, a remote-less repository or a skill that
 * is not there is a sentence in `reason`, never an error (AGENTS.md § Zero config).
 */

export const ISSUE_FILING_SKILL = 'xez-issue-create';

/** The naming convention an issue-filing skill follows: the shared skill and a project's own role. */
export const ISSUE_CREATE_SUFFIX = 'issue-create';

/** The 3.0.3 onboarding kit's workflow that files one issue through the project's own role. */
export const ISSUE_FILING_WORKFLOW = 'issue-filing';

/** Nearer copies first, the order skill discovery itself follows: the project, the team, the user. */
const SOURCE_RANK: Readonly<Record<Skill['source'], number>> = { ai: 0, xezar: 0, agents: 0, team: 1, global: 2 };

/** How long a read waits for the shared skills collection's FIRST load before saying "unknown". */
export const TEAM_SKILLS_WAIT_MS = 1500;

export interface IssueFilingFacts {
  gh: 'ready' | 'not-signed-in' | 'missing';
  remote: 'github' | 'other' | 'none' | 'no-repo';
  /** `pending` = not found locally, and the shared collection has not finished its first load. */
  skill: 'found' | 'missing' | 'pending';
  /** The skill a task selects, when `skill` is `found`. Defaults to `ISSUE_FILING_SKILL`. */
  skillName?: string;
}

const GH_REASON: Record<Exclude<IssueFilingFacts['gh'], 'ready'>, string> = {
  missing: 'The GitHub CLI (gh) is not installed. A person can install it and run `gh auth login`.',
  'not-signed-in': 'The GitHub CLI (gh) is not signed in. A person can run `gh auth login`.',
};

const REMOTE_REASON: Record<Exclude<IssueFilingFacts['remote'], 'github'>, string> = {
  'no-repo': 'This project is not a git repository, so it has no GitHub remote.',
  none: 'This repository has no remote, so there is no GitHub repository to file into.',
  other: 'This repository’s remote is not on GitHub; issue filing needs a github.com remote.',
};

const SKILL_MISSING_REASON = `No issue-filing skill is in this project’s skills: neither ${ISSUE_FILING_SKILL}, nor a project role whose name ends in -${ISSUE_CREATE_SUFFIX}, nor an ${ISSUE_FILING_WORKFLOW} workflow. A person can import ${ISSUE_FILING_SKILL} on the Skills page, or set the project up with the 3.0.3 onboarding.`;
const SKILL_PENDING_REASON = `The shared skills collection is still loading, so whether ${ISSUE_FILING_SKILL} is present is not known yet. Check again shortly.`;

/** The pure half: three facts in, the wire answer out. Every missing fact is named, not just the first. */
export function deriveIssueFiling(facts: IssueFilingFacts): OnboardingIssueFiling {
  const missing: string[] = [];
  if (facts.gh !== 'ready') missing.push(GH_REASON[facts.gh]);
  if (facts.remote !== 'github') missing.push(REMOTE_REASON[facts.remote]);
  if (facts.skill === 'missing') missing.push(SKILL_MISSING_REASON);
  if (missing.length > 0) {
    return { status: 'unavailable', reason: `Not available: ${missing.join(' ')}`, skill: ISSUE_FILING_SKILL };
  }
  // Against an unloaded collection, "we never looked" and "it is not there" must not read the same.
  if (facts.skill === 'pending') {
    return { status: 'unknown', reason: `Not known yet: ${SKILL_PENDING_REASON}`, skill: ISSUE_FILING_SKILL };
  }
  return { status: 'available', reason: null, skill: facts.skillName ?? ISSUE_FILING_SKILL };
}

/** `detectEnvironment()`'s `gh` row, classified. An absent row is treated as "not installed". */
export function ghFact(checks: readonly BackendCheck[]): IssueFilingFacts['gh'] {
  const gh = checks.find((check) => check.name === 'gh');
  if (gh?.available) return 'ready';
  return gh?.hint === GH_NOT_AUTHENTICATED_HINT ? 'not-signed-in' : 'missing';
}

export interface IssueFilingDeps {
  getRepoInfo: typeof getRepoInfo;
  discoverSkills: typeof discoverSkills;
  loadWorkflows: typeof loadWorkflows;
  waitForTeamSkills: typeof waitForTeamSkills;
  waitMs: number;
}

const DEFAULT_DEPS: IssueFilingDeps = {
  getRepoInfo,
  discoverSkills,
  loadWorkflows,
  waitForTeamSkills,
  waitMs: TEAM_SKILLS_WAIT_MS,
};

/**
 * Discover the three facts for `root` and derive the answer. Never throws.
 *
 * The shared collection loads in the background; this waits for that first load for at most
 * `waitMs` so a cold cockpit read is not blocked on a network clone. A skill found locally does
 * not need the wait's result, so only a local miss can read as `pending`.
 */
export async function discoverIssueFiling(
  root: string,
  checks: readonly BackendCheck[],
  deps: Partial<IssueFilingDeps> = {},
): Promise<OnboardingIssueFiling> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const [remote, teamLoaded] = await Promise.all([remoteFact(root, d), settlesWithin(d.waitForTeamSkills(root), d.waitMs)]);
  let skills: Skill[];
  try {
    skills = await d.discoverSkills(root);
  } catch {
    skills = [];
  }
  const skillName = await filingSkillName(root, skills, d);
  const skill: IssueFilingFacts['skill'] = skillName ? 'found' : teamLoaded ? 'missing' : 'pending';
  return deriveIssueFiling({ gh: ghFact(checks), remote, skill, ...(skillName ? { skillName } : {}) });
}

/**
 * The skill a filing task would select, or `null`. Any skill named `issue-create` or ending in
 * `-issue-create` qualifies, and the nearest copy wins — a project's own role over the shared
 * skill — the same rule as the cockpit's "New issue". A project whose `issue-filing` workflow is
 * there counts too, answering with the skill its agent step names.
 */
async function filingSkillName(root: string, skills: readonly Skill[], d: IssueFilingDeps): Promise<string | null> {
  const matches = skills.filter(
    (skill) => skill.name === ISSUE_CREATE_SUFFIX || skill.name.endsWith(`-${ISSUE_CREATE_SUFFIX}`),
  );
  const nearest = [...matches].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source])[0];
  if (nearest) return nearest.name;
  const workflows = await d
    .loadWorkflows(root)
    .then((loaded) => loaded.workflows)
    .catch(() => []);
  const workflow = workflows.find((candidate) => candidate.name === ISSUE_FILING_WORKFLOW);
  if (!workflow) return null;
  return workflow.steps.find((step) => step.skill)?.skill ?? ISSUE_FILING_WORKFLOW;
}

async function remoteFact(root: string, d: IssueFilingDeps): Promise<IssueFilingFacts['remote']> {
  const repo = await d.getRepoInfo(root).catch(() => null);
  if (!repo) return 'no-repo';
  if (!repo.remote) return 'none';
  return forgeKindOfRemote(repo.remote) === 'github' ? 'github' : 'other';
}

/** True when `promise` settles (either way) within `ms`. The timer never holds the process open. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
