import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The small, believable project the captures show: a TypeScript web shop with a login bug, a few
 * project skills and one multi-step workflow. Everything the screenshots render comes from here
 * or from the dry-run mock, never from the developer's machine, so a re-run shows the same data.
 *
 * Commits carry a FIXED author and date, so the Git view renders the same history every time.
 */

const FIXED_DATE = '2026-09-14T09:00:00+00:00'

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content, 'utf8')
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ada Lovelace',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada Lovelace',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
      GIT_AUTHOR_DATE: FIXED_DATE,
      GIT_COMMITTER_DATE: FIXED_DATE,
    },
    stdio: 'ignore',
  })
}

const SESSION_TS = `import type { Request, Response, NextFunction } from 'express'

export interface Session {
  userId: string
  expiresAt: number
}

const sessions = new Map<string, Session>()

export function readSession(req: Request): Session | undefined {
  const token = req.cookies?.session
  if (!token) return undefined
  const session = sessions.get(token)
  if (!session || session.expiresAt < Date.now()) return undefined
  return session
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!readSession(req)) {
    res.redirect('/login')
    return
  }
  next()
}
`

const CART_TS = `export interface CartLine {
  sku: string
  quantity: number
  unitPrice: number
}

export function cartTotal(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0)
}
`

export const SKILLS: Record<string, string> = {
  'code-review.md': `---
name: code-review
description: Review the current diff for correctness, security and readability before a PR.
---

# Code review

Read the diff first. Report findings ranked by severity, each with a file and line.

1. Correctness: does the change do what the task asked?
2. Security: input validation, secrets, injection.
3. Tests: is every new branch covered?
`,
  'write-tests.md': `---
name: write-tests
description: Add focused unit tests for the change and prove each one fails without the fix.
---

# Write tests

Add the smallest test that fails without the change. Run it red, apply the fix, run it green.
`,
  'release-notes.md': `---
name: release-notes
description: Draft user-facing release notes from the merged pull requests since the last tag.
---

# Release notes

Group changes as Added, Changed and Fixed. Write for users, not for maintainers.
`,
}

export const WORKFLOW_YAML = `name: ship-a-fix
description: Fix a bug, prove it with a test, review, then open a draft PR.
steps:
  - id: reproduce
    name: Reproduce
    prompt: "Reproduce the bug described in: {{task}}"
  - id: fix
    name: Fix
    prompt: "Fix it. Keep the change small. {{task}}"
  - id: tests
    name: Tests
    skill: write-tests
    prompt: "Add a regression test for {{task}}"
  - id: review
    name: Review
    skill: code-review
    prompt: "Review the change for {{task}}"
`

/**
 * A slow check step. The dry-run mock answers an agent turn in about a second, so a task that
 * must still read "running" when the tasks list is captured needs a step that genuinely runs:
 * one short agent turn that ends done, then a check command that sleeps.
 */
export const LONG_WORKFLOW_YAML = `name: build-and-verify
description: Implement the change, then run the full verification suite.
steps:
  - id: implement
    name: Implement
    prompt: "{{task}} mock:done"
  - id: verify
    name: Verify
    command: sleep 1200
`

/**
 * The mock answers `mock:ask` with an XEZ:ASK question. Appending the marker in the workflow's
 * step prompt keeps it out of the task text the thread and the task list show, and the instruction
 * before it pushes it past the 120 characters the mock echoes back.
 */
export const ASK_WORKFLOW_YAML = `name: explore-then-ask
description: Explore the code first, then ask before changing anything.
steps:
  - id: explore
    name: Explore and ask
    prompt: "{{task}}\\n\\nRead the checkout module and every date helper first. List each place that formats or parses a date, then ask before you change anything.\\n\\nmock:ask"
`

/** Create the fixture repository at `root` with one committed history. */
export function createFixtureRepo(root: string, name: string): void {
  mkdirSync(root, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'ignore' })
  // A github.com origin is what turns on the GitHub tab and Automations; under XEZ_DRY_RUN the
  // forge answers with its bundled mock issues and pull requests and never reaches the network.
  git(root, 'remote', 'add', 'origin', `https://github.com/acme/${name}.git`)
  write(root, 'README.md', `# ${name}\n\nA small web shop used to demo xezar.\n`)
  write(root, 'package.json', `${JSON.stringify({ name, version: '1.4.0', private: true, type: 'module' }, null, 2)}\n`)
  write(root, '.gitignore', 'node_modules\n.local\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'chore: initial project skeleton')
  write(root, 'src/auth/session.ts', SESSION_TS)
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'feat(auth): cookie sessions')
  write(root, 'src/cart/total.ts', CART_TS)
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'feat(cart): cart total')
  // Project skills and workflows are committed too, the way a team would keep them. A pinned
  // empty `skillsRepos` keeps the team collection out, so the skill list is exactly these three
  // (docs/testing/agent-browser.md § Team skills).
  for (const [file, body] of Object.entries(SKILLS)) write(root, `.xezar/skills/${file}`, body)
  write(root, '.xezar/workflows/ship-a-fix.yaml', WORKFLOW_YAML)
  write(root, '.xezar/workflows/build-and-verify.yaml', LONG_WORKFLOW_YAML)
  write(root, '.xezar/workflows/explore-then-ask.yaml', ASK_WORKFLOW_YAML)
  write(root, '.xezar/config.json', `${JSON.stringify({ skillsRepos: [] }, null, 2)}\n`)
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'chore: add project skills and workflows')
}

/** Uncommitted edits in a task's worktree, so its Changes tab shows a multi-file diff. */
export function editWorktree(worktree: string): void {
  write(
    worktree,
    'src/auth/session.ts',
    SESSION_TS.replace(
      "  const token = req.cookies?.session\n",
      "  // The redirect after login dropped the cookie: read the signed cookie first.\n  const token = req.signedCookies?.session ?? req.cookies?.session\n",
    ).replace("res.redirect('/login')", "res.redirect(\`/login?next=\${encodeURIComponent(req.originalUrl)}\`)"),
  )
  write(
    worktree,
    'test/auth/session.test.ts',
    `import { describe, expect, it } from 'vitest'
import { readSession } from '../../src/auth/session'

describe('readSession', () => {
  it('reads the signed cookie set by the login redirect', () => {
    const req = { signedCookies: { session: 'missing' }, cookies: {} } as never
    expect(readSession(req)).toBeUndefined()
  })
})
`,
  )
}

/** Uncommitted edits in the primary checkout, for the repository Git view. */
export function editPrimaryCheckout(root: string): void {
  write(root, 'src/cart/total.ts', CART_TS.replace(
    '  return lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0)\n',
    '  const cents = lines.reduce((sum, line) => sum + line.quantity * Math.round(line.unitPrice * 100), 0)\n  return cents / 100\n',
  ))
  write(root, 'docs/pricing.md', '# Pricing\n\nPrices are stored in cents and rounded once, at the cart total.\n')
}
