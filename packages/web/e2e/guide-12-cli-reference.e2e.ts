import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootProjectId, readTestEnv } from './agent-browser'
import { GuideBrowser } from './guide-browser'

/**
 * Guide 12 — CLI reference (docs/guide/12-cli-reference.md). Almost every command here (`serve`
 * flags, `run`, `init`, `projects`, `server-install`/`server-deploy`/`server-uninstall`) is a
 * terminal contract with no cockpit surface at all, so the dry-run exception register carries
 * nearly the whole guide:
 *
 * - `serve` flags, port search and terminal output modes: `packages/xezar/src/index.ts` and
 *   `packages/xezar/test/e2e/package-cli.test.ts:34-170,486-495` (the port-fallback case named in
 *   browser-test-spec.md row "12").
 * - `run`: `packages/xezar/test/e2e/package-cli.test.ts`.
 * - `init`: `packages/xezar/src/init-kit.test.ts:12-52` and
 *   `packages/xezar/src/project-kit-cli.test.ts:8-29`.
 * - `projects`: `packages/xezar/src/workspace/projects-cli.test.ts:16-342`.
 * - `mcp`: `packages/xezar/src/mcp/cli.test.ts:120-300`.
 * - `server-install`/`server-deploy`/`server-uninstall`: `packages/xezar/src/server-install/platforms/*.test.ts`.
 *
 * The one thing the guide claims that a running cockpit visibly proves is the version this CLI
 * reports on `-v`/`--version` — the same string `xezar serve` prints in its own banner and the
 * cockpit's Tools menu title, and the same `xezar mcp` invocation the guide's own "To connect an
 * agent" section names, which the project's MCP-connection settings page prints verbatim as the
 * one-time setup command for every client. This file checks that those two numbers agree, and
 * that the `xezar mcp` command text guide 12 sends a reader to guide 13 for is the exact text
 * guide 13's own settings page prints.
 */

let browser: GuideBrowser
let baseUrl: string
let bootProject: string

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  browser = GuideBrowser.open(`e2e-guide-12-${process.pid}`)
}, 60_000)

afterAll(() => {
  browser?.close()
})

describe('guide 12 — CLI reference', () => {
  it('the version the cockpit reports matches the running CLI\'s own --version', async () => {
    const health = (await (await fetch(`${baseUrl}/api/v1/health`)).json()) as { version: string }

    browser.goto(`${baseUrl}/p/${bootProject}/`)
    await browser.waitForRole('button', 'Tools')

    // The sidebar prints a plain "vX.Y.Z" badge beside the Tools trigger — everything else about
    // that menu (its title tooltip, its per-tool rows) belongs to tools-menu.e2e.ts; this file
    // only cross-checks the version text against the CLI's own reported number.
    expect(browser.hasText(`v${health.version}`)).toBe(true)
  })

  it('"To connect an agent: mcp" points at the exact command the MCP-connection page prints', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/settings/mcp-connection`)
    await browser.waitForRole('heading', 'MCP connection')
    // Guide 12's own line: `xezar mcp` (or `npx -y @qodeca/xezar mcp`) — the exact one-time setup
    // command guide 13's page prints for Claude Code, Codex, OpenCode and pi alike.
    expect(browser.hasText('npx -y @qodeca/xezar mcp')).toBe(true)
  })
})
