// Always renders the Terminal homepage, whatever the `home_terminal_enabled`
// flag says — so the new design can be checked on the live site (with live
// data) before switching the real homepage over. Not indexed.
export const revalidate = 60

import type { Metadata } from 'next'
import { SERVER_API_ORIGIN } from '@/lib/serverApiOrigin'
import { TerminalHome } from '../../_components/home/terminal/TerminalHome'
import { getTerminalData } from '../../_components/home/terminal/terminalData'

export const metadata: Metadata = {
  title: 'Homepage preview — Terminal',
  robots: { index: false, follow: false },
}

async function getFaqs(): Promise<{ question: string; answer: string }[]> {
  try {
    const res = await fetch(`${SERVER_API_ORIGIN}/api/v1/marketplace/config`, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return []
    const body = await res.json() as { data?: { homeFaqs?: unknown } }
    return Array.isArray(body.data?.homeFaqs) ? (body.data!.homeFaqs as { question: string; answer: string }[]) : []
  } catch {
    return []
  }
}

export default async function HomeTerminalPreviewPage() {
  const [data, faqs] = await Promise.all([getTerminalData(), getFaqs()])
  return <TerminalHome data={data} faqs={faqs} />
}
