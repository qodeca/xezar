import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { TEST_DIR_RM_OPTIONS } from '../test/helpers/platform.ts';

// The two-branch model: `develop` is the default branch and takes every feature PR; `main` holds
// released work only and takes release-class PRs (promotion, version bump, hotfix). Branch
// protection checks results, not where a PR comes from, so `pr-source-guard.yml` does. It must
// keep working under the trunk model too: while `main` IS the default branch it checks nothing, so
// the change can land before `develop` exists.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (name: string) => parse(readFileSync(join(REPO_ROOT, '.github/workflows', name), 'utf8')) as {
  on: Record<string, { branches?: string[]; types?: string[] } | null>;
  permissions?: Record<string, string>;
  jobs: Record<string, { name?: string; if?: string; env?: Record<string, string>; steps: { id?: string; run?: string; env?: Record<string, string>; uses?: string; with?: Record<string, string> }[] }>;
};

describe('CI under the develop/main model', () => {
  it('runs CI for pull requests and pushes on both branches and the release maintenance lines', () => {
    const ci = read('ci.yml');
    expect(ci.on.pull_request?.branches).toEqual(['main', 'develop', 'release/**']);
    expect(ci.on.push?.branches).toEqual(['main', 'develop', 'release/**']);
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

describe('the browser provider CI and the local setup download and run', () => {
  const job = read('ci.yml').jobs['ui-e2e']!;
  const PIN = join(REPO_ROOT, 'scripts/agent-browser-pin.sh');
  const pin = readFileSync(PIN, 'utf8');
  const ASSETS = [
    'agent-browser-darwin-arm64',
    'agent-browser-darwin-x64',
    'agent-browser-linux-arm64',
    'agent-browser-linux-musl-arm64',
    'agent-browser-linux-musl-x64',
    'agent-browser-linux-x64',
    'agent-browser-win32-x64.exe',
  ];

  it('pins one release and a SHA-256 for every asset the installers pick, in one shared file', () => {
    expect(pin).toMatch(/^AGENT_BROWSER_VERSION=\d+\.\d+\.\d+$/m);
    for (const asset of ASSETS) {
      expect(pin, asset).toMatch(new RegExp(`^\\s+${asset.replace(/\./g, '\\.')}\\) echo [0-9a-f]{64} ;;$`, 'm'));
    }
  });

  it('never installs `latest` – not in CI, the local launcher or the documented snippets', () => {
    for (const file of ['.github/workflows/ci.yml', 'scripts/test-env-up.sh', 'docs/testing/agent-browser.md']) {
      const body = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(body, file).not.toContain('releases/latest');
      expect(body, file).toContain('agent-browser-pin.sh');
    }
  });

  it('verifies the bytes in CI before running them', () => {
    const run = job.steps.find((s) => s.id === 'browser')!.run!;
    expect(run).toContain('. scripts/agent-browser-pin.sh');
    expect(run.indexOf('agent_browser_verify "$ASSET" "$BIN.tmp"')).toBeGreaterThan(-1);
    expect(run.indexOf('agent_browser_verify "$ASSET" "$BIN.tmp"')).toBeLessThan(run.indexOf('"$BIN" install'));
  });

  it('verifies the bytes in the local launcher before running them', () => {
    const up = readFileSync(join(REPO_ROOT, 'scripts/test-env-up.sh'), 'utf8');
    expect(up.indexOf('agent_browser_verify "$ASSET" "$TMP"')).toBeGreaterThan(-1);
    expect(up.indexOf('agent_browser_verify "$ASSET" "$TMP"')).toBeLessThan(up.indexOf('"$BROWSER_COMMAND" install'));
  });

  it('keys the browser cache on the pin file', () => {
    const restore = job.steps.find((s) => s.id === 'browser-cache')!;
    expect(restore.with?.key).toContain("agent-browser-${{ hashFiles('scripts/agent-browser-pin.sh') }}-");
    expect(restore.with?.['restore-keys']).toContain("agent-browser-${{ hashFiles('scripts/agent-browser-pin.sh') }}-");
    const step = job.steps.find((s) => s.id === 'browser')!;
    expect(step.env?.PIN_HASH).toBe("${{ hashFiles('scripts/agent-browser-pin.sh') }}");
    expect(step.run).toContain('cache-key=${RUNNER_OS}-${RUNNER_ARCH}-agent-browser-${PIN_HASH}-chrome-');
  });

  // Runs the helper itself through each hashing tool this machine has, then with none.
  // win32-skip(#975): the pin helper is POSIX shell, sourced by the test-env launcher and CI on Linux/macOS
  it.skipIf(process.platform === 'win32')('hashes with sha256sum, shasum or openssl, and fails closed without one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xez-ab-pin-'));
    try {
      const file = join(dir, 'hello');
      writeFileSync(file, 'hello');
      const HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
      const which = (tool: string) => spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      const run = (bin: string, script: string) =>
        spawnSync('/bin/sh', ['-c', `. "$1"; ${script}`, 'sh', PIN, file], { encoding: 'utf8', env: { PATH: bin } });
      const toolBin = (tools: string[]) => {
        const bin = mkdtempSync(join(dir, 'bin-'));
        for (const tool of ['awk', 'tr', ...tools]) symlinkSync(which(tool), join(bin, tool));
        return bin;
      };
      const present = ['sha256sum', 'shasum', 'openssl'].filter((tool) => which(tool) !== '');
      expect(present.length).toBeGreaterThan(0);
      for (const tool of present) {
        const out = run(toolBin([tool]), 'sha256_of "$2"');
        expect(out.stdout.trim(), tool).toBe(HELLO);
      }
      const none = toolBin([]);
      expect(run(none, 'sha256_of "$2"').status).not.toBe(0);
      expect(run(none, 'agent_browser_verify agent-browser-linux-x64 "$2"').status).not.toBe(0);
      const any = toolBin(present);
      expect(run(any, 'agent_browser_verify agent-browser-linux-x64 "$2"').status).not.toBe(0);
      expect(run(any, 'agent_browser_verify agent-browser-unknown "$2"').status).not.toBe(0);
      expect(run(any, 'agent_browser_verify agent-browser-linux-x64 "$2.missing"').status).not.toBe(0);
    } finally {
      rmSync(dir, TEST_DIR_RM_OPTIONS);
    }
  });
});

describe('dependency update pull requests', () => {
  const config = parse(readFileSync(join(REPO_ROOT, '.github/dependabot.yml'), 'utf8')) as {
    updates: { 'package-ecosystem': string; directory: string; 'target-branch'?: string; schedule: { interval: string }; groups?: Record<string, { 'update-types'?: string[] }> }[];
  };

  it('covers npm and the workflow actions, weekly, grouped minor/patch, into develop — never main', () => {
    expect(config.updates.map((u) => u['package-ecosystem']).sort()).toEqual(['github-actions', 'npm']);
    for (const update of config.updates) {
      expect(update.directory).toBe('/');
      expect(update['target-branch']).toBe('develop');
      expect(update.schedule.interval).toBe('weekly');
      expect(Object.values(update.groups ?? {}).map((g) => g['update-types'])).toEqual([['minor', 'patch']]);
    }
  });
});
