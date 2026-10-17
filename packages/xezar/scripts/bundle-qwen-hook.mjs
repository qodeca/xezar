/** Bundle the Qwen Code tool-policy hook into one dependency-free program (#1044). */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [join(root, 'src', 'core', 'qwen-pre-tool-hook-entry.ts')],
  outfile: join(root, 'scripts', 'qwen-pre-tool-hook.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
});

console.log('bundle-qwen-hook ok — wrote scripts/qwen-pre-tool-hook.mjs');
