import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { z } from 'zod';
import { isSafeGitRef } from '../git-refs.ts';
import { writeFileAtomic } from '../platform/atomic-write.ts';
import { isInsideByIdentity, samePath } from '../platform/path-identity.ts';
import { isDrivePath } from '../platform/path-syntax.ts';
import { launchFile } from '../platform/process-launch.ts';

/**
 * Repository-owned Claude Code hooks for one workflow step (#1001, packing #901 and #936).
 *
 * A read-only Claude step starts with `--setting-sources user` (#863), so a project's own
 * `.claude/settings.json` never loads there. That is the right default, and it also removed the
 * only reviewed place a project could register a `PreToolUse` hook. `claudeSettings` brings hooks
 * back WITHOUT reopening project settings:
 *
 * - The step names settings files and the scripts their hook commands run, as repo-relative paths.
 * - Every file is read from the run's BASE commit (`git cat-file` on the commit the run's
 *   `baseBranch` resolves to), never from the task's working copy, so a change under review cannot
 *   change the hook that guards its own review.
 * - A settings file may hold the `hooks` key and nothing else. Any other key – `permissions`,
 *   `sandbox`, `env`, `mcpServers`, … – fails the step, naming the key.
 * - Each hook is `type: "command"`. A command that names a repository file not listed in
 *   `scripts`, or that uses shell expansion other than the `$CLAUDE_PROJECT_DIR/` prefix, fails
 *   the step: an unlisted script would run from the working copy and escape the pin.
 * - Listed scripts are copied, content-addressed, under the project's runtime state, and each
 *   command is rewritten to the pinned copy. The merged result is one settings file the runner
 *   passes with `--settings`, beside the unchanged `--setting-sources user`.
 *
 * Limit: a pinned script that itself reads another repository file reads the working copy's
 * version. Keep hook scripts self-contained.
 */

/** The one settings key a step may load. Documented in `workflows/AGENTS.md` and AGENT_PROTOCOL.md. */
export const CLAUDE_SETTINGS_ALLOWED_KEYS = ['hooks'] as const;

const HOOK_GROUP_KEYS = new Set(['matcher', 'hooks']);
const HOOK_ENTRY_KEYS = new Set(['type', 'command', 'timeout']);

/** True for a plain repo-relative path: no absolute or drive form, no `.`/`..` segment, no `\`. */
export function isRepoRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (/[\0\\:]/.test(path) || posix.isAbsolute(path) || path.startsWith('-')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

const repoRelativePathSchema = z.string().refine(isRepoRelativePath, {
  message:
    'claudeSettings paths must be repository-relative (no leading "/", drive letter, "\\", "." or ".." segment)',
});

/** The authored step field. */
export const claudeSettingsFieldSchema = z
  .object({
    /** Settings files whose `hooks` the step loads; merged in order. */
    files: z.array(repoRelativePathSchema).min(1),
    /** Every repository script a hook command runs; pinned beside the settings. */
    scripts: z.array(repoRelativePathSchema).optional(),
  })
  .strict();

export type ClaudeSettingsField = z.infer<typeof claudeSettingsFieldSchema>;

/** A refused settings file or hook command; its message is the step's failure reason. */
export class ClaudeStepSettingsError extends Error {}

interface HookEntry {
  type: 'command';
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
export type ClaudeHooks = Record<string, HookGroup[]>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validate one parsed settings document and return its hooks. An allow-list, not a deny-list:
 * anything that is not a recognised hook shape is refused, naming the exact key path.
 */
export function validateClaudeSettingsDoc(doc: unknown, file: string): ClaudeHooks {
  const fail = (detail: string): never => {
    throw new ClaudeStepSettingsError(`claudeSettings file "${file}" refused: ${detail}`);
  };
  if (!isPlainObject(doc)) fail('it must be a JSON object');
  const root = doc as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!(CLAUDE_SETTINGS_ALLOWED_KEYS as readonly string[]).includes(key)) {
      fail(
        `key "${key}" is not allowed – a step may load only "hooks"; a permission, sandbox, env or MCP key would widen the step`,
      );
    }
  }
  const hooks = root.hooks;
  if (hooks === undefined) return {};
  if (!isPlainObject(hooks)) fail('"hooks" must be an object of event names');
  const out: ClaudeHooks = {};
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) fail(`"hooks.${event}" must be a list`);
    out[event] = (groups as unknown[]).map((group, g) => {
      const at = `hooks.${event}[${g}]`;
      if (!isPlainObject(group)) fail(`"${at}" must be an object`);
      const grp = group as Record<string, unknown>;
      for (const key of Object.keys(grp)) {
        if (!HOOK_GROUP_KEYS.has(key)) fail(`key "${at}.${key}" is not allowed`);
      }
      if (grp.matcher !== undefined && typeof grp.matcher !== 'string') fail(`"${at}.matcher" must be a string`);
      if (!Array.isArray(grp.hooks)) fail(`"${at}.hooks" must be a list`);
      const entries = (grp.hooks as unknown[]).map((entry, h) => {
        const eat = `${at}.hooks[${h}]`;
        if (!isPlainObject(entry)) fail(`"${eat}" must be an object`);
        const ent = entry as Record<string, unknown>;
        for (const key of Object.keys(ent)) {
          if (!HOOK_ENTRY_KEYS.has(key)) fail(`key "${eat}.${key}" is not allowed`);
        }
        if (ent.type !== 'command') fail(`"${eat}.type" must be "command"`);
        if (typeof ent.command !== 'string' || ent.command.trim() === '') fail(`"${eat}.command" must be a non-empty string`);
        if (ent.timeout !== undefined && !(typeof ent.timeout === 'number' && ent.timeout > 0)) {
          fail(`"${eat}.timeout" must be a positive number`);
        }
        return {
          type: 'command' as const,
          command: ent.command as string,
          ...(ent.timeout !== undefined ? { timeout: ent.timeout as number } : {}),
        };
      });
      return { ...(grp.matcher !== undefined ? { matcher: grp.matcher as string } : {}), hooks: entries };
    });
  }
  return out;
}

