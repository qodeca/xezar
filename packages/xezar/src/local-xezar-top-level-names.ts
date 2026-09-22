import { z } from 'zod';

/**
 * The published contract for the top-level names of a project's `.local/xezar/` — what a future
 * `xezar state-names --json` prints, and what `local-xezar-top-level-scan.test.ts` checks shipped
 * source against (#838 item C3, follow-up). The scan test imports `STATE_NAME_ENTRIES` rather than
 * declaring its own copy, so the allowed-name list has exactly one source of truth.
 *
 * The shape below is FROZEN by agreement with the external team that keeps a hand-copied version
 * of this list in their own kit's gate: a flat array (never grouped by feature, so their check
 * keeps allowing a name whether or not that feature is switched on), `kind` so they can print a
 * file-vs-directory error, and no regex anywhere — their matcher is a POSIX `case` glob in `sh`,
 * so `templatedSuffixes[].parts` spells a suffix as ordered literal/digit/hex segments instead.
 */

const stateNameKindSchema = z.enum(['file', 'directory']);

const stateNameEntrySchema = z.object({
  name: z.string(),
  kind: stateNameKindSchema,
  reason: z.string(),
  /** Set only when the name is written by an opt-in path — off by default, a non-default runner,
   *  or a mode the project must switch into. `null` means the engine can write it unconditionally. */
  feature: z.string().nullable(),
});

const templatedSuffixPartSchema = z.union([
  z.object({ literal: z.string() }),
  z.object({ kind: z.enum(['digits', 'lowerHex']) }),
]);

const templatedSuffixSchema = z.object({
  id: z.string(),
  appliesTo: z.literal('any-file-name'),
  parts: z.array(templatedSuffixPartSchema),
});

const rotationSchema = z.object({
  base: z.string(),
  separator: z.string(),
  from: z.number().int(),
  to: z.number().int(),
});

export const stateNamesPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  scope: z.literal('local-xezar-top-level'),
  names: z.array(stateNameEntrySchema),
  literalSuffixes: z.array(z.string()),
  templatedSuffixes: z.array(templatedSuffixSchema),
  rotations: z.array(rotationSchema),
});

export type StateNameEntry = z.infer<typeof stateNameEntrySchema>;
export type StateNamesPayload = z.infer<typeof stateNamesPayloadSchema>;

/**
 * The allowed top-level base names, read from production source (see the file header of
 * `local-xezar-top-level-scan.test.ts` for how). `feature` names an opt-in path where one exists;
 * where this task could not determine whether a name is always-written or feature-gated, it says
 * so in the pull request rather than guessing, and leaves `feature` `null`.
 */
