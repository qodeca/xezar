import { deflateSync, inflateSync } from 'node:zlib'

/**
 * The two image jobs the capture harness needs, in plain Node and nothing else.
 *
 * This file exists because the machine that produced the 0.15.0 captures had no image tool at
 * all — no `ffmpeg`, `gifski`, ImageMagick, `pngquant` or `oxipng` — and the repository has no
 * image dependency either. Adding one for a docs-only, opt-in harness would put a native binary
 * (sharp) or a new package into every `npm ci` to serve a command that runs once per release.
 * `node:zlib` is enough for both jobs:
 *
 * - `decodePng` reads the browser's own screenshots (8-bit RGB/RGBA, non-interlaced — exactly
 *   what Chrome writes) so they can become GIF frames or be re-encoded.
 * - `encodeGif` assembles those frames into one looping animated GIF: a median-cut palette per
 *   frame, only the rectangle that changed since the previous frame, unchanged pixels inside it
 *   written as transparent so LZW sees long runs.
 * - `encodePngPalette` is the size fallback for a still that would exceed its budget: the same
 *   quantizer, written as an 8-bit indexed PNG at maximum deflate.
 *
 * Deliberately small and unoptimised beyond what a few dozen frames need. It is not a general
 * image library and must not grow into one.
 */

export interface RgbaImage {
  width: number
  height: number
  /** width × height × 4 bytes, row-major. */
  data: Uint8Array
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function decodePng(file: Uint8Array): RgbaImage {
  const buf = Buffer.from(file)
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('decodePng: not a PNG file')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = -1
  const idat: Buffer[] = []
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('latin1', offset + 4, offset + 8)
    const body = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const bitDepth = body[8]
      colorType = body[9] ?? -1
      const interlace = body[12]
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
        throw new Error(
          `decodePng: unsupported PNG (bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace})`,
        )
      }
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const channels = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = new Uint8Array(width * height * 4)
  const prev = new Uint8Array(stride)
  const line = new Uint8Array(stride)
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1)
    const filter = raw[start]
    for (let x = 0; x < stride; x += 1) {
      const value = raw[start + 1 + x] ?? 0
      const left = x >= channels ? (line[x - channels] ?? 0) : 0
      const up = prev[x] ?? 0
      const upLeft = x >= channels ? (prev[x - channels] ?? 0) : 0
      let decoded: number
      switch (filter) {
        case 0: decoded = value; break
        case 1: decoded = value + left; break
        case 2: decoded = value + up; break
        case 3: decoded = value + ((left + up) >> 1); break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          decoded = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
          break
        }
        default: throw new Error(`decodePng: bad filter ${filter} on row ${y}`)
      }
      line[x] = decoded & 0xff
    }
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4
      out[o] = line[x * channels] ?? 0
      out[o + 1] = line[x * channels + 1] ?? 0
      out[o + 2] = line[x * channels + 2] ?? 0
      out[o + 3] = channels === 4 ? (line[x * channels + 3] ?? 255) : 255
    }
    prev.set(line)
  }
  return { width, height, data: out }
}

// ---- quantization ---------------------------------------------------------------------------

type Box = { keys: number[] }

/** 15-bit RGB key: 5 bits per channel. Enough resolution for flat UI and anti-aliased text. */
const keyOf = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)

/**
 * Median-cut over a 15-bit histogram. Returns up to `maxColors` RGB triples and a lookup from
 * every histogram key present to its nearest palette index.
 */
