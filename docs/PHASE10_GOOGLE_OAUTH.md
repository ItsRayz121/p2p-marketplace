# Phase 10 — Google Authentication: findings + fixes + required config

## What I changed in code (shipped)
1. **`/api/v1/auth/google` no longer dead-ends on raw JSON.** When Google env vars are
   missing it now redirects to `/login?error=google_not_configured` (friendly message)
   instead of returning a 503 JSON blob.
2. **Login page now surfaces Google errors.** The backend OAuth callback redirects
   failures to `/login?error=<code>`, but the login page previously only read
   `googleError` — so real Google failures showed *nothing* (looked like a silent
   hang). It now maps `error` codes (`google_failed`, `google_cancelled`,
   `account_suspended`, `google_not_configured`) to readable messages.
3. (Phase 1) Banned/suspended Google users are redirected to `/account/restricted`
   with an appeal token instead of throwing.

## Code flow (verified correct)
- `/auth/google` → builds the consent URL with `redirect_uri = GOOGLE_CALLBACK_URL`.
- `/auth/google/callback` → exchanges the code using the **same** `GOOGLE_CALLBACK_URL`,
  fetches the profile, upserts the user, sets the `refresh_token` cookie
  (`httpOnly; SameSite=None; Secure` in production), redirects to
  `/auth/google/success?token=…`.
- `/auth/google/success` → stores the access token, calls `/auth/me`, sets the
  `rupchain_auth` hint cookie (via `setUser`), routes to dashboard/admin.

The cookie options and redirect-URI wiring are correct. The remaining failure modes
are **configuration**, not code.

## ✅ What YOU must verify (Google Cloud Console + Railway) — this is the likely cause

### Railway (backend env vars)
- `GOOGLE_CLIENT_ID` — set, matches the OAuth client.
- `GOOGLE_CLIENT_SECRET` — set.
- `GOOGLE_CALLBACK_URL` — **must exactly equal** the production callback, e.g.
  `https://<your-backend-domain>/api/v1/auth/google/callback`
  (scheme + host + path, no trailing slash). If this is wrong you get
  `redirect_uri_mismatch` or an endless loop.
- `FRONTEND_URL` — your Vercel origin, e.g. `https://rupchain.com` (used for redirects).
- `NODE_ENV=production` — required so the refresh cookie is `SameSite=None; Secure`
  (without this, cross-site cookies are rejected and sessions won't persist).

### Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0 Client
- **Authorized redirect URIs** must contain the EXACT `GOOGLE_CALLBACK_URL` above.
- **Authorized JavaScript origins** must contain your frontend origin
  (`https://rupchain.com`) and the backend origin if different.

### OAuth consent screen (fixes the "warning screen")
- If the app is in **Testing** mode, only listed **test users** can sign in and everyone
  sees the "Google hasn't verified this app" warning. Either:
  - add the testers under *Test users*, or
  - **Publish** the app (Publishing status → In production). For basic
    `openid email profile` scopes, publishing usually needs no Google review.

### Cross-site cookies (a real-world gotcha)
The frontend (Vercel) and backend (Railway) are different domains, so `refresh_token`
is a third-party cookie. Browsers with third-party cookies blocked will drop it, so the
session won't survive the 15-minute access-token expiry. **Strongly recommended:** put
frontend and backend on the **same parent domain** (e.g. `rupchain.com` +
`api.rupchain.com`) and set a cookie `Domain=.rupchain.com`. That makes the cookie
first-party and eliminates the most common "logged in then bounced out" reports.
> If you want, I can add a `COOKIE_DOMAIN` env var and apply it to the refresh cookie —
> say the word and I'll wire it.

## Quick test checklist after config
1. Click "Continue with Google" → consent screen (no unverified warning if published).
2. Approve → lands on `/dashboard` (or `/admin`), no bounce to `/login`.
3. Hard-refresh `/dashboard` after 15+ min → still logged in (cookie persisted).
4. Misconfigure on purpose (rename callback) → login shows a clear error, not a hang.
