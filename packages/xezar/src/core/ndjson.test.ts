import { constants } from 'node:buffer';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MAX_NDJSON_LINE_CHARS, NdjsonLineTooLongError, readNdjson } from './ndjson.ts';

/** A stand-in for a child's stdout that yields the given string chunks as they are. */
function chunks(parts: Iterable<string>): NodeJS.ReadableStream {
  return {
    setEncoding: () => undefined,
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield part;
    },
  } as unknown as NodeJS.ReadableStream;
}

async function collect(stream: NodeJS.ReadableStream, max?: number): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of readNdjson(stream, max)) lines.push(line);
  return lines;
}

describe('readNdjson', () => {
  it('yields trimmed, non-empty lines across chunk boundaries, and the unterminated tail', async () => {
    expect(await collect(chunks(['{"a":', '1}\n\n  {"b":2}  \r\n{"c"', ':3}\n{"d":4}']))).toEqual([
      '{"a":1}',
      '{"b":2}',
      '{"c":3}',
      '{"d":4}',
    ]);
  });

  it('reads a real utf8 stream, multi-byte characters split across writes included', async () => {
    const stream = new PassThrough();
    const bytes = Buffer.from('{"t":"zażółć"}\n{"t":"ok"}\n', 'utf8');
    stream.write(bytes.subarray(0, 9));
    stream.end(bytes.subarray(9));
    expect(await collect(stream)).toEqual(['{"t":"zażółć"}', '{"t":"ok"}']);
  });

  it('reads a line exactly at the limit, as it always has', async () => {
    expect(await collect(chunks(['x'.repeat(6), 'y'.repeat(4), '\n']), 10)).toEqual(['xxxxxxyyyy']);
  });

  it('refuses a line past the limit with its size, not a RangeError (#942)', async () => {
    const error = await collect(chunks(['x'.repeat(6), 'y'.repeat(6), '\n{"after":1}\n']), 10)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(NdjsonLineTooLongError);
    expect((error as NdjsonLineTooLongError).chars).toBe(12);
    expect((error as NdjsonLineTooLongError).limit).toBe(10);
    expect((error as Error).message).toBe('one message larger than xezar can read (at least 12 characters; the limit is 10 characters)');
  });

  it('uses the runtime string ceiling as its default limit', () => {
    expect(MAX_NDJSON_LINE_CHARS).toBe(constants.MAX_STRING_LENGTH);
  });

  /**
   * The reported failure, at its real size: one message above the runtime's string ceiling
   * (a `thread/resume` response that carries a whole long Codex history). The chunks are one
   * shared string, so the fixed reader holds references, not copies; the old `buffer += chunk`
   * reader died here with `RangeError: Invalid string length`.
   */
  it('refuses a message above the runtime string ceiling with a readable error (#942)', async () => {
    const piece = 'x'.repeat(128 * 1024 * 1024);
    const count = Math.ceil(constants.MAX_STRING_LENGTH / piece.length) + 1;
    const error = await collect(chunks(Array.from({ length: count }, () => piece))).catch((err: unknown) => err);
    expect((error as Error).message).toMatch(/^one message larger than xezar can read \(at least \d+ MB; the limit is 512 MB\)$/);
    expect(error).toBeInstanceOf(NdjsonLineTooLongError);
  }, 60_000);
});
