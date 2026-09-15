import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectInstallChannel } from './install-channel.ts';

const pkgRoot = join('/opt', 'xezar-pkg');
const builtEntry = pathToFileURL(join(pkgRoot, 'dist', 'index.js')).href;
const sourceEntry = pathToFileURL(join(pkgRoot, 'src', 'index.ts')).href;
const marker = join(pkgRoot, 'src', 'index.ts');

describe('detectInstallChannel (#442)', () => {
  it('answers dev when the package root carries src/index.ts — built dist and tsx alike', () => {
    const seen: string[] = [];
    const exists = (path: string) => {
      seen.push(path);
      return path === marker;
    };
    expect(detectInstallChannel(builtEntry, exists)).toBe('dev');
    expect(detectInstallChannel(sourceEntry, exists)).toBe('dev');
    expect(seen).toEqual([marker, marker]);
  });

  it('answers release when src/index.ts is absent, as in the published tarball', () => {
    expect(detectInstallChannel(builtEntry, () => false)).toBe('release');
  });

  it('answers release when the check throws — never a false dev badge', () => {
    const exists = () => {
      throw new Error('EACCES');
    };
    expect(detectInstallChannel(builtEntry, exists)).toBe('release');
    expect(detectInstallChannel('not a file url', () => true)).toBe('release');
  });
});
