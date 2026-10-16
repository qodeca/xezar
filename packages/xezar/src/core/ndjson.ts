import { constants } from 'node:buffer';

/**
 * The longest single line `readNdjson` will assemble: the runtime's own string ceiling. A line
 * at or under it reads exactly as before; one past it could never have been read — V8 refuses to
 * build the string and throws a bare `RangeError: Invalid string length` (#942) — so the reader
 * refuses it first, with a size a person can act on.
 */
export const MAX_NDJSON_LINE_CHARS = constants.MAX_STRING_LENGTH;

/** One line longer than the reader can hold. `chars` is how much had arrived when it gave up. */
export class NdjsonLineTooLongError extends Error {
  constructor(readonly chars: number, readonly limit: number) {
    super(`one message larger than xezar can read (at least ${formatSize(chars)}; the limit is ${formatSize(limit)})`);
    this.name = 'NdjsonLineTooLongError';
  }
}

/** A count of characters (UTF-8 text: about one byte each) or bytes as a short size for an
 *  error message. */
export function formatSize(count: number, unit: 'characters' | 'bytes' = 'characters'): string {
  if (count >= 1024 * 1024) return `${Math.round(count / (1024 * 1024))} MB`;
  if (count >= 1024) return `${Math.round(count / 1024)} KB`;
  return `${count} ${unit}`;
}

/**
 * Async line iterator over a readable stream of UTF-8 NDJSON — one trimmed,
 * non-empty line per yield. Shared by every stdout/stdin-JSONL runner
 * (the claude CLI's stream-json and codex app-server's JSON-RPC transport).
 *
 * A partial line is kept as a list of chunks and joined once, when its line end arrives, so the
 * reader never builds a string longer than the line itself. A line that grows past `maxLineChars`
 * throws `NdjsonLineTooLongError` before any string that long is built (#942).
 */
export async function* readNdjson(
  stream: NodeJS.ReadableStream,
  maxLineChars: number = MAX_NDJSON_LINE_CHARS,
): AsyncGenerator<string> {
  stream.setEncoding('utf8');
  let pending: string[] = [];
  let pendingChars = 0;
  for await (const chunk of stream as AsyncIterable<string>) {
    let start = 0;
    let idx: number;
    while ((idx = chunk.indexOf('\n', start)) >= 0) {
      const segmentChars = idx - start;
      if (pendingChars + segmentChars > maxLineChars) {
        throw new NdjsonLineTooLongError(pendingChars + segmentChars, maxLineChars);
      }
      const segment = chunk.slice(start, idx);
      const line = (pendingChars === 0 ? segment : pending.join('') + segment).trim();
      pending = [];
      pendingChars = 0;
      start = idx + 1;
      if (line) yield line;
    }
    if (start < chunk.length) {
      pendingChars += chunk.length - start;
      if (pendingChars > maxLineChars) throw new NdjsonLineTooLongError(pendingChars, maxLineChars);
      pending.push(start === 0 ? chunk : chunk.slice(start));
    }
  }
  const tail = pending.join('').trim();
  if (tail) yield tail;
}
