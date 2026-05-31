import type { MetadataRoute } from 'next'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rupchain.pk'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: [
          '/',
          '/marketplace',
          '/marketplace/listings/',
          '/gas',
          '/ctm',
          '/ctm/tokens/',
          '/instant-buy',
          '/register',
          '/login',
          '/fees',
          '/about',
          '/terms',
          '/privacy',
          '/help',
          '/leaderboard',
          '/merchant/',
        ],
        disallow: [
          '/dashboard',
          '/wallet',
          '/orders',
          '/trade/',
          '/kyc',
          '/settings',
          '/my-ads',
          '/notifications',
          '/referral',
          '/ctm/dashboard',
          '/ctm/my-',
          '/ctm/incoming-',
          '/admin/',
          '/gas/orders',
          '/instant-buy/payment/',
          '/instant-buy/status/',
          '/instant-buy/crypto-deposit/',
          '/confirm-withdrawal',
          '/2fa',
          '/setup-username',
        ],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
  }
}
