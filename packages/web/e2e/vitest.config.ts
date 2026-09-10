import '../../../scripts/test-local-state.mjs'
import { defineConfig } from 'vitest/config'

/**
 * `fileParallelism: false` below is a REQUEST, not a guarantee — this line is the guarantee.
 *
 * Vitest applies `VITEST_MAX_WORKERS` at the very END of config resolution, after
 * `fileParallelism: false` has already pinned `maxWorkers` to 1, and unconditionally
 * (`if (process.env.VITEST_MAX_WORKERS) resolved.maxWorkers = Number.parseInt(...)`). It
 * therefore outranks this file AND `--no-file-parallelism` on the command line: measured on
 * vitest 4.1.10, a run with `VITEST_MAX_WORKERS=4` exported forks four workers either way.
 *
 * That is not a speed knob for THIS suite, it is a correctness break (#162). These specs share
 * one server, one machine and one set of on-disk fixtures, and several of them rewrite state
 * that is global to all of it: `project-groups.e2e.ts` seeds a three-project workspace registry
 * into `.local/qa/xez-home/config.json`, while every spec asserting the flat single-project
 * shell waits for `[data-slot="repo-chip"]` — which the cockpit renders only when the registry
 * holds ONE project. `settings-skills`, `settings-bookmarklets` and `workflows` each seed AND
 * DELETE the same two files in `<repo>/.ai/skills/`. Run those concurrently and a spec waits 25s
 * for content another spec just deleted, in a file the change under test never touched. Rounds
 * 1–4 of that blocker (#136, #148, #160, #162) all wore this shape.
 *
 * Deleted rather than pinned: an operator who exports it for `npm test` (the fast unit gate,
 * where parallelism is free and wanted) must not have to know this suite exists.
 * `e2e-file-parallelism.test.ts` fails if this stops working.
 */
delete process.env.VITEST_MAX_WORKERS

/**
 * The e2e suite is deliberately NOT a project in the root vitest.config.ts: `npm test` is the
 * fast unit gate and must never need a running server or a browser. These specs run only via
 * `npm run test:e2e`, which boots the environment first.
 *
 * Plain node environment and no React plugin — the specs shell out to agent-browser and drive
 * a real Chrome; nothing here is bundled or rendered in jsdom.
 */
export default defineConfig({
  test: {
    name: 'e2e',
    root: import.meta.dirname,
    environment: 'node',
    include: ['**/*.e2e.ts'],
    // One browser session, one server: parallel specs would fight over both.
    fileParallelism: false,
    // Pins the shared env's workspace registry to the single-project shape before any spec runs,
    // and restores it afterwards — otherwise whatever the operator last registered in the
    // gitignored `.local/qa/xez-home` decides whether the sidebar renders its flat or its grouped
    // shell, and every spec asserting flat-shell selectors becomes a coin flip. See the module.
    globalSetup: ['./workspace-registry.ts'],
    // A real browser is slower than jsdom, but a smoke test that needs more than this is broken.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
