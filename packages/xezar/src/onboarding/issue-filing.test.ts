import { describe, expect, it } from 'vitest';

import { GH_NOT_AUTHENTICATED_HINT, type BackendCheck } from '../core/backend-detect.ts';
import type { Skill } from '../skills.ts';
import {
  deriveIssueFiling,
  discoverIssueFiling,
  ghFact,
  ISSUE_FILING_SKILL,
  ISSUE_FILING_WORKFLOW,
  type IssueFilingDeps,
} from './issue-filing.ts';

/**
 * The issue-filing capability check (#468, step 3). Every case is one sentence the onboarding
 * answer must not get wrong: "available" while a part is missing, an error instead of a reason,
 * or "not there" about a skills collection nobody has finished reading.
 */

const GH_READY: BackendCheck[] = [{ name: 'gh', available: true, version: 'authenticated' }];
const GH_MISSING: BackendCheck[] = [{ name: 'gh', available: false, hint: 'install the GitHub CLI and run `gh auth login` (only needed for PR creation)' }];
const GH_SIGNED_OUT: BackendCheck[] = [{ name: 'gh', available: false, hint: GH_NOT_AUTHENTICATED_HINT }];

const skill = (name: string, source: Skill['source'] = 'team'): Skill => ({ name, body: '', path: `/skills/${name}.md`, source });
const KIT_ROLE = 'xezar-issue-create';
const never = new Promise<never>(() => undefined);

function deps(over: Partial<IssueFilingDeps> = {}): Partial<IssueFilingDeps> {
  return {
    getRepoInfo: async (root) => ({ root, branch: 'main', remote: 'git@github.com:acme/widgets.git' }),
    discoverSkills: async () => [skill('xez-onboard-opinionated'), skill(ISSUE_FILING_SKILL)],
    loadWorkflows: async () => ({ workflows: [], issues: [] }),
    waitForTeamSkills: async () => [],
    waitMs: 20,
    ...over,
  };
}

