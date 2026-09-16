import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { createApp } from '../server/server.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { executionControlTool } from '../mcp/tools/execution-control.ts';
import { taskReadsTool } from '../mcp/tools/task-reads.ts';
import type { McpTool, McpToolContext } from '../mcp/tool.ts';
import { withEventOrigin } from '../mcp/event-catalog.ts';
import { RunManager, AUTO_RESUME_GRACE_MS } from './run.ts';
import { checkFailureWorkflow, order, providerClock, repair, scriptedRunner, terminal } from './engine-incidents.testkit.ts';

// #520: runContinuation currently settles success after the repairing turn, dropping all pending checks.
describe('G8 Continue preserves the failed check and workflow tail', () => {
  it.fails.each(['MCP continue', 'restart then MCP continue', 'usage resume', 'failed retry'])(
    '%s reruns readiness before gates/evidence/handoff or a final outcome', async mode => {
      const root = mkdtempSync(join(tmpdir(), 'xez-g8-'));
      let store = RunStore.open(join(root, 'data'));
      const clock = providerClock(); const reset = clock.reset();
      const repairing = { before: mode === 'failed retry'
        ? (spec: import('../core/agent-runner.ts').AgentRunSpec) => appendFileSync(join(spec.cwd, 'order.txt'), 'repair\n') : repair };
      const runner = scriptedRunner(mode === 'usage resume'
        ? [{}, { error: `Claude AI usage limit reached|${reset}` }, repairing] : [{}, repairing]);
      let manager = new RunManager(store, root);
      try {
        const def = checkFailureWorkflow(root);
        const record = manager.startRun(def, { task: 'repair checks', worktree: false });
        await terminal(store, record.id);
        expect(store.getRun(record.id)?.status).toBe('failed');
        expect(order(root)).toEqual(['readiness']);
        const premature: string[] = [];
        if (mode === 'restart then MCP continue') {
          await manager.quiesce(); store.flush();
          store = RunStore.open(join(root, 'data'));
          manager = new RunManager(store, root);
        }
        store.on('run', (run: RunRecord) => {
          if (run.id === record.id && run.status === 'done' &&
            def.steps.some(step => run.steps.find(s => s.id === step.id)?.status !== 'done')) premature.push(run.status);
        });
        {
          const app = createApp({ repoRoot: root, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
          const ctx = { project: { id: 'default', name: 'fixture', root }, xezarVersion: '0.0.0-test', service: app } as McpToolContext;
          const call = async (tool: McpTool, args: Record<string, unknown>) => {
            const result = await tool.call(tool.inputSchema.parse(args), ctx);
            return JSON.parse((result.content[0] as { text: string }).text);
          };
          const { version } = await call(taskReadsTool, { view: 'task', taskId: record.id });
          const result = await withEventOrigin({ origin: 'leader', causedBy: 'repair-check', runId: record.id },
            () => call(executionControlTool, { action: 'continue', runId: record.id, expectedVersion: version,
              operationId: 'repair-check', text: 'Repair readiness and finish the remaining workflow.' }));
          expect(result).not.toHaveProperty('error');
        }
        await expect.poll(() => runner.specs.length).toBe(2);
        await terminal(store, record.id);
        if (mode === 'usage resume') {
          expect(store.getRun(record.id)?.status).toBe('failed');
          expect(store.getRun(record.id)?.autoResumeAt).toBe(new Date(reset * 1000 + AUTO_RESUME_GRACE_MS).toISOString());
          clock.advanceTo(reset * 1000 + AUTO_RESUME_GRACE_MS);
          await expect.poll(() => runner.specs.length).toBe(3);
          await terminal(store, record.id);
        }
        expect(order(root), '#520: required check must rerun after repair').toEqual(mode === 'failed retry'
          ? ['readiness', 'repair', 'readiness'] : ['readiness', 'repair', 'readiness', 'gates', 'evidence', 'handoff']);
        expect(premature).toEqual([]);
        expect(store.getRun(record.id)?.status).toBe(mode === 'failed retry' ? 'failed' : 'done');
      } finally { await manager.quiesce(); store.flush(); runner.restore(); clock.restore(); rmSync(root, { recursive: true, force: true }); }
    },
  );
});
