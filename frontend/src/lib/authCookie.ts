// Frontend-domain "auth hint" cookie. The real refresh_token cookie is HttpOnly
// and set by the Railway backend on its own domain, so the Next.js middleware
// running on Vercel cannot see it. This non-HttpOnly hint cookie is written on
// the frontend origin after a successful login so middleware can gate routes.
//
// It is NOT a security boundary — every authenticated API call still requires
// a valid access token + refresh token. The hint only controls client-side
// routing UX.

const COOKIE_NAME = 'rupchain_auth'
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60 // 7 days, matches refresh-token lifetime

export function setAuthHint(): void {
  if (typeof document === 'undefined') return
  const isSecure = typeof location !== 'undefined' && location.protocol === 'https:'
  const parts = [
    `${COOKIE_NAME}=1`,
    'Path=/',
    `Max-Age=${MAX_AGE_SECONDS}`,
    'SameSite=Lax',
  ]
  if (isSecure) parts.push('Secure')
  document.cookie = parts.join('; ')
}

export function clearAuthHint(): void {
  if (typeof document === 'undefined') return
  const isSecure = typeof location !== 'undefined' && location.protocol === 'https:'
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'SameSite=Lax',
  ]
  if (isSecure) parts.push('Secure')
  document.cookie = parts.join('; ')
}

export const AUTH_HINT_COOKIE = COOKIE_NAME
