import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packageManifest = join(packageRoot, 'package.json');

/**
 * Every specifier `@qodeca/xezar` advertises must actually resolve for a consumer OUTSIDE the
 * package.
 *
 * 0.9.3 shipped a distribution whose entry point imported `@…/…/dist/index.js` while the
 * manifest exported only `.`, `./app-type` and `./package.json`. Once a package declares
 * `exports`, Node serves ONLY the listed subpaths and hard-blocks the rest — so every install
 * died with ERR_PACKAGE_PATH_NOT_EXPORTED against a file sitting right there in the tarball
 * (#851).
 *
 * Nothing else in the gate could see it. `bin` paths resolve INSIDE the package and never pass
 * through the exports gate; `check:pack` counts packed files rather than resolving them. The
 * break is only reachable by resolving the real specifiers against the real manifest from
 * outside — which is what this does.
 *
 * The unscoped alias package that used to carry this hazard is gone; the hazard is not. It now
 * belongs to anyone who writes `import { … } from '@qodeca/xezar/app-type'`.
 *
 * Resolution is all it takes: Node applies the exports gate while resolving, before it ever
 * touches the target file, so this needs the manifest only and runs green on a fresh checkout
 * with no `dist/`.
 */

interface Manifest {
  name: string;
  bin: Record<string, string>;
  files: string[];
  exports: Record<string, string>;
}

const readManifest = async (): Promise<Manifest> =>
  JSON.parse(await readFile(packageManifest, 'utf8')) as Manifest;

test('every exported subpath resolves for an outside consumer', async () => {
  const manifest = await readManifest();
  const specifiers = Object.keys(manifest.exports).map((subpath) =>
    subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`,
  );
  assert.ok(specifiers.length > 0, 'the manifest declares no exports — this guard sees nothing');

  const root = await mkdtemp(join(tmpdir(), 'xezar-exports-'));
  try {
    // A consumer that has only the published manifest installed — the exports gate reads
    // nothing else, so this reproduces a real install's resolution exactly.
    await writeFile(join(root, 'package.json'), '{"private":true,"type":"module"}\n', 'utf8');
    const [scope, name] = manifest.name.split('/');
    const installed = join(root, 'node_modules', scope as string, name as string);
    await mkdir(installed, { recursive: true });
    await copyFile(packageManifest, join(installed, 'package.json'));

    for (const specifier of specifiers) {
      await execFile(
        process.execPath,
        ['--input-type=module', '-e', `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`],
        { cwd: root },
      ).catch((error: Error & { stderr?: string }) => {
        assert.fail(
          `'${specifier}' is advertised by the exports map but does not resolve — every consumer ` +
            `importing it would fail (#851): ${error.stderr?.trim() ?? error.message}`,
        );
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the bare package specifier lands on the CLI entry point', async () => {
  const manifest = await readManifest();
  const root = await mkdtemp(join(tmpdir(), 'xezar-exports-main-'));
  try {
    await writeFile(join(root, 'package.json'), '{"private":true,"type":"module"}\n', 'utf8');
    const [scope, name] = manifest.name.split('/');
    const installed = join(root, 'node_modules', scope as string, name as string);
    await mkdir(installed, { recursive: true });
    await copyFile(packageManifest, join(installed, 'package.json'));

    const resolved = await execFile(
      process.execPath,
      ['--input-type=module', '-e', `console.log(import.meta.resolve(${JSON.stringify(manifest.name)}))`],
      { cwd: root },
    );
    assert.match(
      resolved.stdout.trim(),
      /\/dist\/index\.js$/,
      `'${manifest.name}' resolves to ${resolved.stdout.trim()}, not the CLI entry point`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the published package offers exactly the xezar and xez commands', async () => {
  const manifest = await readManifest();
  // The unscoped `cezar-cli` distribution was retired with the rename. A resurrected third bin
  // would put a name on users' PATH that no published package backs.
  assert.deepEqual(Object.keys(manifest.bin).sort(), ['xez', 'xezar']);
  for (const target of Object.values(manifest.bin)) {
    assert.ok(
      manifest.files.some((entry) => target.startsWith(entry)),
      `bin target ${target} is not inside any published \`files\` entry — it would not be packed`,
    );
  }
});
