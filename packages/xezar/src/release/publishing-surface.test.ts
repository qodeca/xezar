import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Structural guard over the whole publishing surface.
 *
 * The inherited pipeline published automatically from three more places: a `pr-<N>` snapshot on
 * every same-repo PR, a `@develop` snapshot on every push to `develop`, and a nightly cron. Each
 * one carried an npm credential into ordinary CI, and each one could put a build on the registry
 * that no human asked for. They were removed with the Xezar rename, and this test is what keeps
 * them removed: a reinstated snapshot job, or an `NPM_TOKEN` that creeps back into `ci.yml`,
 * fails here rather than being noticed after it has already published.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const workflowDir = join(repoRoot, '.github', 'workflows');

const workflows = () =>
  readdirSync(workflowDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => ({ name, body: readFileSync(join(workflowDir, name), 'utf8') }));

describe('publishing surface', () => {
  it('ships exactly two workflows: CI and the manual release', () => {
    expect(workflows().map((w) => w.name).sort()).toEqual(['ci.yml', 'release.yml']);
  });

  it('stores no npm token anywhere — publishing is OIDC trusted publishing', () => {
    // A token is a secret that can expire, leak or be copied out of CI. Trusted publishing
    // replaces it with an identity GitHub mints per job and npm checks against the package's
    // configured publisher. A reinstated `NPM_TOKEN` would quietly reintroduce all of that.
    for (const w of workflows()) {
      expect(w.body, `${w.name} must not reference an npm token`).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
    }
  });

  it('grants id-token only to the release job — that permission IS the credential', () => {
    const withIdToken = workflows().filter((w) => w.body.includes('id-token: write'));
    expect(withIdToken.map((w) => w.name)).toEqual(['release.yml']);
  });

  it('keeps every publish command out of ordinary CI', () => {
    const ci = workflows().find((w) => w.name === 'ci.yml');
    expect(ci).toBeDefined();
    // `npm pack --dry-run` is fine and wanted; an actual publish is not.
    expect(ci!.body).not.toMatch(/npm\s+publish/);
    expect(ci!.body).not.toMatch(/release-snapshot/);
    expect(ci!.body).not.toMatch(/dist-tag/);
    expect(ci!.body).not.toMatch(/publish-snapshot/);
  });

  it('lets the release fire only from an explicit manual dispatch', () => {
    const release = workflows().find((w) => w.name === 'release.yml')!.body;
    const trigger = release.slice(release.indexOf('\non:'), release.indexOf('\npermissions:'));
    expect(trigger).toContain('workflow_dispatch');
    // No push, pull_request or schedule trigger may reach a job that publishes.
    expect(trigger).not.toMatch(/^\s{2}(push|pull_request|schedule|release):/m);
  });

  it('runs the packaging check before it publishes anything', () => {
    const release = workflows().find((w) => w.name === 'release.yml')!.body;
    const packageStep = release.indexOf('npm run test:package');
    const publishStep = release.indexOf('scripts/release.mjs');
    expect(packageStep).toBeGreaterThan(-1);
    expect(publishStep).toBeGreaterThan(-1);
    expect(packageStep).toBeLessThan(publishStep);
  });

  it('has no snapshot channel left to publish from', () => {
    const scripts = readdirSync(join(repoRoot, 'scripts'));
    expect(scripts).not.toContain('release-snapshot.mjs');
    const releaseSources = readdirSync(join(repoRoot, 'packages', 'xezar', 'src', 'release'));
    expect(releaseSources).not.toContain('snapshot.ts');
  });

  it('publishes one package under the agreed identity', () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'packages', 'xezar', 'package.json'), 'utf8'),
    ) as { name: string; private?: boolean; publishConfig?: { access?: string }; bin: Record<string, string> };
    expect(manifest.name).toBe('@qodeca/xezar');
    expect(manifest.private).toBeUndefined();
    expect(manifest.publishConfig?.access).toBe('public');
    expect(Object.keys(manifest.bin).sort()).toEqual(['xez', 'xezar']);

    // Every other workspace stays off the registry.
    for (const dir of ['contract', 'api-client', 'web']) {
      const pkg = JSON.parse(
        readFileSync(join(repoRoot, 'packages', dir, 'package.json'), 'utf8'),
      ) as { name: string; private?: boolean };
      expect(pkg.private).toBe(true);
      expect(pkg.name.startsWith('@qodeca/xezar')).toBe(true);
    }
  });

  it('keeps the MCP mutation run (Stryker) out of what a user installs', () => {
    // #333: Stryker is a release gate over the MCP code, and a devDependency only. A user who
    // installs @qodeca/xezar must get neither its ~140 packages nor its config files.
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'packages', 'xezar', 'package.json'), 'utf8'),
    ) as Record<string, unknown> & { files: string[]; devDependencies: Record<string, string> };
    const stryker = (deps: unknown) => Object.keys((deps ?? {}) as Record<string, string>).filter((n) => n.startsWith('@stryker-mutator/'));
    expect(stryker(manifest.devDependencies)).toEqual(['@stryker-mutator/core', '@stryker-mutator/vitest-runner']);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
      expect(stryker(manifest[field]), `${field} must not name Stryker`).toEqual([]);
    }
    // What the tarball holds is npm's answer, not a reading of `files`: an entry like "." or a
    // glob ships the run's config without naming it.
    const packed = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: join(repoRoot, 'packages', 'xezar'),
        encoding: 'utf8',
      }),
    ) as Array<{ files: Array<{ path: string }> }>;
    const runFiles = ['stryker.config.mjs', 'vitest.mutation.config.ts'];
    const shipped = packed[0]!.files.map((f) => f.path).filter((p) => runFiles.includes(p) || p.startsWith('.stryker-tmp/'));
    expect(shipped, 'the mutation run must not reach the tarball').toEqual([]);
  }, 60_000);
});
