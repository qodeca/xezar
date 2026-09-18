import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { globalStateLayout, type StateLayout } from '../state-layout.ts';
import { atomicWriteJsonSync } from './config.ts';

/**
 * Single-project mode, piece (d): import from the global setup (#600 FR-4, AC-4).
 *
 * The first run with `--single-project` in a folder that holds no xezar state yet asks ONE
 * question in the terminal — "copy your global setup into this project?" — and does what the
 * answer says. That is the whole feature, and three properties carry it:
 *
 * - **It asks before it writes (SP-5.1).** Nothing in the project, and nothing anywhere else, is
 *   written before the answer. A decline writes nothing here; the boot then creates the four
 *   empty files exactly as it would have without this module.
 * - **It asks once (SP-5.2).** A folder that already holds `<project>/.xezar/workspace.json` is
 *   already a single-project root — a clone that carried the file, or a second run — and is never
 *   asked again. The file's PRESENCE is what decides the mode (`state-layout.ts`), so it is also
 *   what decides "already done".
 * - **It is one-way and one-time (SP-5.3).** The global files are read, copied and never looked at
 *   again: there is no link, no watcher and no later sync in either direction. After the import
 *   the two setups are strangers.
 *
 * **The one deliberate exception to BR-2.** The mode's rule is that `~/.xezar` is never opened.
 * This module is the single place that opens it, READ-only, once, before the mode's own files
 * exist, and only after the person said yes. It never writes there. The exception is named in
 * `BACKWARD_COMPATIBILITY.md` and carries a reasoned entry in `state-path-scan.test.ts`, which
 * otherwise fails any code that names the global layout directly.
 *
 * What is copied, and what is not:
 *
 * | Global file (`~/.xezar/…`) | Project file (`<project>/.xezar/…`) | Filtered |
 * | --- | --- | --- |
 * | `config.json` | `workspace.json` | the project registry (`projects`) is dropped |
 * | `agent-accounts.json` | `agent-accounts.json` | per-repo `selections` other than this folder's are dropped |
 * | `ui-state.json` | `workspace-ui.json` | nothing |
 *
 * The registry is dropped because it is a list of THIS machine's folders: committed into a
 * repository it would hand every clone a set of paths that do not exist there, and the mode's
 * registry is exactly one project — the folder itself — which the boot registers on its own. The
 * per-repo account selections are dropped for the same reason: they are keyed by an absolute path
 * on this machine. Everything else is copied verbatim, unknown keys included, because the loaders
 * already keep what they do not understand (`.passthrough()` at every level).
 *
 * A project file that already exists is never overwritten, and a global file that cannot be read
 * or is not a JSON object is skipped and named rather than copied: importing a corrupt workspace
 * file would turn the boot's Q1 refusal on the very next start.
 */

/** One file the import considered, and what happened to it. */
export interface ImportedFile {
  /** Absolute path of the global file. */
  readonly from: string;
  /** Absolute path of the project file. */
  readonly to: string;
  readonly outcome: 'copied' | 'absent' | 'kept-existing' | 'unreadable';
}

/**
 * What the first-run step did:
 *
 * - `not-first-run` — the folder already holds its state, or the layout is global; nothing asked.
 * - `no-terminal` — a first run with nobody to ask (stdin or stdout is not a terminal, or the
 *   command speaks a protocol on stdout); nothing imported, because importing without asking is
 *   the falsifier of SP-5.1.
 * - `declined` — asked, and the answer was no; nothing imported.
 * - `imported` — asked, the answer was yes; `files` says what moved.
 */
export type FirstRunOutcome =
  | { readonly kind: 'not-first-run' }
  | { readonly kind: 'no-terminal' }
  | { readonly kind: 'declined' }
  | { readonly kind: 'imported'; readonly files: readonly ImportedFile[] };

/**
 * Asks the question and answers yes or no, or `null` when there is no one to ask. Injected so the
 * decision is testable without a terminal; the CLI passes {@link askInTerminal}.
 */
export type ImportAsk = (question: string) => Promise<boolean | null>;

/**
 * Is this the first run of the mode in this folder — the only run that may ask?
 *
 * The "already holds state" check is the marker file, and nothing else. `config.json` alone is
 * NOT state: it is the project config a repository has always been able to carry (the kit), and a
 * folder holding only that has never been a single-project root.
 */
export function isFirstSingleProjectRun(layout: StateLayout): boolean {
  return layout.mode === 'project' && !existsSync(layout.workspacePath);
}

/** The question, naming both folders, so the person knows what is read and where it goes. */
export function importQuestion(layout: StateLayout, env: NodeJS.ProcessEnv = process.env): string {
  return (
    `  This folder has no xezar setup yet. Copy your global setup (${globalSetup(env).root}) ` +
    `into ${layout.root} once? Settings, agent accounts and GUI preferences are copied; ` +
    'your project list is not, and nothing is kept in sync afterwards. [y/N] '
  );
}

