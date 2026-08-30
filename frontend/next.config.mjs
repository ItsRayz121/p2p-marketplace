import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Stub out optional/Node-only deps that wagmi/WalletConnect import but
  // must not be bundled in the browser.
  //
  // 'ws'               — Node WebSocket used by isows; browser uses native WebSocket
  // '@wagmi/core/tempo' — internal subpath in newer @wagmi/core, not present in
  //                       the installed version; appkit-adapter-wagmi references it
  // 'pino-pretty'      — WalletConnect logger prettifier (Node only)
  // 'porto/internal'   — Porto wallet internal (optional connector)
  // accounts/lokijs/encoding — other optional peer deps
  webpack: (config) => {
    config.resolve = config.resolve || {}

    config.resolve.fallback = {
      ...(config.resolve.fallback || {}),
      'pino-pretty': false,
      'porto/internal': false,
      accounts: false,
      lokijs: false,
      encoding: false,
      ws: false,
    }

    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      '@wagmi/core/tempo': path.resolve(__dirname, 'src/lib/web3/empty-module.js'),
    }

    return config
  },

  // API proxy — in development, proxies /api/* to backend to avoid CORS on localhost.
  // In production, NEXT_PUBLIC_API_URL is the full Railway backend URL; frontend calls it directly.
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return []
    const backendUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
    ]
  },

  // Security headers
  async headers() {
    // Deliberately permissive where third parties are involved (wallet libs,
    // PostHog, Telegram, token-logo CDNs) — tighten directives one at a time
    // after launch with monitoring. Still blocks the big wins: foreign
    // <script src>, <object>, base hijacking, and plugin content.
    const csp = [
      "default-src 'self'",
      // 'unsafe-inline': Next.js inline runtime + theme/telegram boot scripts + JSON-LD.
      // 'unsafe-eval': required by some WalletConnect/wagmi builds.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com https://telegram.org https://*.telegram.org https://us-assets.i.posthog.com https://www.googletagmanager.com https://www.google-analytics.com https://widget.trustpilot.com",
      "style-src 'self' 'unsafe-inline'",
      // Token/chain logos come from many CDNs (see images.remotePatterns) — allow https broadly for img only.
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      // Backend API (Railway), PostHog, WalletConnect relays (wss), RPC endpoints.
      "connect-src 'self' https: wss:",
      "media-src 'self' blob: https://res.cloudinary.com",
      "worker-src 'self' blob:",
      // Blog video embeds must mirror ALLOWED_IFRAME_HOSTNAMES in
      // backend/src/services/blog.service.ts — the sanitiser strips any iframe
      // off that list, and this CSP blocks any host missing from this one. Both
      // lists have to allow a host for an embed to render. Keep them in sync.
      "frame-src https://challenges.cloudflare.com https://verify.walletconnect.com https://verify.walletconnect.org https://www.youtube.com https://youtube.com https://www.youtube-nocookie.com https://youtube-nocookie.com https://player.vimeo.com https://drive.google.com https://t.me https://widget.trustpilot.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')

    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Content-Security-Policy', value: csp },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          // camera/microphone: self — KYC selfie + video capture use getUserMedia
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=(), payment=()' },
        ],
      },
    ]
  },

  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.amazonaws.com' },
      { protocol: 'https', hostname: 'assets.coingecko.com' },
      { protocol: 'https', hostname: 'coin-images.coingecko.com' },
      { protocol: 'https', hostname: 'raw.githubusercontent.com' },
      { protocol: 'https', hostname: 'cryptologos.cc' },
      { protocol: 'https', hostname: '*.cloudfront.net' },
      // TrustWallet CDN — chain/token logo fallbacks
      { protocol: 'https', hostname: 'assets.trustwallet.com' },
      // Payment method logos
      { protocol: 'https', hostname: 'icon.horse' },
      { protocol: 'https', hostname: 't2.gstatic.com' },
      { protocol: 'https', hostname: 'cdn.worldvectorlogo.com' },
    ],
  },
}

export default nextConfig
