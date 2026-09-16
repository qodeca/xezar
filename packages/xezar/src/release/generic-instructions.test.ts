import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FOLLOWUP_INSTRUCTIONS, HANDOFF_ONLY_INSTRUCTIONS } from '../handoff.ts';
import { fixAndVerifyWorkflow, PROJECT_CONVENTIONS_SKILL } from '../init-kit.ts';
import { HEALTH_TOOL } from '../mcp/bridge.ts';
import { LEADER_ROLE_INSTRUCTION } from '../mcp/leader-delivery.ts';
import { toolListing } from '../mcp/tool.ts';
import { tools } from '../mcp/tools/index.ts';
import { scanText, type ContentException, type ContentLeak } from '../pack-check.ts';
import { buildPlannerPrompt, PLANNER_SYSTEM_PROMPT } from '../planner.ts';
import { buildNamerPrompt, NAMER_SYSTEM_PROMPT } from '../runs/auto-name.ts';
import { BUILD_HINT_HTML } from '../server/static-ui.ts';
import { loadWorkflows } from '../workflows/load.ts';
import { pastedAttachmentsText } from '../workflows/run.ts';
import { PROJECT_SETUP_WORKFLOW, QUICK_TASK_WORKFLOW } from '../workflows/types.ts';
import {
  NATIVE_INSTRUCTION_FILE_RULE,
  PROJECT_SPECIFIC_RULES,
  SOFTWARE_ONLY_FRAMING_RULE,
  stripComments,
} from './instruction-hygiene.testkit.ts';

/**
 * The generic-instructions guard (#466).
 *
 * Owner requirement, verbatim: "a released version of Xezar must never – under any circumstances –
 * contain instructions specific to a particular project. All instructions must be generic enough to
 * suit any project, yet detailed enough to ensure Xezar functions correctly across all types of
 * projects." Owner decision 2026-09-16: shipped help may name a client's own instruction file
 * ("Codex reads AGENTS.md"), and may never tell a user to adopt xezar's own files or process.
 *
 * This test builds an explicit manifest of every first-party instruction PRODUCER — what xezar tells
 * an agent (system and continuation prompts, the planner, the namer, init's files, the MCP surface)
 * and what it tells a person (the cockpit's copy, the recovery page, the npm README, the dry-run
 * mocks) — and scans each against the project-specific rules. Runtime values are scanned as they
 * are produced; source producers are scanned with their comments removed, because comments never
 * ship (`removeComments`) while every string, template and JSX text does.
 *
 * Its partner is the archive half of `check:pack`, which reads the packed bytes themselves.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '../..');
const repoRoot = resolve(packageRoot, '../..');

interface Producer {
  /** What produces the text (for the report). */
  producer: string;
  /** Where: a repo-relative file, or file#export for a runtime value. Exceptions name it exactly. */
  location: string;
  text: string;
}

const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');
const source = (producer: string, path: string): Producer => ({ producer, location: path, text: stripComments(read(path)) });

function walk(dir: string, keep: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(repoRoot, dir))) {
    const path = `${dir}/${name}`;
    if (statSync(join(repoRoot, path)).isDirectory()) out.push(...walk(path, keep));
    else if (keep(path)) out.push(path);
  }
  return out.sort();
}

const isShippedSource = (path: string) => /\.(?:ts|tsx|mjs)$/.test(path) && !/\.(?:test|testkit|e2e)\.tsx?$|\.test\.mjs$|\/__fixtures__\//.test(path);

/** Every MCP tool source file — the registry's tools plus their helpers — for the registry check. */
const MCP_TOOL_SOURCES = walk('packages/xezar/src/mcp/tools', isShippedSource);
const COCKPIT_SOURCES = walk('packages/web/src', isShippedSource);

