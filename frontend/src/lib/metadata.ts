import type { Metadata } from 'next'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rupchain.com'

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
      // Use the dynamic /opengraph-image route (renders the R+chain badge brand
      // mark) — the old static /og-image.png never existed, so shares 404'd.
      images: [{ url: `${BASE_URL}/opengraph-image`, width: 1200, height: 630 }],
    },
    twitter: { card: 'summary_large_image', title, description },
    alternates: { canonical: url },
  }
}
