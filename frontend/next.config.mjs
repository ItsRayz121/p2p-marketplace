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
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
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
    ],
  },
}

export default nextConfig
