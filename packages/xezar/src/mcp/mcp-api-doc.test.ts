import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { HEALTH_TOOL } from './bridge.ts';
import { toolListing } from './tool.ts';
import { COVERAGE_GAPS, TOOL_ACTION_COVERAGE, type ActionCoverage } from './tools/api-coverage.testkit.ts';
import { tools } from './tools/index.ts';

/**
 * #261 — THE MCP API REFERENCE, held to the code it describes.
 *
 * `docs/features/mcp-server/mcp-api.json` is exactly what `tools/list` answers — the same
 * `[HEALTH_TOOL, ...tools.map(toolListing)]` the bridge sends (`bridge.ts`), built from the real
 * registry, never parsed out of source text. `docs/features/mcp-server/mcp-api.md` is hand-written
 * prose around marker-delimited tables that this file regenerates from that listing, from the
 * record-to-action mapping (`tools/api-coverage.testkit.ts`) and from the closed inventory, and the
 * committed files must equal the regenerated ones byte for byte. A tool added, removed, renamed or
 * re-described without regenerating the reference fails `npm test`.
 *
 * To regenerate after a deliberate change (prose outside the markers is kept):
 *   npm test -- packages/xezar/src/mcp/mcp-api-doc.test.ts -u
 *
 * The mapping is checked BOTH ways, the way `contract-parity` insists: every `covered` record is
 * served by an action that exists, and every action is justified by a record. A covered record no
 * action serves goes in `COVERAGE_GAPS` and runs as a `todo` — named, never passing.
 */

const REPO_ROOT = new URL('../../../../', import.meta.url);
const DOCS = new URL('docs/features/mcp-server/', REPO_ROOT);
const API_JSON = fileURLToPath(new URL('mcp-api.json', DOCS));
const API_MD = fileURLToPath(new URL('mcp-api.md', DOCS));
const INVENTORY = fileURLToPath(new URL('mcp-ui-action-inventory.md', DOCS));

type Json = Record<string, any>;
type InventoryStatus = 'covered' | 'global' | 'presentation';
interface InventoryRecord {
  readonly status: InventoryStatus;
  readonly outcome: string;
}

/** What `tools/list` answers, as the bridge builds it. */
const listing = (): Json[] => JSON.parse(JSON.stringify([HEALTH_TOOL, ...tools.map(toolListing)])) as Json[];

const renderJson = (): string => `${JSON.stringify(listing(), null, 2)}\n`;

/** The same row shape `acceptance-parity.test.ts` reads, plus the required-equivalent cell. */
function readInventory(): Map<string, InventoryRecord> {
  const rows = new Map<string, InventoryRecord>();
  for (const line of readFileSync(INVENTORY, 'utf8').split('\n')) {
    const m = /^\| (I-\d{3}) \|.*\| (covered|global|presentation) \|$/.exec(line);
    if (!m) continue;
    const cells = line.split(/(?<!\\)\|/);
    rows.set(m[1]!, { status: m[2] as InventoryStatus, outcome: cells[cells.length - 3]!.trim() });
  }
  return rows;
}

// ---- the registry's actions ----------------------------------------------------------------------

/** The argument that selects what a tool does, when it has one. */
const DISCRIMINATORS = ['action', 'view', 'read'] as const;

function discriminator(tool: Json): string | undefined {
  const props = (tool.inputSchema?.properties ?? {}) as Json;
  return DISCRIMINATORS.find((key) => Array.isArray(props[key]?.enum));
}

/** Every action the wire exposes: `tool:action`, or the tool's bare name when it has no selector. */
function registryActions(): string[] {
  return listing().flatMap((tool) => {
    const key = discriminator(tool);
    return key ? (tool.inputSchema.properties[key].enum as string[]).map((a) => `${tool.name}:${a}`) : [tool.name as string];
  });
}

// ---- rendering -------------------------------------------------------------------------------------

