/** @type {import('next').NextConfig} */
const nextConfig = {
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
      {
        protocol: 'https',
        hostname: '*.amazonaws.com',
      },
    ],
  },
}

export default nextConfig
