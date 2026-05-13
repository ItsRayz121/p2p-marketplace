import { NextRequest, NextResponse } from 'next/server'

// Routes that require authentication
const AUTH_REQUIRED = [
  '/dashboard',
  '/trade',
  '/wallet',
  '/profile',
  '/settings',
  '/merchant',
  '/instant-buy',
  '/setup-username',
]

// Routes that require admin role — handled server-side too, this is UX-only
const ADMIN_REQUIRED = ['/admin']

// Routes accessible only when NOT logged in (redirect to dashboard if authed)
const GUEST_ONLY = ['/login', '/register', '/forgot-password', '/verify-email']

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Read auth state from the presence of the refresh token cookie
  // The actual JWT validation happens server-side in each route handler
  const hasRefreshToken = request.cookies.has('refresh_token')

  const requiresAuth = AUTH_REQUIRED.some((p) => pathname.startsWith(p))
  const requiresAdmin = ADMIN_REQUIRED.some((p) => pathname.startsWith(p))
  const isGuestOnly = GUEST_ONLY.some((p) => pathname.startsWith(p))

  if (requiresAdmin && !hasRefreshToken) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  if (requiresAuth && !hasRefreshToken) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }

  if (isGuestOnly && hasRefreshToken) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|manifest.json|icons|.*\\.png$).*)',
  ],
}