function quantize(
  pixels: Uint8Array,
  include: (index: number) => boolean,
  maxColors: number,
): { palette: number[][]; lookup: Map<number, number> } {
  const counts = new Map<number, number>()
  const sums = new Map<number, [number, number, number]>()
  for (let i = 0; i < pixels.length / 4; i += 1) {
    if (!include(i)) continue
    const o = i * 4
    const r = pixels[o] ?? 0
    const g = pixels[o + 1] ?? 0
    const b = pixels[o + 2] ?? 0
    const key = keyOf(r, g, b)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    const sum = sums.get(key)
    if (sum) {
      sum[0] += r
      sum[1] += g
      sum[2] += b
    } else {
      sums.set(key, [r, g, b])
    }
  }
  const channel = (key: number, c: number) => (key >> (10 - c * 5)) & 31
  let boxes: Box[] = [{ keys: [...counts.keys()] }]
  while (boxes.length < maxColors) {
    // Split the box with the widest channel range weighted by population.
    let best = -1
    let bestScore = 0
    let bestChannel = 0
    boxes.forEach((box, index) => {
      if (box.keys.length < 2) return
      let population = 0
      for (let c = 0; c < 3; c += 1) {
        let min = 31
        let max = 0
        for (const key of box.keys) {
          const v = channel(key, c)
          if (v < min) min = v
          if (v > max) max = v
        }
        if (c === 0) for (const key of box.keys) population += counts.get(key) ?? 0
        const score = (max - min) * Math.sqrt(population)
        if (score > bestScore) {
          bestScore = score
          best = index
          bestChannel = c
        }
      }
    })
    if (best < 0) break
    const box = boxes[best]
    if (!box) break
    const sorted = [...box.keys].sort((a, b) => channel(a, bestChannel) - channel(b, bestChannel))
    const total = sorted.reduce((n, key) => n + (counts.get(key) ?? 0), 0)
    let running = 0
    let cut = 1
    for (let i = 0; i < sorted.length - 1; i += 1) {
      running += counts.get(sorted[i] ?? 0) ?? 0
      if (running >= total / 2) {
        cut = i + 1
        break
      }
      cut = i + 1
    }
    boxes = [
      ...boxes.slice(0, best),
      { keys: sorted.slice(0, cut) },
      { keys: sorted.slice(cut) },
      ...boxes.slice(best + 1),
    ]
  }
  const palette = boxes.map((box) => {
    let n = 0
    let r = 0
    let g = 0
    let b = 0
    for (const key of box.keys) {
      const count = counts.get(key) ?? 0
      const sum = sums.get(key) ?? [0, 0, 0]
      n += count
      r += sum[0]
      g += sum[1]
      b += sum[2]
    }
    return n === 0 ? [0, 0, 0] : [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
  })
  const lookup = new Map<number, number>()
  for (const key of counts.keys()) {
    const sum = sums.get(key) ?? [0, 0, 0]
    const count = counts.get(key) ?? 1
    const r = sum[0] / count
    const g = sum[1] / count
    const b = sum[2] / count
    let bestIndex = 0
    let bestDistance = Infinity
    palette.forEach((colour, index) => {
      const d = ((colour[0] ?? 0) - r) ** 2 + ((colour[1] ?? 0) - g) ** 2 + ((colour[2] ?? 0) - b) ** 2
      if (d < bestDistance) {
        bestDistance = d
        bestIndex = index
      }
    })
    lookup.set(key, bestIndex)
  }
  return { palette, lookup }
}

// ---- GIF ------------------------------------------------------------------------------------

export interface GifFrame {
  image: RgbaImage
  /** How long this frame stays on screen, in milliseconds (GIF resolution is 10 ms). */
  delayMs: number
}

function lzw(indices: Uint8Array, minCodeSize: number): Buffer {
  const clear = 1 << minCodeSize
  const end = clear + 1
  const bytes: number[] = []
  let bitBuffer = 0
  let bitCount = 0
  let codeSize = minCodeSize + 1
  const write = (code: number) => {
    bitBuffer |= code << bitCount
    bitCount += codeSize
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 0xff)
      bitBuffer >>>= 8
      bitCount -= 8
    }
  }
  let dict = new Map<number, number>()
  let next = end + 1
  write(clear)
  let prefix = indices[0] ?? 0
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i] ?? 0
    const key = (prefix << 8) | k
    const found = dict.get(key)
    if (found !== undefined) {
      prefix = found
      continue
    }
    write(prefix)
    if (next < 4096) {
      dict.set(key, next)
      next += 1
      if (next > 1 << codeSize && codeSize < 12) codeSize += 1
    } else {
      write(clear)
      dict = new Map()
      next = end + 1
      codeSize = minCodeSize + 1
    }
    prefix = k
  }
  write(prefix)
  write(end)
  if (bitCount > 0) bytes.push(bitBuffer & 0xff)
  // Sub-blocks of at most 255 bytes, then the zero-length terminator.
  const out: number[] = [minCodeSize]
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255)
    out.push(chunk.length, ...chunk)
  }
  out.push(0)
  return Buffer.from(out)
}

