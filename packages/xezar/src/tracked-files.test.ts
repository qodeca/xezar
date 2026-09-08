import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What this repository is allowed to have under version control.
 *
 * The rename produced a trap worth guarding permanently. Runtime state lived at `.ai/cezar/`
 * and `.ai/qa/cez-home/`, and `.gitignore` named those paths. Renaming the ignore rules to
 * `.ai/xezar/` and `.ai/qa/xez-home/` moved them OFF the directories a developer already had on
 * disk — so a `git add -A` swept four files of local machine state into a commit, including an
 * absolute home-directory path, on a repository about to be made public.
 *
 * Ignore rules are the fix; this is the check that they are still doing their job. It reads
 * `git ls-files`, not the filesystem, so it fails on what is TRACKED rather than what merely
 * exists.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const trackedFiles = (): string[] =>
  execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);

describe('tracked files', () => {
  it('tracks no per-machine runtime state, under either product name', () => {
    // `.ai/qa/agent-home/` is the most credential-adjacent of these: the e2e boot points the
    // agents' OWN config vars at it, so a `codex login` or `claude` login run while that env is
    // active writes real credentials there. It is the newest directory and the one a future
    // ignore-rule tidy-up would be likeliest to move a rule off — which is exactly how the
    // incident in this file's header happened.
    const stateDirs = [
      /^\.ai\/(xezar|cezar)\//,
      /^\.ai\/qa\/(xez|cez)-home\//,
      /^\.ai\/qa\/agent-home\//,
      /^\.ai\/tmp\//,
    ];
    const leaked = trackedFiles().filter((file) => stateDirs.some((dir) => dir.test(file)));
    expect(leaked, 'local runtime state must never be committed').toEqual([]);
  });

  it('tracks no agent work-record archive', () => {
    // Removed with the rename and gitignored; the pipeline still writes them locally.
    const leaked = trackedFiles().filter((file) => /^\.ai\/(runs|specs|analysis)\//.test(file));
    expect(leaked).toEqual([]);
  });

  it('tracks no environment file — only the documented example', () => {
    const tracked = trackedFiles().filter((file) => /(^|\/)\.env($|\.)/.test(file));
    expect(tracked).toEqual(['.env.example']);
  });

  it('tracks no local agent scratch', () => {
    expect(trackedFiles().filter((file) => file.startsWith('.local/'))).toEqual([]);
  });
});
