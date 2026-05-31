import type { Metadata } from 'next'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rupchain.pk'

export function buildMeta(
  title: string,
  description: string,
  path = '',
): Metadata {
  const url = `${BASE_URL}${path}`
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url,
      siteName: 'RupChain',
      images: [{ url: '/og-image.png', width: 1200, height: 630 }],
    },
    twitter: { card: 'summary_large_image', title, description },
    alternates: { canonical: url },
  }
}
