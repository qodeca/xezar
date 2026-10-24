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

describe('the cross-platform matrix', () => {
  // Branch protection on develop and main reads these four by exact name. A required check that
  // does not run on a pull request blocks every merge, so they must come out of the matrix on
  // `pull_request`; the `lts/*` canaries run only on a push to develop (OD-12).
  const REQUIRED = [
    'Cross-platform verify (windows-latest, Node 22)',
    'Cross-platform verify (windows-latest, Node 24)',
    'Cross-platform verify (macos-latest, Node 22)',
    'Cross-platform verify (macos-latest, Node 24)',
  ];
  const job = (read('ci.yml').jobs['cross-platform'] as unknown) as {
    name: string;
    if?: string;
    'continue-on-error': string;
    strategy: { matrix: { os: string[]; node: string; include?: unknown; exclude?: unknown } };
  };
  const { matrix } = job.strategy;
  const branches = /^\$\{\{ fromJSON\(github\.event_name == 'push' && github\.ref == 'refs\/heads\/develop' && '(\[[^']*\])' \|\| '(\[[^']*\])'\) \}\}$/.exec(matrix.node);
  const legs = (event: 'pull_request' | 'push-develop') => {
    const nodes = JSON.parse(branches![event === 'push-develop' ? 1 : 2]!) as string[];
    return matrix.os.flatMap((os) =>
      nodes.map((node) => job.name.replace('${{ matrix.os }}', os).replace('${{ matrix.node }}', node)),
    );
  };

  it('chooses its Node versions from the event alone, with nothing else reshaping the matrix', () => {
    expect(branches, matrix.node).not.toBeNull();
    expect(matrix.include).toBeUndefined();
    expect(matrix.exclude).toBeUndefined();
    expect(job.if).toBeUndefined();
  });

  it('runs exactly the four required legs on a pull request, and no Ubuntu leg', () => {
    expect(legs('pull_request')).toEqual(REQUIRED);
  });

  it('adds the informational lts/* canaries only on a push to develop', () => {
    expect(legs('push-develop')).toEqual([
      ...REQUIRED.slice(0, 2),
      'Cross-platform verify (windows-latest, Node lts/*)',
      ...REQUIRED.slice(2),
      'Cross-platform verify (macos-latest, Node lts/*)',
    ]);
    expect(job['continue-on-error']).toBe("${{ matrix.node == 'lts/*' }}");
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

  it('never proposes an @types/node major, and leaves room for the majors behind the weekly group', () => {
    const npm = config.updates.find((u) => u['package-ecosystem'] === 'npm') as Record<string, unknown>;
    // @types/node tracks the engines.node floor, so a later major would type APIs that floor lacks.
    expect(npm.ignore).toContainEqual({ 'dependency-name': '@types/node', 'update-types': ['version-update:semver-major'] });
    // The default cap (5) hides every major once the weekly group and a few majors are open.
    expect(npm['open-pull-requests-limit']).toBeGreaterThan(5);
  });
});