/** A looping animated GIF. Every frame must share the first frame's dimensions. */
export function encodeGif(frames: GifFrame[]): Buffer {
  const first = frames[0]
  if (!first) throw new Error('encodeGif: no frames')
  const { width, height } = first.image
  const parts: Buffer[] = []
  const header = Buffer.alloc(13)
  header.write('GIF89a', 0, 'latin1')
  header.writeUInt16LE(width, 6)
  header.writeUInt16LE(height, 8)
  header[10] = 0 // no global colour table
  parts.push(header)
  // NETSCAPE2.0: loop forever.
  parts.push(Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'latin1'), 0x03, 0x01, 0x00, 0x00, 0x00]))

  let previous: Uint8Array | undefined
  // Merge consecutive identical frames into one longer frame.
  const merged: GifFrame[] = []
  for (const frame of frames) {
    if (frame.image.width !== width || frame.image.height !== height) {
      throw new Error('encodeGif: frame size differs from the first frame')
    }
    const last = merged.at(-1)
    if (last && Buffer.from(last.image.data).equals(Buffer.from(frame.image.data))) {
      last.delayMs += frame.delayMs
    } else {
      merged.push({ image: frame.image, delayMs: frame.delayMs })
    }
  }

  for (const frame of merged) {
    const data = frame.image.data
    let left = 0
    let top = 0
    let right = width - 1
    let bottom = height - 1
    if (previous) {
      const prev = previous
      const same = (i: number) =>
        data[i * 4] === prev[i * 4] && data[i * 4 + 1] === prev[i * 4 + 1] && data[i * 4 + 2] === prev[i * 4 + 2]
      left = width
      top = height
      right = -1
      bottom = -1
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (!same(y * width + x)) {
            if (x < left) left = x
            if (x > right) right = x
            if (y < top) top = y
            if (y > bottom) bottom = y
          }
        }
      }
      if (right < 0) {
        // Unreachable after merging, kept so a 1×1 no-op frame still encodes validly.
        left = 0
        top = 0
        right = 0
        bottom = 0
      }
    }
    const w = right - left + 1
    const h = bottom - top + 1
    const region = new Uint8Array(w * h * 4)
    const unchanged = new Uint8Array(w * h)
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const src = ((top + y) * width + left + x) * 4
        const dst = (y * w + x) * 4
        region[dst] = data[src] ?? 0
        region[dst + 1] = data[src + 1] ?? 0
        region[dst + 2] = data[src + 2] ?? 0
        region[dst + 3] = 255
        if (
          previous &&
          previous[src] === data[src] &&
          previous[src + 1] === data[src + 1] &&
          previous[src + 2] === data[src + 2]
        ) {
          unchanged[y * w + x] = 1
        }
      }
    }
    const transparentIndex = 255
    const { palette, lookup } = quantize(region, (i) => unchanged[i] === 0, 255)
    const indices = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i += 1) {
      if (unchanged[i] === 1) {
        indices[i] = transparentIndex
        continue
      }
      indices[i] = lookup.get(keyOf(region[i * 4] ?? 0, region[i * 4 + 1] ?? 0, region[i * 4 + 2] ?? 0)) ?? 0
    }
    // What the viewer now shows: the quantized colours where this frame drew, the old ones elsewhere.
    const shown = previous ? Buffer.from(previous) : Buffer.alloc(width * height * 4)
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x
        if (unchanged[i] === 1) continue
        // Track the SOURCE pixel, not the quantized one: diffing against source keeps a static
        // area static across frames even when two frames quantize it to different palettes.
        const src = ((top + y) * width + left + x) * 4
        shown[src] = data[src] ?? 0
        shown[src + 1] = data[src + 1] ?? 0
        shown[src + 2] = data[src + 2] ?? 0
        shown[src + 3] = 255
      }
    }
    previous = new Uint8Array(shown)

    const delayCs = Math.max(2, Math.round(frame.delayMs / 10))
    // Graphic control extension: disposal 1 (leave in place), transparency on.
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x05, delayCs & 0xff, delayCs >> 8, transparentIndex, 0x00]))
    const descriptor = Buffer.alloc(10)
    descriptor[0] = 0x2c
    descriptor.writeUInt16LE(left, 1)
    descriptor.writeUInt16LE(top, 3)
    descriptor.writeUInt16LE(w, 5)
    descriptor.writeUInt16LE(h, 7)
    descriptor[9] = 0x80 | 7 // local colour table, 256 entries
    parts.push(descriptor)
    const table = Buffer.alloc(256 * 3)
    palette.forEach((colour, index) => {
      table[index * 3] = colour[0] ?? 0
      table[index * 3 + 1] = colour[1] ?? 0
      table[index * 3 + 2] = colour[2] ?? 0
    })
    parts.push(table)
    parts.push(lzw(indices, 8))
  }
  parts.push(Buffer.from([0x3b]))
  return Buffer.concat(parts)
}

// ---- indexed PNG ----------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

/** An 8-bit palette PNG (≤ 256 colours, median cut), deflated at level 9. Lossy on purpose. */
export function encodePngPalette(image: RgbaImage, colours = 256): Buffer {
  const { width, height, data } = image
  const { palette, lookup } = quantize(data, () => true, colours)
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4
      raw[y * (width + 1) + 1 + x] =
        lookup.get(keyOf(data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0)) ?? 0
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 3 // indexed colour
  const plte = Buffer.alloc(palette.length * 3)
  palette.forEach((colour, index) => {
    plte[index * 3] = colour[0] ?? 0
    plte[index * 3 + 1] = colour[1] ?? 0
    plte[index * 3 + 2] = colour[2] ?? 0
  })
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
