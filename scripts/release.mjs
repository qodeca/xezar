#!/usr/bin/env node
// Stable-release orchestrator (`node scripts/release.mjs <bump>`) — the
// side-effect half of src/release/stable.ts, invoked by the manually-triggered
// `Release` workflow (.github/workflows/release.yml) after `npm run build` (#482).
//
// This is the ONLY thing in the repository that publishes to npm, and it never
// runs from a push — a human dispatches it and picks the bump (patch/minor/major,
// or `existing` to publish the version already committed). It stamps every
// manifest in the release set (intra-release dependencies kept as caret ranges),
// then publishes them in DEPENDENCY ORDER — contract, api-client, then the
// service — always with `--tag latest`. Publishing a dependent before its
// dependency would briefly advertise a version that is not on the registry yet.
// Today only the service is public, so the service is the only one that ships.
//
// A manifest marked `private` is stamped but NOT published: it is part of the
// release — its version moves in lockstep and the pins against it are rewritten
// — without being on the registry. That is how a package can be consumed inside
// the workspace long before it is offered to anyone else.
//
// Publishes with --ignore-scripts: the workflow ran `npm run build` (whose last
// leg, check:pack, is the tarball-integrity gate) immediately before this, and
// dist/ must exist for this script to even import. Stamping only rewrites the
// version field, so no rebuild is needed.
//
// FAILS when NPM_TOKEN is missing. An earlier revision silently degraded to a
// visible dry run, which meant a green `Release` run proved nothing: the summary
// said "published" nowhere, but no human reads a summary of a job that went
// green. A release either publishes or it fails, so a missing credential is an
// error, not a mode. `--dry-run` stays available as an EXPLICIT flag for local
// rehearsal. The workflow reads `version`/`published` from $GITHUB_OUTPUT and
// cuts the tag + GitHub Release only on a real publish.
//
// Usage: node scripts/release.mjs <patch|minor|major|existing> [--dry-run]
// Env override for tests: XEZ_RELEASE_ROOT (defaults to the repo root).

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPublishable } from '../packages/xezar/dist/release/manifests.js';
import {
  computeStableVersion,
  isReleaseBump,
  stampStableManifests,
} from '../packages/xezar/dist/release/stable.js';

const repoRoot = process.env.XEZ_RELEASE_ROOT
  ? path.resolve(process.env.XEZ_RELEASE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The workspace root publishes nothing; every publishable manifest is named here explicitly.
const dirs = {
  contract: path.join(repoRoot, 'packages/contract'),
  apiClient: path.join(repoRoot, 'packages/api-client'),
  xezar: path.join(repoRoot, 'packages/xezar'),
};
/** Stamp and publish order — a dependency before anything that depends on it. */
const RELEASE_ORDER = ['contract', 'apiClient', 'xezar'];

const readManifest = (dir) => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
const writeManifest = (dir, pkg) =>
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

const emitOutput = (result) => {
  console.log(`release result: ${JSON.stringify(result)}`);
  if (process.env.GITHUB_OUTPUT) {
    const lines = Object.entries(result).map(([k, v]) => `${k}=${v}`);
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, 'utf8');
  }
};

const bump = (process.argv[2] ?? process.env.RELEASE_BUMP ?? '').trim();
if (!isReleaseBump(bump)) {
  console.error(`release: unknown bump "${bump}" — expected patch, minor, major, or existing.`);
  process.exit(1);
}

const manifests = {
  contract: readManifest(dirs.contract),
  apiClient: readManifest(dirs.apiClient),
  xezar: readManifest(dirs.xezar),
};

// The service manifest is the base: it is the package whose version the release is named after.
const version = computeStableVersion(bump, manifests.xezar.version);
if (!version) {
  console.error(
    `release: cannot ${bump}-bump base version "${manifests.xezar.version}" — a stable release must start from a plain x.y.z.`,
  );
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const token = process.env.NODE_AUTH_TOKEN ?? '';
if (!dryRun && !token) {
  console.error('release: NODE_AUTH_TOKEN is empty — refusing to run.');
  console.error('release: a release must publish or fail; it must never report a dry run as one.');
  console.error('release: set the NPM_TOKEN repository secret (see docs/publishing.md), then re-dispatch.');
  console.error('release: to rehearse locally without publishing, pass --dry-run explicitly.');
  process.exit(1);
}

const stamped = stampStableManifests(manifests, version);
for (const key of RELEASE_ORDER) writeManifest(dirs[key], stamped[key]);
const stampedNames = RELEASE_ORDER.map((key) => stamped[key].name);
console.log(
  `release: stamped ${stampedNames.join(' + ')} to ${version} (bump ${bump}, dist-tag latest${dryRun ? ', dry run' : ''})`,
);

// Provenance needs the job's OIDC token (permissions: id-token: write); only
// meaningful for a real publish from Actions.
const provenance = !dryRun && process.env.GITHUB_ACTIONS === 'true' ? ['--provenance'] : [];
// Same cross-platform npm resolution as scripts/release-snapshot.mjs.
const npmExecpath = process.env.npm_execpath;
const runNpm = (args, cwd) => {
  if (npmExecpath) {
    execFileSync(process.execPath, [npmExecpath, ...args], { cwd, stdio: 'inherit' });
  } else {
    const npmCli = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npmCli, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  }
};
const publish = (dir, label) => {
  const args = [
    'publish',
    '--tag', 'latest',
    '--access', 'public',
    '--ignore-scripts',
    ...provenance,
    ...(dryRun ? ['--dry-run'] : []),
  ];
  console.log(`release: npm ${args.join(' ')}  (${label})`);
  runNpm(args, dir);
};

// Dependency order — see the header. `ReleaseManifests` declares its fields in this order for
// exactly this reason. A `private` manifest is stamped above but never published: it is part of
// the release (its version moves, its pins are rewritten) without being on the registry.
const published = [];
for (const key of RELEASE_ORDER) {
  if (!isPublishable(stamped[key])) {
    console.log(`release: ${stamped[key].name} is private — stamped to ${version}, not published.`);
    continue;
  }
  publish(dirs[key], stamped[key].name);
  published.push(stamped[key].name);
}

emitOutput({
  published: !dryRun,
  dryRun,
  bump,
  version,
  rootName: stamped.xezar.name,
  publishedNames: published.join(','),
});
