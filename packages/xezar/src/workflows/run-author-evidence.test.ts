import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { closeStoreAndRemove } from '../runs/store.testkit.ts';
import { BRIEF_MAX_FILE_BYTES } from '../runs/author-evidence.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { scriptedRunner, terminal } from './engine-incidents.testkit.ts';
import type { RunnerId } from '../core/agent-runner.ts';

/**
 * #933 — a review step can read the evidence of the task it checks, on every backend.
 *
 * Before: a read-only Codex review could not read the author task's evidence (its criteria file,
 * its sealed gate record, its handoff) — the files lived in the author's folders, and a Codex
 * read-only step reads only through its command allowlist. Nothing named the author task either.
 *
 * Now a task started with `evidenceFromRunId` gets, at every agent step: a read-only COPY of that
 * task's evidence folder and handoff in its own run folder, and the same files quoted
 * (size-limited, truncation named) in its opening message. The author's folders are never handed
 * to the session — on Codex every `additionalDirectories` entry is a writable root.
 */

const AUTHOR_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const CRITERIA = 'AC-1: the total is computed in cents\naccepted-by: owner, 2026-10-01\n';
const SEAL = '{"head":"abc123","status":"pass","sealed":true}\n';
const HANDOFF = '# Handoff\nPR #42 at abc123, gates sealed.\n';

const reviewWorkflow = (runner: RunnerId): WorkflowDef => ({
  name: 'review',
  source: 'built-in',
  steps: [{ id: 'review', prompt: '{{task}}', runner, allowedTools: ['Read', 'Grep', 'Glob', 'Bash'] }],
});

