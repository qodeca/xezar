/**
 * #671 — test-only: pin the home-derived skill sources so a developer's own catalog cannot leak
 * into an MCP fixture that says "this project has no skills".
 *
 * `skills.ts` resolves its two GLOBAL skill dirs from `os.homedir()` — `~/.agents/skills` and
 * `~/.claude/skills` — and does so ONCE, in the module-level `GLOBAL_SKILL_DIRS` const. It
 * deliberately does NOT use `agentHomePaths()` for them: a skill is CONTENT, not identity, and the
 * dirs are written by tools xezar does not control (`npx skills`; xezar's own default-on skills
 * update). `XEZ_HOME`, which `vitest.setup.ts` pins per worker, does not cover them.
 *
 * That is a real, deterministic leak on any machine whose global catalog carries a skill — this
 * machine's `~/.agents/skills/xez-issue-create/SKILL.md` made `task-create.test.ts`'s
 * `setup({ skills: [] })` fixture find an issue-create skill it asserts does not exist. Pinning
 * `process.env.HOME` inside a fixture's `setup()` is TOO LATE: the dirs were already resolved when
 * `skills.ts` was first imported (directly, or through `server.ts` / `workflows/run.ts`).
 *
 * So the pin is a MODULE-LOAD side effect, and this module MUST be a test file's FIRST import —
 * before anything that reaches `skills.ts`. The scratch home is EMPTY, which is the point: global
 * discovery finds nothing in it, so a fixture that writes only its own `.xezar/skills` really is
 * "a project with no skills". `mcpAmbientHome` records the home that was in effect before the pin,
 * so a test can prove the pin replaced a home that carried a skill.
 *
 * Only `homedir()` feeds skill discovery, so only `HOME`/`USERPROFILE` are pinned here. The
 * agent-home variables `scripts/test-env-up.sh` documents (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
 * `OPENCODE_CONFIG_DIR`) do not affect `skills.ts`, and each fixture that reads them pins them
 * itself. `XDG_CONFIG_HOME` is not read by discovery either.
 *
 * Test-only (`.testkit.ts`): it never ships in `dist`, and `test:coverage:mcp` excludes it.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

/** The home that was in effect before the pin — what a developer's own skill catalog would sit in. */
export const mcpAmbientHome = previous.HOME;

/** The empty scratch home discovery resolves against for the rest of this test file. */
export const mcpTestHome = realpathSync(mkdtempSync(join(tmpdir(), 'xez-mcp-test-home-')));

process.env.HOME = mcpTestHome;
process.env.USERPROFILE = mcpTestHome;

// Restore the ambient home and drop the scratch. The worker may run the next test file, which must
// not inherit a `HOME` that points at a directory this file is about to remove.
afterAll(() => {
  if (previous.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = previous.HOME;
  if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previous.USERPROFILE;
  rmSync(mcpTestHome, { recursive: true, force: true });
});