describe('discoverIssueFiling', () => {
  it('is available when gh is signed in, the remote is on GitHub and the skill is in the catalog', async () => {
    await expect(discoverIssueFiling('/p', GH_READY, deps())).resolves.toEqual({
      status: 'available',
      reason: null,
      skill: 'xez-issue-create',
    });
  });

  it('accepts the 3.0.3 kit role and reports it as the skill a task selects', async () => {
    const answer = await discoverIssueFiling(
      '/p',
      GH_READY,
      deps({ discoverSkills: async () => [skill(KIT_ROLE, 'xezar')] }),
    );
    expect(answer).toEqual({ status: 'available', reason: null, skill: 'xezar-issue-create' });
  });

  it('prefers the project kit role over the shared skill when both are there', async () => {
    const answer = await discoverIssueFiling(
      '/p',
      GH_READY,
      deps({ discoverSkills: async () => [skill(ISSUE_FILING_SKILL), skill(KIT_ROLE, 'xezar')] }),
    );
    expect(answer.skill).toBe('xezar-issue-create');
  });

  it('accepts the 3.0.3 issue-filing workflow, answering with the skill its step names', async () => {
    const answer = await discoverIssueFiling(
      '/p',
      GH_READY,
      deps({
        discoverSkills: async () => [],
        loadWorkflows: async () => ({
          workflows: [
            {
              name: ISSUE_FILING_WORKFLOW,
              source: 'file',
              steps: [
                { id: 'kit', command: 'true' },
                { id: 'file', prompt: '{{task}}', skill: 'xezar-issue-create' },
              ],
            },
          ],
          issues: [],
        }),
      }),
    );
    expect(answer).toEqual({ status: 'available', reason: null, skill: 'xezar-issue-create' });
  });

  it('a throwing workflow read is a missing workflow, never an error', async () => {
    const answer = await discoverIssueFiling(
      '/p',
      GH_READY,
      deps({ discoverSkills: async () => [], loadWorkflows: async () => Promise.reject(new Error('boom')) }),
    );
    expect(answer.status).toBe('unavailable');
    expect(answer.reason).not.toContain('boom');
  });

  it('says gh is not installed — as a reason, never an error', async () => {
    const answer = await discoverIssueFiling('/p', GH_MISSING, deps());
    expect(answer.status).toBe('unavailable');
    expect(answer.reason).toBe(
      'Not available: The GitHub CLI (gh) is not installed. A person can install it and run `gh auth login`.',
    );
  });

  it('treats a missing gh row as not installed', async () => {
    const answer = await discoverIssueFiling('/p', [], deps());
    expect(answer.status).toBe('unavailable');
    expect(answer.reason).toContain('is not installed');
  });

  it('tells "installed but signed out" apart from "not installed"', async () => {
    const answer = await discoverIssueFiling('/p', GH_SIGNED_OUT, deps());
    expect(answer.status).toBe('unavailable');
    expect(answer.reason).toBe('Not available: The GitHub CLI (gh) is not signed in. A person can run `gh auth login`.');
  });

  it('is unavailable in a repository with no remote', async () => {
    const answer = await discoverIssueFiling('/p', GH_READY, deps({ getRepoInfo: async (root) => ({ root, branch: 'main' }) }));
    expect(answer.status).toBe('unavailable');
    expect(answer.reason).toContain('has no remote');
  });

  it('is unavailable outside a git repository', async () => {
    const answer = await discoverIssueFiling('/p', GH_READY, deps({ getRepoInfo: async () => null }));
    expect(answer.status).toBe('unavailable');
    expect(answer.reason).toContain('not a git repository');
  });

  it('is unavailable when the remote is on another host', async () => {
    const answer = await discoverIssueFiling(
      '/p',
      GH_READY,
      deps({ getRepoInfo: async (root) => ({ root, branch: 'main', remote: 'https://gitlab.com/acme/widgets.git' }) }),
    );
    expect(answer.status).toBe('unavailable');
    expect(answer.reason).toContain('not on GitHub');
  });

  it('never forwards the remote URL, which can carry an account or a token', async () => {
    const answer = await discoverIssueFiling(
      '/p',
      GH_MISSING,
      deps({ getRepoInfo: async (root) => ({ root, branch: 'main', remote: 'https://someone:s3cret@gitlab.com/acme/widgets.git' }) }),
    );
    expect(answer.reason).not.toMatch(/someone|s3cret|acme/);
  });

  it('is unavailable when the skill is missing from a fully loaded catalog', async () => {
    const answer = await discoverIssueFiling('/p', GH_READY, deps({ discoverSkills: async () => [skill('xez-onboard-opinionated')] }));
    expect(answer.status).toBe('unavailable');
    expect(answer.reason).toContain(
      'No issue-filing skill is in this project’s skills: neither xez-issue-create, nor a project role whose name ends in -issue-create, nor an issue-filing workflow.',
    );
  });

  it('names every missing part, not only the first', async () => {
    const answer = await discoverIssueFiling(
      '/p',
      GH_SIGNED_OUT,
      deps({ getRepoInfo: async () => null, discoverSkills: async () => [] }),
    );
    expect(answer.status).toBe('unavailable');
    expect(answer.reason).toContain('not signed in');
    expect(answer.reason).toContain('not a git repository');
    expect(answer.reason).toContain('No issue-filing skill is in this project');
  });

  it('reads "unknown", not "missing", while the shared collection has not loaded', async () => {
    const answer = await discoverIssueFiling(
      '/p',
      GH_READY,
      deps({ discoverSkills: async () => [], waitForTeamSkills: () => never }),
    );
    expect(answer.status).toBe('unknown');
    expect(answer.reason).toMatch(/^Not known yet: .*still loading/);
  });

  it('a skill found locally does not wait on the shared collection', async () => {
    const answer = await discoverIssueFiling('/p', GH_READY, deps({ waitForTeamSkills: () => never }));
    expect(answer.status).toBe('available');
  });

  it('a failed collection load is a finished load: the skill is missing, not pending', async () => {
    const answer = await discoverIssueFiling(
      '/p',
      GH_READY,
      deps({ discoverSkills: async () => [], waitForTeamSkills: async () => Promise.reject(new Error('offline')) }),
    );
    expect(answer.status).toBe('unavailable');
  });

  it('degrades a throwing catalog or git read to a reason', async () => {
    const answer = await discoverIssueFiling(
      '/p',
      GH_READY,
      deps({
        getRepoInfo: async () => Promise.reject(new Error('boom')),
        discoverSkills: async () => Promise.reject(new Error('boom')),
      }),
    );
    expect(answer.status).toBe('unavailable');
    expect(answer.reason).not.toContain('boom');
  });
});

describe('deriveIssueFiling / ghFact', () => {
  it('a known missing part outranks a pending skill', () => {
    expect(deriveIssueFiling({ gh: 'missing', remote: 'github', skill: 'pending' }).status).toBe('unavailable');
  });

  it('classifies the gh probe', () => {
    expect(ghFact(GH_READY)).toBe('ready');
    expect(ghFact(GH_SIGNED_OUT)).toBe('not-signed-in');
    expect(ghFact(GH_MISSING)).toBe('missing');
  });
});