/**
 * The first-run step: decide whether to ask, ask, and import on yes. Writes nothing unless the
 * answer is yes, and never writes outside `<project>/.xezar`.
 */
export async function runFirstRunImport(
  layout: StateLayout,
  ask: ImportAsk,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FirstRunOutcome> {
  if (!isFirstSingleProjectRun(layout)) return { kind: 'not-first-run' };
  const answer = await ask(importQuestion(layout, env));
  if (answer === null) return { kind: 'no-terminal' };
  if (!answer) return { kind: 'declined' };
  return { kind: 'imported', files: importGlobalSetup(layout, env) };
}

/**
 * Copy the global setup into a project layout — the one read of `~/.xezar` the mode makes.
 *
 * Exported for the tests; production reaches it only through {@link runFirstRunImport}, after a
 * yes. `workspace.json` is written LAST, because its presence is what makes the folder a
 * single-project root: an import interrupted half-way leaves a folder that still counts as a
 * first run, rather than one that is half-imported and never asked again.
 */
export function importGlobalSetup(layout: StateLayout, env: NodeJS.ProcessEnv = process.env): ImportedFile[] {
  if (layout.mode !== 'project' || layout.projectRoot === null) return [];
  const global = globalSetup(env);
  const projectRoot = layout.projectRoot;
  const plan: Array<{ from: string; to: string; transform: (value: Record<string, unknown>) => Record<string, unknown> }> = [
    { from: global.accountsPath, to: layout.accountsPath, transform: (value) => accountsForProject(value, projectRoot) },
    { from: global.uiStatePath, to: layout.uiStatePath, transform: (value) => value },
    { from: global.workspacePath, to: layout.workspacePath, transform: withoutRegistry },
  ];
  return plan.map(({ from, to, transform }) => {
    if (existsSync(to)) return { from, to, outcome: 'kept-existing' };
    const value = readJsonObject(from);
    if (value === 'absent' || value === 'unreadable') return { from, to, outcome: value };
    atomicWriteJsonSync(to, transform(value));
    return { from, to, outcome: 'copied' };
  });
}

/**
 * The global layout — named ONCE in this module, on the line `state-path-scan.test.ts` allowlists as
 * the one-time BR-2 exception. Every read of the global setup goes through this, so the exception
 * cannot quietly grow a second call site.
 */
function globalSetup(env: NodeJS.ProcessEnv): StateLayout {
  return globalStateLayout(env);
}

/** The workspace config without this machine's project registry. */
function withoutRegistry(config: Record<string, unknown>): Record<string, unknown> {
  const { projects: _projects, ...rest } = config;
  return rest;
}

/** The accounts store with only this folder's per-repo selection kept. */
function accountsForProject(store: Record<string, unknown>, projectRoot: string): Record<string, unknown> {
  const selections = store.selections;
  if (selections === null || typeof selections !== 'object' || Array.isArray(selections)) return store;
  const own = (selections as Record<string, unknown>)[projectRoot];
  return { ...store, selections: own === undefined ? {} : { [projectRoot]: own } };
}

function readJsonObject(path: string): Record<string, unknown> | 'absent' | 'unreadable' {
  if (!existsSync(path)) return 'absent';
  try {
    const raw = readFileSync(path, 'utf8');
    // An empty file is the user's own empty state (the reading `loadWorkspaceConfig` takes).
    if (raw.trim() === '') return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/**
 * The CLI's {@link ImportAsk}: a `[y/N]` prompt on the terminal. `null` when stdin or stdout is not
 * a terminal — a script, a CI job, an IDE task — because a question nobody can see must not be
 * answered on the person's behalf in either direction.
 */
export const askInTerminal: ImportAsk = async (question) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
};

/** The one line the boot prints after the step, or `null` when there is nothing to say. */
export function firstRunImportLine(outcome: FirstRunOutcome, layout: StateLayout, env: NodeJS.ProcessEnv = process.env): string | null {
  switch (outcome.kind) {
    case 'not-first-run':
    case 'declined':
      return null;
    case 'no-terminal':
      return `  not a terminal, so nothing was imported from ${globalSetup(env).root} — starting ${layout.root} with defaults`;
    case 'imported': {
      const copied = outcome.files.filter((file) => file.outcome === 'copied').map((file) => file.to);
      const skipped = outcome.files.filter((file) => file.outcome === 'unreadable').map((file) => file.from);
      const parts = [
        copied.length > 0 ? `imported ${copied.length} file(s) into ${layout.root}` : `nothing to import from ${globalSetup(env).root}`,
        ...(skipped.length > 0 ? [`skipped unreadable ${skipped.join(', ')}`] : []),
      ];
      return `  ${parts.join('; ')}`;
    }
  }
}
