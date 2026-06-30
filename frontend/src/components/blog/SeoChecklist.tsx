'use client'

import { useMemo } from 'react'
import { cn } from '@/lib/utils'

type Status = 'good' | 'warn' | 'bad'
interface Check { label: string; status: Status; hint?: string }

interface Props {
  title: string
  slug: string
  excerpt: string
  bodyHtml: string
  metaTitle: string
  metaDescription: string
  focusKeyword: string
  coverImageUrl: string
}

/**
 * Deterministic, real-time on-page SEO checklist. Every item is computed
 * directly from the current content — there is NO AI guessing, so nothing here
 * is ever a "maybe". Updates live as the author types.
 */
export function SeoChecklist(props: Props) {
  const { checks, score } = useMemo(() => analyse(props), [props])

  const tone = score >= 80 ? 'text-success' : score >= 50 ? 'text-warning' : 'text-rose-500'
  const bar = score >= 80 ? 'bg-success' : score >= 50 ? 'bg-warning' : 'bg-rose-500'

  return (
    <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold text-text-primary">SEO check</span>
        <span className={cn('text-sm font-bold', tone)}>{score}%</span>
      </div>
      <div className="h-1.5 w-full bg-surface-alt rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', bar)} style={{ width: `${score}%` }} />
      </div>
      <ul className="space-y-1.5">
        {checks.map((c) => (
          <li key={c.label} className="flex items-start gap-2 text-xs">
            <span
              className={cn(
                'mt-1 w-2 h-2 rounded-full shrink-0',
                c.status === 'good' ? 'bg-success' : c.status === 'warn' ? 'bg-warning' : 'bg-rose-500',
              )}
            />
            <span className="text-text-secondary">
              {c.label}
              {c.hint && c.status !== 'good' && <span className="text-text-muted"> — {c.hint}</span>}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[10px] text-text-muted leading-snug">Factual checks only — computed from your content, never guessed.</p>
    </div>
  )
}

function analyse(p: Props): { checks: Check[]; score: number } {
  const kw = p.focusKeyword.trim().toLowerCase()
  const hasKw = kw.length > 0

  // Parse the rich HTML in the browser for accurate structure reads.
  let text = '', firstPara = '', headings: string[] = [], imgCount = 0, imgsNoAlt = 0, linkCount = 0
  if (typeof window !== 'undefined' && window.DOMParser) {
    const doc = new DOMParser().parseFromString(p.bodyHtml || '', 'text/html')
    text = (doc.body.textContent || '').trim()
    firstPara = (doc.querySelector('p')?.textContent || '').toLowerCase()
    headings = Array.from(doc.querySelectorAll('h2, h3')).map((h) => (h.textContent || '').toLowerCase())
    const imgs = Array.from(doc.querySelectorAll('img'))
    imgCount = imgs.length
    imgsNoAlt = imgs.filter((i) => !(i.getAttribute('alt') || '').trim()).length
    linkCount = doc.querySelectorAll('a').length
  }
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0
  const inc = (hay: string, needle: string) => hay.toLowerCase().includes(needle)

  const effTitle = (p.metaTitle || p.title).trim()
  const effDesc = (p.metaDescription || p.excerpt).trim()

  const checks: Check[] = [
    {
      label: 'Focus keyword set',
      status: hasKw ? 'good' : 'warn',
      hint: 'add a target phrase to unlock keyword checks',
    },
    {
      label: 'Keyword in title',
      status: !hasKw ? 'warn' : inc(effTitle, kw) ? 'good' : 'bad',
      hint: 'include the focus keyword in the title',
    },
    {
      label: 'Keyword in first paragraph',
      status: !hasKw ? 'warn' : firstPara && inc(firstPara, kw) ? 'good' : 'bad',
      hint: 'mention it early in the article',
    },
    {
      label: 'Keyword in a subheading',
      status: !hasKw ? 'warn' : headings.some((h) => inc(h, kw)) ? 'good' : 'warn',
      hint: 'use it in an H2/H3',
    },
    {
      label: 'Keyword in URL slug',
      status: !hasKw ? 'warn' : inc(p.slug, kw.replace(/\s+/g, '-')) ? 'good' : 'warn',
      hint: 'the slug should contain the keyword',
    },
    {
      label: `Title length (${effTitle.length}/60)`,
      status: effTitle.length === 0 ? 'bad' : effTitle.length >= 30 && effTitle.length <= 60 ? 'good' : 'warn',
      hint: 'aim for 30–60 characters',
    },
    {
      label: `Meta description (${effDesc.length}/160)`,
      status: effDesc.length === 0 ? 'bad' : effDesc.length >= 120 && effDesc.length <= 160 ? 'good' : 'warn',
      hint: 'aim for 120–160 characters',
    },
    {
      label: `Content length (${words} words)`,
      status: words >= 600 ? 'good' : words >= 300 ? 'warn' : 'bad',
      hint: 'longer, useful articles rank better (300+ min, 600+ ideal)',
    },
    {
      label: 'Has subheadings',
      status: headings.length >= 2 ? 'good' : headings.length === 1 ? 'warn' : 'bad',
      hint: 'break content up with H2/H3 headings',
    },
    {
      label: 'Has an image',
      status: imgCount > 0 || p.coverImageUrl ? 'good' : 'warn',
      hint: 'add a cover or in-article image',
    },
    {
      label: 'All images have alt text',
      status: imgCount === 0 ? 'good' : imgsNoAlt === 0 ? 'good' : 'bad',
      hint: `${imgsNoAlt} image(s) missing alt text`,
    },
    {
      label: 'Has a link',
      status: linkCount > 0 ? 'good' : 'warn',
      hint: 'link to a related page or source',
    },
  ]

  const score = Math.round((checks.filter((c) => c.status === 'good').length / checks.length) * 100)
  return { checks, score }
}