/** A table cell: pipes escaped, line breaks kept visible. */
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
const code = (text: string): string => `\`${text}\``;
/** A description as a block quote, one quoted line per source line, so its own layout survives. */
const quote = (text: string): string =>
  text
    .trim()
    .split(/\r?\n/)
    .map((line) => (line.trim() === '' ? '>' : `> ${line.trimEnd()}`))
    .join('\n');

/** The first sentence of a description, its purpose. */
function purpose(description: string): string {
  const firstLine = description.split('\n')[0]!;
  return /^(.+?[.!?])(\s|$)/.exec(firstLine)?.[1] ?? firstLine;
}

function hint(annotations: Json | undefined, key: string): string {
  const value = annotations?.[key];
  return value === undefined ? 'not set' : value ? 'yes' : 'no';
}

function presence(tool: Json, key: string): string {
  const schema = tool.inputSchema as Json;
  if ((schema.required as string[] | undefined)?.includes(key)) return 'required';
  return schema.properties?.[key] ? 'some actions' : '—';
}

function typeOf(schema: Json | undefined): string {
  if (!schema) return 'any';
  if (Array.isArray(schema.enum)) return schema.enum.map((v: unknown) => code(String(v))).join(' \\| ');
  if (schema.const !== undefined) return code(JSON.stringify(schema.const));
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((s: Json) => typeOf(s)).join(' or ');
  if (schema.type === 'array') return `array of ${typeOf(schema.items)}`;
  return String(schema.type ?? 'any');
}

/** Bounds and defaults a reviewer checks, straight from the JSON Schema keywords. */
function limitsOf(schema: Json): string {
  const own = (s: Json): string[] => {
    const out: string[] = [];
    for (const [key, label] of [
      ['minLength', 'min length'],
      ['maxLength', 'max length'],
      ['minimum', 'min'],
      ['maximum', 'max'],
      ['minItems', 'min items'],
      ['maxItems', 'max items'],
    ] as const)
      if (s[key] !== undefined) out.push(`${label} ${s[key]}`);
    if (s.pattern !== undefined) out.push(`pattern ${code(s.pattern)}`);
    if (s.default !== undefined) out.push(`default ${code(JSON.stringify(s.default))}`);
    return out;
  };
  const parts = [...own(schema), ...(Array.isArray(schema.anyOf) ? schema.anyOf.flatMap((s: Json) => own(s)) : [])];
  return parts.join(', ');
}

/** One row per argument, nested object and array-item properties as dotted paths. */
function argumentRows(schema: Json, prefix = '', depth = 0): string[] {
  const rows: string[] = [];
  const required = new Set((schema.required as string[] | undefined) ?? []);
  for (const [name, raw] of Object.entries((schema.properties ?? {}) as Json)) {
    const prop = raw as Json;
    const path = `${prefix}${name}`;
    rows.push(`| ${code(path)} | ${typeOf(prop)} | ${required.has(name) ? 'yes' : 'no'} | ${cell(limitsOf(prop))} | ${cell(prop.description ?? '')} |`);
    if (depth >= 3) continue;
    const objectOf = (s: Json | undefined): Json | undefined =>
      s?.type === 'object' && s.properties ? s : Array.isArray(s?.anyOf) ? s!.anyOf.find((x: Json) => x.type === 'object' && x.properties) : undefined;
    const itemsOf = (s: Json | undefined): Json | undefined =>
      s?.type === 'array' ? s.items : Array.isArray(s?.anyOf) ? s!.anyOf.find((x: Json) => x.type === 'array')?.items : undefined;
    const nested = objectOf(prop);
    if (nested) rows.push(...argumentRows(nested, `${path}.`, depth + 1));
    const item = objectOf(itemsOf(prop));
    if (item) rows.push(...argumentRows(item, `${path}[].`, depth + 1));
  }
  return rows;
}

const ids = (list: readonly string[] | undefined): string => (list ?? []).join(', ');

function shortOutcome(outcome: string): string {
  const plain = outcome.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain;
  return sentence.length > 140 ? `${sentence.slice(0, 139).trimEnd()}…` : sentence;
}

