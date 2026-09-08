import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
// This file lives at packages/xezar/test/e2e; the orchestrator it drives is at the REPO root,
// because a release spans every workspace and belongs to none of them.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const script = join(repoRoot, 'scripts', 'release.mjs');

// The orchestrator imports packages/xezar/dist/release/stable.js, so this suite runs after
// `npm run build`.

/** A miniature of the real workspace: the three release manifests, in their real directories,
 *  with the same intra-release dependency edges the pipeline has to re-pin. */
async function makeFixture(version = '0.1.5'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xezar-release-'));
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fake-monorepo', private: true, version: '0.0.0' }, null, 2)}\n`,
  );

  // The contract package joins the stamped set: private, so never published, but versioned in
  // lockstep and depended on by the api-client.
  await mkdir(join(root, 'packages', 'contract'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'contract', 'package.json'),
    `${JSON.stringify({ name: '@scope/fake-contract', version: '0.9.9', private: true, files: ['index.js'] }, null, 2)}\n`,
  );
  await writeFile(join(root, 'packages', 'contract', 'index.js'), 'export {};\n');

  await mkdir(join(root, 'packages', 'api-client'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'api-client', 'package.json'),
    `${JSON.stringify({ name: '@scope/fake-client', version, files: ['index.js'] }, null, 2)}\n`,
  );
  await writeFile(join(root, 'packages', 'api-client', 'index.js'), 'export {};\n');

  await mkdir(join(root, 'packages', 'xezar'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'xezar', 'package.json'),
    `${JSON.stringify(
      {
        name: '@scope/fake-root',
        version,
        files: ['index.js'],
        devDependencies: { '@scope/fake-client': `^${version}` },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, 'packages', 'xezar', 'index.js'), 'export {};\n');
  return root;
}

const readPkg = async (root: string, ...segments: string[]) =>
  JSON.parse(await readFile(join(root, ...segments, 'package.json'), 'utf8')) as {
    version: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

function runScript(fixtureRoot: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    XEZ_RELEASE_ROOT: fixtureRoot,
    GITHUB_OUTPUT: join(fixtureRoot, 'github-output.txt'),
    NODE_AUTH_TOKEN: '',
    GITHUB_ACTIONS: '',
    ...extraEnv,
  };
  return execFile(process.execPath, [script, ...args], { env, maxBuffer: 10 * 1024 * 1024 });
}

test('a patch bump stamps every manifest, keeps the caret ranges, and emits the version', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    const { stdout } = await runScript(root, ['patch', '--dry-run']);
    assert.match(stdout, /dist-tag latest/);
    // Dependency order: the client is published before the service that depends on it. A
    // dependent published first would advertise a version that is not on the registry yet.
    assert.ok(
      stdout.indexOf('@scope/fake-client') < stdout.indexOf('@scope/fake-root'),
      'the api-client must be published before the service',
    );

    const contractPkg = await readPkg(root, 'packages', 'contract');
    const clientPkg = await readPkg(root, 'packages', 'api-client');
    const xezarPkg = await readPkg(root, 'packages', 'xezar');
    assert.equal(contractPkg.version, '0.1.6');
    assert.equal(clientPkg.version, '0.1.6');
    assert.equal(xezarPkg.version, '0.1.6');
    // Caret, not an exact pin — the stable-release contract.
    assert.deepEqual(xezarPkg.devDependencies, { '@scope/fake-client': '^0.1.6' });

    // The workspace root publishes nothing and must be left exactly as it was.
    const rootPkg = await readPkg(root);
    assert.equal(rootPkg.version, '0.0.0');

    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^version=0\.1\.6$/m);
    assert.match(output, /^published=false$/m);
    assert.match(output, /^dryRun=true$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a private package is stamped but never published', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    // Mark the client private, the way the api-client is until its contract stops moving.
    const clientPath = join(root, 'packages', 'api-client', 'package.json');
    const clientPkg = JSON.parse(await readFile(clientPath, 'utf8')) as Record<string, unknown>;
    await writeFile(clientPath, `${JSON.stringify({ ...clientPkg, private: true }, null, 2)}\n`);

    await writeFile(join(root, 'github-output.txt'), '');
    const { stdout } = await runScript(root, ['patch', '--dry-run']);

    // Stamped in lockstep — a frozen version would strand the service's pin against it.
    assert.equal((await readPkg(root, 'packages', 'api-client')).version, '0.1.6');
    assert.deepEqual((await readPkg(root, 'packages', 'xezar')).devDependencies, {
      '@scope/fake-client': '^0.1.6',
    });

    // …but never handed to npm, and the skip is stated rather than silent.
    assert.match(stdout, /@scope\/fake-client is private — stamped to 0\.1\.6, not published/);
    assert.ok(
      !/npm publish[^\n]*\(@scope\/fake-client\)/.test(stdout),
      'a private package must not be published',
    );
    // The service still publishes.
    assert.match(stdout, /\(@scope\/fake-root\)/);

    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^publishedNames=@scope\/fake-root$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the existing bump publishes the committed version verbatim', { timeout: 120_000 }, async () => {
  const root = await makeFixture('2.3.4');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    await runScript(root, ['existing', '--dry-run']);
    assert.equal((await readPkg(root, 'packages', 'xezar')).version, '2.3.4');
    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^version=2\.3\.4$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('no credential at all FAILS the release instead of quietly dry-running', { timeout: 120_000 }, async () => {
  // Regression guard. The pipeline used to force `--dry-run` when the credential was absent and
  // exit 0, so an unconfigured repository produced a GREEN `Release` run that published nothing
  // and cut no tag. Green means published; anything else is a failure a human has to look at.
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    // No --dry-run flag, no OIDC endpoint, no NODE_AUTH_TOKEN.
    const error = await runScript(root, ['minor']).then(
      () => null,
      (e: Error & { code?: number; stderr?: string }) => e,
    );
    assert.ok(error, 'a release with no credential must exit non-zero');
    assert.notEqual(error.code, 0);
    assert.match(error.stderr ?? '', /refusing to run/);

    // Nothing was stamped and nothing was claimed.
    assert.equal((await readPkg(root, 'packages', 'xezar')).version, '0.1.5');
    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.doesNotMatch(output, /^published=true$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an OIDC-capable job needs no token — the id-token endpoint IS the credential', { timeout: 120_000 }, async () => {
  // What a real `Release` run looks like: `permissions: id-token: write` makes GitHub expose the
  // token-minting endpoint, and that is the whole credential. If this ever regressed to
  // demanding NODE_AUTH_TOKEN, every trusted-publishing release would fail before npm was asked.
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    const { stdout } = await runScript(root, ['minor', '--dry-run'], {
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.test/token',
      GITHUB_ACTIONS: 'true',
    });
    assert.match(stdout, /dist-tag latest/);
    assert.doesNotMatch(stdout, /refusing to run/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an explicit --dry-run never claims a publish', { timeout: 120_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    await runScript(root, ['minor', '--dry-run']);
    const output = await readFile(join(root, 'github-output.txt'), 'utf8');
    assert.match(output, /^published=false$/m);
    assert.match(output, /^dryRun=true$/m);
    assert.match(output, /^version=0\.2\.0$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unknown bump exits non-zero without touching the manifests', { timeout: 60_000 }, async () => {
  const root = await makeFixture('0.1.5');
  try {
    await writeFile(join(root, 'github-output.txt'), '');
    await assert.rejects(runScript(root, ['snapshot', '--dry-run']));
    assert.equal((await readPkg(root, 'packages', 'xezar')).version, '0.1.5');
    assert.equal((await readPkg(root, 'packages', 'api-client')).version, '0.1.5');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