const PROJECT_DIR_PREFIX = /^(?:\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\})\//;
/** Whitespace and shell operators split words, so `a;.x/y.sh` or `2>/dev/null` is read as separate words. */
const WORD_SEPARATORS = /(\s+|[;&|<>()]+)/;
const SEPARATOR_ONLY = /^(?:\s+|[;&|<>()]+)$/;

/** Single-quote for the POSIX shell Claude Code runs hook commands in. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Refusal-only containment: it may widen a refusal, never grant anything. */
function isInside(path: string, root: string): boolean {
  const child = resolve(path);
  const parent = resolve(root);
  return samePath(child, parent) || isInsideByIdentity(parent, child);
}

/** Absolute in the POSIX shell that runs hooks, or a Windows drive path. */
const isAbsoluteHookPath = (path: string): boolean => posix.isAbsolute(path) || isDrivePath(path);

export interface HookCommandContext {
  /** Listed script (repo-relative) → absolute pinned copy. */
  scripts: ReadonlyMap<string, string>;
  /** Whether a repo-relative name exists at the base commit or in the working copy. */
  existsInRepo: (relativePath: string) => boolean;
  /** Absolute roots no hook command may name directly: the primary checkout and the working copy. */
  protectedRoots: readonly string[];
}

/**
 * Rewrite one hook command so every listed script points at its pinned copy, and refuse a command
 * that would run anything else from the repository. Strict by design (owner decision on #1001):
 * a relative path with a `/`, a bare name that exists in the repository, an absolute path inside
 * the checkout, a `$CLAUDE_PROJECT_DIR/` path that is not listed, or any other `$`/backtick
 * expansion fails the step.
 */