function renderBlocks(inventory: Map<string, InventoryRecord>): Record<string, string> {
  const wire = listing();

  const toolRows = wire.map(
    (t) =>
      `| ${code(t.name)} | ${cell(t.title ?? '')} | ${cell(purpose(t.description))} | ${hint(t.annotations, 'readOnlyHint')} | ${hint(t.annotations, 'destructiveHint')} | ${hint(t.annotations, 'idempotentHint')} | ${hint(t.annotations, 'openWorldHint')} | ${presence(t, 'expectedVersion')} | ${presence(t, 'operationId')} |`,
  );

  const argumentSections = wire.map((t) => {
    const rows = argumentRows(t.inputSchema);
    const strict = t.inputSchema.additionalProperties === false ? 'Unknown arguments are rejected.' : 'Unknown arguments are NOT rejected: the schema does not set `additionalProperties: false`.';
    return [
      `### ${code(t.name)}`,
      '',
      quote(t.description),
      '',
      rows.length === 0
        ? `Takes no arguments. ${strict}`
        : [strict, '', '| Argument | Type | Required | Limits | Description (verbatim from the schema) |', '| --- | --- | --- | --- | --- |', ...rows].join('\n'),
    ].join('\n');
  });

  const servedBy = new Map<string, string[]>();
  for (const [action, cover] of Object.entries(TOOL_ACTION_COVERAGE))
    for (const r of cover.serves ?? []) servedBy.set(r, [...(servedBy.get(r) ?? []), code(action)]);
  const recordRows = [...inventory]
    .filter(([, rec]) => rec.status === 'covered')
    .map(([id, rec]) => {
      const gap = COVERAGE_GAPS[id];
      const served = gap ? `**(GAP)** ${cell(gap)}` : (servedBy.get(id) ?? []).join(', ');
      return `| ${id} | ${cell(shortOutcome(rec.outcome))} | ${served} |`;
    });

  const actionRows = Object.entries(TOOL_ACTION_COVERAGE).map(
    ([action, c]: [string, ActionCoverage]) => `| ${code(action)} | ${ids(c.serves)} | ${ids(c.reads)} | ${ids(c.refuses)} | ${cell(c.unrecorded ?? '')} |`,
  );

  return {
    tools: [
      '| Tool | Title | Purpose (first sentence of its description) | Read-only | Destructive | Idempotent | Open world | `expectedVersion` | `operationId` |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...toolRows,
    ].join('\n'),
    arguments: argumentSections.join('\n\n'),
    records: ['| Record | Required outcome (inventory, first sentence) | Served by |', '| --- | --- | --- |', ...recordRows].join('\n'),
    actions: ['| Tool action | Serves (covered) | Safe read of (global) | Refuses | Why it has no record |', '| --- | --- | --- | --- | --- |', ...actionRows].join('\n'),
  };
}

const BLOCK_NAMES = ['tools', 'arguments', 'records', 'actions'] as const;
const markers = (name: string) => [`<!-- mcp-api:${name}:start -->`, `<!-- mcp-api:${name}:end -->`] as const;

/** The committed page with every generated block replaced by its regenerated content. */
function regenerateDoc(doc: string, blocks: Record<string, string>): string {
  let out = doc;
  for (const name of BLOCK_NAMES) {
    const [start, end] = markers(name);
    const from = out.indexOf(start);
    const to = out.indexOf(end);
    if (from < 0 || to < from) throw new Error(`mcp-api.md lost its ${start} … ${end} markers`);
    out = `${out.slice(0, from + start.length)}\n${blocks[name]}\n${out.slice(to)}`;
  }
  return out;
}

// ---- the checks ---------------------------------------------------------------------------------

