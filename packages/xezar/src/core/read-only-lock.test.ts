import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { DEFAULT_ALLOWED_TOOLS } from '../workflows/types.ts';
import {
  claudeBashRules,
  COMMAND_RUNNING_ARGUMENTS,
  IMPLEMENTED_ARGUMENT_POLICY_PROGRAMS,
  decideReadOnlyCommand,
  isReadOnlyStep,
  matchesBashAllowlistEntry,
} from './read-only-lock.ts';
import { READ_ONLY_LOCK_FIXTURES } from './read-only-lock.testkit.ts';

describe('shared read-only lock (#863)', () => {
  it('owns the read-only signal for every runner', () => {
    expect(isReadOnlyStep(['Read', 'Grep', 'Glob', 'Bash'])).toBe(true);
    expect(isReadOnlyStep([])).toBe(true);
    expect(isReadOnlyStep(undefined)).toBe(false);
    expect(isReadOnlyStep([...DEFAULT_ALLOWED_TOOLS])).toBe(false);
    expect(isReadOnlyStep(['Read', 'Edit'])).toBe(false);
    expect(isReadOnlyStep(['Read', 'Write'])).toBe(false);
  });

  it('owns Claude Code prefix semantics and rule formatting', () => {
    expect(matchesBashAllowlistEntry('git status', 'git status')).toBe(true);
    expect(matchesBashAllowlistEntry('git status --short', 'git status')).toBe(true);
    expect(matchesBashAllowlistEntry('git statusx', 'git status')).toBe(false);
    expect(claudeBashRules([' git status ', '', 'gh pr view'])).toEqual([
      'Bash(git status:*)',
      'Bash(gh pr view:*)',
    ]);
  });

  it.each(READ_ONLY_LOCK_FIXTURES)('$name', ({ command, entries, rule }) => {
    const decision = decideReadOnlyCommand(command, entries);
    if (rule === undefined) {
      expect(decision).toEqual({ allowed: true });
    } else {
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.rule).toBe(rule);
        expect(decision.reason).toContain(`Rule ${rule}`);
      }
    }
  });

  it('documents a reason for every command-argument audit row', () => {
    expect(COMMAND_RUNNING_ARGUMENTS.length).toBeGreaterThan(0);
    for (const row of COMMAND_RUNNING_ARGUMENTS) {
      expect(row.program).not.toBe('');
      expect(row.rule).toMatch(/^command\./);
      expect(Array.isArray(row.argumentShapes)).toBe(true);
      expect(row.reason).toMatch(/\S/);
    }
  });

  it('dispatches every argument row by program', () => {
    expect([...IMPLEMENTED_ARGUMENT_POLICY_PROGRAMS].sort()).toEqual(
      COMMAND_RUNNING_ARGUMENTS.map((row) => row.program).sort(),
    );
  });

  it.each(COMMAND_RUNNING_ARGUMENTS)('applies the $enforcement branch for $program', (row) => {
    const decision = decideReadOnlyCommand(row.program, [row.program]);
    if (row.enforcement === 'never-named') {
      expect(decision).toMatchObject({ allowed: false, rule: 'command.never-named' });
    } else {
      expect(decision).toEqual({ allowed: true });
    }
  });

  it('audits every command shipped by the five read-only workflow lists', () => {
    const workflows = ['code-review', 'design-review', 'qa', 'architecture-review', 'business-analysis'];
    const covered = new Set(COMMAND_RUNNING_ARGUMENTS.map((row) => row.program));
    for (const workflow of workflows) {
      const text = readFileSync(new URL(`../../../../.xezar/workflows/${workflow}.yaml`, import.meta.url), 'utf8');
      const document: unknown = parse(text);
      expect(document).toBeTypeOf('object');
      const steps = (document as { steps?: Array<{ bashAllowlist?: unknown }> }).steps ?? [];
      const entries = steps.flatMap((step) => Array.isArray(step.bashAllowlist) ? step.bashAllowlist : []);
      for (const entry of entries) {
        expect(entry).toBeTypeOf('string');
        const program = String(entry).trim().split(/\s+/, 1)[0] ?? '';
        expect(covered, `${workflow}: ${String(entry)}`).toContain(program);
      }
    }
  });

  it.each(['env', 'timeout', 'xargs', 'nohup', 'exec', 'eval', 'command', 'bash', 'sh', 'zsh', 'nice', 'caffeinate'])(
    'refuses the wrapper %s unless an entry names it',
    (wrapper) => {
      const refused = decideReadOnlyCommand(`${wrapper} git status`, ['git status']);
      expect(refused).toMatchObject({ allowed: false, rule: 'syntax.wrapper-command' });
      expect(decideReadOnlyCommand(`${wrapper} git status`, [wrapper])).toEqual({ allowed: true });
    },
  );
});
