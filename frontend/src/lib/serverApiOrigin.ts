// The origin server-side rendering uses to reach the backend.
//
// This is deliberately NOT the same value the browser uses. The browser talks to
// the public, Cloudflare-fronted host (NEXT_PUBLIC_API_URL, e.g.
// api.rupchain.com). Server rendering runs inside Vercel's datacenter, so
// sending it through Cloudflare adds a pointless extra CDN hop to the render
// path — and worse, Cloudflare bot protection can block server-to-server calls
// coming from Vercel IPs, which makes SSR silently render empty states while the
// browser works fine.
//
// Set BACKEND_ORIGIN_URL (server-only — NOT NEXT_PUBLIC_) to the backend's raw
// origin, e.g. the *.up.railway.app URL, so SSR talks to Railway directly.
// Falls back to the public URL when unset, so existing deployments keep working.
function normaliseOrigin(raw: string): string {
  let v = raw.trim().replace(/\/$/, '')
  // Tolerate a bare host ("foo.up.railway.app") — fetch needs an absolute URL.
  if (v && !/^https?:\/\//i.test(v)) v = `https://${v}`
  return v
}

/** Backend origin for server-side fetches. Never import this into client code. */
export const SERVER_API_ORIGIN = normaliseOrigin(
  process.env.BACKEND_ORIGIN_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001',
)

/** True when SSR is bypassing the public Cloudflare host. Server logs only. */
export const USING_ORIGIN_OVERRIDE = !!process.env.BACKEND_ORIGIN_URL