async function manifest(): Promise<Producer[]> {
  const syncReadme = (await import(pathToFileURL(join(packageRoot, 'scripts/sync-readme.mjs')).href)) as {
    absolutizeReadmeLinks(markdown: string, repoUrl: string): string;
  };
  return [
    // ---- what every agent task is told ----
    { producer: 'built-in workflow', location: 'packages/xezar/src/workflows/types.ts#QUICK_TASK_WORKFLOW', text: JSON.stringify(QUICK_TASK_WORKFLOW) },
    { producer: 'built-in workflow', location: 'packages/xezar/src/workflows/types.ts#PROJECT_SETUP_WORKFLOW', text: JSON.stringify(PROJECT_SETUP_WORKFLOW) },
    { producer: 'handoff contract', location: 'packages/xezar/src/handoff.ts#HANDOFF_ONLY_INSTRUCTIONS', text: HANDOFF_ONLY_INSTRUCTIONS },
    { producer: 'follow-up contract', location: 'packages/xezar/src/handoff.ts#FOLLOWUP_INSTRUCTIONS', text: FOLLOWUP_INSTRUCTIONS },
    source('handoff module', 'packages/xezar/src/handoff.ts'),
    { producer: 'planner role', location: 'packages/xezar/src/planner.ts#PLANNER_SYSTEM_PROMPT', text: PLANNER_SYSTEM_PROMPT },
    { producer: 'planner prompt (no checks)', location: 'packages/xezar/src/planner.ts#buildPlannerPrompt', text: buildPlannerPrompt('Draft the campaign brief', [], []) },
    { producer: 'planner prompt (checks)', location: 'packages/xezar/src/planner.ts#buildPlannerPrompt', text: buildPlannerPrompt('Fix the pricing bug', [], ['npm test']) },
    source('planner module', 'packages/xezar/src/planner.ts'),
    { producer: 'namer role', location: 'packages/xezar/src/runs/auto-name.ts#NAMER_SYSTEM_PROMPT', text: NAMER_SYSTEM_PROMPT },
    { producer: 'namer prompt', location: 'packages/xezar/src/runs/auto-name.ts#buildNamerPrompt', text: buildNamerPrompt({ task: 'Revise the methods section' }) },
    source('namer module', 'packages/xezar/src/runs/auto-name.ts'),
    { producer: 'attachment note', location: 'packages/xezar/src/workflows/run.ts#pastedAttachmentsText', text: pastedAttachmentsText([{ name: 'a.pdf', url: '/a', path: '/tmp/a.pdf' }]) },
    source('continuation, variant and restart prompts', 'packages/xezar/src/workflows/run.ts'),
    // ---- `xezar init` and the CLI ----
    { producer: 'init workflow (no check)', location: 'packages/xezar/src/init-kit.ts#fixAndVerifyWorkflow', text: fixAndVerifyWorkflow(undefined) },
    { producer: 'init workflow (check)', location: 'packages/xezar/src/init-kit.ts#fixAndVerifyWorkflow', text: fixAndVerifyWorkflow({ command: 'npm test', source: 'package.json' }) },
    { producer: 'init skill', location: 'packages/xezar/src/init-kit.ts#PROJECT_CONVENTIONS_SKILL', text: PROJECT_CONVENTIONS_SKILL },
    source('CLI help and init output', 'packages/xezar/src/index.ts'),
    // ---- the MCP surface a leader reads ----
    source('MCP initialize instructions', 'packages/xezar/src/mcp/bridge.ts'),
    { producer: 'MCP health tool', location: 'packages/xezar/src/mcp/bridge.ts#HEALTH_TOOL', text: JSON.stringify(HEALTH_TOOL) },
    { producer: 'leader role', location: 'packages/xezar/src/mcp/leader-delivery.ts#LEADER_ROLE_INSTRUCTION', text: LEADER_ROLE_INSTRUCTION },
    source('leader blockers', 'packages/xezar/src/mcp/leader-delivery.ts'),
    source('pi leader blocker', 'packages/xezar/src/mcp/adapters/pi.ts'),
    ...tools.map((tool) => ({ producer: `MCP tool ${tool.name} listing`, location: `mcp-tool:${tool.name}`, text: JSON.stringify(toolListing(tool)) })),
    ...MCP_TOOL_SOURCES.map((path) => source('MCP tool refusals and guidance', path)),
    // ---- what a person reads ----
    source('missing-cockpit recovery page', 'packages/xezar/src/server/static-ui.ts'),
    source('dry-run pull request', 'packages/xezar/src/server/forge/github.ts'),
    ...COCKPIT_SOURCES.map((path) => source('cockpit copy', path)),
    { producer: 'npm README', location: 'packages/xezar/README.md', text: syncReadme.absolutizeReadmeLinks(read('README.md'), 'https://github.com/qodeca/xezar') },
    source('dry-run Claude mock', 'packages/xezar/scripts/mock-claude.mjs'),
    source('dry-run pi mock', 'packages/xezar/scripts/mock-pi-rpc.mjs'),
    source('pi leader extension', 'packages/xezar/scripts/pi-leader-extension.ts'),
  ];
}

const P3 = '#466 P3 after #450/#460';
const CAPABILITY = "names a client's own instruction file as what that client reads — a capability reference (owner decision 2026-09-16)";

/**
 * Reviewed exceptions: one rule, one producer location, one fragment of the line. SHRINKING ONLY —
 * an exception that stops matching fails this test, and the list may not grow past the ceiling.
 * Remove an entry when its work package lands, and lower the ceiling with it.
 */
