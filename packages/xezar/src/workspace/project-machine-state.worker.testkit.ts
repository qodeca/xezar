import { writeFileSync } from 'node:fs';
import { projectStateLayout } from '../state-layout.ts';
import { recordLastListen } from './project-machine-state.ts';

/**
 * One CROSS-PROCESS writer of `<project>/.local/xezar/machine-state.json`, for the
 * lost-update test of #649.
 *
 * It exists as a real child process because the thing under test is a real
 * cross-process lock: two `await`s inside one vitest worker are serialized by the
 * in-process queue and would prove nothing about two `xez` commands started at the
 * same moment. The test holds the file lock while this process runs, so the two
 * writers really do contend for it.
 *
 * Usage: `tsx project-machine-state.worker.testkit.ts <projectRoot> <markerPath>`
 *
 * The marker is written BEFORE the call, so the test's only timing assumption is
 * the read-modify-write itself rather than this process's tsx startup. The layout
 * is passed explicitly, so this process needs no global state.
 */
const [projectRoot = '', marker = ''] = process.argv.slice(2);

if (marker) writeFileSync(marker, 'ready');

await recordLastListen(
  { port: 4321, host: '127.0.0.1', observedAt: '2026-01-01T00:00:00.000Z' },
  projectStateLayout(projectRoot),
);
