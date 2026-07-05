import { NextRequest, NextResponse } from 'next/server'

// Routes that require authentication
const AUTH_REQUIRED = [
  '/dashboard',
  '/trade',
  '/wallet',
  '/profile',
  '/settings',
  '/setup-username',
  '/kyc',
  '/orders',
  '/payment-methods',
  '/my-ads',
  '/create-ad',
  '/notifications',
  '/referral',
  '/ctm',
  '/gas/orders',
]

// Routes that require admin role — handled server-side too, this is UX-only
const ADMIN_REQUIRED = ['/admin']

// Routes accessible only when NOT logged in (redirect to dashboard if authed)
const GUEST_ONLY = ['/login', '/register', '/forgot-password', '/verify-email']

// Social link-preview crawlers (Telegram, WhatsApp, X, Facebook, Slack,
// Discord, LinkedIn, etc.). They don't run JS — they only read the server HTML
// <head>. We let them past the auth gate on otherwise-gated routes (e.g. /ctm
// listings) so a shared trade link unfurls into its rich Open Graph card.
const CRAWLER_UA =
  /(bot|crawl|spider|facebookexternalhit|telegrambot|whatsapp|twitterbot|slackbot|discordbot|linkedinbot|embedly|quora link preview|pinterest|redditbot|skypeuripreview|vkshare|W3C_Validator|preview)/i

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // File-based metadata image routes must always be reachable (even on gated
  // segments) so crawlers can fetch the generated card. They expose no private
  // data — the underlying listing endpoints are public.
  if (pathname.includes('/opengraph-image') || pathname.includes('/twitter-image')) {
    return NextResponse.next()
  }

  const isCrawler = CRAWLER_UA.test(request.headers.get('user-agent') ?? '')

  // Auth presence is read from the frontend-domain hint cookie set after a
  // successful login. The real refresh_token is HttpOnly and set by the
  // backend on its own (Railway) origin, so the Vercel-side middleware can't
  // see it. Each protected backend route still validates the JWT — the hint
  // cookie only controls client-side route gating.
  // The hint cookie value carries a coarse role: "admin" for staff, "1" for
  // regular users. Routing UX only — the real role is enforced server-side.
  const authHint = request.cookies.get('rupchain_auth')?.value
  const hasAuthHint = !!authHint
  const isAdminHint = authHint === 'admin'

  const requiresAuth = AUTH_REQUIRED.some((p) => pathname.startsWith(p))
  const requiresAdmin = ADMIN_REQUIRED.some((p) => pathname.startsWith(p))
  const isGuestOnly = GUEST_ONLY.some((p) => pathname.startsWith(p))

  // Staff opening the bare homepage drop straight into the admin panel — no
  // "logged in as a user" detour. Only "/" is redirected, so admins can still
  // reach the user side by navigating to /dashboard, /marketplace, etc.
  if (pathname === '/' && isAdminHint) {
    return NextResponse.redirect(new URL('/admin', request.url))
  }

  if (requiresAdmin && !hasAuthHint) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  if (requiresAuth && !hasAuthHint && !isCrawler) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('redirect', pathname)
    // Preserve a shared trade link's referral code across the auth gate (e.g. a
    // brand-new visitor opening /ctm/listings/<id>?ref=<code>) so signup still
    // attributes them to the sharer.
    const ref = request.nextUrl.searchParams.get('ref')
    if (ref) loginUrl.searchParams.set('ref', ref)
    return NextResponse.redirect(loginUrl)
  }

  if (isGuestOnly && hasAuthHint) {
    return NextResponse.redirect(new URL(isAdminHint ? '/admin' : '/dashboard', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|manifest.json|icons|.*\\.png$).*)',
  ],
}
