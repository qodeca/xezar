import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = process.env.XEZ_E2E_DRY_RUN_REGISTER_ROOT ?? process.cwd()
const registerPath = join(repoRoot, 'docs/testing/browser-dry-run-exceptions.md')
const manualChecksPath = join(repoRoot, 'docs/testing/browser-manual-checks.md')

function tableRows(source: string, firstCell: RegExp): string[] {
  return source.split('\n').filter((line) => firstCell.test(line))
}

describe('browser dry-run documentation register', () => {
  it('cites only lower-level tests that exist on disk', () => {
    const register = readFileSync(registerPath, 'utf8')
    const testPaths = [...register.matchAll(/`(packages\/[^`\s]+\.test\.(?:ts|tsx))`/g)]
      .map((match) => match[1])
      .filter((path): path is string => path !== undefined)

    expect(testPaths.length).toBeGreaterThan(0)
    for (const testPath of testPaths) {
      expect(existsSync(join(repoRoot, testPath)), `register cites ${testPath}`).toBe(true)
    }
  })

  it('classifies every guide exactly once', () => {
    const register = readFileSync(registerPath, 'utf8')
    const guideRows = tableRows(register, /^\| \d{2} \|/)
    const registeredParts = guideRows.map((row) => row.split('|')[1]?.trim())
    const guideParts = readdirSync(join(repoRoot, 'docs/guide'))
      .map((name) => /^(\d{2})-.*\.md$/.exec(name)?.[1])
      .filter((part): part is string => part !== undefined)
      .sort()

    expect(registeredParts.sort()).toEqual(guideParts)
    expect(new Set(registeredParts).size).toBe(guideParts.length)
  })

  it('keeps a dated result or an explained NOT PERFORMED result for every manual row', () => {
    const manualChecks = readFileSync(manualChecksPath, 'utf8')
    const rows = tableRows(manualChecks, /^\| Guide \d{2} /)

    expect(rows).toHaveLength(6)
    for (const row of rows) {
      const hasDate = /\d{4}-\d{2}-\d{2} \(CEST\)/.test(row)
      const hasExplainedNonPerformance = /NOT PERFORMED/.test(row) && /reason:\s*\S+/.test(row)
      expect(hasDate || hasExplainedNonPerformance, `manual row has no date or NOT PERFORMED reason: ${row}`).toBe(true)
    }
  })
})
