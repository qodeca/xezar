/**
 * The end of a child's stderr, bounded. A runner reads stderr only for the last few lines of a
 * failure message, but a session can live for hours and a chatty CLI writes megabytes there; the
 * runners used to keep every chunk. This keeps at most `maxChars` characters – the newest – so
 * the failure detail reads the same and memory stays flat.
 */

/** Characters kept: far more than the three lines a failure message quotes. */
export const STDERR_TAIL_CHARS = 64 * 1024;

export class StderrTail {
  private tail = '';

  constructor(private readonly maxChars: number = STDERR_TAIL_CHARS) {}

  push(chunk: string): void {
    const next = this.tail + chunk;
    this.tail = next.length > this.maxChars ? next.slice(next.length - this.maxChars) : next;
  }

  /** Everything kept, as `chunks.join('')` would have read for output within the bound. */
  text(): string {
    return this.tail;
  }
}
