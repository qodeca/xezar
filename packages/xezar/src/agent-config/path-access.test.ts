import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { checkedConfigPath, readConfigBytes } from './path-access.ts';

let fixture: string;
let root: string;
beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'xez-config-path-')));
  root = join(fixture, 'home');
  mkdirSync(root);
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

it.each(['missing', 'self', 'existing'])('refuses a %s leaf symlink with a typed reason', async (kind) => {
  const path = join(root, 'config');
  const target = kind === 'self' ? path : join(root, kind);
  if (kind === 'existing') writeFileSync(target, 'FAKE-CREDENTIAL');
  symlinkSync(target, path);
  await expect(checkedConfigPath(path, root)).rejects.toMatchObject({ reason: 'symlink', status: 409 });
});

it('refuses an escaping directory even when the requested file is absent', async () => {
  const outside = join(fixture, 'home-sibling'); // prefix overlap is not containment
  mkdirSync(outside);
  symlinkSync(outside, join(root, 'linked'));
  await expect(checkedConfigPath(join(root, 'linked', 'missing', 'config'), root))
    .rejects.toMatchObject({ reason: 'outside-root' });
});

it('refuses a directory chain that escapes then links back inside', async () => {
  const outside = join(fixture, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(root, 'exit'));
  symlinkSync(root, join(outside, 'back'));
  await expect(checkedConfigPath(join(root, 'exit', 'back', 'config'), root))
    .rejects.toMatchObject({ reason: 'outside-root' });
});

it('allows an internal directory link and missing suffixes', async () => {
  mkdirSync(join(root, 'actual'));
  symlinkSync(join(root, 'actual'), join(root, 'linked'));
  await expect(checkedConfigPath(join(root, 'linked', 'missing', 'config'), root))
    .resolves.toBe(join(root, 'actual', 'missing', 'config'));
});

it('canonicalizes a relocated whole home without authorizing a file symlink', async () => {
  const alias = join(fixture, 'alias');
  symlinkSync(root, alias);
  const path = join(alias, 'config');
  writeFileSync(join(root, 'config'), '  raw\n');
  await expect(readConfigBytes(await checkedConfigPath(path, alias))).resolves.toBe('  raw\n');
  rmSync(join(root, 'config'));
  symlinkSync(join(root, 'credential'), join(root, 'config'));
  await expect(checkedConfigPath(path, alias)).rejects.toMatchObject({ reason: 'symlink' });
});

it('refuses a leaf changed to a symlink between checking and opening', async () => {
  const path = join(root, 'config');
  writeFileSync(path, '{}');
  const checked = await checkedConfigPath(path, root);
  rmSync(path);
  writeFileSync(join(root, 'credential'), 'FAKE-CREDENTIAL');
  symlinkSync(join(root, 'credential'), path);
  await expect(readConfigBytes(checked)).rejects.toMatchObject({ reason: 'symlink' });
});

it('refuses the boundary itself and lexical traversal without looping', async () => {
  await expect(checkedConfigPath(root, root)).rejects.toMatchObject({ reason: 'outside-root' });
  await expect(checkedConfigPath(join(root, '..', 'config'), root)).rejects.toMatchObject({ reason: 'outside-root' });
});
