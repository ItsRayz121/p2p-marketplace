'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

/**
 * Sidebar call-to-action that rotates across RupChain's surfaces so the same
 * post doesn't always push one product. The starting card is randomised per
 * page load (a first-time visitor might see USDT, the next sees Community
 * Tokens), then it cycles every ~12s with a soft fade. Purely presentational —
 * no tracking, no persistence.
 */

interface Promo {
  key: string
  title: string
  body: string
  cta: string
  href: string
}

const PROMOS: Promo[] = [
  {
    key: 'usdt',
    title: 'Trade USDT the safe way',
    body: 'KYC-verified traders, on-chain proof, and dispute protection — buy & sell with JazzCash, Easypaisa & bank.',
    cta: 'Get started free',
    href: '/register',
  },
  {
    key: 'ctm',
    title: 'Discover Community Tokens',
    body: 'Buy & sell community-listed tokens P2P with the same KYC checks, on-chain proof, and dispute protection.',
    cta: 'Explore tokens',
    href: '/ctm',
  },
  {
    key: 'gas',
    title: 'Top up gas in seconds',
    body: 'Pay in USD or PKR via JazzCash or Easypaisa and get gas delivered straight to your wallet.',
    cta: 'Buy gas fees',
    href: '/gas',
  },
]

const ROTATE_MS = 12_000

export function BlogPromoCard() {
  // Random start so the featured card differs across visits/pages. Chosen once
  // on mount to keep SSR/first paint deterministic (index 0) and avoid hydration
  // mismatch, then advanced on the client.
  const [index, setIndex] = useState(0)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    setIndex(Math.floor(Math.random() * PROMOS.length))
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => {
      setVisible(false)
      window.setTimeout(() => {
        setIndex((i) => (i + 1) % PROMOS.length)
        setVisible(true)
      }, 300)
    }, ROTATE_MS)
    return () => window.clearInterval(id)
  }, [])

  const promo = PROMOS[index]!

  return (
    <div className="rounded-xl border border-border bg-gradient-to-br from-slate-900 to-blue-950 p-5 text-white">
      <div className={`transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0'}`}>
        <p className="text-sm font-bold">{promo.title}</p>
        <p className="mt-1 text-xs text-slate-300">{promo.body}</p>
        <Link
          href={promo.href}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-bold text-white transition-colors hover:bg-primary-hover"
        >
          {promo.cta} <ArrowRight size={15} />
        </Link>
      </div>
    </div>
  )
}