describe('a task started with evidenceFromRunId sees the named task evidence (#933)', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let runner: ReturnType<typeof scriptedRunner> | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-933-ev-'));
    store = RunStore.open(join(root, '.local/xezar'));
    manager = new RunManager(store, root);
    // The author task's evidence folder (top-level records + a nested gate seal) and its handoff
    // journal, where the engine and the kit put them. The route checks the author RECORD exists
    // (`server` tests); the engine only reads these files.
    const evidence = join(root, '.local/xezar/tasks', AUTHOR_ID);
    mkdirSync(join(evidence, 'gates', 'abc123', '1'), { recursive: true });
    writeFileSync(join(evidence, 'CRITERIA'), CRITERIA);
    writeFileSync(join(evidence, 'gates', 'abc123', '1', 'manifest.json'), SEAL);
    mkdirSync(join(root, '.local/xezar/runs'), { recursive: true });
    writeFileSync(join(root, '.local/xezar/runs', `${AUTHOR_ID}.handoff.md`), HANDOFF);
    runner = undefined;
  });

  afterEach(async () => {
    await manager.quiesce();
    manager.dispose();
    runner?.restore();
    store.flush();
    closeStoreAndRemove(store, root);
  });

  const startReview = async (backend: RunnerId, evidenceFromRunId: string | null = AUTHOR_ID) => {
    runner?.restore();
    runner = scriptedRunner([{ chunks: ['verdict posted\nXEZ:DONE'] }]);
    const record = manager.startRun(reviewWorkflow(backend), {
      task: 'review PR 42',
      worktree: false,
      ...(evidenceFromRunId ? { evidenceFromRunId } : {}),
    });
    await terminal(store, record.id);
    const spec = runner.specs[0];
    if (!spec) throw new Error('no agent spawned');
    return { record, spec };
  };

  it('criterion 1: a Codex review step receives the author criteria file and sealed gate record', async () => {
    const { record, spec } = await startReview('codex');

    expect(store.getRun(record.id)?.status).toBe('done');
    expect(store.getRun(record.id)?.evidenceFromRunId).toBe(AUTHOR_ID);
    // Quoted in the opening message — no read access needed at all.
    expect(spec.userPrompt).toContain(`Evidence from task ${AUTHOR_ID}`);
    expect(spec.userPrompt).toContain('### evidence/CRITERIA');
    expect(spec.userPrompt).toContain(CRITERIA.trim());
    expect(spec.userPrompt).toContain('### evidence/gates/abc123/1/manifest.json');
    expect(spec.userPrompt).toContain(SEAL.trim());
    expect(spec.userPrompt).toContain('### handoff.md');
    // And copied, read-only, into the review run's OWN folder.
    const snapshot = join(root, '.local/xezar/runs', `${record.id}-evidence`);
    expect(readFileSync(join(snapshot, 'evidence', 'CRITERIA'), 'utf8')).toBe(CRITERIA);
    expect(readFileSync(join(snapshot, 'evidence', 'gates', 'abc123', '1', 'manifest.json'), 'utf8')).toBe(SEAL);
    expect(readFileSync(join(snapshot, 'handoff.md'), 'utf8')).toBe(HANDOFF);
  });

  it('hard limit: no author folder is ever handed to the session as a reachable (writable) directory', async () => {
    const { spec } = await startReview('codex');
    const dirs = spec.additionalDirectories ?? [];
    expect(dirs.some((d) => d.includes(AUTHOR_ID))).toBe(false);
    expect(dirs.some((d) => d.includes('-evidence'))).toBe(false);
  });

  it('criterion 3: the same review on Claude, Codex and Qwen Code sees the same evidence set', async () => {
    const blocks: Record<string, string> = {};
    for (const backend of ['claude', 'codex', 'qwen'] as const) {
      const { record, spec } = await startReview(backend);
      const at = spec.userPrompt.indexOf(`## Evidence from task ${AUTHOR_ID}`);
      expect(at, `${backend} got no evidence block`).toBeGreaterThan(-1);
      // The one run-specific part is the snapshot folder's own id; everything else must be equal.
      blocks[backend] = spec.userPrompt.slice(at).replaceAll(record.id, '<run>');
    }
    expect(blocks.codex).toBe(blocks.claude);
    expect(blocks.qwen).toBe(blocks.claude);
    expect(blocks.claude).toContain(CRITERIA.trim());
  });

  it('a Continue on another backend (a fresh session) gets the same evidence; a resumed one does not repeat it', async () => {
    runner = scriptedRunner([
      { chunks: ['first pass\nXEZ:DONE'] },
      { chunks: ['second pass\nXEZ:DONE'] },
      { chunks: ['third pass\nXEZ:DONE'] },
    ]);
    const record = manager.startRun(reviewWorkflow('claude'), { task: 'review PR 42', worktree: false, evidenceFromRunId: AUTHOR_ID });
    await terminal(store, record.id);
    // Backend switch → no session to resume → a fresh session that must see the evidence too.
    expect(manager.continueRun(record.id, { text: 'check again', runner: 'codex' })).toEqual({ ok: true });
    await expect.poll(() => runner?.specs.length).toBe(2);
    await terminal(store, record.id);
    expect(runner.specs[1]?.resume).toBe(false);
    expect(runner.specs[1]?.userPrompt).toContain(CRITERIA.trim());
    // Same backend → the session resumes and already holds the evidence in its history.
    expect(manager.continueRun(record.id, { text: 'one more look' })).toEqual({ ok: true });
    await expect.poll(() => runner?.specs.length).toBe(3);
    await terminal(store, record.id);
    expect(runner.specs[2]?.resume).toBe(true);
    expect(runner.specs[2]?.userPrompt).not.toContain('Evidence from task');
  });

  it('an absent field is today’s behaviour: no block, no snapshot folder, no note', async () => {
    const { record, spec } = await startReview('codex', null);
    expect(spec.userPrompt).not.toContain('Evidence from task');
    expect(existsSync(join(root, '.local/xezar/runs', `${record.id}-evidence`))).toBe(false);
    expect(store.getRun(record.id)?.evidenceFromRunId).toBeUndefined();
  });

  it('a large file is quoted only up to its limit, and the truncation is named', async () => {
    writeFileSync(join(root, '.local/xezar/tasks', AUTHOR_ID, 'big.log'), 'x'.repeat(BRIEF_MAX_FILE_BYTES + 500));
    const { spec } = await startReview('codex');
    expect(spec.userPrompt).toContain(
      `[truncated: showing the first ${BRIEF_MAX_FILE_BYTES} of ${BRIEF_MAX_FILE_BYTES + 500} bytes; the full file is in the copy]`,
    );
  });

  it('a task with no evidence left behind is stated as a gap, not silently empty', async () => {
    const EMPTY_ID = '11111111-2222-4333-8444-555555555555'; // a task that left nothing on disk
    const { spec } = await startReview('codex', EMPTY_ID);
    expect(spec.userPrompt).toContain(`Task ${EMPTY_ID} left no evidence files or handoff that xezar could find`);
    expect(spec.userPrompt).toContain('Name this as a gap in your result.');
  });
});
