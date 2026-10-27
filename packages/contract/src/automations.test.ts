import { describe, expect, it } from 'vitest';
import { automationLogSinceSchema } from './automations.ts';

describe('automationLogSinceSchema', () => {
  // zod 4.6 made `datetime()` require seconds; the log's `since` filter is a public input
  // (MCP `logQuery.since`, HTTP `?since=`) and keeps accepting the minute-only form (#1160).
  it.each(['2026-10-24T09:30Z', '2026-10-24T09:30:00Z', '2026-10-24T09:30:00.123Z'])('accepts %s', (since) => {
    expect(automationLogSinceSchema.safeParse(since).success).toBe(true);
  });

  it.each(['2026-10-24', '2026-10-24T09Z', '2026-10-24T09:30', 'yesterday', ''])('refuses %s', (since) => {
    expect(automationLogSinceSchema.safeParse(since).success).toBe(false);
  });
});
