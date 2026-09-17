/**
 * Xezar's zero-config guard for pi sessions running in a linked Git worktree (#537).
 *
 * The process cwd is necessary but insufficient: pi's edit/write tools accept absolute paths,
 * and Bash can select another checkout with `cd` or `git -C`. This extension keeps the task
 * worktree as the project tool root while preserving the existing ability to use temp files and
 * home-scoped tooling outside the repository. It is loaded only for isolated worktree runs.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

interface ExtensionContextLike {
  cwd: string;
}

interface ExtensionApiLike {
  registerFlag(name: string, options: { description?: string; type: 'string' }): void;
  getFlag(name: string): boolean | string | undefined;
  on(
    event: 'tool_call',
    handler: (event: ToolCall, context: ExtensionContextLike) => ToolGuardResult | undefined,
  ): void;
}

interface ToolGuardResult {
  block: true;
  reason: string;
}

const ROOT_FLAG = 'xezar-worktree-root';
const BLOCK_REASON =
  'Blocked by Xezar: this isolated task must keep project writes and Git commands inside its worktree.';

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Resolve a possibly-not-yet-created path through the nearest existing ancestor. */
function realPotential(path: string): string | undefined {
  const suffix: string[] = [];
  let cursor = resolve(path);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    suffix.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
  try {
    return resolve(realpathSync(cursor), ...suffix);
  } catch {
    return undefined;
  }
}

/** A linked worktree's `.git` file points below `<primary>/.git/worktrees/…`. */
function primaryRoot(worktreeRoot: string): string | undefined {
  try {
    const marker = readFileSync(join(worktreeRoot, '.git'), 'utf8');
    const match = /^gitdir:\s*(.+)\s*$/m.exec(marker);
    if (!match?.[1]) return undefined;
    const gitDirSpelling = match[1];
    const gitDir = realPotential(isAbsolute(gitDirSpelling) ? gitDirSpelling : resolve(worktreeRoot, gitDirSpelling));
    if (!gitDir) return undefined;
    const needle = `${sep}.git${sep}worktrees${sep}`;
    const index = gitDir.lastIndexOf(needle);
    if (index < 0) return undefined;
    return gitDir.slice(0, index);
  } catch {
    return undefined;
  }
}

function unquotePath(token: string): string | undefined {
  let value = token.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  if (value === '$HOME' || value === '${HOME}') return homedir();
  if (value.startsWith('$HOME/')) return join(homedir(), value.slice(6));
  if (value.startsWith('${HOME}/')) return join(homedir(), value.slice(8));
  // A dynamic path cannot be proved safe before execution, so the boundary fails closed.
  if (/[$`]/.test(value)) return undefined;
  return value;
}

function bashTargets(command: string): Array<string | undefined> {
  const targets: Array<string | undefined> = [];
  const token = String.raw`("[^"]*"|'[^']*'|[^\s;&|()]+)`;
  const patterns = [
    new RegExp(String.raw`(?:^|[;&|()\n]\s*)(?:builtin\s+)?cd(?:\s+--)?(?:\s+${token})?`, 'g'),
    new RegExp(String.raw`\bgit(?:\s+-[^\s]+)*\s+-C\s+${token}`, 'g'),
  ];
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      // `cd` with no operand means HOME and remains allowed.
      targets.push(match[1] === undefined ? homedir() : unquotePath(match[1]));
    }
  }
  return targets;
}

function pathEscapes(
  spelling: string | undefined,
  worktreeRoot: string,
  primary: string,
): boolean {
  if (spelling === undefined || spelling.length === 0) return true;
  const absolute = isAbsolute(spelling);
  const lexical = absolute ? resolve(spelling) : resolve(worktreeRoot, spelling);
  // A relative project path is always rooted in the worktree. `..` may not turn it into a
  // sibling, even when that sibling happens to be Xezar runtime state under the primary root.
  if (!absolute && !inside(worktreeRoot, lexical)) return true;
  const real = realPotential(lexical);
  if (!real) return true;
  if (inside(worktreeRoot, real)) return false;
  // Absolute temp/home tool paths outside this repository retain their historical behavior.
  // Inside the primary checkout, however, the task worktree is the only permitted project tree.
  return !absolute || inside(primary, real);
}

function guardToolCall(
  configuredRoot: string,
  contextCwd: string,
  event: ToolCall,
): ToolGuardResult | undefined {
  if (!['write', 'edit', 'bash'].includes(event.toolName)) return undefined;

  let worktreeRoot: string;
  let cwd: string;
  try {
    worktreeRoot = realpathSync(configuredRoot);
    cwd = realpathSync(contextCwd);
  } catch {
    return { block: true, reason: `${BLOCK_REASON} The worktree root could not be resolved.` };
  }
  const primary = primaryRoot(worktreeRoot);
  if (!primary || cwd !== worktreeRoot) {
    return { block: true, reason: `${BLOCK_REASON} The active tool root could not be verified.` };
  }

  if (event.toolName === 'write' || event.toolName === 'edit') {
    const path = typeof event.input.path === 'string' ? event.input.path : undefined;
    return pathEscapes(path, worktreeRoot, primary) ? { block: true, reason: BLOCK_REASON } : undefined;
  }

  const command = typeof event.input.command === 'string' ? event.input.command : undefined;
  if (command === undefined) return { block: true, reason: BLOCK_REASON };
  return bashTargets(command).some((path) => pathEscapes(path, worktreeRoot, primary))
    ? { block: true, reason: BLOCK_REASON }
    : undefined;
}

export default function piWorktreeGuard(pi: ExtensionApiLike): void {
  pi.registerFlag(ROOT_FLAG, {
    type: 'string',
    description: 'Pin Xezar task tools to this isolated working copy.',
  });
  pi.on('tool_call', (event, context) => {
    const configured = pi.getFlag(ROOT_FLAG);
    if (typeof configured !== 'string' || configured.length === 0) {
      return { block: true, reason: `${BLOCK_REASON} The configured worktree root is missing.` };
    }
    return guardToolCall(configured, context.cwd, event);
  });
}

export const __internals = { guardToolCall };
