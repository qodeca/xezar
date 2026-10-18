import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The two-branch model: `develop` is the default branch and takes every feature PR; `main` holds
// released work only and takes release-class PRs (promotion, version bump, hotfix). Branch
// protection checks results, not where a PR comes from, so `pr-source-guard.yml` does. It must
// keep working under the trunk model too: while `main` IS the default branch it checks nothing, so
// the change can land before `develop` exists.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (name: string) => parse(readFileSync(join(REPO_ROOT, '.github/workflows', name), 'utf8')) as {
  on: Record<string, { branches?: string[]; types?: string[] } | null>;
  permissions?: Record<string, string>;
  jobs: Record<string, { name?: string; if?: string; steps: { run?: string; env?: Record<string, string>; uses?: string }[] }>;
};

describe('CI under the develop/main model', () => {
  it('runs CI for pull requests and pushes on both branches', () => {
    const ci = read('ci.yml');
    expect(ci.on.pull_request?.branches).toEqual(['main', 'develop']);
    expect(ci.on.push?.branches).toEqual(['main', 'develop']);
  });
});

describe('the PR source guard', () => {
  const wf = read('pr-source-guard.yml');
  const job = wf.jobs['pr-source-guard']!;
  const step = job.steps[0]!;

  it('reruns when a PR is retargeted, so a green check cannot follow a feature PR into main', () => {
    // Named break: drop `edited`, and a PR retargeted from develop to main keeps its green check.
    expect(wf.on.pull_request?.types).toEqual(['opened', 'synchronize', 'reopened', 'edited']);
    expect(wf.on.pull_request?.branches).toBeUndefined();
  });

  it('always reports under its required-check name, with read-only permissions and no checkout', () => {
    expect(job.name).toBe('PR source guard');
    // A job-level `if` would skip it, and the check would read as passed for the wrong reason.
    expect(job.if).toBeUndefined();
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(job.steps.some((s) => s.uses)).toBe(false);
  });

  it('reads every ref through env, never by interpolating it into the script', () => {
    expect(step.env).toMatchObject({
      BASE_REF: '${{ github.base_ref }}',
      HEAD_REF: '${{ github.head_ref }}',
      HEAD_REPO: '${{ github.event.pull_request.head.repo.full_name }}',
      THIS_REPO: '${{ github.repository }}',
      DEFAULT_BRANCH: '${{ github.event.repository.default_branch }}',
    });
    expect(step.run).not.toMatch(/\$\{\{/);
  });

  it('checks only PRs into main while main is not the default branch, from this repository, release-class heads only', () => {
    const run = step.run!;
    expect(run).toContain('[ "$BASE_REF" != main ] || [ "$DEFAULT_BRANCH" = main ]');
    expect(run).toContain('[ "$HEAD_REPO" != "$THIS_REPO" ]');
    expect(run).toMatch(/promote\/\*\|release\/v\*\|hotfix\/\*\)/);
    expect(run.match(/exit 1/g)).toHaveLength(2);
  });
});
