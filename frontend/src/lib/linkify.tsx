import { Fragment, type ReactNode } from 'react'
import Link from 'next/link'

/**
 * Safe auto-linking for chat text. Everything is built as React elements from the
 * plain string (never innerHTML), and only http(s) URLs are ever linked — so
 * `javascript:`, `data:` and friends can never become an href.
 *
 *  - Platform links (rupchain.com, www.rupchain.com — with or without a scheme) are
 *    routed client-side through next/link as a same-origin path.
 *  - Any other http(s) URL opens in a new tab with noopener/noreferrer.
 *  - Trailing sentence punctuation / closing brackets are kept OUT of the link.
 */

const PLATFORM_HOSTS = new Set(['rupchain.com', 'www.rupchain.com'])

// scheme-ful URLs, or a bare platform domain (rupchain.com/…). The tail excludes
// whitespace and angle brackets; trailing punctuation is trimmed afterwards.
const URL_RE = /(https?:\/\/[^\s<>"]+|(?<![@\w./-])(?:www\.)?rupchain\.com(?:\/[^\s<>"]*)?)/gi

const TRAILING_PUNCT = /[.,;:!?'")\]}>]/

function trimTrailing(raw: string): { url: string; rest: string } {
  let url = raw
  let rest = ''
  while (url.length > 0) {
    const c = url[url.length - 1]!
    if (!TRAILING_PUNCT.test(c)) break
    // Keep a closing bracket that balances an opener inside the URL, e.g. wiki/Foo_(bar)
    if (c === ')' && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break
    url = url.slice(0, -1)
    rest = c + rest
  }
  return { url, rest }
}

export type ParsedLink = { href: string; internal: boolean; path?: string }

/** Validate a candidate and decide how to link it. Returns null if it must not be linked. */
export function parseChatUrl(candidate: string): ParsedLink | null {
  const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`
  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password) return null // user:pass@host — classic phishing disguise
  if (PLATFORM_HOSTS.has(u.hostname.toLowerCase())) {
    return { href: u.href, internal: true, path: `${u.pathname}${u.search}${u.hash}` || '/' }
  }
  return { href: u.href, internal: false }
}

export function linkifyText(text: string, keyPrefix: string, linkClassName = 'underline break-all'): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0
    const { url, rest } = trimTrailing(m[0])
    const parsed = url ? parseChatUrl(url) : null
    if (!parsed) continue
    if (start > last) out.push(text.slice(last, start))
    const key = `${keyPrefix}-lnk-${n++}`
    out.push(
      parsed.internal ? (
        <Link key={key} href={parsed.path!} className={linkClassName} onClick={(e) => e.stopPropagation()}>
          {url}
        </Link>
      ) : (
        <a
          key={key}
          href={parsed.href}
          target="_blank"
          rel="noopener noreferrer nofollow ugc"
          className={linkClassName}
          onClick={(e) => e.stopPropagation()}
        >
          {url}
        </a>
      ),
    )
    if (rest) out.push(rest)
    last = start + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out.length ? out : [text]
}

/** Convenience wrapper for places that just want a fragment. */
export function Linkified({ text, className }: { text: string; className?: string }) {
  return <Fragment>{linkifyText(text, 'lk', className)}</Fragment>
}
