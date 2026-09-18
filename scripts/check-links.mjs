#!/usr/bin/env node
// Offline relative-link/anchor checker for Markdown docs. No network, no dependencies.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const designsRoot = resolve(root, 'designs');
const roots = ['docs', 'README.md', '.xezar/docs', 'designs'].map((p) => resolve(root, p));
const walk = (path) => {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return extname(path) === '.md' ? [path] : [];
  return readdirSync(path).flatMap((name) => walk(join(path, name)));
};
const slugify = (text) => text.trim().toLowerCase().replace(/[^\w\- ]+/g, '').replace(/ /g, '-');
const headingSlugs = (file) =>
  readFileSync(file, 'utf8').split('\n').filter((l) => /^#{1,6}\s+/.test(l)).map((l) => slugify(l.replace(/^#{1,6}\s+/, '')));
const files = roots
  .flatMap(walk)
  .filter((f, i, a) => a.indexOf(f) === i && (!f.startsWith(designsRoot) || f.endsWith('README.md')));

let broken = 0;
const report = (file, lineNo, target) => {
  console.log(`${relative(root, file)}:${lineNo} → ${target}`);
  broken++;
};
for (const file of files) {
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    for (const [, raw] of line.matchAll(/]\(([^)]+)\)/g)) {
      const target = decodeURIComponent(raw);
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [rawPath, anchor] = target.split('#');
      const targetFile = rawPath ? resolve(dirname(file), rawPath) : file;
      if (rawPath && !existsSync(targetFile)) report(file, i + 1, target);
      else if (anchor && extname(targetFile) === '.md' && !headingSlugs(targetFile).includes(anchor)) report(file, i + 1, target);
    }
  });
}
process.exit(broken > 0 ? 1 : 0);
