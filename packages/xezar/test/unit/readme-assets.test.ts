import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../../../docs/assets/readme/', import.meta.url));

function svgFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? svgFiles(path) : entry.name.endsWith('.svg') ? [path] : [];
  });
}

test('README SVGs remain small, self-contained vector images (#448)', () => {
  const files = svgFiles(root);
  assert.ok(files.length >= 16, 'all four illustrations and twelve icons must exist');
  for (const file of files) {
    const bytes = readFileSync(file);
    const svg = bytes.toString('utf8');
    assert.ok(bytes.length <= 60_000, `${file}: exceeds 60 KB`);
    assert.doesNotMatch(svg, /<\s*(?:[\w-]+:)?script\b/i, `${file}: scripts are forbidden`);
    assert.doesNotMatch(svg, /<\s*(?:image|foreignObject)\b|\bon\w+\s*=|currentColor|data:|<!ENTITY/i, `${file}: vectors only, no active content`);
    assert.doesNotMatch(svg, /(?:\b(?:xlink:)?href\s*=\s*["'](?!#)|url\(\s*["']?(?!#)[^\s])/i, `${file}: external references are forbidden`);
    assert.match(svg, /role="img"/);
    assert.match(svg, /<title\b/);
    const dimensions = file.includes(`${join('icons', '')}/`) ? [48, 48]
      : file.includes('hero-') ? [1280, 400]
      : file.includes('architecture-') ? [1200, 640] : [1200, 360];
    assert.ok(svg.includes(`viewBox="0 0 ${dimensions.join(' ')}"`), `${file}: unexpected canvas`);
    if (svg.includes('<text')) {
      assert.match(svg, /font-family: ui-sans-serif, system-ui, sans-serif/);
    }
  }
});
