import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { DEFAULT_AGENT_ACCOUNT_ID } from '@qodeca/xezar-contract';
import { globalStateLayout, isSymbolicLink, projectStateDirRefusal, type StateLayout } from '../state-layout.ts';
import { atomicWriteJsonSync, withoutMachineScopedKeys } from './config.ts';
import type { GlobalImportState, RecordedGlobalImportState } from './project-machine-state.ts';

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
 * | `config.json` | `workspace.json` | the project registry (`projects`) and the machine-scoped `browseRoot`/`projectsDir` are dropped (#650) |
 * | `agent-accounts.json` | `agent-accounts.json` | per-repo `selections` other than this folder's are dropped |
 * | `ui-state.json` | `workspace-ui.json` | nothing |
 *
 * The registry is dropped because it is a list of THIS machine's folders: committed into a
 * repository it would hand every clone a set of paths that do not exist there, and the mode's
 * registry is exactly one project — the folder itself — which the boot registers on its own. The
 * machine-scoped GUI roots are dropped for the same reason and in the same breath (#650):
 * `browseRoot` and `projectsDir` are this host's defaults (often `~/`), and adding, cloning and
 * browsing are refused in the mode, so neither has a consumer there. The per-repo account
 * selections are dropped for the same reason: they are keyed by an absolute path on this machine.
 * Everything else is copied verbatim, unknown keys included, because the loaders already keep what
 * they do not understand (`.passthrough()` at every level).
 *
 * A project file that already exists is never overwritten, and a global file that cannot be read
 * or is not a JSON object is skipped and named rather than copied: importing a corrupt workspace
 * file would turn the boot's Q1 refusal on the very next start.
 *
 * Nothing is written through a symbolic link (#612 review M1): when `<project>/.xezar` is a link,
 * or resolves outside the project, every file is refused; a single target file that is a link is
 * refused on its own. Either way the global file is not read, and the boot line names the refusal.
 *
 * ## Three doors, one consent rule (#819 items 1a–1d)
 *
 * The prompt above is one way to answer the question, and it only exists where a person is
 * watching a first run. Two more doors answer it without changing the rule that a PERSON consents
 * before the global home is read:
 *
 * - **A flag on the launch** — `--import-global` / `--no-import-global` ({@link resolveImportDecision}).
 *   Each is an explicit answer typed by a person, so it REPLACES the question: with either flag
 *   given nothing is asked, stdin is never read, and a non-terminal launch imports on a yes rather
 *   than degrading to `not-asked`. Both flags at once contradict each other and refuse the launch.
 *   Deliberately not an environment variable: a variable is inherited by every child process, so
 *   it would answer on behalf of people who never typed it.
 * - **A command run later** — `xezar accounts import-global` ({@link importGlobalAccounts}). The
 *   prompt happens exactly once, on the one boot that finds no `workspace.json`, and by the time
 *   anyone notices they wanted their accounts, the boot has written the four empty files and the
 *   folder is never a first run again. This door merges ACCOUNTS ONLY into the existing file:
 *   `workspace.json` and `workspace-ui.json` may already be committed, and overwriting them later
 *   would be a hand edit by proxy.
 *
 * Whichever door answered, the outcome is remembered in the per-machine
 * `<project>/.local/xezar/machine-state.json` ({@link globalImportStateOf}), so "declined",
 * "nobody was asked" and "imported" stop being the same disk state. It is per-machine on purpose:
 * consent belongs to the person at this checkout, and `workspace.json` is shared with everyone who
 * clones the repository.
 */

/** One file the import considered, and what happened to it. */
export interface ImportedFile {
  /** Absolute path of the global file. */
  readonly from: string;
  /** Absolute path of the project file. */
  readonly to: string;
  readonly outcome: 'copied' | 'absent' | 'kept-existing' | 'unreadable' | 'refused-symlink';
}

/**
 * What the first-run step did:
 *
 * - `not-first-run` — the folder already holds its state, or the layout is global; nothing asked.
 * - `no-terminal` — a first run with nobody to ask (stdin or stdout is not a terminal, or the
 *   command speaks a protocol on stdout); nothing imported, because importing without asking is
 *   the falsifier of SP-5.1.
 * - `declined` — asked, and the answer was no; nothing imported. A `--no-import-global` launch
 *   answers the same way, without asking.
 * - `imported` — the answer was yes (asked, or given as `--import-global`); `files` says what moved.
 * - `already-set-up` — a flag answered a folder that already holds its state. The flag changes
 *   nothing there, because merging a launch flag into an existing — possibly committed — file is
 *   not what a person asking to import expects; the line names the command that does it.
 */
export type FirstRunOutcome =
  | { readonly kind: 'not-first-run' }
  | { readonly kind: 'already-set-up' }
  | { readonly kind: 'no-terminal' }
  | { readonly kind: 'declined' }
  | { readonly kind: 'imported'; readonly files: readonly ImportedFile[] };

/**
 * What the first-run step should do: ask the person, or act on the answer a flag already gave.
 *
 * `'ask'` is the zero-config default and the only value that reaches the terminal, so the prompt
 * path stays byte-identical to the one #600 shipped.
 */
export type ImportDecision = 'ask' | 'import' | 'skip';

/** The refusal when both flags are given — one message, shared by the CLI and its test. */
export const IMPORT_FLAG_CONFLICT =
  '--import-global and --no-import-global contradict each other — give one of them, or neither to be asked';

/** The line a flag gets in the global layout, where there is nothing to import from. */
export const IMPORT_IN_GLOBAL_LAYOUT_LINE =
  '  this folder uses your global setup already, so there is nothing to import';

/**
 * The decision the two flags spell, or `'conflict'` when they contradict each other.
 *
 * A pure function of the two booleans so the CLI can refuse a contradictory launch BEFORE it
 * resolves a layout or writes a file — `parseArgs` has no notion of mutually exclusive flags, and
 * last-wins parsing would silently import for someone who typed both and meant neither.
 */
export function resolveImportDecision(flags: {
  readonly import?: boolean | undefined;
  readonly skip?: boolean | undefined;
}): ImportDecision | 'conflict' {
  if (flags.import === true && flags.skip === true) return 'conflict';
  if (flags.import === true) return 'import';
  if (flags.skip === true) return 'skip';
  return 'ask';
}

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
  decision: ImportDecision = 'ask',
): Promise<FirstRunOutcome> {
  if (!isFirstSingleProjectRun(layout)) return { kind: decision === 'ask' ? 'not-first-run' : 'already-set-up' };
  // A flag is the answer: `ask` is never called, so stdin is never read and a launch with no
  // terminal — a script, a CI job, an IDE task — imports or declines as it was told.
  if (decision === 'skip') return { kind: 'declined' };
  if (decision === 'import') return { kind: 'imported', files: importGlobalSetup(layout, env) };
  const answer = await ask(importQuestion(layout, env));
  if (answer === null) return { kind: 'no-terminal' };
  if (!answer) return { kind: 'declined' };
  return { kind: 'imported', files: importGlobalSetup(layout, env) };
}

/**
 * The outcome as the persisted per-machine state, or `null` when the step decided nothing worth
 * remembering (a folder that was already set up, with or without a flag).
 *
 * `no-terminal` records `not-asked` rather than `declined`: nobody answered, and a later run with
 * a terminal — or the `accounts import-global` command — is still free to import. Keeping the two
 * apart is the whole point of persisting anything, because on disk they used to look the same.
 */
export function globalImportStateOf(outcome: FirstRunOutcome): RecordedGlobalImportState | null {
  switch (outcome.kind) {
    case 'imported':
      return 'imported';
    case 'declined':
      return 'declined';
    case 'no-terminal':
      return 'not-asked';
    case 'not-first-run':
    case 'already-set-up':
      return null;
  }
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
    { from: global.workspacePath, to: layout.workspacePath, transform: withoutMachineScopedKeys },
  ];
  const dirRefused = projectStateDirRefusal(layout) !== null;
  return plan.map(({ from, to, transform }) => {
    if (dirRefused || isSymbolicLink(to)) return { from, to, outcome: 'refused-symlink' };
    if (existsSync(to)) return { from, to, outcome: 'kept-existing' };
    const value = readJsonObject(from);
    if (value === 'absent' || value === 'unreadable') return { from, to, outcome: value };
    atomicWriteJsonSync(to, transform(value));
    return { from, to, outcome: 'copied' };
  });
}

/** One account the merge saw, named the way the command is allowed to name it. */
export interface ImportedAccount {
  readonly id: string;
  /** The provider as the row spells it, or `unknown` for a row that names none. */
  readonly provider: string;
}

/** What `accounts import-global` did, in the terms the command prints and a test asserts on. */
export interface AccountImportReport {
  readonly outcome: 'merged' | 'no-global-file' | 'unreadable' | 'refused-symlink' | 'not-project-layout';
  /** Accounts copied in, in the order the global file lists them. Id and provider only — see
   *  {@link accountImportLines} for why a label and a config dir are deliberately not carried. */
  readonly added: readonly ImportedAccount[];
  /** Accounts the global file also has and the project already had — kept as the project has them. */
  readonly kept: readonly ImportedAccount[];
  /** `<provider> → <account id>` per default account taken over. */
  readonly defaults: readonly string[];
  /** `<provider> → <account id>` per default the global file names with no account to back it. */
  readonly danglingSkipped: readonly string[];
  /** Whether this folder's own per-repo selection was taken over. */
  readonly selectionAdded: boolean;
  /** Whether anything was written. A second run changes nothing and writes nothing. */
  readonly changed: boolean;
}

function emptyReport(outcome: AccountImportReport['outcome']): AccountImportReport {
  return { outcome, added: [], kept: [], defaults: [], danglingSkipped: [], selectionAdded: false, changed: false };
}

/**
 * Merge the global agent accounts into this project's `agent-accounts.json` — the later door of
 * the one-time import, run by a person through `xezar accounts import-global`.
 *
 * Four properties carry it, and each is a failure mode the first-run prompt does not have because
 * it only ever ran against a folder with no files at all:
 *
 * - **It never overwrites.** An account id the project already carries is KEPT, even when the
 *   global file has a different `configDir` for it: the project file may be committed and edited
 *   by a teammate, and a command that says "import" must not quietly replace their row. The same
 *   holds for a `defaults` entry and for this folder's own `selections` row.
 * - **It never writes a dangling default.** A `defaults.<provider>` naming an id with no account
 *   record resolves silently to the built-in login at run time, so it REPORTS an account no run
 *   uses — the exact confusion #819 item 2 describes, and the verbatim copy of `defaults` is one
 *   of its three sources. An id that resolves to nothing after the merge is skipped and named.
 *   The reserved built-in id resolves by definition and is not dangling.
 * - **It is idempotent.** Nothing to add means nothing written: the second run leaves the file
 *   byte-identical, so it is safe in a script and safe to run twice by hand.
 * - **It merges accounts only.** `workspace.json` and `workspace-ui.json` are the files a team
 *   commits; folding a person's global settings into them later is a hand edit by proxy, not an
 *   import, so this door does not touch them.
 *
 * Unknown keys survive on both sides: the project file is spread through, and an account row is
 * copied as it stands.
 */
export function importGlobalAccounts(layout: StateLayout, env: NodeJS.ProcessEnv = process.env): AccountImportReport {
  if (layout.mode !== 'project' || layout.projectRoot === null) return emptyReport('not-project-layout');
  const to = layout.accountsPath;
  if (projectStateDirRefusal(layout) !== null || isSymbolicLink(to)) return emptyReport('refused-symlink');
  const global = readJsonObject(globalSetup(env).accountsPath);
  if (global === 'absent') return emptyReport('no-global-file');
  if (global === 'unreadable') return emptyReport('unreadable');
  const existing = readJsonObject(to);
  if (existing === 'unreadable') return emptyReport('unreadable');
  const base = existing === 'absent' ? {} : existing;

  const accounts = accountRows(base);
  const ids = new Set(accounts.map((row) => row.id));
  const added: ImportedAccount[] = [];
  const kept: ImportedAccount[] = [];
  for (const row of accountRows(global)) {
    const named: ImportedAccount = { id: row.id, provider: typeof row.provider === 'string' ? row.provider : 'unknown' };
    if (ids.has(row.id)) {
      kept.push(named);
      continue;
    }
    ids.add(row.id);
    accounts.push(row);
    added.push(named);
  }
  // Resolves against the MERGED set, so a default whose account arrives in this same run is kept.
  const resolves = (id: string): boolean => id === DEFAULT_AGENT_ACCOUNT_ID || ids.has(id);

  const defaults = { ...stringMap(base.defaults) };
  const defaultsTaken: string[] = [];
  const danglingSkipped: string[] = [];
  for (const [provider, id] of Object.entries(stringMap(global.defaults))) {
    if (defaults[provider] !== undefined) continue;
    if (!resolves(id)) {
      danglingSkipped.push(`${provider} → ${id}`);
      continue;
    }
    defaults[provider] = id;
    defaultsTaken.push(`${provider} → ${id}`);
  }

  const selections = { ...objectMap(base.selections) };
  const projectRoot = layout.projectRoot;
  const keys = [projectRoot, realRoot(projectRoot)];
  const globalSelections = objectMap(global.selections);
  // The key is matched on the literal spelling first and the realpath'd one second, as
  // `selectionFor` reads it: stored keys are realpath'd, and a folder reached through a symbolic
  // link would otherwise lose its own choice. It is kept AS STORED, so the reader finds it again.
  const globalKey = keys.find((candidate) => globalSelections[candidate] !== undefined);
  const mineIsWanted = globalKey !== undefined && !keys.some((candidate) => selections[candidate] !== undefined);
  let selectionAdded = false;
  if (globalKey !== undefined && mineIsWanted) {
    const mine = Object.fromEntries(
      Object.entries(stringMap(globalSelections[globalKey])).filter(([, id]) => resolves(id)),
    );
    selectionAdded = Object.keys(mine).length > 0;
    if (selectionAdded) selections[globalKey] = mine;
  }

  const changed = added.length > 0 || defaultsTaken.length > 0 || selectionAdded;
  if (changed) atomicWriteJsonSync(to, { ...base, accounts, defaults, selections });
  return {
    outcome: 'merged',
    added,
    kept,
    defaults: defaultsTaken,
    danglingSkipped,
    selectionAdded,
    changed,
  };
}

/**
 * What `accounts import-global` prints — one line per thing it did, and a final count.
 *
 * **It names account ids and providers, and nothing else.** A label is a display string a person
 * chose and is very often an identity (an email address, a client's name), and a `configDir` is a
 * path on this machine that usually carries the person's own name. Neither is needed to understand
 * what was copied, both end up in a terminal scrollback, a CI log or a pasted transcript, and the
 * rest of xezar already withholds an identity-looking label rather than echoing it. The project's
 * own state folder is not named either: the boot line above already says where this folder keeps
 * its state, so repeating it here only adds a path to the log.
 */
export function accountImportLines(report: AccountImportReport, layout: StateLayout): string[] {
  switch (report.outcome) {
    case 'not-project-layout':
      return [IMPORT_IN_GLOBAL_LAYOUT_LINE];
    case 'refused-symlink':
      return ['  refused to write this project\'s agent accounts through a symbolic link — nothing was imported'];
    case 'unreadable':
      return ['  could not read the agent accounts — nothing was imported'];
    case 'no-global-file':
      return ['  your global setup holds no agent accounts — nothing was changed'];
    case 'merged':
      return [
        ...report.added.map((entry) => `  + account ${entry.id} (${entry.provider})`),
        ...report.kept.map((entry) => `  = account ${entry.id} (${entry.provider}) already here, left untouched`),
        ...report.defaults.map((entry) => `  + default account for ${entry}`),
        ...report.danglingSkipped.map(
          (entry) => `  ! skipped default account for ${entry} — no such account, so nothing would use it`,
        ),
        ...(report.selectionAdded ? ['  + this folder\'s own account choice'] : []),
        `  ${report.added.length} account(s) added, ${report.kept.length} left untouched`,
      ];
  }
}

/** Does this project already carry agent accounts of its own? */
export function projectHasAccounts(layout: StateLayout): boolean {
  if (layout.mode !== 'project') return false;
  const store = readJsonObject(layout.accountsPath);
  return store !== 'absent' && store !== 'unreadable' && accountRows(store).length > 0;
}

/**
 * The line a launch flag gets once the folder is already set up — or nothing at all.
 *
 * A bootstrap script that starts the engine may pass `--import-global` on EVERY start, so this
 * line has to earn its place each time rather than repeating a recommendation forever. It is
 * printed only while it could still be acted on: an import that already happened, or a project
 * that already carries accounts, has nothing left to say, so the flag succeeds in silence with the
 * launch's exit code untouched.
 */
export function repeatedImportLine(layout: StateLayout, importState: GlobalImportState): string | null {
  if (importState === 'imported' || projectHasAccounts(layout)) return null;
  return (
    '  this folder already has its own xezar setup, so nothing was imported — ' +
    'copy your global agent accounts in with: npx @qodeca/xezar accounts import-global'
  );
}

/**
 * The global layout — named ONCE in this module, on the line `state-path-scan.test.ts` allowlists as
 * the one-time BR-2 exception. Every read of the global setup goes through this, so the exception
 * cannot quietly grow a second call site.
 */
function globalSetup(env: NodeJS.ProcessEnv): StateLayout {
  return globalStateLayout(env);
}

/**
 * The accounts store with only this folder's per-repo selection kept. Looked up on the literal
 * spelling first and the realpath'd one second, as `selectionFor` does: stored keys are
 * realpath'd, and a non-git folder reached through a symlink would otherwise lose its own
 * selection (#612 review n1). The key is kept as stored, so `selectionFor` finds it the same way.
 */
function accountsForProject(store: Record<string, unknown>, projectRoot: string): Record<string, unknown> {
  const selections = store.selections;
  if (selections === null || typeof selections !== 'object' || Array.isArray(selections)) return store;
  const byRoot = selections as Record<string, unknown>;
  const key = [projectRoot, realRoot(projectRoot)].find((candidate) => byRoot[candidate] !== undefined);
  return { ...store, selections: key === undefined ? {} : { [key]: byRoot[key] } };
}

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/**
 * The account rows of a raw store, as `{id}`-bearing objects.
 *
 * Raw on purpose: the merge copies a row VERBATIM, exactly as the first-run import copies the
 * whole file, so a row a newer xezar wrote survives and the account schema stays the one authority
 * on what a row means (it salvages per entry on the next read). Only the `id` is read here,
 * because it is what "already present" is decided on.
 */
function accountRows(store: Record<string, unknown>): Array<Record<string, unknown> & { id: string }> {
  const raw = store.accounts;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (row): row is Record<string, unknown> & { id: string } =>
      row !== null && typeof row === 'object' && !Array.isArray(row) && typeof (row as { id?: unknown }).id === 'string',
  );
}

