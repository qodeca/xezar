import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import {
  providerForActiveRun,
  providerForExistingRun,
  providersRequiredByWorkflow,
  unavailableProviderMessage,
} from './provider-action-gate.ts';

const run = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run-1',
  title: 'Task',
  workflow: 'quick-task',
  task: 'Task',
  status: 'done',
  createdAt: '2026-07-24T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
  ...overrides,
});

describe('provider action gate', () => {
  it('collects each agent step backend and ignores checks', () => {
    const workflow: WorkflowDef = {
      name: 'mixed',
      source: 'built-in',
      steps: [
        { id: 'a', prompt: 'a', runner: 'codex' },
        { id: 'check', command: 'npm test' },
        { id: 'b', prompt: 'b' },
        { id: 'c', prompt: 'c', runner: 'qwen' },
      ],
    };

    expect(providersRequiredByWorkflow(workflow, 'claude')).toEqual(['claude', 'codex', 'qwen']);
  });

  it('reports disabled before missing credentials', () => {
    expect(unavailableProviderMessage(['codex'], {
      providers: [
        { provider: 'claude', status: 'connected', enabled: true },
        { provider: 'codex', status: 'connected', enabled: false },
        { provider: 'qwen', status: 'not-installed', enabled: true },
      ],
    })).toBe('Codex is disabled. Enable it in Settings → Agents → Providers, or with project_config set_provider_enabled (provider codex, enabled true).');
  });

  it.each(['disconnected', 'unknown'] as const)(
    'reports unavailable credentials for a %s provider',
    (status) => {
      expect(unavailableProviderMessage(['codex'], {
        providers: [{ provider: 'codex', status, enabled: true }],
      })).toBe('Codex credentials are unavailable. Authorize it in Settings → Agents → Providers, or run `xez providers connect codex` on the machine that runs xezar.');
    },
  );

  it('reports unavailable credentials when the provider status row is missing', () => {
    expect(unavailableProviderMessage(['qwen'], { providers: [] }))
      .toBe('Qwen Code credentials are unavailable. Authorize it in Settings → Agents → Providers, or run `xez providers connect qwen` on the machine that runs xezar.');
  });

  it('uses an explicit override before the latest step backend', () => {
    expect(providerForExistingRun(run({
      runner: 'claude',
      steps: [
        { id: 'first', name: 'First', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, backend: 'claude' },
        { id: 'last', name: 'Last', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, backend: 'codex' },
      ],
    }), 'qwen')).toBe('qwen');
  });

  it('uses the run runner before any historical step backend for a continuation', () => {
    expect(providerForExistingRun(run({
      runner: 'claude',
      steps: [
        { id: 'first', name: 'First', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, backend: 'claude' },
        { id: 'last', name: 'Last', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, backend: 'codex' },
      ],
    }))).toBe('claude');
  });

  it('uses the run runner, then Claude, when no step backend exists', () => {
    expect(providerForExistingRun(run({ runner: 'qwen' }))).toBe('qwen');
    expect(providerForExistingRun(run())).toBe('claude');
  });

  it('uses the current active step backend for a live message', () => {
    expect(providerForActiveRun(run({
      runner: 'claude',
      currentStepId: 'retry',
      steps: [
        { id: 'retry', name: 'Retry', kind: 'agent', status: 'running', iterations: 2, tokensUsed: 0, backend: 'claude' },
        { id: 'later', name: 'Later', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, backend: 'codex' },
      ],
    }))).toBe('claude');
  });

  it('falls back from an un-attributed active step to the run runner, historical backend, then Claude', () => {
    expect(providerForActiveRun(run({
      runner: 'qwen',
      currentStepId: 'active',
      steps: [{ id: 'active', name: 'Active', kind: 'agent', status: 'running', iterations: 1, tokensUsed: 0 }],
    }))).toBe('qwen');
    expect(providerForActiveRun(run({
      steps: [{ id: 'previous', name: 'Previous', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, backend: 'codex' }],
    }))).toBe('codex');
    expect(providerForActiveRun(run())).toBe('claude');
  });
});
