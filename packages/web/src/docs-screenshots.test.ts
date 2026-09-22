import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  SCREENSHOT_DIR,
  SHOT_MAX_BYTES,
  TOUR_FILE,
  TOUR_MAX_BYTES,
  TOUR_MAX_MS,
  allShotFiles,
} from '../e2e/capture/manifest'

/**
 * The docs screenshots (#448 PR-1b, currently 0.18.0) are a contract other PRs build on: the README and
 * every guide part link them by name. This pins that each listed file is on disk, is a real PNG,
 * and stays inside its size budget — so a re-capture that drops a state, renames one or bloats
 * one fails the fast gate instead of a README link on github.com.
 *
 * The list comes from `e2e/capture/manifest.ts`, which is also what the capture harness shoots.
 */

const repoRoot = resolve(import.meta.dirname, '../../..')
const dir = resolve(repoRoot, SCREENSHOT_DIR)

const PNG_MAGIC = '89504e470d0a1a0a'
const GIF_MAGIC = '474946383961' // GIF89a

function head(path: string, bytes: number): string {
  const buffer = Buffer.alloc(bytes)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buffer, 0, bytes, 0)
  } finally {
    closeSync(fd)
  }
  return buffer.toString('hex')
}

/** Every frame's delay in a GIF, in milliseconds, read from its Graphic Control Extensions. */
function gifFrameDelays(bytes: Buffer): number[] {
  const skipSubBlocks = (at: number): number => {
    while (bytes[at] !== 0) at += bytes[at]! + 1
    return at + 1
  }
  const tableSize = (packed: number) => (packed & 0x80 ? 3 * 2 ** ((packed & 0x07) + 1) : 0)
  const delays: number[] = []
  let at = 13 + tableSize(bytes[10]!)
  while (at < bytes.length) {
    const block = bytes[at]
    if (block === 0x3b) return delays
    if (block === 0x21) {
      if (bytes[at + 1] === 0xf9) delays.push(bytes.readUInt16LE(at + 4) * 10)
      at = skipSubBlocks(at + 2)
    } else if (block === 0x2c) {
      at = skipSubBlocks(at + 10 + tableSize(bytes[at + 9]!) + 1)
    } else {
      throw new Error(`unexpected GIF block 0x${block?.toString(16)} at byte ${at}`)
    }
  }
  throw new Error('the GIF has no trailer')
}

describe(`the ${SCREENSHOT_DIR} screenshots`, () => {
  const files = allShotFiles()

  it('names every file exactly once', () => {
    expect(new Set(files).size).toBe(files.length)
  })

  it.each(files)('%s exists, is a PNG and is within the size budget', (file) => {
    const path = resolve(dir, file)
    expect(existsSync(path), `${SCREENSHOT_DIR}/${file} is missing`).toBe(true)
    expect(head(path, 8)).toBe(PNG_MAGIC)
    expect(statSync(path).size).toBeLessThanOrEqual(SHOT_MAX_BYTES)
  })

  it(`${TOUR_FILE} exists, is a GIF and is within the size budget`, () => {
    const path = resolve(dir, TOUR_FILE)
    expect(existsSync(path), `${SCREENSHOT_DIR}/${TOUR_FILE} is missing`).toBe(true)
    expect(head(path, 6)).toBe(GIF_MAGIC)
    expect(statSync(path).size).toBeLessThanOrEqual(TOUR_MAX_BYTES)
  })

  it(`${TOUR_FILE} plays for at most ${TOUR_MAX_MS / 1000} seconds`, () => {
    const delays = gifFrameDelays(readFileSync(resolve(dir, TOUR_FILE)))
    expect(delays.length).toBeGreaterThan(1)
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(TOUR_MAX_MS)
  })

  it('holds no PNG the manifest does not name, so a stale capture cannot linger unnoticed', () => {
    const onDisk = readdirSync(dir).filter((name) => name.endsWith('.png'))
    expect(onDisk.filter((name) => !files.includes(name))).toEqual([])
  })

  it('lists every file in its README', () => {
    const readme = readFileSync(resolve(dir, 'README.md'), 'utf8')
    for (const file of [...files, TOUR_FILE]) expect(readme).toContain(file)
  })
})
