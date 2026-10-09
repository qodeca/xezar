/**
 * Whether `content` already holds `line` as one of its lines. Lines split on LF or CRLF and compare
 * trimmed, so a file saved with Windows line endings (or by an editor that added trailing spaces)
 * still counts as containing the line, and an append-once writer does not add it again on every run.
 */
export function hasLine(content: string, line: string): boolean {
  return content.split(/\r?\n/).some((existing) => existing.trim() === line);
}
