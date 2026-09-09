import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Engine-owned run state: run index, transcripts, worktrees, scratch, todos,
 * UI state, launch key and automations. Always `<repo>/.local/xezar`, for every
 * project. There is no other location and no discovery step — a directory from
 * an older layout is simply not xezar state any more.
 */
export function projectDataDir(repoRoot: string): string {
  return join(repoRoot, '.local/xezar');
}

/** Called by writers, never by read-only discovery. Protect secondary project contexts too. */
export function ensureProjectDataIgnored(dataDir: string): void {
  if (basename(dirname(dataDir)) !== '.local') return;
  try {
    const local = dirname(dataDir);
    mkdirSync(local, { recursive: true, mode: 0o700 });
    const file = join(local, '.gitignore');
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (!current.split('\n').includes('*')) writeFileSync(file, `${current}\n*\n`, 'utf8');
  } catch { /* Normal store writes decide how to handle a read-only repository. */ }
}

/** Ephemeral tools keep working when the target is missing or read-only. */
export function projectScratchDir(repoRoot: string): string {
  if (!existsSync(repoRoot)) return tmpdir();
  const data = projectDataDir(repoRoot);
  try {
    ensureProjectDataIgnored(data);
    const scratch = join(data, 'tmp');
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    return scratch;
  } catch { return tmpdir(); }
}
