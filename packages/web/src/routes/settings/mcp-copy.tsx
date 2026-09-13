import type { ReactNode } from 'react'

/**
 * Copy with `backticked` names, rendered as `<code>` instead of literal backticks (#301, C1).
 * The backtick is spelled `\x60`: the design guardian does not lex regex literals, and a literal
 * backtick there opens a template string that hides every later comment from its stripper.
 *
 * `words` are names to render as code even where the text does not backtick them — server copy the
 * cockpit shows verbatim, such as the decision record's "Use leader_events in Codex" (design review
 * NB-3 on #403). A word inside a backticked span is already code and is left alone.
 */
export function withCode(text: string, words: readonly string[] = []): ReactNode {
  const bare = words.length ? new RegExp(`\\b(${words.map(escapeRegExp).join('|')})\\b`) : null
  return text.split(/\x60([^\x60]+)\x60/).map((part, i) =>
    i % 2 ? (
      <code key={i} className="font-mono break-words">
        {part}
      </code>
    ) : bare ? (
      part.split(bare).map((piece, j) =>
        j % 2 ? (
          <code key={`${i}-${j}`} className="font-mono break-words">
            {piece}
          </code>
        ) : (
          piece
        ),
      )
    ) : (
      part
    ),
  )
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
