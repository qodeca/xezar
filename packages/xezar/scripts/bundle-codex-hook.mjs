/** Bundle the trusted Codex hook into one dependency-free, content-addressable program. */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [join(root, 'src', 'core', 'codex-read-only-hook-entry.ts')],
  outfile: join(root, 'scripts', 'codex-read-only-hook.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
});

console.log('bundle-codex-hook ok — wrote scripts/codex-read-only-hook.mjs');