export const STATE_NAME_ENTRIES: readonly StateNameEntry[] = [
  { name: 'runs.json', kind: 'file', reason: 'The run index (runs/store.ts, runs/run-index.ts).', feature: null },
  { name: 'runs', kind: 'directory', reason: 'The per-run event NDJSON / handoff / images directory (runs/store.ts, workflows/run.ts).', feature: null },
  { name: 'worktrees', kind: 'directory', reason: 'Task git worktrees (git-worktree.ts WORKTREES_DIR, mcp/resource-ownership.ts).', feature: null },
  { name: 'tmp', kind: 'directory', reason: 'Per-run agent scratch directories (runs/agent-tmpdir.ts, project-data-paths.ts projectScratchDir).', feature: null },
  {
    name: 'kit',
    kind: 'directory',
    reason:
      'The project kit of a home-folder launch: projectKitDir moves the kit here so init and ' +
      'PUT /config never turn the user workspace file into a kit (project-kit-paths.ts).',
    feature: null,
  },
  { name: 'writer-claims', kind: 'directory', reason: 'Cross-process writer-instance claims (runs/project-writer.ts).', feature: null },
  { name: 'ui-state.json', kind: 'file', reason: 'Per-repo GUI state, direct write (ui-state.ts).', feature: null },
  { name: 'launch-key', kind: 'file', reason: 'The `/new` prefill key, direct write, mode 0600 (server/launch-key.ts).', feature: null },
  {
    name: 'todos.json',
    kind: 'file',
    reason: 'The follow-up inbox (todos.ts). `XEZ_TODOS_FILE` is only a usable path when follow-up generation is on.',
    feature: 'followups',
  },
  { name: 'onboarding-state.json', kind: 'file', reason: 'Onboarding progress (onboarding/state.ts).', feature: null },
  { name: 'audit.ndjson', kind: 'file', reason: 'The MCP audit trail, with `.1`–`.4` rotation and `.lock` (mcp/audit-trail.ts, AUDIT_TRAIL_FILE).', feature: null },
  { name: 'mcp-audit.ndjson', kind: 'file', reason: 'The legacy audit trail name, read-only, never written (mcp/audit-trail.ts, LEGACY_AUDIT_TRAIL_FILE).', feature: null },
  { name: 'mcp-connection.json', kind: 'file', reason: 'The MCP bridge connection descriptor (mcp/connection-file.ts, MCP_CONNECTION_FILE).', feature: null },
  { name: 'mcp', kind: 'directory', reason: 'The MCP subdirectory (leader cursors, …) (mcp/event-journal.ts, mcp/reconnect.ts).', feature: null },
  { name: 'mcp-owner-claims', kind: 'directory', reason: 'Cross-process MCP ownership claims (workspace/project-owner.ts, OWNER_CLAIM_DIR).', feature: null },
  { name: 'mcp-operations.ndjson', kind: 'file', reason: 'The MCP operation-receipt journal (mcp/operation-receipts.ts, RECEIPT_JOURNAL_FILE).', feature: null },
  { name: 'mcp-operations.json', kind: 'file', reason: 'The MCP operation-receipt snapshot (mcp/operation-receipts.ts, RECEIPT_SNAPSHOT_FILE).', feature: null },
  { name: 'automations.json', kind: 'file', reason: 'Automation definitions (automations/store.ts DEFINITIONS, automations/coordinator.ts).', feature: 'automations' },
  { name: 'automation-state.json', kind: 'file', reason: 'Automation runtime state (automations/store.ts STATE).', feature: 'automations' },
  { name: 'automation-receipts.ndjson', kind: 'file', reason: 'Automation receipts (automations/store.ts RECEIPTS).', feature: 'automations' },
  { name: 'automation-log.ndjson', kind: 'file', reason: 'Automation log (automations/store.ts LOG).', feature: 'automations' },
  { name: 'automation-poll.lock', kind: 'file', reason: 'The automation poller’s cross-process lock (automations/store.ts, POLL_LOCK).', feature: 'automations' },
  {
    name: 'pi-leader.json',
    kind: 'file',
    reason:
      'The pi leader socket descriptor (mcp/adapters/pi-link.ts PI_LEADER_FILE; written by ' +
      'scripts/pi-leader-extension.ts DESCRIPTOR_FILE).',
    feature: 'pi',
  },
  { name: 'tasks', kind: 'directory', reason: 'Task evidence directories — written by the kit, read here for evidence-root resolution (core/run-evidence-roots.ts).', feature: null },
  // ---- single-project mode only ----
  {
    name: 'machine-state.json',
    kind: 'file',
    reason: 'Per-machine facts of a single-project root — single-project mode only (workspace/project-machine-state.ts).',
    feature: 'single-project-mode',
  },
  { name: 'cache', kind: 'directory', reason: 'The project layout’s skills cache — single-project mode only (state-layout.ts).', feature: 'single-project-mode' },
  { name: 'ipc', kind: 'directory', reason: 'The project layout’s IPC directory — single-project mode only (state-layout.ts).', feature: 'single-project-mode' },
];

/**
 * Names whose only construction site is a runtime variable the source scan cannot resolve
 * statically (`automations/store.ts`'s shared read/write helpers — see `UNRESOLVED_CALLS` in
 * `local-xezar-top-level-scan.test.ts`). A scan-only annotation: never part of the published
 * `StateNamesPayload`, which has no notion of "how the scan proved this name real".
 */
export const SCAN_UNRESOLVED_ONLY_NAMES: ReadonlySet<string> = new Set([
  'automation-state.json',
  'automation-receipts.ndjson',
  'automation-log.ndjson',
]);

/** The four literal suffixes a name may carry as-is (a lock, its takeover guard, or a staging file). */
export const LITERAL_SUFFIXES: readonly string[] = ['.tmp', '.lock', '.takeover', '.lock.takeover'];

/**
 * The one templated suffix shape shipped source constructs: an atomic-write staging name,
 * `<name>.<pid>.<8 lowercase hex chars>.tmp` (`renameSync`'s source, e.g. the pi leader
 * descriptor). `parts` is ordered structured segments rather than a regex, per the frozen schema.
 */
export const TEMPLATED_SUFFIXES: StateNamesPayload['templatedSuffixes'] = [
  {
    id: 'atomic-write',
    appliesTo: 'any-file-name',
    parts: [{ literal: '.' }, { kind: 'digits' }, { literal: '.' }, { kind: 'lowerHex' }, { literal: '.tmp' }],
  },
];

/** The one rotation family shipped source constructs: `audit.ndjson.1` (newest) … `.4` (oldest). */
export const ROTATIONS: StateNamesPayload['rotations'] = [{ base: 'audit.ndjson', separator: '.', from: 1, to: 4 }];

export const STATE_NAMES_PAYLOAD: StateNamesPayload = stateNamesPayloadSchema.parse({
  schemaVersion: 1,
  scope: 'local-xezar-top-level',
  names: STATE_NAME_ENTRIES,
  literalSuffixes: LITERAL_SUFFIXES,
  templatedSuffixes: TEMPLATED_SUFFIXES,
  rotations: ROTATIONS,
});