export function rewriteHookCommand(command: string, where: string, ctx: HookCommandContext): string {
  const fail = (detail: string): never => {
    throw new ClaudeStepSettingsError(`claudeSettings hook ${where} refused: ${detail}`);
  };
  return command
    .split(WORD_SEPARATORS)
    .map((part) => {
      if (part === '' || SEPARATOR_ONLY.test(part)) return part;
      const word = part.replace(/["']/g, '');
      if (word === '') return part;
      const projectDir = PROJECT_DIR_PREFIX.exec(word);
      const candidate = projectDir ? word.slice(projectDir[0].length) : word;
      if (/[$`]/.test(candidate)) fail(`"${part}" uses shell expansion; only a "$CLAUDE_PROJECT_DIR/" prefix is allowed`);
      const relative = candidate.replace(/^(?:\.\/)+/, '');
      const pinned = ctx.scripts.get(relative);
      if (pinned !== undefined) return shellQuote(pinned);
      const notListed = `"${candidate}" names a repository file that is not listed in claudeSettings.scripts`;
      if (projectDir) fail(notListed);
      if (isAbsoluteHookPath(candidate)) {
        if (ctx.protectedRoots.some((root) => isInside(candidate, root))) fail(notListed);
        return part;
      }
      if (candidate === '.') return part;
      if (candidate.includes('/') || candidate.includes('\\') || candidate === '..') fail(notListed);
      if (ctx.existsInRepo(relative)) fail(notListed);
      return part;
    })
    .join('');
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((done) => {
    launchFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) =>
      done({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

interface BaseBlob {
  content: string;
  executable: boolean;
}

async function readBaseBlob(repoRoot: string, commit: string, path: string, what: string): Promise<BaseBlob> {
  const entry = await git(repoRoot, ['ls-tree', commit, '--', path]);
  const match = /^(\d{6}) blob [0-9a-f]+\t/.exec(entry.stdout);
  if (!entry.ok || !match) {
    throw new ClaudeStepSettingsError(
      `claudeSettings ${what} "${path}" is not a file at the run's base commit ${commit.slice(0, 12)} – commit it to the base branch first`,
    );
  }
  if (match[1] !== '100644' && match[1] !== '100755') {
    throw new ClaudeStepSettingsError(`claudeSettings ${what} "${path}" must be a regular file (not a symlink)`);
  }
  const blob = await git(repoRoot, ['cat-file', 'blob', `${commit}:${path}`]);
  if (!blob.ok) throw new ClaudeStepSettingsError(`claudeSettings ${what} "${path}" could not be read: ${blob.stderr.trim()}`);
  return { content: blob.stdout, executable: match[1] === '100755' };
}

export interface PinClaudeStepSettingsInput {
  field: ClaudeSettingsField;
  /** The primary checkout: where Git is asked, and a root no hook may name. */
  repoRoot: string;
  /** The run's base (`RunRecord.baseBranch`): a branch name or the starting commit. */
  baseRef: string | undefined;
  /** The step's working copy. */
  cwd: string;
  /** The project's runtime-state directory (`.local/xezar`). */
  dataDir: string;
}

/**
 * Read, validate, pin and merge a step's `claudeSettings`. Answers the absolute path of the
 * pinned settings file for `--settings`. Throws `ClaudeStepSettingsError` with the step's failure
 * reason; nothing is dropped silently.
 */
export async function pinClaudeStepSettings(input: PinClaudeStepSettingsInput): Promise<string> {
  const { field, repoRoot, baseRef, cwd, dataDir } = input;
  if (!baseRef || !isSafeGitRef(baseRef)) {
    throw new ClaudeStepSettingsError(
      'claudeSettings needs the run\'s Git base commit to read its hooks from, and this run has none',
    );
  }
  const resolved = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  const commit = resolved.stdout.trim();
  if (!resolved.ok || !/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new ClaudeStepSettingsError(`claudeSettings could not resolve the run's base "${baseRef}" to a commit`);
  }

  const files = await Promise.all(field.files.map((path) => readBaseBlob(repoRoot, commit, path, 'file')));
  const scriptPaths = [...new Set(field.scripts ?? [])];
  const scripts = await Promise.all(scriptPaths.map((path) => readBaseBlob(repoRoot, commit, path, 'script')));

  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        files: field.files.map((path, i) => [path, files[i]!.content]),
        scripts: scriptPaths.map((path, i) => [path, scripts[i]!.executable, scripts[i]!.content]),
      }),
    )
    .digest('hex')
    .slice(0, 32);
  const pinDir = join(dataDir, 'claude-settings', hash);
  const pinnedScripts = new Map(scriptPaths.map((path) => [path, join(pinDir, 'scripts', ...path.split('/'))]));

  const baseTop = await git(repoRoot, ['ls-tree', '--name-only', commit]);
  const baseNames = new Set(baseTop.ok ? baseTop.stdout.split('\n').filter(Boolean) : []);
  const ctx: HookCommandContext = {
    scripts: pinnedScripts,
    existsInRepo: (relative) => baseNames.has(relative) || existsSync(join(cwd, relative)),
    protectedRoots: [repoRoot, cwd],
  };

  const merged: ClaudeHooks = {};
  field.files.forEach((path, i) => {
    let doc: unknown;
    try {
      doc = JSON.parse(files[i]!.content);
    } catch (err) {
      throw new ClaudeStepSettingsError(
        `claudeSettings file "${path}" refused: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    for (const [event, groups] of Object.entries(validateClaudeSettingsDoc(doc, path))) {
      const rewritten = groups.map((group, g) => ({
        ...group,
        hooks: group.hooks.map((hook, h) => ({
          ...hook,
          command: rewriteHookCommand(hook.command, `"${path}" hooks.${event}[${g}].hooks[${h}]`, ctx),
        })),
      }));
      merged[event] = [...(merged[event] ?? []), ...rewritten];
    }
  });

  // Rewritten on every spawn, so a pinned copy that was changed on disk is put back.
  for (const [i, path] of scriptPaths.entries()) {
    const target = pinnedScripts.get(path)!;
    await mkdir(dirname(target), { recursive: true });
    await writeFileAtomic(target, scripts[i]!.content, { finalMode: scripts[i]!.executable ? 0o755 : 0o644 });
  }
  const settingsPath = join(pinDir, 'settings.json');
  await mkdir(pinDir, { recursive: true });
  await writeFileAtomic(settingsPath, `${JSON.stringify({ hooks: merged }, null, 2)}\n`);
  return settingsPath;
}

/** The note a non-Claude step with `claudeSettings` records instead of loading anything. */
export function claudeSettingsUnsupportedNote(backend: string): string {
  return `claudeSettings is not supported by the ${backend} runner – it applies only to Claude Code, so this step runs without the named hooks`;
}