const EXCEPTIONS: readonly ContentException[] = [
  { rule: 'owner-name', file: 'packages/xezar/README.md', fragment: '**MIT** © Patryk Lewczuk', reason: 'licence attribution', ref: '#466' },
];

/** The most exceptions this guard may carry. Lower it when one is removed; never raise it. */
const EXCEPTION_CEILING = 1;

/**
 * Native instruction-file names, each allowed only where it is a capability reference. Exact
 * location and fragment, like every other exception — never a whole file.
 */
const NATIVE_FILE_EXCEPTIONS: readonly ContentException[] = [];
const NATIVE_FILE_EXCEPTION_CEILING = 0;

/** Software-only framing the audit found (F03, F04, F15, F31, F24), each owned by a work package. */
const FRAMING_EXCEPTIONS: readonly ContentException[] = [
  { rule: 'software-only-framing', file: 'packages/xezar/src/mcp/bridge.ts', fragment: 'xezar controls coding-agent tasks', reason: 'F15 — MCP initialize instructions', ref: P3 },
  { rule: 'software-only-framing', file: 'packages/xezar/src/mcp/leader-delivery.ts#LEADER_ROLE_INSTRUCTION', fragment: 'Read GitHub facts', reason: 'F04 — leader role', ref: P3 },
  { rule: 'software-only-framing', file: 'packages/xezar/src/mcp/leader-delivery.ts#LEADER_ROLE_INSTRUCTION', fragment: 'in their own worktrees', reason: 'F03 — leader role', ref: P3 },
  { rule: 'software-only-framing', file: 'packages/xezar/src/mcp/leader-delivery.ts', fragment: 'Read GitHub facts', reason: 'F04 — leader role source', ref: P3 },
  { rule: 'software-only-framing', file: 'packages/xezar/src/mcp/leader-delivery.ts', fragment: 'in their own worktrees', reason: 'F03 — leader role source', ref: P3 },
  { rule: 'software-only-framing', file: 'mcp-tool:leader_events', fragment: 'quality gates', reason: 'F31 — leader_events description', ref: P3 },
  { rule: 'software-only-framing', file: 'packages/xezar/src/mcp/tools/leader-events.ts', fragment: 'quality gates', reason: 'F31 — leader_events description source', ref: P3 },
];
const FRAMING_EXCEPTION_CEILING = 7;

function scan(producers: readonly Producer[], rules = PROJECT_SPECIFIC_RULES, exceptions: readonly ContentException[] = EXCEPTIONS) {
  const used = new Set<ContentException>();
  const leaks: Array<ContentLeak & { producer: string }> = [];
  for (const p of producers) {
    for (const leak of scanText(p.location, p.text, rules, exceptions, used)) leaks.push({ ...leak, producer: p.producer });
  }
  return { leaks, stale: exceptions.filter((e) => !used.has(e)) };
}

const report = (leaks: ReadonlyArray<ContentLeak & { producer: string }>) =>
  leaks.map((l) => `${l.producer} — ${l.file}:${l.line} [${l.rule}] …${l.fragment}…`);

