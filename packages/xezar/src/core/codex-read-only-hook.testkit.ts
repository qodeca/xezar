import { READ_ONLY_LOCK_FIXTURES } from './read-only-lock.testkit.ts';

/** Codex-shaped copies of the shared golden table, plus its two payload-only refusals. */
export const CODEX_READ_ONLY_HOOK_FIXTURES = [
  ...READ_ONLY_LOCK_FIXTURES.map((fixture) => ({
    ...fixture,
    payload: { tool_name: 'Bash', tool_input: { command: fixture.command } },
  })),
  {
    name: 'wrong tool payload',
    command: '',
    entries: ['git status'],
    payload: { tool_name: 'apply_patch', tool_input: { command: 'git status' } },
    rule: 'payload.tool-name',
  },
  {
    name: 'missing command payload',
    command: '',
    entries: ['git status'],
    payload: { tool_name: 'Bash', tool_input: {} },
    rule: 'payload.command',
  },
] as const;