/** The string-valued entries of a raw object value; everything else is dropped. */
function stringMap(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(objectMap(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** A raw object value, or `{}` for anything that is not one. */
function objectMap(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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

/** The terminal {@link askInTerminal} talks to — injected so the abort path is testable. */
export interface TerminalIo {
  readonly isTerminal: boolean;
  question(question: string): Promise<string>;
  say(line: string): void;
}

function processTerminal(): TerminalIo {
  return {
    isTerminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    question: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    say: (line) => console.log(line),
  };
}

/**
 * The CLI's {@link ImportAsk}: a `[y/N]` prompt on the terminal. `null` when stdin or stdout is not
 * a terminal — a script, a CI job, an IDE task — because a question nobody can see must not be
 * answered on the person's behalf in either direction.
 *
 * Ctrl-C or Ctrl-D at the prompt makes readline reject with an `AbortError`; that is a decline,
 * said in one plain line, not a boot crash (#612 review m1).
 */
export async function askInTerminal(question: string, io: TerminalIo = processTerminal()): Promise<boolean | null> {
  if (!io.isTerminal) return null;
  let answer: string;
  try {
    answer = await io.question(question);
  } catch (err) {
    if (!(err instanceof Error && err.name === 'AbortError')) throw err;
    io.say('  import cancelled — nothing was imported from your global setup');
    return false;
  }
  const normalized = answer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}

/** The one line the boot prints after the step, or `null` when there is nothing to say. */
export function firstRunImportLine(outcome: FirstRunOutcome, layout: StateLayout, env: NodeJS.ProcessEnv = process.env): string | null {
  switch (outcome.kind) {
    case 'not-first-run':
    case 'declined':
      return null;
    case 'already-set-up':
      // A flag on a folder that is already a single-project root read nothing and wrote nothing.
      // Whether that is worth a line depends on facts this pure function does not have, so the
      // CLI asks `repeatedImportLine` — a bootstrap may pass the flag on every start.
      return null;
    case 'no-terminal':
      // Names the project folder and NOT the home: with nobody asked, the home was not read, and
      // no output of the mode names a path it did not open (`single-project-home-safety.test.ts`).
      return `  not a terminal, so nothing was imported from your global setup — starting ${layout.root} with defaults`;
    case 'imported': {
      const copied = outcome.files.filter((file) => file.outcome === 'copied').map((file) => file.to);
      const skipped = outcome.files.filter((file) => file.outcome === 'unreadable').map((file) => file.from);
      const refused = outcome.files.filter((file) => file.outcome === 'refused-symlink').map((file) => file.to);
      const parts = [
        copied.length > 0 ? `imported ${copied.length} file(s) into ${layout.root}` : `nothing to import from ${globalSetup(env).root}`,
        ...(skipped.length > 0 ? [`skipped unreadable ${skipped.join(', ')}`] : []),
        ...(refused.length > 0 ? [`refused to write through a symbolic link: ${refused.join(', ')}`] : []),
      ];
      return `  ${parts.join('; ')}`;
    }
  }
}