describe('generic instructions (#466)', () => {
  it('covers a populated manifest: every producer has text, and the registries match it', async () => {
    const producers = await manifest();
    expect(producers.length).toBeGreaterThan(40);
    for (const p of producers) expect(p.text.trim().length, `${p.producer} @ ${p.location} produced no text`).toBeGreaterThan(0);

    // new-tool-escape: every registered MCP tool, and every file under mcp/tools, is in the manifest.
    const listed = new Set(producers.map((p) => p.location));
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(listed.has(`mcp-tool:${tool.name}`), `MCP tool ${tool.name} has no manifest entry`).toBe(true);
    for (const tool of tools) expect(JSON.stringify(toolListing(tool))).toContain(tool.description.slice(0, 40));
    expect(MCP_TOOL_SOURCES).toContain('packages/xezar/src/mcp/tools/index.ts');

    // Every built-in workflow the loader serves with no project files is in the manifest.
    const empty = mkdtempSync(join(tmpdir(), 'xez-generic-builtins-'));
    try {
      const { workflows } = await loadWorkflows(empty);
      const builtIns = workflows.filter((w) => w.source === 'built-in');
      expect(builtIns.map((w) => w.name)).toEqual([PROJECT_SETUP_WORKFLOW.name, QUICK_TASK_WORKFLOW.name].sort());
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }

    // The cockpit walk found the cockpit, not an empty directory.
    expect(COCKPIT_SOURCES.length).toBeGreaterThan(100);
    expect(COCKPIT_SOURCES).toContain('packages/web/src/routes/settings/agents-section.tsx');
  });

  it('finds no project-specific instruction in any producer', async () => {
    const { leaks, stale } = scan(await manifest());
    expect(report(leaks)).toEqual([]);
    expect(stale.map((e) => `${e.file} [${e.rule}] ${e.fragment}`), 'stale exception — remove it and lower the ceiling').toEqual([]);
    expect(EXCEPTIONS.length).toBeLessThanOrEqual(EXCEPTION_CEILING);
  });

  it("names a client's instruction file only as a reviewed capability reference", async () => {
    const { leaks, stale } = scan(await manifest(), [NATIVE_INSTRUCTION_FILE_RULE], NATIVE_FILE_EXCEPTIONS);
    expect(report(leaks)).toEqual([]);
    expect(stale).toEqual([]);
    expect(NATIVE_FILE_EXCEPTIONS.length).toBeLessThanOrEqual(NATIVE_FILE_EXCEPTION_CEILING);
    for (const e of [...EXCEPTIONS, ...NATIVE_FILE_EXCEPTIONS, ...FRAMING_EXCEPTIONS]) {
      expect(e.reason.length).toBeGreaterThan(0);
      expect(e.ref).toMatch(/#466/);
    }
  });

  it('pins the known software-only framing (audit class 2) to its work packages', async () => {
    const { leaks, stale } = scan(await manifest(), [SOFTWARE_ONLY_FRAMING_RULE], FRAMING_EXCEPTIONS);
    expect(report(leaks)).toEqual([]);
    expect(stale.map((e) => `${e.file} ${e.fragment}`), 'stale exception — remove it and lower the ceiling').toEqual([]);
    expect(FRAMING_EXCEPTIONS.length).toBeLessThanOrEqual(FRAMING_EXCEPTION_CEILING);
  });

  it('reports a leak with producer, location and fragment, and scans strings but not comments', () => {
    const producers: Producer[] = [
      { producer: 'fixture', location: 'fixture.ts', text: stripComments("// follow SDLC.md\nconst hint = 'run repo-gates.sh first';\n") },
    ];
    const { leaks } = scan(producers, PROJECT_SPECIFIC_RULES, []);
    expect(report(leaks)).toEqual(["fixture — fixture.ts:2 [own-gate-script] …const hint = 'run repo-gates.sh first';…"]);
  });

  it('allowlist-too-wide: an exception for one fragment does not cover a leak beside it', () => {
    const exception: ContentException = { rule: 'native-instruction-file', file: 'x.ts', fragment: 'Codex reads AGENTS.md', reason: CAPABILITY, ref: '#466' };
    const producers: Producer[] = [
      { producer: 'fixture', location: 'x.ts', text: "label: 'Codex reads AGENTS.md'\nhint: 'Adopt our AGENTS.md and SDLC.md process'" },
    ];
    const native = scan(producers, [NATIVE_INSTRUCTION_FILE_RULE], [exception]);
    expect(native.leaks.map((l) => l.line)).toEqual([2]);
    expect(native.stale).toEqual([]);
    expect(scan(producers, PROJECT_SPECIFIC_RULES, []).leaks.map((l) => l.rule)).toEqual(['own-process-doc']);
  });

  it('keeps the three labeled domain examples in init, and a checks-free path in the planner', () => {
    for (const text of [PROJECT_CONVENTIONS_SKILL, fixAndVerifyWorkflow(undefined)]) {
      expect(text).toMatch(/software/i);
      expect(text).toMatch(/advertising agency/i);
      expect(text).toMatch(/scientific research/i);
    }
    expect(PLANNER_SYSTEM_PROMPT).toContain('never invent one');
    expect(buildPlannerPrompt('t', [], [])).toContain('do not add a command step');
    expect(PLANNER_SYSTEM_PROMPT).not.toMatch(/coding agent cockpit/);
    expect(NAMER_SYSTEM_PROMPT).not.toMatch(/coding agent cockpit/);
  });

  it('keeps every protocol marker of the handoff contract byte-for-byte', () => {
    for (const marker of ['XEZ_HANDOFF_FILE', '## Progress log', '## Resume notes', 'XEZ:DONE', 'XEZ:MONITORING', 'XEZ:ASK <json>', 'XEZ:PR=<number>', 'XEZ:ISSUE=<number>', 'XEZ:TITLE=', '{"questions":[{"header":"≤12-char label","question":"a clear question ending in ?","multiSelect":false,"options":[{"label":"short choice","description":"what it means / the trade-off"}]}]}']) {
      expect(HANDOFF_ONLY_INSTRUCTIONS).toContain(marker);
    }
    expect(relative(repoRoot, packageRoot)).toBe('packages/xezar');
  });
});
