/**
 * The terminal's `event=` names against the MCP event catalog (#467, PR 4).
 *
 * The type system already refuses an `event` that is neither a catalog kind nor a listed
 * terminal-only name, and a catalog kind with no `CATALOG_KIND_SOURCE` row. These cases pin the
 * two things a type cannot: that the lists do not overlap, and that the store bridge prints
 * exactly the kinds the table says it owns — no more (a duplicate of a journal line), no fewer
 * (a kind nobody prints).
 */

import { readFileSync } from 'node:fs';
import { MCP_EVENT_KIND_CATEGORY } from '@qodeca/xezar-contract';
import { describe, expect, it } from 'vitest';

import { CATALOG_KIND_SOURCE, TERMINAL_ONLY_EVENTS } from './event-names.ts';

const catalogKinds = Object.keys(MCP_EVENT_KIND_CATEGORY);

describe('the terminal event vocabulary', () => {
  it('describes every catalog kind, and nothing that is not one', () => {
    expect(Object.keys(CATALOG_KIND_SOURCE).sort()).toEqual([...catalogKinds].sort());
  });

  it('never reuses a catalog kind as a terminal-only name', () => {
    // RED against: a catalog that grows `task.queued` while the terminal keeps its own meaning.
    expect(TERMINAL_ONLY_EVENTS.filter((name) => catalogKinds.includes(name))).toEqual([]);
    expect(new Set(TERMINAL_ONLY_EVENTS).size).toBe(TERMINAL_ONLY_EVENTS.length);
  });

  it('the store bridge prints exactly the catalog kinds marked `store`', () => {
    // Every `event:` literal in the bridge, including both arms of a conditional.
    const source = readFileSync(new URL('./activity-source.ts', import.meta.url), 'utf8');
    const printed = new Set<string>();
    for (const match of source.matchAll(/event: ([^,\n]+),/g)) {
      for (const literal of match[1]!.matchAll(/'([a-z.-]+)'/g)) printed.add(literal[1]!);
    }
    const catalogPrinted = [...printed].filter((name) => catalogKinds.includes(name)).sort();
    const storeOwned = Object.entries(CATALOG_KIND_SOURCE)
      .filter(([, source]) => source.from === 'store')
      .map(([kind]) => kind)
      .sort();
    expect(catalogPrinted).toEqual(storeOwned);
  });
});
