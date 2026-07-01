// Server-side pass over stored blog HTML: assign stable `id`s to every h2/h3 so
// the "On this page" table of contents can deep-link and the scroll-spy can
// observe them, and return the flat heading list the TOC renders. Runs in the
// RSC (no DOM), so it's plain string work — deliberately conservative regex over
// a full HTML parser, which is fine for the tight tag set the TipTap editor emits.

export interface TocHeading {
  id: string
  text: string
  level: 2 | 3
}

function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'section'
  )
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Inject ids into the article's h2/h3 tags and extract the TOC. Existing `id`
 * attributes are preserved; generated ids are de-duplicated with a numeric
 * suffix. Returns the rewritten HTML plus the ordered heading list.
 */
export function extractHeadings(bodyHtml: string): { html: string; headings: TocHeading[] } {
  const headings: TocHeading[] = []
  const used = new Set<string>()

  const html = bodyHtml.replace(
    /<h([23])\b([^>]*)>([\s\S]*?)<\/h\1>/g,
    (_full, levelStr: string, attrs: string, inner: string) => {
      const level = Number(levelStr) as 2 | 3
      const text = stripTags(inner)
      if (!text) return _full // skip empty headings entirely

      // Reuse an author-supplied id if present; otherwise derive + de-dupe.
      const existing = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)
      let id = existing?.[1] ?? slugifyHeading(text)
      if (!existing) {
        let candidate = id
        let n = 2
        while (used.has(candidate)) candidate = `${id}-${n++}`
        id = candidate
      }
      used.add(id)
      headings.push({ id, text, level })

      const attrsWithId = existing ? attrs : `${attrs} id="${id}"`
      return `<h${level}${attrsWithId}>${inner}</h${level}>`
    },
  )

  return { html, headings }
}
