import type { ReactNode } from 'react'

/**
 * Telegram-style lightweight text formatting for channel broadcasts:
 * **bold**, __underline__, a leading "> " on a line for a quote, and raw
 * URLs auto-linked. Deliberately NOT full markdown/HTML — every token is
 * built as a React element from the plain string, so there is no HTML
 * string ever parsed and no XSS surface (React escapes all text content).
 */

const TOKEN_RE = /(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(https?:\/\/[^\s<>"')]+)/g

function renderLineTokens(line: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let i = 0
  for (const match of line.matchAll(TOKEN_RE)) {
    const [token] = match
    const start = match.index ?? 0
    if (start > lastIndex) nodes.push(line.slice(lastIndex, start))
    if (token.startsWith('**')) {
      nodes.push(<strong key={`${keyPrefix}-${i++}`}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('__')) {
      nodes.push(<span key={`${keyPrefix}-${i++}`} className="underline">{token.slice(2, -2)}</span>)
    } else {
      nodes.push(
        <a
          key={`${keyPrefix}-${i++}`}
          href={token}
          target="_blank"
          rel="noopener noreferrer"
          className="underline break-all"
          onClick={(e) => e.stopPropagation()}
        >
          {token}
        </a>,
      )
    }
    lastIndex = start + token.length
  }
  if (lastIndex < line.length) nodes.push(line.slice(lastIndex))
  return nodes
}

/** Renders a channel message body as React nodes — safe to drop straight into JSX.
 *  Each line is its own block element (a quote line becomes a <blockquote>) so
 *  lines stack naturally with no <br> needed, and no inline element ever ends up
 *  wrapping a block one (invalid HTML → hydration mismatch). */
export function renderChannelText(body: string): ReactNode {
  const lines = body.split('\n')
  return lines.map((line, idx) => {
    const isQuote = line.startsWith('> ')
    const content = renderLineTokens(isQuote ? line.slice(2) : line, `l${idx}`)
    return isQuote ? (
      <blockquote key={idx} className="border-l-2 border-current/40 pl-2 italic opacity-90">
        {content.length ? content : ' '}
      </blockquote>
    ) : (
      <div key={idx}>{content.length ? content : ' '}</div>
    )
  })
}
