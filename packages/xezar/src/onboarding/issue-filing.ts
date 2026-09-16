import type { OnboardingIssueFiling } from '@qodeca/xezar-contract';
import { GH_NOT_AUTHENTICATED_HINT, type BackendCheck } from '../core/backend-detect.ts';
import { forgeKindOfRemote } from '../server/forge/index.ts';
import { getRepoInfo } from '../server/git.ts';
import { discoverSkills } from '../skills.ts';
import { waitForTeamSkills } from '../skills-remote.ts';

/**
 * "Can this project file a tracker issue?" — discovered, never configured (#468, step 3).
 *
 * Issue filing is a task that selects the shared `xez-issue-create` skill and publishes through
 * the GitHub CLI. So it works exactly when three facts hold, and each is discovered the way the
 * rest of the engine already discovers it:
 *
 * - `gh` is installed and signed in — `detectEnvironment()`'s own probe, passed in by the caller;
 * - the repository has a GitHub remote — `getRepoInfo` + `forgeKindOfRemote`, the forge resolver's
 *   own host table;
 * - the skill is in this project's catalog — `discoverSkills`, which already applies local-first
 *   precedence and the person's import curation of the shared collection.
 *
 * Nothing here writes, and nothing throws: a missing CLI, a remote-less repository or a skill that
 * is not there is a sentence in `reason`, never an error (AGENTS.md § Zero config).
 */

export const ISSUE_FILING_SKILL = 'xez-issue-create';

/** How long a read waits for the shared skills collection's FIRST load before saying "unknown". */
export const TEAM_SKILLS_WAIT_MS = 1500;

export interface IssueFilingFacts {
  gh: 'ready' | 'not-signed-in' | 'missing';
  remote: 'github' | 'other' | 'none' | 'no-repo';
  /** `pending` = not found locally, and the shared collection has not finished its first load. */
  skill: 'found' | 'missing' | 'pending';
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

const SKILL_MISSING_REASON = `The ${ISSUE_FILING_SKILL} skill is not in this project’s skills. A person can import it on the Skills page or add it to the project’s own skills folder.`;
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
  return { status: 'available', reason: null, skill: ISSUE_FILING_SKILL };
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
  waitForTeamSkills: typeof waitForTeamSkills;
  waitMs: number;
}

const DEFAULT_DEPS: IssueFilingDeps = { getRepoInfo, discoverSkills, waitForTeamSkills, waitMs: TEAM_SKILLS_WAIT_MS };

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
  let names: Set<string>;
  try {
    names = new Set((await d.discoverSkills(root)).map((skill) => skill.name));
  } catch {
    names = new Set();
  }
  const skill: IssueFilingFacts['skill'] = names.has(ISSUE_FILING_SKILL) ? 'found' : teamLoaded ? 'missing' : 'pending';
  return deriveIssueFiling({ gh: ghFact(checks), remote, skill });
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