describe('#261 — the MCP API reference against the registry and the inventory', () => {
  it('mcp-api.json is exactly what tools/list answers, byte for byte', async () => {
    // A missing file would be WRITTEN by a local file snapshot and pass; it has to exist first.
    expect(existsSync(API_JSON), 'docs/features/mcp-server/mcp-api.json is missing').toBe(true);
    await expect(renderJson()).toMatchFileSnapshot(API_JSON);
  });

  it('the generated tables in mcp-api.md say exactly what the registry, the mapping and the inventory say', async () => {
    expect(existsSync(API_MD), 'docs/features/mcp-server/mcp-api.md is missing').toBe(true);
    const doc = readFileSync(API_MD, 'utf8');
    await expect(regenerateDoc(doc, renderBlocks(readInventory()))).toMatchFileSnapshot(API_MD);
  });

  it('every covered inventory record is served by a tool action that exists, or is a named gap', () => {
    const inventory = readInventory();
    expect(inventory.size).toBe(140);
    const actions = new Set(registryActions());
    const served = new Set<string>();
    for (const [action, cover] of Object.entries(TOOL_ACTION_COVERAGE)) {
      if (!actions.has(action)) continue; // reported by the next case
      for (const r of cover.serves ?? []) served.add(r);
    }
    const covered = [...inventory].filter(([, rec]) => rec.status === 'covered').map(([id]) => id);
    expect(covered).toHaveLength(89);
    expect(covered.filter((id) => !served.has(id) && !(id in COVERAGE_GAPS)), 'covered records no action serves').toEqual([]);
    // A gap is only for a covered record nothing serves: never a second label on a served one.
    for (const id of Object.keys(COVERAGE_GAPS)) {
      expect(inventory.get(id)?.status, `${id} in COVERAGE_GAPS`).toBe('covered');
      expect(served.has(id), `${id} is both served and a gap`).toBe(false);
    }
  });

  it('every action the registry exposes is declared and justified, and nothing else is declared', () => {
    const actions = registryActions();
    const declared = Object.keys(TOOL_ACTION_COVERAGE);
    expect(declared.filter((a) => !actions.includes(a)), 'declared actions the registry does not expose').toEqual([]);
    expect(actions.filter((a) => !declared.includes(a)), 'registry actions with no declared coverage').toEqual([]);
    for (const [action, c] of Object.entries(TOOL_ACTION_COVERAGE)) {
      const records = [...(c.serves ?? []), ...(c.reads ?? []), ...(c.refuses ?? [])];
      expect(records.length > 0 || Boolean(c.unrecorded?.trim()), `${action} names no record and gives no reason`).toBe(true);
      if (records.length > 0) expect(c.unrecorded, `${action} names records and also claims to have none`).toBeUndefined();
    }
  });

  it('the mapping names only inventory records, each in a role its status allows', () => {
    const inventory = readInventory();
    for (const [action, c] of Object.entries(TOOL_ACTION_COVERAGE)) {
      for (const r of [...(c.serves ?? []), ...(c.reads ?? []), ...(c.refuses ?? [])]) expect(inventory.has(r), `${action} names ${r}`).toBe(true);
      // Serving a presentation or global record would dress a non-action or a boundary up as coverage.
      for (const r of c.serves ?? []) expect(inventory.get(r)?.status, `${action} serves ${r}`).toBe('covered');
      // A safe effective read is what section 3 allows a GLOBAL record, and nothing else.
      for (const r of c.reads ?? []) expect(inventory.get(r)?.status, `${action} reads ${r}`).toBe('global');
    }
  });

  it('the published artifacts carry no secret and no account identity (F-15, F-12, N-01)', () => {
    const published = `${renderJson()}\n${readFileSync(API_MD, 'utf8')}`;
    expect(published).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9-]+\.[a-z]{2,}/i);
    expect(published).not.toMatch(/\b(ghp_|gho_|github_pat_|sk-ant-|sk-[A-Za-z0-9]{20}|xox[abp]-)/);
    expect(published).not.toMatch(/"(email|organization|organisation|login|password|token|apiKey)"\s*:/i);
  });

  for (const [id, missing] of Object.entries(COVERAGE_GAPS)) it.todo(`GAP ${id} — ${missing}`);
});
