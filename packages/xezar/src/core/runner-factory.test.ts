import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentRunner, RunnerId } from './agent-runner.ts';
import { RUNNER_IDS } from './agent-runner.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { PiRunner } from './pi-runner.ts';
import { createRunner } from './runner-factory.ts';
import { RunStore } from '../runs/store.ts';

/**
 * #54 (gap R15) — `createRunner` is the dispatch at the seam AGENTS.md names:
 * "One seam: every backend implements `AgentRunner`/`AgentSession`." The runner
 * CLASSES are each well covered; what was not, before this file, is the one
 * function that decides which of them the user's task actually runs on.
 *
 * A mis-wired `case` does not crash. It runs the task on the wrong agent, with
 * the wrong model and the wrong tool permissions, while the run record still
 * names the backend the user picked — a silent, expensive, user-visible failure.
 * So every assertion here pins a runner's own IDENTITY (its class, and its
 * `backend` field), never merely that something truthy came back.
 *
 * Nothing here spawns an agent CLI. Every runner constructor only resolves a
 * binary NAME (`resolveClaudeExecutable`, `XEZ_CODEX_BIN`, …) and a timeout, so
 * constructing all four is pure and works on a host with no agent installed.
 */

/**
 * The expected class per id, typed as a TOTAL `Record<RunnerId, …>` on purpose:
 * adding an id to `RUNNER_IDS` without extending this table is a compile error
 * under `npm run typecheck` (tests are typechecked via tsconfig.test.json).
 * That is the static half of AGENT_PROTOCOL.md §9 item 2 — "add the id to
 * `RunnerId` / `RUNNER_IDS` … and a `case` in `createRunner`". The runtime half,
 * which needs no edit to this file at all, is the `RUNNER_IDS` table below.
 */
const EXPECTED_RUNNER: Record<RunnerId, new () => AgentRunner> = {
  claude: ClaudeCliRunner,
  codex: CodexAppServerRunner,
  opencode: OpencodeServerRunner,
  pi: PiRunner,
};

describe('createRunner — one runner class per runner id', () => {
  it.each(RUNNER_IDS)('maps the "%s" id to its own runner class', (id) => {
    expect(createRunner(id)).toBeInstanceOf(EXPECTED_RUNNER[id]);
  });

  it('gives every id a DIFFERENT class — no two ids share a runner', () => {
    // Two cases returning the same class is exactly what a copy-pasted `case`
    // looks like, and `toBeInstanceOf` alone would not notice it if the wrong
    // class happened to be a match for both.
    const classes = RUNNER_IDS.map((id) => createRunner(id).constructor);
    expect(new Set(classes).size).toBe(RUNNER_IDS.length);
  });

  it('keeps the expectation table in step with RUNNER_IDS', () => {
    // Guards the guard: a table that silently lost a row would make the
    // per-id case above assert nothing for the missing id.
    expect(Object.keys(EXPECTED_RUNNER).sort()).toEqual([...RUNNER_IDS].sort());
  });
});

describe('createRunner — every RUNNER_IDS entry has its own factory case', () => {
  /**
   * THE regression this file exists for. `createRunner` ends in a `default`
   * that returns `ClaudeCliRunner`, so a new id added to `RUNNER_IDS` without a
   * matching `case` does not throw and does not fail to compile — it silently
   * runs on Claude. This test needs no edit when that happens: the new id falls
   * through to the default, the returned runner reports `backend: 'claude'`,
   * and that is not the id asked for. Failure is therefore guaranteed, not
   * incidental — the only id whose default answer would match is `claude`
   * itself, which already has its case.
   */
  it.each(RUNNER_IDS)(
    'returns a runner that reports its own backend as "%s" — never the default fallback',
    (id) => {
      expect(createRunner(id).backend).toBe(id);
    },
  );

  it('reaches a dedicated case for every id, so none is served by the default', () => {
    const wrongly = RUNNER_IDS.filter((id) => createRunner(id).backend !== id);
    expect(wrongly).toEqual([]);
  });
});

describe('createRunner — the unmatched input (pinned, not designed)', () => {
  /**
   * There is no documented error: the switch's `default` falls through to the
   * Claude runner for anything it does not recognise. Pinned as CURRENT
   * behaviour, not endorsed — this silent fallback is precisely why the
   * `RUNNER_IDS` coverage test above has to exist.
   */
  it('falls back to the Claude runner for an unknown id instead of throwing', () => {
    const runner = createRunner('not-a-backend' as RunnerId);
    expect(runner).toBeInstanceOf(ClaudeCliRunner);
    expect(runner.backend).toBe('claude');
  });

  it('falls back to the Claude runner when no backend is given at all', () => {
    // The zero-config path: callers that never chose a backend still get one.
    const runner = createRunner(undefined);
    expect(runner).toBeInstanceOf(ClaudeCliRunner);
    expect(runner.backend).toBe('claude');
  });
});

describe('createRunner — the legacy `claude-cli` id (BACKWARD_COMPATIBILITY.md §3)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'xez-runner-factory-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('runs an old `claude-cli` record on the Claude runner, through the real store fold', () => {
    // The fold lives at the STORE layer (`storedRunnerSchema`), not in the
    // factory, so this walks the real path a resumed old run takes: read the
    // record back, hand the store's value to the factory. No fold is simulated.
    writeFileSync(
      join(dataDir, 'runs.json'),
      JSON.stringify([
        {
          id: 'legacy-1',
          title: 'fix the login bug',
          workflow: 'quick-task',
          task: 'fix the login bug',
          status: 'done',
          createdAt: '2026-01-01T00:00:00.000Z',
          tokensUsed: 0,
          archived: false,
          steps: [],
          runner: 'claude-cli',
        },
      ]),
      'utf8',
    );

    const stored = RunStore.open(dataDir).getRun('legacy-1')?.runner;
    expect(stored).toBe('claude'); // folded on the way in, before the factory sees it

    const runner = createRunner(stored);
    expect(runner).toBeInstanceOf(ClaudeCliRunner);
    expect(runner.backend).toBe('claude');
  });

  it('still answers the raw legacy spelling with the Claude runner', () => {
    // `AgentBackend` keeps `claude-cli` accepted at the factory too, for any
    // caller holding an unfolded value. Pinned so removing the case is a
    // deliberate break, not an accident.
    const runner = createRunner('claude-cli');
    expect(runner).toBeInstanceOf(ClaudeCliRunner);
    expect(runner.backend).toBe('claude');
  });
});
