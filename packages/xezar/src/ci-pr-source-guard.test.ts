import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The two-branch model: `develop` is the default branch and takes every feature PR; `main` holds
// released work only and takes release-class PRs (promotion, version bump, hotfix). Branch
// protection checks results, not where a PR comes from, so `ci.yml` carries a job that does. It
// must keep working under the trunk model too: while `main` IS the default branch it checks
// nothing, so the change can land before `develop` exists.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const text = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = { name?: string; if?: string; steps: Step[] };
const wf = parse(text) as { on: Record<string, { branches?: string[] } | null>; jobs: Record<string, Job> };

describe('CI under the develop/main model', () => {
  it('runs for pull requests and pushes on both branches', () => {
    expect(wf.on.pull_request?.branches).toEqual(['main', 'develop']);
    expect(wf.on.push?.branches).toEqual(['main', 'develop']);
  });

  it('has a PR source guard job that always reports, so it can be a required check', () => {
    const job = wf.jobs['pr-source-guard'];
    expect(job, 'ci.yml has a pr-source-guard job').toBeDefined();
    expect(job!.name).toBe('PR source guard');
    // A job-level `if` would skip it, and the check would read as passed for the wrong reason.
    expect(job!.if).toBeUndefined();
  });

  it('reads every ref through env, never by interpolating it into the script', () => {
    const [guard] = wf.jobs['pr-source-guard']!.steps;
    expect(guard!.env).toMatchObject({
      EVENT: '${{ github.event_name }}',
      BASE_REF: '${{ github.base_ref }}',
      HEAD_REF: '${{ github.head_ref }}',
      DEFAULT_BRANCH: '${{ github.event.repository.default_branch }}',
    });
    expect(guard!.run).not.toMatch(/\$\{\{/);
  });

  it('checks only PRs into main while main is not the default branch, and allows only release-class heads', () => {
    const run = wf.jobs['pr-source-guard']!.steps[0]!.run!;
    expect(run).toContain('[ "$EVENT" != pull_request ] || [ "$BASE_REF" != main ] || [ "$DEFAULT_BRANCH" = main ]');
    expect(run).toMatch(/promote\/\*\|release\/v\*\|hotfix\/\*\)/);
    expect(run).toContain('exit 1');
  });
});
