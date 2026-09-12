import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { auditOriginSchema } from '@qodeca/xezar-contract';

/**
 * #266 — WHICH AUDIT ORIGINS PRODUCTION ACTUALLY WRITES.
 *
 * `auditOriginSchema` offers four members and production opens one channel. That is a decided state
 * for 0.14.0 (D-06 § 10.6), not a defect — the defect was that four documents could quietly stop
 * describing it. Four surfaces now say "only `mcp`": the schema's own comment
 * (`packages/contract/src/mcp-audit.ts`), the module comment of `audit-trail.ts`, and two sections
 * of `docs/features/mcp-server/mcp-api.md` ("The two meanings of `origin`", Findings 3). This file
 * is what makes those four sentences a checked claim instead of a remembered one: wire a second
 * door (#364) and it fails, naming the documents that must change with it.
 *
 * It scans source text, so the usual fail-open worry applies: a regex that stops matching finds
 * nothing, and "no second door" reads the same as "the scanner broke". Here it is closed by the
 * assertion's own shape — the second case expects exactly ONE element, so an empty scan fails it
 * too. The first case is the populated-input control that says WHICH of the two happened: it pins
 * the one call the scan must always find, and it goes red on its own when the MCP door stops
 * stamping `mcp` (proven), while staying green when a second door is added (also proven).
 */

const SRC = fileURLToPath(new URL('../', import.meta.url));
const PRODUCTION_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** `.channel('<origin>')` — the only way an origin is bound to a door (`AuditTrail.channel`). */
const CHANNEL_CALL = /\.channel\(\s*'([a-z]+)'\s*\)/g;

/**
 * Comments out, code in. The documents this file guards QUOTE the call they describe, and a scan
 * that reads prose as wiring would count `audit-trail.ts`'s own comment as a second door. Block
 * comments and whole-line `//` / ` *` comments go; a trailing comment on a code line stays, which
 * is the harmless direction — it can only ever add a match, never hide one, and a wrong extra match
 * fails loudly with the file named.
 */
const withoutComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');

interface ChannelCall {
  readonly file: string;
  readonly origin: string;
}

/** Every `.ts` file under a directory that is not a test or a test kit. */
function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...productionFiles(full));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.testkit.ts')) continue;
    out.push(full);
  }
  return out;
}

function channelCalls(root: string): ChannelCall[] {
  const found: ChannelCall[] = [];
  for (const file of productionFiles(root)) {
    const text = withoutComments(readFileSync(file, 'utf8'));
    for (const match of text.matchAll(CHANNEL_CALL)) {
      found.push({ file: relative(PRODUCTION_ROOT, file), origin: match[1]! });
    }
  }
  return found;
}

describe('audit origins that production actually writes (#266)', () => {
  it('finds the MCP door — the control that proves the scan is not silently empty', () => {
    const calls = channelCalls(SRC);
    // If this ever reads `[]`, the scan is broken and the case below means nothing.
    expect(calls).toContainEqual({ file: 'src/mcp/index.ts', origin: 'mcp' });
  });

  it('writes `mcp` and nothing else; `ui`, `automation` and `cli` stay reserved', () => {
    const calls = channelCalls(SRC);
    expect(
      calls,
      'A door was wired or unwired. Update all four surfaces that say the trail is MCP-only: ' +
        'auditOriginSchema (packages/contract/src/mcp-audit.ts), the module comment of ' +
        'packages/xezar/src/mcp/audit-trail.ts, and mcp-api.md ("The two meanings of `origin`" and ' +
        'Findings 3) — then D-06 § 10.6 and #364.',
    ).toEqual([{ file: 'src/mcp/index.ts', origin: 'mcp' }]);
  });

  it('keeps the reserved members in the enum — narrowing it would be a contract break', () => {
    expect(auditOriginSchema.options).toEqual(['ui', 'mcp', 'automation', 'cli']);
  });
});
