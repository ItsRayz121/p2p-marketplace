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

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Auth presence is read from the frontend-domain hint cookie set after a
  // successful login. The real refresh_token is HttpOnly and set by the
  // backend on its own (Railway) origin, so the Vercel-side middleware can't
  // see it. Each protected backend route still validates the JWT — the hint
  // cookie only controls client-side route gating.
  const hasAuthHint = request.cookies.has('rupchain_auth')

  const requiresAuth = AUTH_REQUIRED.some((p) => pathname.startsWith(p))
  const requiresAdmin = ADMIN_REQUIRED.some((p) => pathname.startsWith(p))
  const isGuestOnly = GUEST_ONLY.some((p) => pathname.startsWith(p))

  if (requiresAdmin && !hasAuthHint) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  if (requiresAuth && !hasAuthHint) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }

  if (isGuestOnly && hasAuthHint) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|manifest.json|icons|.*\\.png$).*)',
  ],
}
