import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `scripts/sync-readme.mjs` copies the root README into the package that npm publishes (#287).
 * The root README's relative links (`docs/screenshots/*.png`, `docs/server-install/*.md`,
 * `LICENSE`) are right on GitHub and point at nothing inside the package, so on npmjs.com every
 * screenshot and guide link was broken. These cases hold the copy to absolute links, and hold the
 * root README to the relative ones GitHub needs.
 */

type SyncReadme = {
  absolutizeReadmeLinks: (markdown: string, repoUrl: string) => string;
  githubRepoUrl: (repositoryUrl: unknown) => string;
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../..');
const load = () => import(pathToFileURL(resolve(packageRoot, 'scripts/sync-readme.mjs')).href) as Promise<SyncReadme>;

const REPO = 'https://github.com/qodeca/xezar';

/** Every link target in prose that would resolve against the package rather than a URL. Code is skipped. */
function relativeTargets(markdown: string): string[] {
  const prose = markdown
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, '')
    .replace(/`+[^`\n]*`+/g, '');
  const targets = [
    ...[...prose.matchAll(/\]\(\s*([^)\s]+)/g)].map((m) => m[1]!),
    ...[...prose.matchAll(/\s(?:src|href)="([^"]+)"/gi)].map((m) => m[1]!),
    ...[...prose.matchAll(/^ {0,3}\[(?!\^)[^\]]+\]:[ \t]*(\S+)/gm)].map((m) => m[1]!),
  ];
  return targets.filter((t) => !/^(#|[a-z][a-z0-9+.-]*:)/i.test(t));
}

describe('sync-readme: the README npm publishes', () => {
  it('has no relative link or image left once the real root README is synced', async () => {
    const { absolutizeReadmeLinks, githubRepoUrl } = await load();
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as { repository: { url: string } };
    const root = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');

    const synced = absolutizeReadmeLinks(root, githubRepoUrl(manifest.repository.url));

    expect(relativeTargets(synced)).toEqual([]);
    expect(synced).toContain(`](https://raw.githubusercontent.com/qodeca/xezar/main/docs/screenshots/task-view.png)`);
    expect(synced).toContain(`](${REPO}/blob/main/LICENSE)`);
  });

  it('leaves the root README itself relative, because those links are right on GitHub', () => {
    const root = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
    expect(root).toContain('](docs/screenshots/task-view.png)');
    expect(relativeTargets(root).length).toBeGreaterThan(0);
  });

  it('points documents at the blob view and images at the raw file, keeping the fragment and title', async () => {
    const { absolutizeReadmeLinks } = await load();
    const input = [
      '[guide](docs/server-install/ubuntu-vps.md#the-box) and [licence](./LICENSE "MIT")',
      '[![shot](docs/screenshots/a.png)](docs/screenshots/a.png)',
      '<img src="docs/logo.svg" alt="logo"> <a href="/docs/README.md">map</a>',
      '[ref]: docs/project-layout.md',
    ].join('\n');

    expect(absolutizeReadmeLinks(input, REPO).split('\n')).toEqual([
      `[guide](${REPO}/blob/main/docs/server-install/ubuntu-vps.md#the-box) and [licence](${REPO}/blob/main/LICENSE "MIT")`,
      '[![shot](https://raw.githubusercontent.com/qodeca/xezar/main/docs/screenshots/a.png)](https://raw.githubusercontent.com/qodeca/xezar/main/docs/screenshots/a.png)',
      `<img src="https://raw.githubusercontent.com/qodeca/xezar/main/docs/logo.svg" alt="logo"> <a href="${REPO}/blob/main/docs/README.md">map</a>`,
      `[ref]: ${REPO}/blob/main/docs/project-layout.md`,
    ]);
  });

  it('leaves absolute URLs, in-page anchors, footnotes and anything inside code untouched', async () => {
    const { absolutizeReadmeLinks } = await load();
    const input = [
      '[site](https://opencode.ai) [mail](mailto:a@b.c) [up](#quick-start)',
      '[^1]: a footnote, not a link',
      'inline `[x](docs/a.md)` stays',
      '```md',
      '[x](docs/a.md)',
      '```',
      '~~~',
      '![y](docs/b.png)',
      '~~~',
    ].join('\n');

    expect(absolutizeReadmeLinks(input, REPO)).toBe(input);
  });

  it('derives the GitHub URL from the manifest and refuses a repository it cannot place', async () => {
    const { githubRepoUrl } = await load();
    expect(githubRepoUrl('git+https://github.com/qodeca/xezar.git')).toBe(REPO);
    expect(githubRepoUrl('https://github.com/qodeca/xezar')).toBe(REPO);
    expect(githubRepoUrl('git@github.com:qodeca/xezar.git')).toBe(REPO);
    expect(() => githubRepoUrl('https://gitlab.com/qodeca/xezar.git')).toThrow(/not a GitHub repository/);
    expect(() => githubRepoUrl(undefined)).toThrow(/not a GitHub repository/);
  });
});
