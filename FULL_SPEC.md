# PakSwap — Full Developer Specification
## Build From Scratch · No Hardcoded Data · All Pages · A to Z · v3

> Hand this document to any developer. Everything they need is here.
> Every piece of data shown in the UI must come from the API. No exceptions.

---

## Quick Navigation

| Sections | Topic |
|----------|-------|
| 1–3 | Project overview, tech stack, registration |
| 4–4b | Auth system, API client |
| 5–8 | Rates, gas fees, float pricing, merchant spread |
| 9–11 | Trust system, collateral, hot wallet |
| 12–15 | Web3, KYC limits, CNIC dedup, geoblock, emails |
| 16 | All pages (routes, data sources, interconnection) |
| 17 | Admin panel (all pages) |
| 18–19 | Database schema, two-layer verification |
| 20–22 | Real-time, design system, developer rules |
| 23–26 | Setup, env vars, API format, phases |
| 27 | B2C launch audit (security, UX, fraud, AML, growth) |
| 28–30 | Backend structure, testing, API contracts |
| 31 | Gas Fee Infrastructure (→ GAS_FEE_SPEC.md) |
| 32 | Database Transaction Safety (→ DB_TRANSACTION_RULES.md) |

**Satellite documents (read alongside this spec):**
- [GAS_FEE_SPEC.md](GAS_FEE_SPEC.md) — Complete gas fee infrastructure specification
- [DB_TRANSACTION_RULES.md](DB_TRANSACTION_RULES.md) — Atomic operation catalog; every `db.$transaction()` requirement
- [FRONTEND_STANDARDS.md](FRONTEND_STANDARDS.md) — Tailwind config, component library, custom hooks, form standards

---

## 1. Project Overview

**PakSwap** is a Pakistan-focused P2P (peer-to-peer) crypto exchange platform.

Users can:
- Buy and sell crypto using PKR (JazzCash / Easypaisa / Bank Transfer)
- Use "Instant Buy" to buy crypto directly from the platform (OTC) using PKR or crypto
- Post ads to trade with other users
- Manage a crypto wallet (deposit, withdraw)
- Track trades, disputes, referrals, KYC
- Connect a Web3 wallet for crypto-to-crypto payments (optional, never required)

The platform has three account types, each with its own dedicated portal:
- **User** — regular trader, goes to User Dashboard after login
- **Merchant** — verified business trader with collateral locked, own inventory and spread control, goes to Merchant Dashboard after login
- **Admin/Staff** — platform operators (kyc_reviewer, dispute_agent, admin, super_admin), goes to Admin Panel after login

### Portal Routing — After Login
One login page for everyone. After successful login, backend returns `user.role`. Frontend redirects:
```
role === 'user'                        → /dashboard        (User Dashboard)
role === 'merchant'                    → /merchant/dashboard  (Merchant Dashboard)
role === 'admin' | 'super_admin'
  | 'kyc_reviewer' | 'dispute_agent'  → /admin            (Admin Panel)
```
Admin can also switch to user/merchant view to test the platform.

### How the P2P Model Works (Important)
The platform does NOT hold liquidity. There is no order book. Here is exactly how money flows:

**P2P Trade:**
1. Seller posts an ad saying "I will sell 100 USDT at PKR 278 each"
2. Buyer clicks Buy → trade starts → buyer sends PKR to seller via JazzCash/bank
3. Buyer uploads payment screenshot → admin verifies → seller confirms receipt
4. Seller sends USDT from their own wallet directly to buyer's wallet address (outside platform)
5. Admin marks trade complete

**Instant Buy (OTC):**
1. Buyer places an order for e.g. 100 USDT
2. Buyer sends PKR to platform's JazzCash/bank account
3. Buyer uploads screenshot → OCR Layer 1 auto-checks → Admin Layer 2 reviews
4. Admin approves → platform's operator manually sends USDT to buyer's wallet
5. Order marked complete

The platform earns a fee on each transaction. It does not need to hold large amounts of crypto.

### Payout Model — Manual vs Automated (Critical Separation)

| System | Triggered by | Payout Method | Latency | Manual Operator Step |
|--------|-------------|--------------|---------|---------------------|
| P2P Trade | Peer-to-peer | Seller's own wallet (outside platform) | Minutes | None — seller sends directly |
| Instant Buy (OTC) | Platform ← user PKR | Operator manually sends from hot wallet | Hours | **Yes — admin approves, operator sends** |
| Gas Fee Supply | Platform ← user USDT | Automated via TronWeb SDK | < 60 seconds | **None — fully automated** |

> **Never confuse these three flows.** P2P has NO platform payout. Instant Buy is MANUAL (operator uses their wallet software). Gas Fee is AUTOMATED (TronWeb SDK sends TRX automatically). See Section 31 and GAS_FEE_SPEC.md for gas fee details.

---

## 2. Tech Stack

### Frontend
- **Framework:** Next.js 14+ (App Router, `'use client'` for interactive pages)
- **Language:** TypeScript
- **HTTP Client:** Axios — all API calls via a central `lib/api.ts` file
- **State:** Zustand (`lib/store.ts`) — stores `user` object after login
- **Web3 (optional):** `wagmi` + `viem` for EVM chains, `@solana/wallet-adapter` for Solana — only for crypto-to-crypto Instant Buy and withdrawal address verification
- **Styling:** Tailwind CSS — design tokens and component standards in FRONTEND_STANDARDS.md. Never use inline styles.
- **No hardcoded data** — every number, name, balance, rate, status, and fee comes from API

### Backend
- **Framework:** Fastify (Node.js)
- **Language:** TypeScript
- **ORM:** Prisma
- **Database:** PostgreSQL
- **Auth:** JWT (access token in `Authorization: Bearer <token>` header)
- **File Storage:** AWS S3 (screenshots, KYC documents)
- **Queue:** BullMQ + Redis (async jobs: OCR verification, rate updates, payout workers)
- **Email:** Nodemailer (OTP emails, trade notifications)
- **External APIs:** Binance/CoinGecko (live rates), Etherscan (ETH gas), mempool.space (BTC fees), Tatum/Moralis (on-chain monitoring)

### Infrastructure
- Backend on Railway (or any Node host)
- Frontend on Vercel
- PostgreSQL on Railway
- Redis on Railway
- S3 bucket for file uploads

---

## 3. Registration Flow — One-Time Account Type Selection

### First Visit: Choose Account Type
On the `/register` page, before the form, show two large cards:

```
┌─────────────────────┐    ┌─────────────────────┐
│  👤 Join as Trader  │    │  🏪 Apply as         │
│                     │    │     Merchant         │
│  Buy & sell crypto  │    │  Run a crypto        │
│  with other users.  │    │  business on         │
│  Quick setup.       │    │  PakSwap.            │
│                     │    │  Requires business   │
│  [Get Started →]    │    │  verification.       │
│                     │    │  [Apply Now →]       │
└─────────────────────┘    └─────────────────────┘
```

- User clicks one card → that choice is stored in localStorage as `intended_role`
- Registration form is the same for both — email, fullName, password, referralCode
- **Required legal checkbox (must be ticked before submitting):** "I have read and agree to the [Terms of Service](/terms) and [Privacy Policy](/privacy). I confirm I am 18 years of age or older."
  - Backend field: `User.termsAcceptedAt (DateTime)` — set on registration to current timestamp
  - Backend field: `User.termsVersion (String)` — e.g. `"v1.0"` — lets you re-ask if ToS changes
  - If checkbox is not checked → form does not submit; show inline error "You must accept the Terms of Service to register"
- After email verification:
  - `intended_role === 'user'` → redirect to `/dashboard`
  - `intended_role === 'merchant'` → redirect to `/merchant-apply`
- **This is asked only once, on registration.** Never asked again.
- Every subsequent login: backend returns `user.role` → frontend auto-redirects accordingly.
- If a user later wants to become a merchant, they go to `/merchant-apply` from their dashboard.

---

## 4. Authentication System

### How auth works

**Token architecture (Section 27.2 — must implement before launch):**
- **Access token:** 15-minute expiry — stored in **Zustand memory only** (never localStorage — XSS-vulnerable)
- **Refresh token:** 7-day expiry — stored as **httpOnly + SameSite=Strict cookie** (JavaScript cannot read it)

**Flow:**
1. User visits `/register` → chooses account type (once) → fills form → OTP on email → verified → redirected to their portal
2. User logs in at `/login` → backend sets httpOnly `refresh_token` cookie + returns `accessToken` (15min) in JSON body → frontend stores `accessToken` in Zustand memory only
3. Every API request sends `Authorization: Bearer <accessToken>` header from Zustand store
4. On 401: frontend calls `POST /api/auth/refresh` (sends cookie automatically) → receives new `accessToken` → updates Zustand → retries original request
5. If refresh fails (cookie expired/revoked): clear Zustand state → redirect to `/login?next=<path>`
6. On logout: `POST /api/auth/logout` → backend clears httpOnly cookie + invalidates `Session.refreshTokenHash` in DB → Zustand cleared
7. On page load/refresh: call `POST /api/auth/refresh` silently to restore session from cookie → if fails, user is logged out

**Optional 2FA (TOTP):** if enabled, login returns `preAuthToken` in JSON (not a real access token) → user submits TOTP code to `POST /api/auth/2fa/verify { preAuthToken, totpCode }` → receives real `accessToken` + refresh cookie

**Auth endpoints:**
```
POST /api/auth/login     → { accessToken: string } + sets httpOnly refresh_token cookie
POST /api/auth/refresh   → { accessToken: string } (reads cookie automatically — no body needed)
POST /api/auth/logout    → clears cookie, invalidates session in DB
```

**New DB field:** `Session.refreshTokenHash` (HMAC-SHA256 of refresh token — never store token plain)

**CSRF protection (paired with cookie auth):**
Every mutating request (`POST`, `PATCH`, `DELETE`, `PUT`) must include `X-CSRF-Token` header.
Frontend fetches this token once on app load from `GET /api/auth/csrf-token` and stores in Zustand.
See Section 27.25 for full implementation.

**Security rationale:** Storing JWT in localStorage means any XSS, malicious browser extension, or compromised npm package can steal the token and make authenticated requests from anywhere — including submitting withdrawals. httpOnly cookies are not accessible to JavaScript under any circumstance.

### Zustand store (`lib/store.ts`)
After login, store the access token and user object. The store is the only place the access token lives — never localStorage, never a cookie that JavaScript can read.

```typescript
// lib/store.ts — auth slice
interface AuthStore {
  accessToken: string | null        // 15-min JWT — stored in memory only
  csrfToken: string | null          // per-session CSRF token from GET /api/auth/csrf-token
  user: User | null
  setAccessToken: (token: string) => void
  setCsrfToken: (token: string) => void
  setUser: (user: User) => void
  clearAuth: () => void             // called on logout or refresh failure
}
```

On app mount (`app/layout.tsx`):
1. Call `POST /api/auth/refresh` (sends httpOnly cookie automatically)
2. On success: store `accessToken` in Zustand + call `GET /api/auth/me` → store `user`
3. Call `GET /api/auth/csrf-token` → store `csrfToken` in Zustand
4. On failure: user is logged out — show public page or redirect to `/login`

After login, call `GET /api/auth/me` and store the result as `user`:
```typescript
interface User {
  id: string
  email: string
  fullName: string
  username: string
  role: 'user' | 'merchant' | 'kyc_reviewer' | 'dispute_agent' | 'admin' | 'super_admin'
  kycStatus: 'none' | 'pending' | 'approved' | 'rejected'
  kycLevel: 'none' | 'basic' | 'enhanced'
  referralCode: string
  isEmailVerified: boolean
  twoFaEnabled: boolean
  dailyBuyUsed: number
  dailyBuyLimit: number
  monthlyBuyUsed: number
  monthlyBuyLimit: number
  socialLinks: {           // stored privately, never shown to other users unless admin enables
    twitter?: string
    facebook?: string
    linkedin?: string
    instagram?: string
    website?: string
  }
  createdAt: string
}
```

### API — Auth Endpoints
```
POST /api/auth/register         { email, fullName, password, referralCode?, intendedRole?: 'user'|'merchant' }
  Note: NO social links here — collected during KYC only, not registration
POST /api/auth/login            { email, password }
POST /api/auth/verify-email     { email, code }
POST /api/auth/resend-email-otp { email }
POST /api/auth/forgot-password  { email }
POST /api/auth/reset-password   { email, code, newPassword }
GET  /api/auth/me               → returns User object (with limits)
POST /api/auth/logout
PATCH /api/auth/profile         { fullName?, username? }
GET  /api/users/me/rank         → { badge, badgeLabel, badgeIcon, trustScore, totalTrades, completionRate, avgRating, nextBadge: { label, tradesNeeded, completionRequired } | null }
POST /api/auth/change-password  { currentPassword, newPassword }
POST /api/auth/2fa/setup        → returns { secret, qrCode }
POST /api/auth/2fa/enable       { code }
POST /api/auth/2fa/verify       { preAuthToken, totpCode } → returns access token
POST /api/auth/2fa/disable      { code }
GET  /api/auth/sessions         → list of active sessions
DELETE /api/auth/sessions/:id   → revoke session
```

---

## 4b. API Client Setup (`lib/api.ts`)

```typescript
import axios from 'axios'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000'

export const api = axios.create({
  baseURL: `${API_BASE}/api`,
  timeout: 30000,
  withCredentials: true,   // send httpOnly refresh_token cookie on every request
})

// Attach access token from Zustand store (memory only — never localStorage)
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken   // Zustand store
  if (token) config.headers.Authorization = `Bearer ${token}`

  // CSRF token for all mutating requests
  const csrfToken = useAuthStore.getState().csrfToken
  if (csrfToken && ['post','patch','put','delete'].includes((config.method ?? '').toLowerCase())) {
    config.headers['X-CSRF-Token'] = csrfToken
  }
  return config
})

// Handle 401 — attempt silent token refresh before redirecting
let isRefreshing = false
let refreshQueue: Array<(token: string) => void> = []

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const original = err.config
    if (err.response?.status === 401 && !original._retry) {
      original._retry = true
      if (!isRefreshing) {
        isRefreshing = true
        try {
          const { data } = await axios.post(`${API_BASE}/api/auth/refresh`, {}, { withCredentials: true })
          const newToken = data.data.accessToken
          useAuthStore.getState().setAccessToken(newToken)
          refreshQueue.forEach(cb => cb(newToken))
          refreshQueue = []
          isRefreshing = false
          original.headers.Authorization = `Bearer ${newToken}`
          return api(original)
        } catch {
          isRefreshing = false
          refreshQueue = []
          useAuthStore.getState().clearAuth()
          if (typeof window !== 'undefined') {
            window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`
          }
        }
      } else {
        return new Promise(resolve => {
          refreshQueue.push((token) => {
            original.headers.Authorization = `Bearer ${token}`
            resolve(api(original))
          })
        })
      }
    }
    return Promise.reject(err)
  }
)

// NOTE: localStorage is NEVER used for tokens. Access token lives in Zustand memory.
// Refresh token lives in httpOnly cookie — browser sends it automatically via withCredentials: true.
```

All API modules exported from this file:
- `authApi` — authentication
- `marketplaceApi` — ads, rates, stats, config (includes site notice)
- `tradesApi` — P2P trades
- `adsApi` — user's own ads
- `walletApi` — balances, deposits, withdrawals, fees, payment methods, saved addresses
- `kycApi` — KYC submission
- `disputesApi` — disputes
- `notificationsApi` — notifications (with unread count)
- `merchantsApi` — merchant features, spread, inventory, stats, dashboard summary (`GET /api/merchants/dashboard/summary`)
- `instantBuyApi` — OTC/instant buy orders
- `referralApi` — referral data
- `leaderboardApi` — public leaderboard (no auth required)
  ```typescript
  export const leaderboardApi = {
    get: (params?: { type?: 'traders'|'merchants'; period?: 'all'|'30d'|'7d'; page?: number; limit?: number }) =>
      api.get('/leaderboard', { params }),
  }
  ```
- `usersApi` — public user profile
  ```typescript
  export const usersApi = {
    getProfile: (username: string) => api.get(`/users/${username}/profile`),
    getMyRank: () => api.get('/users/me/rank'),
  }
  ```
- `adminApi` — admin panel operations (includes analytics: `analytics: (params?: any) => api.get('/admin/analytics', { params })`)

---

## 5. Live Rate System (Critical — Must Work Before Launch)

### How rates work
Rates are stored in `platformConfig` table as `rate_USDT_PKR`, `rate_BTC_PKR`, etc.
A backend cron job updates them automatically every 5 minutes from Binance.
The frontend always reads from the API — never hardcodes a rate.

### Backend: Rate Updater Cron Job
**File:** `backend/src/jobs/rateUpdater.ts`

```
Every 5 minutes:
  1. Fetch prices from Binance API: GET https://api.binance.com/api/v3/ticker/price
  2. Fetch USD/PKR from: GET https://api.exchangerate-api.com/v4/latest/USD
     (or use a fixed admin-set USD/PKR rate from platformConfig if external API fails)
  3. For each supported coin: coinPKR = coinUSD * usdPKR
  4. Write to platformConfig: key=rate_{COIN}_PKR, value={rate}
  5. Log the update with timestamp
```

**Supported coins:** USDT, USDC, BTC, ETH, BNB, SOL, TRX, AVAX, APT, NEAR, OP, ARB, SUI, RON, TON

**Fallback:** If Binance is unreachable, keep the last known rate. Never set rate to 0. Log the failure and alert admin via email.

### API Endpoints
```
GET /api/marketplace/rate/:coin     → { rate: number, updatedAt: string, source: 'live'|'cached' }
GET /api/marketplace/rates          → { rates: { USDT: 278.5, BTC: 8750000, ... }, updatedAt: string }
```

The `updatedAt` field lets the frontend show "Rate updated 2 min ago" — always show this to users so they know the rate is live.

### Frontend: Rate Display Rule
Every place a rate is shown must display:
- The rate value from API
- A "last updated X minutes ago" indicator (compute from `updatedAt`)
- A refresh button that re-fetches on click

---

## 6. Live Gas Fee System

### Concept
Total withdrawal fee = **Live Network Fee** + **Platform Fixed Fee**

- **Live Network Fee** = actual blockchain cost (fetched in real-time from external API)
- **Platform Fixed Fee** = set by admin in `platformConfig` (e.g., `platform_fee_ERC20 = 0.3 USDT`)
- **Total shown to user** = live fee + platform fee, in both coin units and PKR equivalent
- **No other fees** — these two combined are the only fees. Be explicit about this in the UI.

### Example
User wants to withdraw ETH on ERC-20:
- Live gas fee from Etherscan: 0.001 ETH ≈ $3 ≈ PKR 840
- Platform fixed fee: PKR 500 (set in admin config)
- **Total fee: PKR 1,340 shown to user**
- If withdrawal amount is too small to cover the fee, block it and show: "Minimum withdrawal must exceed fee of PKR 1,340"

### Fee Sources Per Network

| Network | Fee Source | API |
|---------|-----------|-----|
| ERC-20 (ETH) | Live gas price | `GET https://api.etherscan.io/api?module=gastracker&action=gasoracle` |
| BTC | Live mempool fee | `GET https://mempool.space/api/v1/fees/recommended` → use `fastestFee` sat/vB × 250 vB |
| TRC-20 | Flat (gas is stable) | From `platformConfig: fee_network_TRC20` |
| BEP-20 | Flat (gas is stable) | From `platformConfig: fee_network_BEP20` |
| SOL | Live fee | `GET https://api.mainnet-beta.solana.com` — `getFeeForMessage` |
| Others | Flat | From platformConfig |

### Backend: Fee Endpoint
```
GET /api/wallet/live-fee?coin=ETH&network=ERC20
→ {
    networkFee: { amount: 0.001, coin: 'ETH', pkr: 840 },
    platformFee: { amount: 0.0018, coin: 'ETH', pkr: 500 },
    totalFee:    { amount: 0.0028, coin: 'ETH', pkr: 1340 },
    minimumWithdrawal: { amount: 0.01, coin: 'ETH' },
    fetchedAt: '2026-05-07T10:00:00Z'
  }
```

The frontend calls this endpoint when:
1. User opens the withdraw form
2. User changes the network selection
3. User clicks a "Refresh fee" button

**Never cache the fee on the frontend for more than 60 seconds.** Always show a "Refresh" button.

### platformConfig keys for fees
```
platform_fee_ERC20     → platform's own fee in USDT (e.g. "1.2")
platform_fee_BEP20     → platform's own fee in USDT
platform_fee_TRC20     → platform's own fee in USDT
platform_fee_SOL       → platform's own fee in SOL
platform_fee_BTC       → platform's own fee in BTC
fee_network_TRC20      → flat network fee for TRC20 in USDT
fee_network_BEP20      → flat network fee for BEP20 in USDT
```

---

## 7. P2P Ad Float Pricing (Auto-Pricing)

Sellers can choose between **fixed price** or **float price**:

- **Fixed:** Seller sets e.g. `PKR 282 per USDT` — stays fixed until changed
- **Float:** Seller sets e.g. `+1.5% above market rate` — price updates automatically as market moves

### How Float Works
- Ad stores: `priceType: 'fixed' | 'float'`, `floatOffset: number` (percentage, can be negative for below market)
- Every time the rate updater runs (every 5 min), it recalculates float ad prices and updates `Ad.price`
- Marketplace shows the recalculated price — users always see a fresh price

### Ad Schema Addition
```
Ad
  ...existing fields...
  priceType: 'fixed' | 'float'    default: 'fixed'
  floatOffset: number              e.g. 1.5 means +1.5% above market, -1 means 1% below
  lastPriceUpdate: DateTime
```

### Create/Edit Ad Form Addition
Show a toggle: "Fixed Price" vs "Float Price (auto)"
- If float: show input for "% above/below market rate" (e.g. +2%, -0.5%)
- Show live preview: "Current rate PKR 278 → Your price PKR 283.56 (+2%)"

---

## 8. Merchant Spread Control

Merchants can set their own spread (markup) on top of market rate for their Instant Buy orders.

- `Merchant.spreadBps` — stored in database in basis points (100 bps = 1%)
- Admin approves a merchant's spread range (e.g. max 300 bps = 3%)
- Merchant sets their spread from their dashboard

### Merchant Dashboard — `/merchant/dashboard`

**Data to fetch:**
```
GET /api/merchants/me        → merchant profile + status + spreadBps
GET /api/merchants/me/inventory → coin inventory with amounts and prices
GET /api/marketplace/rates   → all live rates (for preview)
```

**Spread Control UI:**
- Slider or input: "Your spread: X%"
- Live preview: "Market rate: PKR 278 → Your price: PKR {278 * (1 + spread/100)}"
- Save button → `PATCH /api/merchants/me/spread { spreadBps }`

**Inventory Management:**
```
GET    /api/merchants/me/inventory
POST   /api/merchants/me/inventory    { coin, network, availableAmount, pricePerUnit }
DELETE /api/merchants/me/inventory/:id
```

---

## 9. Trust Score, Badges & Ranks

Every user and merchant has a trust profile visible on their public profile and on marketplace ad cards. Badges and ranks are computed automatically from real trade data — never manually assigned or hardcoded.

### Trust Score Calculation (backend, computed after every trade rating)
```
score = (completionRate * 0.5) + (avgRating / 5 * 0.3) + (log10(totalTrades + 1) / log10(1001) * 0.2)
```
Score is a float 0–1. Stored in `TradeStats.trustScore`. Recomputed after every `TradeRating` submission.

---

### User Badge Tiers
Auto-assigned by backend based on `totalTrades` + `completionRate`. Stored in `TradeStats.badge`.

| Badge | Icon | Condition |
|-------|------|-----------|
| New Trader | 🆕 | < 5 trades |
| Active Trader | ✅ | 5–49 trades, completion ≥ 80% |
| Trusted Trader | ⭐ | 50–199 trades, completion ≥ 90% |
| Top Trader | 🔵 | 200–499 trades, completion ≥ 95% |
| Elite Trader | 🏆 | 500+ trades, completion ≥ 98% |

**Badge downgrade rule:** If completion rate drops below a tier threshold, badge downgrades on next recalculation. Users are notified of both upgrades and downgrades.

---

### Merchant Rank Tiers
Merchants have a separate rank computed from `totalVolumePKR` AND `avgRating` AND `disputeRate`. Stored in `Merchant.rank`.

| Rank | Icon | Volume (PKR) | Rating | Dispute Rate |
|------|------|-------------|--------|-------------|
| Bronze Merchant | 🥉 | Any (newly approved) | Any | — |
| Silver Merchant | 🥈 | ≥ 500,000 PKR | ≥ 4.0 | < 5% |
| Gold Merchant | 🥇 | ≥ 5,000,000 PKR | ≥ 4.5 | < 3% |
| Platinum Merchant | 💎 | ≥ 25,000,000 PKR | ≥ 4.8 | < 1% |

- Merchant rank shown alongside the standard "🏪 Verified Merchant" badge
- Rank updates weekly (BullMQ cron job: `merchant-rank-updater`, every Sunday midnight PKT)
- Displayed as: "🏪 Verified Merchant · 🥇 Gold"
- Platinum merchants get a special UI highlight on marketplace (gradient border, featured position)

**Merchant Rank API:**
```
GET /api/merchants/:id → includes rank: 'bronze'|'silver'|'gold'|'platinum'
GET /api/merchants/me  → same
```

---

### Rank/Badge Assignment Rules (Backend)
1. After every trade completes → `recalculate-trade-stats` job runs
2. Checks if badge tier should change → creates `Notification` if changed
3. Merchant rank: weekly cron only (not per-trade, to avoid frequent flapping)
4. Admin can manually override a badge in extreme cases (scam reversal) — logged in AuditLog

---

### Public Leaderboard
```
GET /api/leaderboard?type=traders|merchants&period=all|30d|7d&limit=20
→ {
    traders: [{ rank, username, badge, totalTrades, completionRate, avgRating, totalVolumePKR }],
    merchants: [{ rank, username, merchantRank, totalVolumePKR, avgRating, disputeRate }]
  }
```
- All fields from DB — no invented data
- `period=30d` shows top performers in last 30 days by trade volume
- Usernames shown; no full names or emails

---

### API
```
GET /api/users/:username/profile
→ {
    username, fullName (masked), joinedAt,
    tradeStats: { totalTrades, completionRate, avgRating, totalVolumePKR },
    trustScore: number,   ← float 0–1
    badge: string,        ← 'new'|'active'|'trusted'|'top'|'elite'
    badgeLabel: string,   ← human label e.g. "Elite Trader"
    badgeIcon: string,    ← emoji
    recentReviews: []     ← last 5 reviews from real trades
  }

GET /api/users/me/rank   ← logged-in user's own rank/badge + progress to next tier
→ {
    badge, badgeLabel, badgeIcon,
    trustScore,
    totalTrades, completionRate, avgRating,
    nextBadge: { label, tradesNeeded, completionRequired } | null
  }
```

### Where badges appear
| Location | What to show |
|----------|-------------|
| Marketplace ad card | Badge icon + label next to username |
| Trade page (counterparty) | Badge icon + label |
| Merchant profile | Merchant rank prominently, user badge secondary |
| User public profile | Full badge card with progress bar |
| Dashboard | Own badge + "X trades to next tier" progress bar |
| Leaderboard | Rank number + badge + stats |
| Admin user list | Badge column |

**Never fake, hardcode, or manually set a badge.** All assignment is automated from real `TradeStats`.

---

## 10. Seller Collateral Lock (Phase 1 — Required for Merchants)

### Concept
Any user who wants to post sell ads must lock a minimum USDT collateral. This is not escrow — the platform does not hold trade funds. The collateral is a good-faith deposit that stays locked while the seller is active. It signals seriousness and deters scammers.

### Rules
- **First 3 completed sell trades: collateral-free.** New sellers can post and complete up to 3 sell trades with no collateral required. This removes the barrier for new users to get started.
- **After 3 completed sell trades:** system automatically prompts seller to lock 50 USDT collateral to continue posting sell ads. Tracked via `User.completedSellTrades` counter.
- **Merchant collateral on approval:** 100 USDT locked when merchant status is approved (configurable: `collateral_merchant`). Merchants skip the 3-trade free period — they go straight to locking 100 USDT as part of activation.
- Collateral sits in `Wallet.lockedBalance` — not spendable, not withdrawable while locked
- Seller can unlock any time **if no active trades** — `POST /api/wallet/unlock-collateral`
- If a seller is found to have scammed → admin can seize collateral: `POST /api/admin/users/:id/seize-collateral { reason }`

### platformConfig keys
```
collateral_free_sell_trades  → 3     (completed sell trades allowed before collateral required)
collateral_min_sell          → 50    (USDT required after free trades exhausted)
collateral_merchant          → 100   (USDT required on merchant approval)
require_collateral_to_sell   → false (set true to skip free trades and require collateral immediately)
```

### Frontend — Collateral Prompt
When `user.completedSellTrades >= collateral_free_sell_trades` and seller tries to create a new ad:
- Show modal: "You've completed 3 trades! Lock 50 USDT collateral to keep selling. This builds buyer trust and can be unlocked anytime."
- "Lock Collateral" button → deposit flow → lock flow
- "Not now" → cannot post ad until collateral locked

> **Enforcement model (both layers required):**
> - **Frontend:** Shows the prompt so the user understands why (UX)
> - **Backend:** Independently rejects the `POST /api/ads` request if collateral condition is unmet (security — Rule 18 in Section 22)
> Never rely on frontend-only enforcement for financial restrictions.

### Auto-Scaling for Merchants
If a merchant's dispute rate (disputes / total trades) exceeds 10%, their required collateral doubles automatically:
```
If merchant.disputeRate > 0.10 → requiredCollateral = collateral_merchant * 2
If merchant.disputeRate > 0.20 → merchant suspended pending review
```

### Collateral Status on Marketplace
- Ads from sellers with locked collateral show "🔒 Collateral" badge
- Ads from sellers with no collateral show a warning — buyers can still trade but see the risk
- Admin can require all sell ads to have collateral via platformConfig: `require_collateral_to_sell = true`

### API Endpoints
```
POST /api/wallet/lock-collateral    { amount, coin }   → locks balance
POST /api/wallet/unlock-collateral                     → unlocks if no active trades
GET  /api/wallet/collateral-status  → { locked, amount, coin, canUnlock, activeTradesCount }
POST /api/admin/users/:id/seize-collateral { reason }  → admin only, moves to platform wallet
```

### platformConfig keys
```
collateral_min_sell      → 50    (USDT required to post sell ad)
collateral_merchant      → 100   (USDT required on merchant approval)
require_collateral_to_sell → false  (set true to enforce for ALL sellers)
```

---

## 11. Collateral — How It's Held and What Happens on Ban

### Where Collateral Lives
The collateral is a **virtual lock in the database**, not a separate on-chain wallet. Here is exactly what happens:

1. Merchant deposits 100 USDT to their PakSwap deposit address (a blockchain address the platform controls)
2. The platform's hot wallet receives the USDT on-chain — the platform operator controls this wallet's private keys
3. In the database: `Wallet.balance = 100`, `Wallet.lockedBalance = 0`
4. When merchant activates: `Wallet.balance = 0`, `Wallet.lockedBalance = 100`
   A `CollateralLock` record is created: `{ userId, coin: 'USDT', amount: 100, status: 'locked' }`

The USDT physically sits in the platform's hot wallet throughout. The "lock" is purely a database flag that prevents withdrawal.

### What Happens When Account is Banned
Admin clicks "Ban" + "Seize Collateral":
1. `POST /api/admin/users/:id/seize-collateral { reason }`
2. Backend sets `CollateralLock.status = 'seized'`, `CollateralLock.seizeReason = reason`
3. `Wallet.lockedBalance = 0` (the record is zeroed)
4. A `Transaction` record is created: `{ type: 'seized', amount: 100, note: reason }`
5. The USDT remains in the platform's hot wallet — the platform owner retains it
6. Admin sees the seizure in the Audit Log with reason and timestamp

### What Happens When Account is NOT Banned (Normal Unlock)
1. Merchant calls `POST /api/wallet/unlock-collateral`
2. Backend checks: no active trades where this user is seller
3. If clear: `Wallet.lockedBalance -= 100`, `Wallet.balance += 100`
4. `CollateralLock.status = 'unlocked'`
5. Merchant can now withdraw normally

### Important — Terms of Service Requirement
The platform's Terms of Service MUST state:
- Collateral is a security deposit held by PakSwap
- It may be seized in cases of fraud, scamming, or violation of platform rules
- Seizure decisions are at PakSwap's discretion and are final
- Disputes about seizures must be raised within 30 days

### platformConfig keys
```
collateral_min_sell       → 50    USDT to post sell ads
collateral_merchant       → 100   USDT locked on merchant approval
require_collateral_to_sell → false  if true, ALL sellers must lock collateral
```

---

## 11b. Platform Hot Wallet Management — Admin Setup

The platform operates **hot wallets** — blockchain addresses that the operator controls with private keys. All user deposits and Instant Buy payouts flow through these addresses. This section defines how the admin/owner sets them up and manages them.

### What the Hot Wallet Is Used For
| Purpose | Direction | Who acts |
|---------|-----------|---------|
| User crypto deposits | User → Platform hot wallet | User sends, operator credits DB |
| Instant Buy payout | Platform hot wallet → Buyer | Operator sends manually after admin approves |
| Merchant collateral receipt | Merchant → Platform hot wallet | Merchant sends, operator credits DB |
| Withdrawal payout | Platform hot wallet → User | Operator sends manually after admin approves |

The platform does NOT use automated smart contracts or custodial software in Phase 1. The operator manually sends crypto using their own wallet software (e.g. Trust Wallet, MetaMask, Binance). Phase 2 can automate this with Fireblocks or a similar custodian.

---

### How Admin Adds/Updates Hot Wallet Addresses

**Step 1 — Set deposit addresses in Admin Config (`/admin/config`):**

Each coin+network combination needs a platform deposit address. These are the addresses shown to users when they deposit. Admin sets them via `platformConfig`:

| Config Key | Example Value | Used For |
|-----------|--------------|---------|
| `deposit_address_USDT_TRC20` | `TXxxx...` | User USDT deposits on Tron |
| `deposit_address_USDT_BEP20` | `0xabc...` | User USDT deposits on BSC |
| `deposit_address_USDT_ERC20` | `0xabc...` | User USDT deposits on Ethereum |
| `deposit_address_BTC_BTC` | `bc1q...` | Bitcoin deposits |
| `deposit_address_ETH_ERC20` | `0xabc...` | ETH deposits |
| `deposit_address_SOL_SOL` | `xxx...` | Solana deposits |
| `payout_address_note` | "Send from Binance hot wallet" | Internal note for operators |

Admin goes to `/admin/config` → finds these keys → enters the blockchain addresses → saves.

**IMPORTANT:** The private keys for these addresses are NEVER stored in the platform. The operator manages the private keys separately (hardware wallet, Binance account, or custodial software). The platform only stores the public deposit address.

**Step 2 — These addresses are used in two places:**
1. **Wallet deposit page** (`/wallet`) — `GET /api/wallet/address/:coin/:network` returns the address from `platformConfig[deposit_address_{coin}_{network}]`
2. **Merchant activation** — merchant is told to send 100 USDT to this same address

---

### Admin Wallet Management Page — `/admin/wallet`

**New page — visible to `super_admin` only.**

```
GET  /api/admin/wallet/addresses        → all configured deposit addresses with status
POST /api/admin/wallet/addresses { coin, network, address, label? }  → set/update
GET  /api/admin/wallet/balance-summary  → estimated platform holdings (manual input)
POST /api/admin/wallet/balance-summary  { coin, network, estimatedBalance }  → update manually
```

**UI Sections:**

**1. Deposit Addresses**
- Table: Coin | Network | Address | Status (set/missing) | Last Updated | Edit button
- "Set Address" button for any missing coin/network
- Edit shows input with current address pre-filled
- Warning if address is missing: "⚠️ Users cannot deposit {coin} on {network} until this is set"
- Each address shown with copy button and QR code

**2. Estimated Platform Holdings (manual)**
- Admin manually enters the platform's estimated crypto holdings (cannot be auto-synced in Phase 1)
- Purpose: lets admin see if there is enough liquidity to fulfill pending withdrawals/Instant Buy orders
- Fields: Coin | Network | Estimated Balance | Last Updated (timestamp of manual entry)
- This is for operator visibility only — not shown to users

**3. Pending Payouts Summary**
- Sum of all pending withdrawal amounts by coin → `GET /api/admin/wallet/pending-payouts`
- Sum of all pending Instant Buy orders by coin
- Shows: "You owe 2,450 USDT across 8 pending withdrawals"
- Operator checks this before sending to ensure they have enough on-chain balance

**4. Payout Instructions (for operator)**
- Static reference panel showing steps for operator when approving a withdrawal or Instant Buy:
  1. Check the destination address on the order
  2. Open your wallet software (MetaMask, Trust Wallet, Binance App)
  3. Send exact amount to the address
  4. Copy the TX hash
  5. Paste TX hash in the "Mark as Sent" field in admin panel
  6. Click Approve

---

### Env Variables for Hot Wallet
```
# Hot wallet addresses (public addresses only — private keys stay with operator)
# Can also be set via admin /config page — env vars are just the defaults
PLATFORM_DEPOSIT_USDT_TRC20=TXxxx...
PLATFORM_DEPOSIT_USDT_BEP20=0xabc...
PLATFORM_DEPOSIT_USDT_ERC20=0xabc...
PLATFORM_DEPOSIT_BTC=bc1q...
PLATFORM_DEPOSIT_ETH=0xabc...

# Alert email for escalations and large withdrawal requests
ADMIN_ALERT_EMAIL=ops@pakswap.pk
```

Backend reads these env vars on startup and seeds `platformConfig` if those keys are missing. Admin can override them at any time via `/admin/config`.

---

## 12. Wallet Connect (Web3)

### Scope — What It Is Used For
Wallet Connect is **optional** and only used for two specific purposes:

1. **Instant Buy — Crypto-to-Crypto:** Instead of pasting a tx hash, user connects their wallet and sends crypto directly from it. The frontend detects the transaction automatically.
2. **Withdrawal address verification:** User signs a message to prove they own the destination address before a large withdrawal (optional security step).

**Never required for login, registration, or PKR payments.**

### Supported Wallets
- MetaMask, WalletConnect v2 (EVM chains: ETH, BNB, MATIC, ARB, OP, BASE, AVAX)
- Phantom (Solana)
- Future: Tonkeeper (TON), Ronin Wallet

### Frontend Implementation
Use `wagmi` v2 + `@rainbow-me/rainbowkit` for EVM. Simple connect button, shown only on crypto-to-crypto Instant Buy page.

```typescript
// Only import on crypto-deposit page, not globally
import { useAccount, useSendTransaction } from 'wagmi'
```

### Crypto-to-Crypto Instant Buy with Wallet Connect
1. User reaches `/instant-buy/crypto-deposit/:orderId`
2. Show two options:
   - **Option A (Manual):** "I will send manually" → show address → user pastes tx hash
   - **Option B (Connect Wallet):** "Connect Wallet & Send" → wagmi connect → send transaction → tx hash captured automatically → submit to API
3. Both options lead to: `POST /api/instant-buy/orders/:id/confirm-deposit { txHash }`

### Backend: On-Chain Monitoring (Replaces Manual Tx Hash)
Instead of relying on user-submitted tx hash, the backend monitors the deposit address on-chain.

**For EVM chains:** Use Moralis Streams or Tatum Webhook — when a transaction arrives at the platform's deposit address matching the expected amount and coin, auto-trigger Layer 1 verification.

**For TRC20:** Use TronGrid webhooks.

**For BTC:** Use BlockCypher webhooks.

```
POST /api/webhooks/deposit  ← called by Moralis/Tatum when deposit detected
  → FIRST: verify webhook signature (see below — reject unsigned webhooks with 401)
  → find matching InstantBuyOrder by toAddress + coin + network
  → update incomingTxHash, status → 'payment_uploaded'
  → queue Layer 1 verification job
```

**Webhook Signature Verification (CRITICAL — must implement before accepting webhooks):**
```typescript
// middleware/verifyWebhookSignature.ts
import crypto from 'crypto'

export const verifyMoralisWebhook = (req: FastifyRequest, reply: FastifyReply) => {
  const signature = req.headers['x-moralis-signature'] as string
  const body = JSON.stringify(req.body)
  const expected = crypto
    .createHmac('sha256', process.env.MORALIS_WEBHOOK_SECRET!)
    .update(body)
    .digest('hex')
  if (signature !== expected) {
    return reply.status(401).send({ error: 'INVALID_WEBHOOK_SIGNATURE' })
  }
}

// Tatum uses header 'x-payload-hash' — same HMAC pattern
// BlockCypher uses query param 'token' — validate against BLOCKCYPHER_TOKEN env var
```

**New env vars:**
```
MORALIS_WEBHOOK_SECRET=...   # from Moralis dashboard → Streams → your stream → webhook secret
TATUM_WEBHOOK_SECRET=...
BLOCKCYPHER_TOKEN=...
```

Apply this middleware to ALL `/api/webhooks/*` routes. An unverified webhook from any attacker's IP can trigger fraudulent deposit credits.

This means the user doesn't even need to paste a tx hash — it's detected automatically within seconds.

---

## 12b. KYC Compliance — Daily & Monthly Limits

### Limits by KYC Level (based on SBP guidelines)

| KYC Level | Daily Buy Limit (PKR) | Monthly Buy Limit (PKR) |
|-----------|----------------------|------------------------|
| none | 0 (cannot buy) | 0 |
| basic | 50,000 | 200,000 |
| enhanced | 500,000 | 2,000,000 |

These limits apply to both P2P trades and Instant Buy combined.

### Backend Enforcement
Before creating any trade or Instant Buy order:
1. Check `user.kycStatus === 'approved'`
2. Fetch today's total PKR spent: sum of completed trades + Instant Buy orders in last 24h
3. If `todaySpent + newAmount > dailyLimit` → reject with `DAILY_LIMIT_EXCEEDED`
4. Same check for monthly limit

### Frontend — Limit Display
On the Instant Buy order form and create-trade page:
- Show a progress bar: "Daily limit: PKR 23,000 / 50,000 used"
- If limit reached: disable form and show upgrade message
- Fetch from `GET /api/auth/me` which includes `dailyBuyUsed`, `dailyBuyLimit`, `monthlyBuyUsed`, `monthlyBuyLimit`

### Admin Config Keys
```
kyc_limit_basic_daily    → 50000
kyc_limit_basic_monthly  → 200000
kyc_limit_enhanced_daily → 500000
kyc_limit_enhanced_monthly → 2000000
```

---

## 13. CNIC Uniqueness Check (Fraud Prevention)

During KYC approval, the admin (or system) must verify that the CNIC number is not already linked to another approved account.

### How It Works
1. When admin approves KYC, the system extracts or admin enters the CNIC number
2. Backend checks: `SELECT COUNT(*) FROM KycSubmission WHERE cnicNumber = ? AND status = 'approved' AND userId != ?`
3. If duplicate found: block approval, alert admin "This CNIC is already used by account X"

### Schema Addition
```
KycSubmission
  ...existing fields...
  cnicNumber: string (nullable, set during approval)
  cnicNumberHash: string (hashed for privacy, used for dedup check)
```

### Future: OCR CNIC Extraction
Phase 2: Use OCR (same BullMQ worker) to auto-extract CNIC number from the front photo. Store it hashed. Check for duplicates automatically during Layer 1 verification.

---

## 14. Geo-Blocking

Block access from FATF high-risk countries and sanctioned regions. Protects the platform legally.

### Backend Middleware
```typescript
// middleware/geoblock.ts
// On every request, check CloudFlare header CF-IPCountry or use ip-api.com
const BLOCKED_COUNTRIES = ['IR', 'KP', 'RU', 'BY', 'SY', 'CU', 'MM', 'SD', 'ZW']
if (BLOCKED_COUNTRIES.includes(country)) {
  return reply.status(403).send({ error: 'SERVICE_UNAVAILABLE_IN_YOUR_REGION' })
}
```

Apply this middleware to all authenticated routes. The `/` page and public pages can still load (for SEO), but any API call will be blocked.

### Frontend
If API returns `SERVICE_UNAVAILABLE_IN_YOUR_REGION`, show a dedicated page: "PakSwap is not available in your region."

---

## 15. Email Notification Templates

Every email sent by the platform must use these templates. All dynamic values come from the database — never hardcoded. Send via Nodemailer. Use a simple HTML template with the PakSwap logo, the message, and a CTA button.

| Trigger | Recipient(s) | Subject | Key content |
|---------|-------------|---------|-------------|
| Registration OTP | New user | "Verify your PakSwap account" | 6-digit code, expires in 10 min |
| Forgot password OTP | User | "Reset your PakSwap password" | 6-digit code, expires in 10 min |
| Trade started | Buyer + Seller | "New trade #{orderRef} started" | Coin, amount, PKR value, counterparty username, link to trade |
| Payment uploaded (buyer) | Seller | "Payment received for trade #{orderRef} — please verify" | Amount, payment method, link to trade |
| Trade completed | Buyer + Seller | "Trade #{orderRef} completed ✅" | Coin sent, amount, rate, link to leave a rating |
| Trade cancelled | Buyer + Seller | "Trade #{orderRef} was cancelled" | Reason, link to marketplace |
| Trade escalated (admin) | All admins | "⚠️ Trade #{orderRef} needs urgent review" | Age of trade, current status, direct admin link |
| Dispute opened | Buyer + Seller + Admin | "Dispute opened on trade #{orderRef}" | Reason, link to dispute |
| Dispute resolved | Buyer + Seller | "Dispute #{id} resolved" | Winner, resolution note |
| KYC submitted | User | "KYC submission received" | "We'll review within 24 hours" |
| KYC approved | User | "KYC approved ✅ — you can now trade" | KYC level unlocked, daily limit |
| KYC rejected | User | "KYC submission rejected" | Rejection reason, link to resubmit |
| Merchant KYC approved | Applicant | "Merchant application approved — deposit to activate" | "Deposit 100 USDT to your PakSwap wallet, then click Activate" |
| Merchant KYC rejected | Applicant | "Merchant application rejected" | Reason |
| Merchant activated | Merchant | "Welcome to PakSwap Merchants! 🏪" | Dashboard link, spread setup link |
| Instant Buy order created | User | "Instant Buy order #{orderRef} created" | Coin, amount, payment instructions link |
| Instant Buy approved | User | "Your Instant Buy order is complete ✅" | Coin sent, amount, tx hash if available |
| Instant Buy rejected | User | "Instant Buy order #{orderRef} rejected" | Rejection reason |
| Withdrawal requested | User | "Withdrawal request received" | Amount, coin, network, "pending admin review" |
| Withdrawal approved | User | "Withdrawal approved ✅" | Amount, coin, tx hash |
| Withdrawal rejected | User | "Withdrawal rejected" | Reason |
| Referral reward earned | Referrer | "You earned {amount} PKR referral reward!" | From which referral, total earned |
| Collateral prompt | Seller | "Lock collateral to keep selling on PakSwap" | After 3 trades, link to lock |
| Collateral seized | Banned user | "Your collateral has been seized" | Reason, amount |
| Low inventory | Merchant | "⚠️ Low inventory: {coin} is running low" | Current amount, link to add inventory |
| Badge upgraded | User | "🎉 You've earned a new badge: {badgeLabel}!" | New badge, stats that triggered it, link to profile |
| Badge downgraded | User | "Your trader badge has changed" | New badge, reason (completion rate dropped), how to recover |
| Merchant rank upgraded | Merchant | "🥇 You've reached {rank} Merchant status!" | New rank, volume milestone hit |
| Merchant rank downgraded | Merchant | "Your merchant rank has changed" | New rank, what dropped (rating/dispute rate), how to recover |
| Site notice changed | — | — | (no email — shown as banner on site only) |

**Implementation notes:**
- All emails must have a plain-text fallback
- Unsubscribe link required by law (for non-transactional emails like referral rewards)
- Transactional emails (OTP, trade, withdrawal) cannot be unsubscribed from
- Store email send history in `EmailLog` table: `{ userId, template, sentAt, status }`

---

## 15b. Trade Dispute Auto-Escalation

If a trade stays unresolved too long, it should auto-escalate to prevent silent stalling.

### Escalation Rules
| Trade Status | Time Threshold | Action |
|---|---|---|
| `payment_pending` | 4 hours | Auto-cancel trade, notify both parties |
| `payment_uploaded` | 2 hours with no admin action | Send email to all admins "Urgent: Trade needs review" |
| `disputed` | 48 hours | Send escalation email to super_admin |

### Backend: Escalation Job
BullMQ repeatable job runs every 30 minutes:
```
For each active trade:
  if (status === 'payment_pending' && age > 4h) → auto-cancel
  if (status === 'payment_uploaded' && age > 2h) → email admins
  if (status === 'disputed' && age > 48h) → email super_admin
```

### New platformConfig Keys
```
trade_auto_cancel_hours    → 4
trade_escalate_hours       → 2
dispute_escalate_hours     → 48
```

---

## 16. All Pages — Routes, Interconnections, and Data Sources

### Page Interconnection Map — Critical Links Every Developer Must Implement

Every clickable element below must navigate to the right destination. No dead ends.

| From Page | User Action | Destination |
|-----------|------------|-------------|
| `/` Home | Click "Buy Crypto" | `/instant-buy` |
| `/` Home | Click "Start Trading" / "Trade Now" | `/marketplace` |
| `/` Home | Click on a top ad | `/trade/new?adId=xxx` |
| `/` Home | Click username in top ad | `/profile/[username]` |
| `/marketplace` | Click "Buy" on an ad | `/trade/new?adId=xxx` |
| `/marketplace` | Click seller username | `/profile/[username]` |
| `/marketplace` | Click merchant name | `/merchant/[id]` |
| `/trade/new?adId=xxx` | Confirm → trade created | `/trade/[id]` |
| `/trade/[id]` | Open Dispute button | Inline dispute form → `POST /api/trades/:id/dispute` |
| `/trade/[id]` | Trade completes | Show rating prompt → stay on same page |
| `/trade/[id]` | Click counterparty username | `/profile/[username]` |
| `/orders` (Trade History) | Click any trade row | `/trade/[id]` |
| `/wallet` | Click "Withdraw" | Inline withdraw modal |
| `/wallet` | Click "Deposit" | Shows address + QR inline |
| `/wallet` | Click "Payment Methods" | `/payment-methods` |
| `/wallet` | Click transaction row | `/orders` or `/instant-buy/status/[id]` depending on type |
| `/kyc` (approved) | Click "Upgrade to Enhanced" | `/kyc` with enhanced form shown |
| `/settings` | Click "Upgrade KYC" | `/kyc` |
| `/instant-buy` | Selects coin, clicks Next | `/instant-buy/order/[id]` |
| `/instant-buy/order/[id]` | Submits order | `/instant-buy/payment/[id]` (PKR) or `/instant-buy/crypto-deposit/[id]` (crypto) |
| `/instant-buy/payment/[id]` | Uploads screenshot | `/instant-buy/status/[id]` |
| `/instant-buy/status/[id]` | Approved | Shows completion, link to wallet |
| `/dashboard` | Click "Repeat" on last order | `/instant-buy/order/[id]` (pre-filled) |
| `/dashboard` | Click trade in recent list | `/trade/[id]` |
| `/dashboard` | Click "View All Trades" | `/orders` |
| `/dashboard` | Click "Start KYC" | `/kyc` |
| `/dashboard` | Click "Post Ad" | `/create-ad` |
| `/dashboard` | Click "My Ads" | `/my-ads` |
| `/my-ads` | Click "Edit" on ad | `/edit-ad/[id]` |
| `/my-ads` | Click ad row | `/trade/new?adId=xxx` (to preview ad as buyer sees it) |
| `/dispute-history` | Click dispute row | `/dispute/[id]` |
| `/merchant/dashboard` | Click "Edit Inventory" | Inline or `/merchant/inventory` |
| `/merchant/[id]` | Click "Trade with this merchant" | `/instant-buy?merchantId=xxx` |
| `/profile/[username]` | Click on a review | No action — reviews are read-only |
| `/leaderboard` | Click trader username | `/profile/[username]` |
| `/leaderboard` | Click merchant name | `/merchant/[id]` |
| `/notifications` | Click notification row | Type-specific page (trade, dispute, kyc, etc.) |
| Navbar bell | Click notification | Same as `/notifications` row |
| Any page | Click logo | `/` |

**Auth guards:**
- All `/dashboard`, `/orders`, `/wallet`, `/trade/*`, `/kyc`, `/settings`, `/referral`, `/my-ads`, `/create-ad` require login → redirect to `/login?next=<current-path>`
- After login redirect back to `next` param or role-appropriate dashboard
- `/marketplace`, `/`, `/leaderboard`, `/fees`, `/profile/*`, `/merchant/*` are public (no login required)

---

### Rule: Every page that shows data MUST
1. Show a loading state while fetching
2. Show an error state if fetch fails
3. Show an empty state if there is no data
4. Never initialize state with fake data
5. Show rate/fee `updatedAt` timestamps where relevant

---

### 16.0a Forgot Password — `/forgot-password`

**Step 1 — Enter Email:**
- Input: email address
- Submit → `POST /api/auth/forgot-password { email }`
- Show: "If this email is registered, you'll receive a 6-digit code."
- (Never confirm whether email exists — security best practice)

**Step 2 — Enter OTP:**
- 6-digit code input (sent to email)
- Resend button (enabled after 60 seconds): `POST /api/auth/resend-email-otp { email }`
- Submit code → moves to step 3 (validated client-side — keep code in state)

**Step 3 — New Password:**
- New password input + confirm password input
- Submit → `POST /api/auth/reset-password { email, code, newPassword }`
- On success → redirect to `/login` with message "Password reset. Please log in."
- On error (`INVALID_CODE`, `CODE_EXPIRED`) → show error, let user retry or go back to step 1

---

### 16.0b Username Setup — `/setup-username`

**When shown:** After email verification, if `user.username` is null or auto-generated.
Backend auto-generates a username on registration (e.g. `user_a4f2b1`) so the user is never blocked. This page lets them personalise it.

**Flow:**
- Redirect here after first login if `user.username` starts with `user_` (auto-generated)
- Show: "Choose your username — this is what other traders see on the marketplace."
- Input: username (3–20 chars, alphanumeric + underscore, no spaces)
- Live availability check: `GET /api/auth/check-username?username=xyz` → `{ available: bool }` — debounced 500ms
- Submit → `PATCH /api/auth/profile { username }`
- "Skip for now" → allowed, but show reminder on dashboard until username is set

**New API endpoint needed:**
```
GET /api/auth/check-username?username=xyz → { available: boolean }
```

---

### 16.1 Home Page — `/`

**Data to fetch on load:**
```
GET /api/marketplace/stats      → { totalUsers, totalTrades, totalVolume, activeMerchants }
GET /api/marketplace/top-ads    → top buy and sell ads
GET /api/marketplace/cms/home_faqs → FAQ items [{ q, a }]
GET /api/marketplace/rate/USDT  → { rate, updatedAt }
GET /api/marketplace/config     → public platform config (fetched on ALL pages)
  Response: {
    site_notice: string,            ← empty string = no banner
    site_notice_type: 'info'|'warning'|'error',
    geo_block_enabled: boolean,
    allowed_countries: string[],
    referral_reward_pkr: number,
    home_faqs: Array<{q:string,a:string}>,
  }
```

**Site Notice Banner (applies to ALL pages):**
Frontend should call `GET /api/marketplace/config` once per page load (cache 60s).  
If `site_notice` is non-empty, render a full-width banner ABOVE the navbar:
- `info` type → blue background `#dbeafe`
- `warning` type → yellow background `#fef9c3`
- `error` type → red background `#fee2e2`
Include a dismiss `×` button — dismissed state stored in `sessionStorage` (reappears next tab/session).  
Admin sets/clears via `/admin/config` (key: `site_notice`).

**UI Sections (all dynamic):**
- Hero calculator: rate from API, show "Rate updated X min ago", input default is `''`
- Stats bar: all numbers from `getStats()` — no hardcoded numbers
- Top Buy/Sell Ads: from `getTopAds()` — if empty, hide section
- FAQ: from `getCms('home_faqs')` — if empty, show nothing
- No hardcoded testimonials or user counts

---

### 16.2 Marketplace — `/marketplace`

**Data to fetch:**
```
GET /api/marketplace/ads?side=buy&coin=USDT&page=1&limit=20
GET /api/marketplace/rate/:coin  → { rate, updatedAt }
```

**State:**
- `side`: 'buy' | 'sell' — default 'buy'
- `coin`: string — default 'USDT'
- `pkrAmount`: string — default `''` (empty, never '5000')
- `ads`: Ad[] — from API
- `rate`: number | null — from API

**Ad card shows (all from API):**
- `ad.user.username`, `ad.user.badge` — trust badge
- `ad.price` — current price (updated by float pricing if float ad)
- `ad.priceType` — show "📈 Float" label if float ad
- `ad.minOrder`, `ad.maxOrder`
- `ad.paymentMethods[]`
- `ad.user.tradeStats.totalTrades`, `ad.user.tradeStats.completionRate`
- Trade button → `POST /api/trades { adId, amount }` → redirect to `/trade/:id`

---

### 16.3 Trade Page — `/trade/[id]`

**Data to fetch:**
```
GET /api/trades/:id
```

**Poll every 10 seconds** while status is active.

**Trade object includes:**
- `trade.status`: payment_pending | payment_uploaded | payment_confirmed | crypto_sent | crypto_released | cancelled | disputed
- `trade.orderRef` — shown at top with 📋 copy button
- `trade.buyer.username`, `trade.buyer.badge`
- `trade.seller.username`, `trade.seller.badge`
- `trade.coin`, `trade.network`, `trade.amount`, `trade.price`, `trade.fiatAmount`
- `trade.paymentMethod`
- `trade.messages[]` — each with `attachmentUrl?`
- `trade.paymentProofUrl`
- `trade.buyerWalletAddress` — buyer's destination address
- `trade.sellerTxHash` — shown after seller marks crypto sent
- `trade.createdAt`, `trade.expiresAt`

**Timer:** `Math.max(0, trade.expiresAt - Date.now())` — never hardcoded.

**⏰ Expiry Warning Banner (shown to buyer — proactive, not just the race condition fix):**
```typescript
const minutesLeft = Math.floor((new Date(trade.expiresAt).getTime() - Date.now()) / 60000)
// Show yellow banner when < 30 minutes remaining:
if (minutesLeft < 30 && minutesLeft > 0 && trade.status === 'payment_pending') {
  // "⚠️ This trade expires in {minutesLeft} minutes. Upload your payment proof before it expires."
}
// Show red banner when < 10 minutes remaining:
if (minutesLeft < 10 && minutesLeft > 0 && trade.status === 'payment_pending') {
  // "🚨 Hurry! Trade expires in {minutesLeft} minutes. Upload now or the trade will be cancelled."
}
```
Also send a push notification to buyer when trade has < 1 hour remaining (backend scheduled job).

**"What Happens Next?" Step Indicator (shown on all active trade pages):**
Persistent sidebar/card showing simplified status steps. Reduces confusion for first-time traders.

```
Step 1 — You pay                [✅ Done]
Step 2 — Admin verifies         [⏳ In Progress] ← current if payment_uploaded
Step 3 — Seller sends crypto    [ ]
Step 4 — You confirm receipt    [ ]
Step 5 — Trade complete         [ ]
```

- Seller sees the same steps from their perspective ("Buyer pays" → "Admin verifies" → "You send crypto" → etc.)
- Current step highlighted in blue. Completed steps in green. Future steps in gray.
- On mobile: collapsible card (tap to expand) — doesn't push the chat below the fold.

**Complete P2P Trade Status Flow:**
```
payment_pending
  → buyer uploads screenshot → payment_uploaded
    → admin confirms payment → payment_confirmed
      → seller sees "Send crypto now" prompt
        → seller clicks "I Have Sent the Crypto" → crypto_sent
          → buyer confirms receipt → crypto_released (completed)
            → rating prompt shown to both parties
```

**Actions:**
```
POST /api/trades/:id/confirm-payment   (multipart: screenshot)        → buyer uploads proof
POST /api/trades/:id/mark-crypto-sent  { txHash? }                    → seller confirms sent
POST /api/trades/:id/confirm-receipt                                   → buyer confirms received
POST /api/trades/:id/cancel            { reason }
POST /api/trades/:id/message           { message?, file? (multipart) } → chat with optional image
POST /api/trades/:id/rate              { rating: 1-5, comment?: string, tags?: string[] }
POST /api/trades/:id/dispute           { reason, description }
```

**Seller "I Have Sent the Crypto" UI:**
- Shown ONLY to seller when `trade.status === 'payment_confirmed'`
- Prominent card: "✅ Payment verified by admin. Please send {amount} {coin} to the buyer's address now."
- Buyer's wallet address: `trade.buyerWalletAddress` — shown with copy button
- Optional tx hash input field (buyer can use this to verify on-chain)
- Button: "I Have Sent the Crypto" → `POST /api/trades/:id/mark-crypto-sent`

**Buyer "Confirm Receipt" UI:**
- Shown ONLY to buyer when `trade.status === 'crypto_sent'`
- Card: "Seller says they've sent {amount} {coin}. Please check your wallet before confirming."
- Button: "✅ Yes, I Received It" → `POST /api/trades/:id/confirm-receipt` → status: `crypto_released`
- Button: "❌ I Haven't Received It" → opens dispute form inline

#### Rating System (shown after trade completes)
When `trade.status === 'crypto_released'` (completed):
- Both buyer AND seller are prompted to rate each other — separately and independently
- Neither sees the other's rating until both have submitted (or 48 hours pass)
- Rating: 1–5 stars (required)
- Comment: text (optional, max 200 chars)
- Tags (optional multi-select): "Fast Payment", "Good Communication", "Trustworthy", "Smooth Trade", "Slow Response", "Payment Issue"

**Rate prompt UI:**
- Shown as a modal/card at top of trade page after completion
- "Rate your experience with {counterparty.username}"
- Star selector (1–5, click to select, highlighted)
- Tag chips: click to toggle
- Comment textarea
- Submit button → `POST /api/trades/:id/rate`
- "Skip for now" → dismiss for 24h, show reminder once more, then auto-skip

**What happens after rating:**
- `TradeStats` for the rated user is recalculated automatically (backend job)
- Trust badge is re-evaluated
- Rating becomes visible on user's public profile

**API:**
```
POST /api/trades/:id/rate     { rating, comment?, tags? }  → submit rating
GET  /api/trades/:id/ratings  → { myRating, theirRating (null until both rated or 48h) }
```

**TradeStats recalculation (backend, triggered after each rating):**
```
completionRate = completedTrades / totalTrades
avgRating = average of all ratings received
trustScore = (completionRate * 0.5) + (avgRating/5 * 0.3) + (logScale(totalTrades) * 0.2)
badge = assigned based on trustScore + totalTrades thresholds
```

---

### 16.4 Trade History — `/orders`

```
GET /api/trades?page=1&limit=20&status=all|active|completed|cancelled&search=&coin=
```

- Filter tabs: All | Active | Completed | Cancelled
- Search input: searches by `orderRef` or counterparty username — from `search=` param
- Coin filter dropdown (USDT / BTC / ETH / All)
- Each row: orderRef (with 📋 copy button), coin, amount, fiatAmount, status badge, counterparty username+badge, date
- Click row → `/trade/:id`
- Empty state per filter: "No active trades" / "No completed trades" etc.

---

### 16.5 Trade Initiation — `/trade/new?adId=xxx`

**Purpose:** Confirmation page before a trade is created. Buyer reviews the deal details and enters the amount.

**Data to fetch:**
```
GET /api/marketplace/ads/:adId → ad details (price, seller, payment methods, terms)
GET /api/auth/me               → buyer's daily limit remaining
```

**Page shows (all from API):**
- Seller: `ad.user.username` + trust badge + `tradeStats.completionRate` + `tradeStats.totalTrades`
- Coin and network
- Price: `ad.price` PKR per coin (with "📈 Float price" label if float ad)
- Payment methods available: `ad.paymentMethods[]`
- Seller's terms: `ad.terms`
- Trade window: `ad.tradeWindow` minutes

**Amount input:**
- Enter PKR amount OR coin amount — both fields, live conversion between them using `ad.price`
- Validation: must be between `ad.minOrder` and `ad.maxOrder`
- Must not exceed user's remaining daily limit
- Show: "You'll receive: {coinAmount} {coin}" computed from input

**Confirm button → create trade:**
```
**Buyer must also provide their wallet address** to receive crypto after the trade:
- Address input: "Your {coin} wallet address ({network})" — required for sell ads
- Pre-filled if buyer has a saved address for this coin/network
- **Validation: per-network cryptographic validation (not just length/prefix — see Section 27.26)**
  - EVM (ETH / BNB / ARB / OP / AVAX / MATIC): validate EIP-55 checksum via `viem`'s `isAddress(addr)` + show warning if mixed-case checksum fails
  - Bitcoin: validate using `bitcoinjs-lib`'s `address.toOutputScript()` — rejects typos that pass length check
  - Solana: validate base58 encoded 32-byte public key
  - TRC-20 (Tron): must start with `T`, length 34, valid base58check
  - If address fails validation: show specific error "This doesn't look like a valid {network} address. Please double-check."
  - If user pastes an address for the wrong network (e.g. EVM address for TRC20): detect and show "This looks like an EVM address. You selected TRC20 network."

```
POST /api/trades { adId, amount, buyerWalletAddress }   (amount in PKR)
→ redirect to /trade/:id
```

---

### 16.6 My Ads — `/my-ads`

```
GET /api/ads
PATCH /api/ads/:id/pause
PATCH /api/ads/:id/activate
DELETE /api/ads/:id
```

Each ad shows: coin, side, price, priceType (fixed/float), floatOffset, totalAmount, minOrder, maxOrder, status, createdAt — all from API.

---

### 16.7 Create Ad — `/create-ad`

**Data to fetch:**
```
GET /api/marketplace/rate/:coin  → live market rate reference
GET /api/wallet                  → user's wallet balance
```

**Form fields — all empty by default:**
- Side: Buy / Sell
- Coin: dropdown
- Price type: Fixed or Float toggle
- If Fixed: price input (PKR per coin) — empty
- If Float: offset input (e.g. +1.5%) + live preview of resulting price
- Total amount: empty
- Min order (PKR): empty
- Max order (PKR): empty
- Payment methods: checkboxes
- Trade window: select (15, 30, 60 min)
- Terms: textarea

```
POST /api/ads { side, coin, network, priceType, price?, floatOffset?, totalAmount, minOrder, maxOrder, paymentMethods[], tradeWindow, terms }
→ redirect to /my-ads
```

---

### 16.8 Edit Ad — `/edit-ad/[id]`

**Data to fetch:**
```
GET /api/ads  → filter by id
GET /api/marketplace/rate/:coin
```

All fields pre-populated from API. Float offset shown if `ad.priceType === 'float'`.

```
PATCH /api/ads/:id { price?, floatOffset?, priceType, totalAmount, minOrder, maxOrder, paymentMethods[], tradeWindow, terms }
DELETE /api/ads/:id → redirect to /my-ads
```

---

### 16.9 Wallet — `/wallet`

**Data to fetch:**
```
GET /api/wallet              → wallets[]: { coin, network, balance, lockedBalance, depositAddress }
GET /api/wallet/transactions → paginated transaction history
GET /api/wallet/payment-methods → PKR payment methods
```

**Withdraw form:**
- Coin: from wallet list
- Network: from wallet list
- Amount: empty
- Address: empty
- Fee section (DYNAMIC — fetched live):
  ```
  GET /api/wallet/live-fee?coin=ETH&network=ERC20
  → show: Network fee: 0.001 ETH (PKR 840)
           Platform fee: 0.0018 ETH (PKR 500)
           Total fee: 0.0028 ETH (PKR 1,340)
  ```
- Show a "🔄 Refresh fee" button — re-fetch on click
- Fee timestamp: "Fee updated 30 sec ago"
- If amount ≤ total fee: show error "Amount must be greater than fee (PKR 1,340)"

```
POST /api/wallet/withdraw { coin, network, amount, toAddress }
```

**Deposit:**
```
GET /api/wallet/address/:coin/:network → { address }
```
Show address + QR code. Note: QR code is generated client-side from the address string using a library like `qrcode.react`.

**Payment Methods (PKR):**
```
GET    /api/wallet/payment-methods
POST   /api/wallet/payment-methods  { type, accountName, mobileNumber?, bankName?, ibanNumber? }
DELETE /api/wallet/payment-methods/:id
```

**Saved Crypto Addresses:**
Users can save wallet addresses so they don't retype them on every Instant Buy or withdrawal.
```
GET    /api/wallet/saved-addresses                        → list of saved addresses
POST   /api/wallet/saved-addresses { label, coin, network, address }  → save new
DELETE /api/wallet/saved-addresses/:id
```

On withdraw form and Instant Buy order form:
- Show dropdown "Use saved address" above the address input
- Each option: `{label} — {address truncated}` — from API
- Selecting one fills the address input
- Checkbox on address input: "Save this address as '{label}'" — saves on order submit

---

### 16.10 KYC — `/kyc`

```
GET /api/kyc/status → { status, kycLevel, rejectionReason? }
```

- approved → show approved badge + current level, offer "Upgrade to Enhanced" if on basic
- pending → show "Under Review", no form
- none/rejected → show form

#### Two-Tier KYC — Clearly Separated

**Basic KYC** (fast, unlocks PKR 50,000/day):
- CNIC front photo
- CNIC back photo
- Selfie holding CNIC
- Full name (pre-filled from `user.fullName`, editable)
- **No social links required** — keep it fast
- Expected review time: 1–4 hours
- Submit: `POST /api/kyc/submit { tier: 'basic', ... }`

**Enhanced KYC** (unlocks PKR 500,000/day — shown as upgrade from basic):
- All basic fields above (re-uploaded or reused from previous submission)
- **2–3 social media links (required, each 30+ days old):**
  - Up to 3 inputs, minimum 2 filled
  - Each input: URL + platform dropdown (Twitter/X, Facebook, LinkedIn, Instagram, TikTok)
  - UI note: "⚠️ All accounts must be 30+ days old. Admin verifies manually during review."
- Expected review time: 24–48 hours
- Submit: `POST /api/kyc/submit { tier: 'enhanced', ... }`

**Why social links only in Enhanced:**
- Basic KYC gets users trading quickly with minimal friction
- Social links are an enhanced fraud deterrent for high-volume traders
- New users don't get blocked on their first day by social media requirements

**Admin KYC review — enhanced tier social link steps:**
1. Click each link — confirm it opens a real, non-private profile
2. Check join date (most platforms show "Joined Month Year" on profile)
3. If any account < 30 days old → reject: "Social media account too new (must be 30+ days)"
4. If link is fake/broken → reject: "Invalid social media profile"

```
POST /api/kyc/submit (multipart/form-data)
  For basic:    { tier: 'basic', cnicFront, cnicBack, selfie, fullName }
  For enhanced: { tier: 'enhanced', cnicFront, cnicBack, selfie, fullName,
                  socialLinks: [{ platform, url }] (min 2, max 3) }
```

---

### 16.11 Settings — `/settings`

```
GET /api/auth/me
GET /api/auth/sessions
```

**Profile:**
```
PATCH /api/auth/profile { fullName, username }
```

**Change Password:**
```
POST /api/auth/change-password { currentPassword, newPassword }
```

**2FA:**
- Disabled: `POST /api/auth/2fa/setup` → show QR → `POST /api/auth/2fa/enable { code }`
- Enabled: `POST /api/auth/2fa/disable { code }`

**Sessions:**
```
DELETE /api/auth/sessions/:id
```

**Social Links (read-only display in settings):**
- Show the links submitted during KYC — read-only, cannot be changed here
- Label: "Your social media profiles were verified during KYC. To update them, submit a new KYC request."
- This prevents users from swapping in fake profiles after being approved

**Buy Limits (read-only display):**
- Show user's current KYC level and limits from `user.dailyBuyLimit`, `user.monthlyBuyLimit`
- "Upgrade KYC to increase limits" link

---

### 16.12 Instant Buy Wizard — `/instant-buy`

**Step 1 — Choose token:**
- Grid of supported tokens — metadata only (name, emoji), no prices yet

**Step 2 — Choose network + payment:**
- Network dropdown
- Pay with: PKR or Crypto
- Fetch live rates:
  ```
  GET /api/marketplace/rates → all rates at once
  ```
  Show rate for selected token: "1 USDT = PKR 278.5 (updated 3 min ago)"
  Use `Promise.allSettled()` so one failure doesn't block others.

**Step 3 — Enter amount:**
- Amount input: empty
- Live conversion as user types (rate from step 2)
- Show limit bar: "You have PKR 27,000 remaining today"
  - If amount would exceed limit: show error before submit

**Proceed → `/instant-buy/order/new?token=USDT&network=TRC20&payWith=PKR`**

---

### 16.13 Instant Buy Order Form — `/instant-buy/order/[id]`

**URL params:** `token`, `network`, `payWith`

**Data to fetch:**
```
GET /api/marketplace/rate/:token  → { rate, updatedAt }
GET /api/auth/me                  → dailyBuyUsed, dailyBuyLimit (for limit check)
```

**Form — all empty:**
- PKR amount (if PKR mode): empty
- Coin amount: computed from rate as user types
- Wallet address (destination): empty

**Rate breakdown (all computed from live rate):**
- `Rate: 1 {token} = PKR {rate}` + "updated X min ago"
- `Platform fee (1% PKR / 0.5% crypto)` — computed
- `You receive: {coinAmt * 0.99} {token}` — computed
- Refresh rate button

**Limit check:**
- If PKR amount > remaining daily limit: show "Exceeds daily limit" error

**Timer:** 600 seconds from when rate loads. Re-fetch rate on timer expiry.

**Submit:**
```
POST /api/instant-buy/orders { coin, network, paymentMode, amount, toAddress }
→ /instant-buy/payment/:id  (PKR)
→ /instant-buy/crypto-deposit/:id  (Crypto)
```

---

### 16.14 Instant Buy Payment (PKR) — `/instant-buy/payment/[id]`

**Data to fetch:**
```
GET /api/instant-buy/orders/:id
GET /api/instant-buy/payment-config
→ { jazzcash, easypaisa, accountName, bankIban, bankName, supportWhatsapp }
```

All payment details from `platformConfig` — never hardcoded.

**Timer:** `Math.max(0, new Date(order.quoteExpiresAt).getTime() - Date.now())`. Default 30 min if missing.

**Submit:**
```
POST /api/instant-buy/orders/:id/submit-payment (multipart: screenshot)
→ /instant-buy/status/:id
```

---

### 16.15 Instant Buy Crypto Deposit — `/instant-buy/crypto-deposit/[id]`

**Data:**
```
GET /api/instant-buy/orders/:id
```

**Two options shown:**

**Option A — Manual (always available):**
- Show platform's deposit address for this coin/network
- User sends from their external wallet
- User pastes tx hash
- Submit: `POST /api/instant-buy/orders/:id/confirm-deposit { txHash }`

**Option B — Connect Wallet (EVM only, optional):**
- "Connect Wallet" button → wagmi/RainbowKit connect
- Show connected address
- "Send {coinAmt} {token} to platform" button → trigger on-chain send
- On tx confirmation: auto-submit tx hash to API
- If blockchain webhook is set up: tx is auto-detected, user doesn't need to do anything

**Timer:** Same as payment page — from `order.quoteExpiresAt`.

---

### 16.16 Instant Buy Status — `/instant-buy/status/[id]`

```
GET /api/instant-buy/orders/:id
```

Poll every 15 seconds while status is `payment_uploaded` or `admin_review`.

| Status | UI |
|--------|-----|
| `payment_pending` | "Awaiting Payment" |
| `payment_uploaded` | "Verifying Payment... (Layer 1 OCR check)" |
| `admin_review` | "Under Admin Review (Layer 2)" |
| `completed` | "Order Complete ✅" |
| `rejected` | "Order Rejected ❌" + `order.rejectionReason` from API |

---

### 16.17 Instant Buy History — `/instant-buy/history`

```
GET /api/instant-buy/orders?page=1&limit=20
```

Each row from API: orderRef, coin, coinAmount, fiatAmount, status, paymentMode, createdAt.

---

### 16.18 Dispute History — `/dispute-history`

```
GET /api/disputes
```

Tabs: All, Open, Resolved. Each card: all fields from API.

---

### 16.19 Dispute Detail — `/dispute/[id]`

```
GET /api/disputes/:id
POST /api/disputes/:id/message { message }
POST /api/disputes/:id/evidence (multipart)
```

---

### 16.20 Open Dispute

```
POST /api/disputes { tradeId, reason, description }
→ /dispute/:id
```

---

### 16.21 Merchant Apply & KYC — `/merchant-apply`

#### Important Design Decision
Merchants do NOT need to complete regular user KYC first. They go through a single **Merchant KYC** flow that is stricter than user KYC and covers everything in one submission. This avoids double friction.

| Regular User KYC | Merchant KYC |
|-----------------|--------------|
| CNIC front + back + selfie | CNIC front + back + selfie |
| 1 social link (Twitter or Facebook) | — |
| — | Business proof (NTN certificate OR bank statement showing business activity OR trade license) |
| — | Business name + description |
| — | Contact phone number |
| — | **2–3 social/business links (required):** business Facebook/Instagram page + personal Twitter/LinkedIn + optional website |
| — | Agreement to merchant terms |

**Merchant social links rules:**
- Minimum 2 links required, max 3
- At least one must be a business presence (Facebook Business page, Instagram Business, or website)
- At least one must be a personal professional link (LinkedIn or Twitter/X)
- **All accounts must be at least 30 days old — same rule as user KYC**
- Admin verifies each link manually during merchant KYC review: click the link, check join date, confirm it's real
- Newly created social accounts → KYC rejected with reason "Social media account too new (must be 30+ days old)"
- All stored in `MerchantKycSubmission.socialLinks[]` and copied to `Merchant.socialLinks[]` on approval
- Visible to admin always for investigation purposes
- Visible publicly on merchant profile only if `platformConfig: show_merchant_social_links = true` (default false)

#### Flow
1. User registers a normal account (email + password) — no KYC needed yet
2. User goes to `/merchant-apply`
3. If they already did user KYC — that data is reused, they only need to add business proof
4. If they did NOT do user KYC — the merchant apply form includes CNIC fields inline
5. Submission → admin reviews in a dedicated **Merchant KYC Queue** (separate from user KYC queue)
6. Admin approves → system automatically locks 100 USDT collateral from merchant's wallet
   - If merchant does not have 100 USDT in their PakSwap wallet → approval is held → merchant notified to deposit first
7. Merchant role assigned → redirect to Merchant Dashboard

#### Status Page
`GET /api/merchants/me` returns:
```json
{
  "status": "none | pending | approved | rejected | pending_collateral",
  "rejectionReason": "...",
  "collateralLocked": false,
  "collateralAmount": 100,
  "submittedAt": "..."
}
```

`pending_collateral` = approved by admin but merchant hasn't deposited 100 USDT yet.

#### API
```
GET  /api/merchants/me          → current merchant status
POST /api/merchants/apply       { businessName, businessDescription, contactPhone,
                                  businessProofType: 'ntn'|'bank_statement'|'trade_license' }
                                + multipart: cnicFront?, cnicBack?, selfie?, businessProofFile
POST /api/merchants/activate    → called after merchant deposits collateral → triggers role assignment
```

#### Admin — Merchant KYC Queue
```
GET  /api/admin/merchants/queue
GET  /api/admin/merchants/:id
POST /api/admin/merchants/:id/approve  { notes? }  → sets status 'pending_collateral', sends email
POST /api/admin/merchants/:id/reject   { reason }
```

---

### 16.22 User Dashboard — `/dashboard`

**This is the home page for logged-in regular users.** Redirected here after login if `role === 'user'`.

**Data to fetch — use the aggregation endpoint (single call, not 7 separate calls):**
```
GET /api/dashboard/summary
→ {
    user: { ...User object with kycStatus, dailyBuyUsed, dailyBuyLimit, monthlyBuyUsed, monthlyBuyLimit },
    wallets: Wallet[],
    recentTrades: Trade[5],
    recentInstantBuy: InstantBuyOrder[3],
    usdtRate: { rate, updatedAt },
    notifications: { items: Notification[5], unreadCount: number },
    rank: { badge, badgeLabel, badgeIcon, trustScore, totalTrades, completionRate, nextBadge }
  }
```

**Why:** On a 3G mobile connection, 7 parallel API calls take 4–8 seconds (limited by the slowest). One aggregated call takes 300–800ms. This is the single highest-impact performance fix for the dashboard.

**Fallback:** If `/api/dashboard/summary` is not yet built, call the 7 individual endpoints with `Promise.allSettled()` so one failure does not block the rest:
```typescript
const [meRes, walletsRes, tradesRes, ibRes, rateRes, notifRes, rankRes] = await Promise.allSettled([
  api.get('/auth/me'), api.get('/wallet'), api.get('/trades?limit=5'),
  api.get('/instant-buy/orders?limit=3'), api.get('/marketplace/rate/USDT'),
  api.get('/notifications?limit=5&unread=true'), api.get('/users/me/rank'),
])
// Each result: check res.status === 'fulfilled' before using res.value
```

**Dashboard sections (all from API, never hardcoded):**

**1. Welcome bar**
- "Welcome back, {user.fullName.split(' ')[0]}" — from Zustand store
- KYC status badge: "✅ KYC Verified" / "⚠️ KYC Pending" / "❌ KYC Required" — from `user.kycStatus`
- Daily limit bar: "PKR {dailyBuyUsed.toLocaleString()} / {dailyBuyLimit.toLocaleString()} used today" — from API
- "Upgrade KYC" button if kycLevel is 'none' or 'basic'

**2. Portfolio (wallet balances)**
- Cards for each coin with non-zero balance: `wallet.coin`, `wallet.balance`, `wallet.lockedBalance`
- PKR equivalent: `wallet.balance * rate` — computed using live rate from API
- "Deposit" + "Withdraw" quick actions per coin
- If all balances are zero: show "No funds yet — deposit to get started"

**3. Quick Actions row**
- Buy Crypto → `/instant-buy`
- Marketplace → `/marketplace`
- My Ads → `/my-ads`
- Referral → `/referral`

**4. Recent Trades (last 5)**
- From `GET /api/trades?limit=5`
- Each row: orderRef, coin, amount, status badge, counterparty username, date
- "View All" → `/orders`
- Empty state: "No trades yet" — never fake trades

**5. Recent Instant Buy Orders (last 3)**
- From `GET /api/instant-buy/orders?limit=3`
- Each row: orderRef, coin, coinAmount, fiatAmount, status badge, date
- **"Repeat" button on last completed order** → pre-fills Instant Buy wizard with same coin/network/payWith, skipping step 1 and 2, landing on step 3 (amount entry) — saves returning users 2 clicks
- "View All" → `/instant-buy/history`

**6. Trader Badge Card**
- From `GET /api/users/me/rank`
- Shows: badge icon + label (e.g. "⭐ Trusted Trader"), trust score bar
- Progress to next tier: "X more trades + Y% completion needed for Top Trader"
- If already Elite: "🏆 You've reached the highest tier!"
- Link to own public profile: `/profile/{user.username}`

**7. Notifications (unread only, max 5)**
- From `GET /api/notifications?limit=5&unread=true`
- "View All" → `/notifications`

**8. Site Notice Banner (global — shown on ALL pages when set)**
- On every page load, frontend checks `GET /api/marketplace/config` which includes `site_notice`
- If `site_notice` is non-empty: show a yellow banner at the top of the page, above the navbar
- Example: "⚠️ Platform maintenance scheduled for Sunday 2am–4am PKT"
- User can dismiss it for the session (localStorage flag), but it reappears on next session
- Admin sets/clears via admin dashboard or `/admin/config`

---

### 16.23 Merchant Dashboard — `/merchant/dashboard`

**This is the home page for merchants.** Redirected here after login if `role === 'merchant'`.

**Data to fetch — use the merchant aggregation endpoint (single call):**
```
GET /api/merchants/dashboard/summary
→ {
    merchant: { ...Merchant, spreadBps, status, disputeRate, rank, rankUpdatedAt },
    user: { ...User },
    wallets: Wallet[],
    collateral: { locked, amount, canUnlock, activeTradesCount },
    recentTrades: Trade[10],
    inventory: MerchantInventory[],
    stats: { totalTrades, totalVolumePKR, totalRevenuePKR, avgRating, completionRate,
             trades24h, volume24h, revenue24h },
    rates: { USDT: number, BTC: number, ETH: number, ... },
    notifications: { items: Notification[5], unreadCount: number },
    rank: { badge, badgeLabel, badgeIcon, trustScore, totalTrades, completionRate, nextBadge }
  }
```

**Why:** Same reason as user dashboard — 9 parallel mobile requests on 3G takes 6–10 seconds. One aggregated call takes 400–800ms.

**Backend implementation:**
```typescript
// GET /api/merchants/dashboard/summary
const [merchant, wallets, collateral, trades, inventory, stats, rates, notifs, rank] = await Promise.all([
  db.merchant.findUnique({ where: { userId }, include: { user: true } }),
  db.wallet.findMany({ where: { userId } }),
  getCollateralStatus(userId),
  db.trade.findMany({ where: { OR: [{ buyerId: userId }, { sellerId: userId }] }, take: 10, orderBy: { createdAt: 'desc' } }),
  db.merchantInventory.findMany({ where: { merchant: { userId } } }),
  getMerchantStats(userId),
  getRatesFromCache(),   // Redis cache from rate updater cron
  getNotifications(userId, 5),
  getUserRank(userId),
])
```

**Fallback:** If `/api/merchants/dashboard/summary` is not yet built, call the 9 individual endpoints with `Promise.allSettled()` so one failure does not block the rest.

**Dashboard sections:**

**1. Merchant Status Bar**
- Business name: from `merchant.businessName` (API)
- Status badge: "✅ Active Merchant" / "⚠️ Suspended" — from API
- Merchant rank badge: e.g. "🥇 Gold Merchant" — from `merchant.rank`, shown with colour (Bronze=brown, Silver=gray, Gold=amber, Platinum=indigo gradient)
- Rank updated at: "Rank updated {date}" — from `merchant.rankUpdatedAt`
- Progress hint: e.g. "PKR X more volume needed for Platinum" — computed from thresholds
- Collateral: "🔒 100 USDT Locked" + "Unlock" button (only if `canUnlock === true`)
- Dispute rate: `{(merchant.disputeRate * 100).toFixed(1)}%` — from API, red if > 10%
- If `disputeRate > 0.10`: show warning "Your dispute rate is high. Collateral will double if it exceeds 10%."

**2. Spread Control**
- Current spread: loaded from `merchant.spreadBps / 100` — from API
- Slider or input: 0% to max allowed by admin
- Live preview: "Market rate PKR 278 → Your price PKR {278 * (1 + spread/100)}"
- Save: `PATCH /api/merchants/me/spread { spreadBps }`

**3. Inventory Management**
- Table of `GET /api/merchants/me/inventory` — coin, network, availableAmount, pricePerUnit, PKR value
- PKR value = `inventory.availableAmount * rate[inventory.coin]` — computed from live rates
- Add: `POST /api/merchants/me/inventory { coin, network, availableAmount, pricePerUnit }`
- Remove: `DELETE /api/merchants/me/inventory/:id`
- Empty state: "No inventory — add coins to start selling"

**4. Recent Trades (last 10)**
- From `GET /api/trades?limit=10`
- Show both buy and sell sides
- Revenue column: fee earned per trade (from API)

**4b. Low Inventory Alerts**
- Any inventory item where `availableAmount < platformConfig.inventory_low_stock_threshold`:
  - Show inline warning on that inventory row: "⚠️ Low stock"
  - Also shown as a notification (from `GET /api/notifications`)
  - Email sent automatically by backend (see email templates)

**5. Revenue Summary**
```
GET /api/merchants/me/stats
→ { totalTrades, totalVolumePKR, totalRevenuePKR, avgRating, completionRate,
    trades24h, volume24h, revenue24h }
```
Show: Today's trades, today's volume, today's revenue, overall rating — all from API.

**6. Notifications**

---

### 16.24 Merchant Public Profile — `/merchant/[id]`

```
GET /api/merchants/:id → { merchant, user, stats, reviews[], inventory[] }
```

All data from API. Show trust badge. Reviews from real trades. Empty state if no reviews.

**"Trade with this merchant" button:**
- Shown to any logged-in user browsing the merchant profile
- Clicks → `/marketplace?merchant={id}` (marketplace pre-filtered to show only this merchant's ads)
- If merchant has no active ads: button is disabled, tooltip: "No active ads from this merchant"
- If not logged in: button → `/login?redirect=/merchant/{id}`

**Social links (shown only if `platformConfig: show_merchant_social_links = true`):**
- Display as icon links (Twitter bird, Facebook F, LinkedIn in, Instagram camera, website globe)
- Never shown by default — admin must enable

---

### 16.25 Payment Methods — `/payment-methods`

```
GET    /api/wallet/payment-methods
POST   /api/wallet/payment-methods { type, accountName, mobileNumber?, bankName?, ibanNumber? }
DELETE /api/wallet/payment-methods/:id
```

Account name pre-filled from `user.fullName` but editable.

---

### 16.26 Referral — `/referral`

```
GET /api/referral → { rewards[], totalEarned, totalReferrals, activeReferrals }
```

- referralCode: from `user.referralCode` in Zustand store
- All stats from API
- Referred users table: real data, names masked as `F*** K***`
- Empty state if no referrals — never fake names
- Share links: WhatsApp, Telegram, Facebook — built from real referralCode

---

### 16.27 Notifications — `/notifications`

```
GET   /api/notifications?page=1&limit=20
PATCH /api/notifications/:id/read
PATCH /api/notifications/read-all
```

All fields from API: title, body, type, createdAt, isRead. Each row shows the icon for its type.

**Notification Types (stored in `Notification.type`):**
| Type | Icon | When triggered |
|------|------|----------------|
| `trade_started` | 🔄 | New trade initiated with you |
| `payment_uploaded` | 💳 | Buyer uploaded payment proof |
| `payment_confirmed` | ✅ | Admin confirmed payment |
| `crypto_sent` | 📤 | Seller marked crypto sent |
| `trade_completed` | 🎉 | Trade completed |
| `trade_cancelled` | ❌ | Trade cancelled |
| `dispute_opened` | ⚠️ | Dispute raised on your trade |
| `dispute_resolved` | ⚖️ | Dispute resolved |
| `kyc_approved` | ✅ | KYC approved |
| `kyc_rejected` | ❌ | KYC rejected |
| `withdrawal_approved` | 💸 | Withdrawal processed |
| `withdrawal_rejected` | ❌ | Withdrawal rejected |
| `referral_reward` | 🎁 | Referral reward earned |
| `collateral_prompt` | 🔒 | You've completed 3 trades, lock collateral to continue |
| `badge_upgraded` | 🏅 | Your trader badge level increased |
| `badge_downgraded` | 📉 | Your trader badge level decreased |
| `merchant_rank_upgraded` | 🥇 | Your merchant rank increased |
| `merchant_rank_downgraded` | 📉 | Your merchant rank decreased |
| `low_inventory` | ⚠️ | Merchant inventory running low |
| `instant_buy_approved` | ✅ | Instant Buy order completed |
| `instant_buy_rejected` | ❌ | Instant Buy order rejected |

Unread count is shown as a red badge on the bell icon in the navbar (`GET /api/notifications?unread=true&limit=1` to get count only, or use the count from full fetch).

---

### 16.28 User Public Profile — `/profile/[username]`

```
GET /api/users/:username/profile
→ { username, badge, tradeStats, trustScore, recentReviews[], joinedAt }
```

This is the public-facing page anyone can view. Shows trust badge, merchant rank, and real reviews. Never hardcode any stats.

**Sections:**
- Header: username, badge icon + label, member since (year only), trust score bar
- Stats row: Total Trades | Completion Rate | Avg Rating (stars) | Volume (PKR) — all from `tradeStats`
- Badge progress card: current badge, progress bar toward next badge (trades needed, completion rate needed)
- Recent reviews (last 10): reviewer masked name, star rating, comment, trade date — from `tradeStats.recentReviews`
- Empty state if no reviews yet

---

### 16.29 Leaderboard — `/leaderboard` (Public, No Login Required)

Shows top traders and top merchants by real trade volume. All data from API.

```
GET /api/leaderboard?type=traders&period=all|30d|7d&page=1&limit=20
GET /api/leaderboard?type=merchants&period=all|30d|7d&page=1&limit=20
```

**UI:**
- Two tabs: "Top Traders" and "Top Merchants"
- Period filter: All Time / This Month / This Week
- Traders table columns: # Rank | Username | Badge | Total Trades | Completion % | Avg Rating | Volume (PKR)
- Merchants table columns: # Rank | Merchant Name | Merchant Rank | Volume (PKR) | Avg Rating | Dispute Rate
- Top 3 get gold/silver/bronze visual treatment (🥇 🥈 🥉 row highlight)
- Platinum merchants shown with gradient border and a ⭐ Featured marker
- Clicking a username → `/profile/[username]` (trader) or `/merchant/[id]` (merchant)
- No full names or emails — username only, no CNIC, no contact info

**Notes:**
- This page is fully public — no login required — to build trust with new visitors
- "All Time" is the default view
- Pagination: 20 per page, show total count

---

### 16.30 Fees Page — `/fees` (Public, No Login Required)

Displays all platform fees in one place. All values come from `GET /api/marketplace/config` and `GET /api/wallet/fee-schedule`.

**Sections:**
1. **P2P Trading Fees**
   - Maker fee: 0% (ad poster earns by setting their own price)
   - Taker fee: 0% (fee is embedded in the ad price — no explicit taker fee)
   - Note: Seller sets price above market; buyer pays that price. Platform takes nothing extra on P2P trades.

2. **Instant Buy Fees (OTC)**
   - PKR payment: Platform spread (shown as %) — fetched from config key `instant_buy_pkr_fee_pct`
   - Crypto payment: shown as % — fetched from config key `instant_buy_crypto_fee_pct`
   - Both displayed as: `"We include a X% service fee in the quoted rate"`

3. **Withdrawal Fees (per coin)**
   - Fetched from `GET /api/wallet/fee-schedule`
   - Response: `[{ coin, network, networkFee, platformFee, totalFee, minWithdraw, unit }]`
   - Show as a table: Coin | Network | Network Fee | Platform Fee | Total Fee | Min Withdrawal
   - Add note: "Network fees are live estimates — final fee shown at time of withdrawal"

4. **Referral Reward**
   - Show `referral_reward_pkr` value from config
   - "You earn X PKR + your friend earns X PKR after their first completed trade"

5. **KYC Limits**
   - Basic KYC: buy up to `kyc_basic_daily_limit` PKR/day, `kyc_basic_monthly_limit` PKR/month
   - Enhanced KYC: up to `kyc_enhanced_daily_limit` / month
   - Values fetched from `GET /api/marketplace/config`

**API Endpoints:**
```
GET /api/marketplace/config   → fee percentages, referral reward, KYC limits
GET /api/wallet/fee-schedule  → withdrawal fees per coin/network
```

This page is accessible without login. No authentication required.

---

## 17. Admin Panel Pages — `/admin/*`

**Access guard:** Every admin page checks `user.role`. If `role === 'user'` or `role === 'merchant'`, redirect to their respective dashboard.

**Admin Sidebar Navigation (visible on all admin pages):**
| Link | Route | Who sees it |
|------|-------|------------|
| Dashboard | `/admin` | All roles |
| KYC Queue | `/admin/kyc` | kyc_reviewer, admin, super_admin |
| Merchant KYC | `/admin/merchants/kyc` | kyc_reviewer, admin, super_admin |
| Payments | `/admin/payments` | admin, super_admin |
| Instant Buy | `/admin/instant-buy` | admin, super_admin |
| Withdrawals | `/admin/withdrawals` | admin, super_admin |
| Disputes | `/admin/disputes` | dispute_agent, admin, super_admin |
| Users | `/admin/users` | admin, super_admin |
| Fraud Flags | `/admin/fraud` | admin, super_admin |
| Audit Log | `/admin/audit` | admin, super_admin |
| Rates | `/admin/rates` | admin, super_admin |
| Revenue | `/admin/revenue` | admin, super_admin |
| Analytics | `/admin/analytics` | All roles |
| Platform Config | `/admin/config` | super_admin only |
| Team | `/admin/team` | super_admin only |
| Wallet | `/admin/wallet` | super_admin only |
| Gas Fees | `/admin/gas` | admin, super_admin |

---

### 17.1 Admin Dashboard — `/admin`

```
GET /api/admin/dashboard/stats
→ {
    pendingKyc, pendingMerchantKyc, pendingTrades, openDisputes,
    pendingWithdrawals, pendingInstantBuy, escalatedTrades,
    totalUsers, activeUsers24h,
    totalVolume24h, totalVolumeWeek, totalVolumeMonth,
    revenueToday, revenueWeek, revenueMonth, revenueAllTime
  }
```

**Every stat count is a clickable link to the relevant queue:**
- `pendingKyc` → `/admin/kyc`
- `pendingMerchantKyc` → `/admin/merchants/kyc`
- `pendingTrades` → `/admin/payments`
- `openDisputes` → `/admin/disputes`
- `pendingWithdrawals` → `/admin/withdrawals`
- `pendingInstantBuy` → `/admin/instant-buy`
- `escalatedTrades` → `/admin/payments?filter=escalated` — shown in RED if > 0, never just a number

**Revenue card (all from API, never hardcoded):**
- Today / This Week / This Month / All Time — PKR values from `revenueToday`, `revenueWeek`, etc.
- "Full report →" links to `/admin/revenue`

**Site Notice control (inline):**
- Text input showing current `site_notice` from platformConfig
- "Set Notice" → `PATCH /api/admin/config { updates: { site_notice: '...' } }`
- "Clear" → sets to `''`
- Label: "Banner shown to ALL users on every page when set"

---

### 17.2 KYC Queue (Users) — `/admin/kyc`

```
GET /api/admin/kyc/queue?page=1&status=pending&kycLevel=basic|enhanced&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&search=
GET /api/admin/kyc/:id
POST /api/admin/kyc/:id/approve { kycLevel, cnicNumber }
POST /api/admin/kyc/:id/reject  { reason }
```

Filters on the page: Status (pending/approved/rejected), KYC Level (basic/enhanced), Date range picker (dateFrom/dateTo), Search (name or email).

On approve: backend checks `cnicNumber` uniqueness. If duplicate, return error `CNIC_ALREADY_REGISTERED`.

---

### 17.2b Merchant KYC Queue — `/admin/merchants/kyc`

Separate queue from user KYC. Shows business proof + CNIC together.

```
GET /api/admin/merchants/queue?page=1&status=pending|approved|rejected&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&search=
GET /api/admin/merchants/:id         → full submission with all documents
POST /api/admin/merchants/:id/approve { notes? }
  → sets merchant status to 'pending_collateral'
  → sends email: "Approved — deposit 100 USDT to activate your merchant account"
POST /api/admin/merchants/:id/reject  { reason }
  → sends email with reason
```

When merchant deposits collateral and calls `POST /api/merchants/activate`:
- Backend verifies wallet balance ≥ `collateral_merchant` USDT
- Locks collateral: moves from `balance` to `lockedBalance` in Wallet
- Creates `CollateralLock` record
- Sets `User.role = 'merchant'`, `Merchant.status = 'approved'`
- Sends approval email

---

### 17.3 Payments Queue — `/admin/payments`

```
GET  /api/admin/payments/queue?page=1&status=pending|approved|rejected&coin=USDT|BTC|ETH&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&minAmount=&maxAmount=
POST /api/admin/payments/:id/approve
POST /api/admin/payments/:id/reject { reason }
```

Filters on page: Status, Coin, Date range, Amount range (minAmount/maxAmount in PKR).

---

### 17.4 Disputes Queue — `/admin/disputes`

```
GET  /api/admin/disputes/queue?page=1&status=open|resolved&escalated=true&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&search=
POST /api/admin/disputes/:id/resolve { winner: 'buyer'|'seller', resolution }
```

Show escalation flag if dispute is > 48h old. Filters: Status, Escalated only toggle, Date range, Search by trade ID or username.

---

### 17.5 Instant Buy Queue — `/admin/instant-buy`

```
GET  /api/admin/instant-buy/queue?page=1&status=pending|approved|rejected&coin=&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&minAmount=&maxAmount=&ocrResult=passed|failed|pending
POST /api/admin/instant-buy/:id/approve
POST /api/admin/instant-buy/:id/reject { reason }
```

Show Layer 1 OCR result alongside each order (passed/failed/pending). Filters: Status, Coin, Date range, Amount range (PKR), OCR result.

---

### 17.6 Withdrawals Queue — `/admin/withdrawals`

```
GET  /api/admin/withdrawals?page=1&status=pending|approved|rejected&coin=&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&minAmount=&maxAmount=
POST /api/admin/withdrawals/:id/approve
POST /api/admin/withdrawals/:id/reject { reason }
```

Filters: Status, Coin, Date range, Amount range (in coin units).

---

### 17.7 User Management — `/admin/users`

```
GET  /api/admin/users?page=1&search=&status=active|suspended|banned&role=user|merchant&kycLevel=none|basic|enhanced&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
GET  /api/admin/users/:id
POST /api/admin/users/:id/suspend   { reason }
POST /api/admin/users/:id/ban       { reason }
POST /api/admin/users/:id/unsuspend
```

Filters: Search (name/email/username), Status (active/suspended/banned), Role, KYC level, Registration date range.

---

### 17.8 Fraud Flags — `/admin/fraud`

```
GET  /api/admin/fraud/flags?page=1&reviewed=true|false&type=duplicate_cnic|multiple_accounts|suspicious_transfer|other&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
POST /api/admin/fraud/flags/:id/review { actionTaken }
```

Filters: Reviewed/unreviewed, Flag type, Date range.

---

### 17.9 Audit Log — `/admin/audit`

```
GET /api/admin/audit-log?page=1&adminId=&action=&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&search=
```

Filters: Admin user (dropdown of all staff), Action type (approve_kyc/reject_kyc/ban_user/resolve_dispute/…), Date range, Search by target user or note text. Each row shows: timestamp, admin name, action, target, notes.

---

### 17.10 Rate Monitor — `/admin/rates`

**New page — shows live rate health.**

```
GET /api/admin/rates/status
→ {
    rates: { USDT: { value: 278.5, updatedAt: '...', source: 'binance' }, ... },
    lastCronRun: string,
    nextCronRun: string,
    cronStatus: 'healthy' | 'stale' | 'failed'
  }
```

If `cronStatus === 'stale'` (last run > 10 min ago): show alert in red.
Admin can trigger manual rate refresh: `POST /api/admin/rates/refresh`
Admin can override a specific rate manually: `PATCH /api/admin/rates { coin, rate }` (sets it in platformConfig and marks `source: 'manual'`)

---

### 17.11 Platform Config — `/admin/config`

```
GET   /api/admin/config
PATCH /api/admin/config { updates: { [key]: value } }
```

**All required platformConfig keys:**

| Key | Description | Example |
|-----|-------------|---------|
| `ib_jazzcash_number` | Instant Buy JazzCash | `03001234567` |
| `ib_easypaisa_number` | Instant Buy Easypaisa | `03001234567` |
| `ib_account_name` | Account name | `PakSwap (Pvt) Ltd` |
| `ib_bank_iban` | Bank IBAN | `PK36HABB0000049501460064` |
| `ib_bank_name` | Bank name | `HBL` |
| `support_whatsapp` | Support WhatsApp | `+923001234567` |
| `platform_fee_ERC20` | Platform fee on ERC20 withdrawals (USDT) | `1.2` |
| `platform_fee_BEP20` | Platform fee on BEP20 withdrawals (USDT) | `0.3` |
| `platform_fee_TRC20` | Platform fee on TRC20 withdrawals (USDT) | `0.5` |
| `platform_fee_SOL` | Platform fee on SOL withdrawals | `0.005` |
| `platform_fee_BTC` | Platform fee on BTC withdrawals | `0.00005` |
| `fee_network_TRC20` | Network fee TRC20 (flat, USDT) | `1` |
| `fee_network_BEP20` | Network fee BEP20 (flat, USDT) | `0.5` |
| `usd_pkr_rate` | USD/PKR manual override (used if external API fails) | `278.5` |
| `rate_update_interval_minutes` | How often cron updates rates | `5` |
| `kyc_limit_basic_daily` | Daily buy limit basic KYC (PKR) | `50000` |
| `kyc_limit_basic_monthly` | Monthly buy limit basic KYC (PKR) | `200000` |
| `kyc_limit_enhanced_daily` | Daily buy limit enhanced KYC (PKR) | `500000` |
| `kyc_limit_enhanced_monthly` | Monthly buy limit enhanced KYC (PKR) | `2000000` |
| `trade_auto_cancel_hours` | Hours before pending trade auto-cancels | `4` |
| `trade_escalate_hours` | Hours before unreviewed trade escalates | `2` |
| `dispute_escalate_hours` | Hours before dispute escalates to super_admin | `48` |
| `referral_reward_pkr` | Reward per successful referral (PKR) | `500` |
| `collateral_min_sell` | Min USDT to lock to post sell ads | `50` |
| `collateral_merchant` | USDT locked on merchant approval | `100` |
| `require_collateral_to_sell` | Block all sell ads without collateral | `false` |
| `merchant_max_spread_bps` | Max spread merchants can set (bps) | `300` |
| `show_user_social_links` | Make user social links public on profiles | `false` |
| `show_merchant_social_links` | Make merchant social links public on merchant profiles | `false` |
| `home_faqs` | JSON FAQ array | `[{"q":"...","a":"..."}]` |
| `collateral_free_sell_trades` | Number of free sell trades before collateral required | `3` |
| `inventory_low_stock_threshold` | Units below which merchant gets low stock alert | `10` |
| `site_notice` | JSON or empty — shown as global banner on all pages | `""` |
| `site_notice_type` | Banner colour type: `info`, `warning`, `error` | `"info"` |

---

### 17.12 Team Management — `/admin/team`

```
GET    /api/admin/team
POST   /api/admin/team/invite { email, role }
PATCH  /api/admin/team/:userId/role { role }
DELETE /api/admin/team/:userId
```

---

### 17.13 Revenue Dashboard — `/admin/revenue`

**Purpose:** Shows platform earnings over time. Access: `admin` and `super_admin` only.

**Data to fetch:**
```
GET /api/admin/revenue?period=7d|30d|90d|all&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
→ {
    summary: {
      totalRevenuePkr: number,      ← sum of all platform fees collected (PKR equivalent)
      instantBuyRevenue: number,    ← fees from Instant Buy orders
      withdrawalFeeRevenue: number, ← platform portion of withdrawal fees
      referralPayouts: number,      ← total referral rewards paid out
      netRevenue: number,           ← totalRevenue - referralPayouts
    },
    byDay: [{ date: string, revenue: number }],   ← for chart
    byCoin: [{ coin: string, revenue: number }],  ← breakdown per coin
    recentTransactions: [{ id, type, amount, coin, createdAt, description }]
  }
```

**UI Sections:**
1. Period selector: 7D / 30D / 90D / All Time / Custom range
2. 4 summary cards: Total Revenue | Instant Buy Revenue | Withdrawal Fees | Net (after referral payouts)
3. Line chart: Daily revenue over selected period (use any simple charting library, or ASCII fallback with sorted table)
4. Bar chart / table: Revenue by coin (USDT, BTC, ETH, etc.)
5. Recent fee transactions table: columns = Date | Type | Coin | Amount | Description

**Backend:**
- Revenue = sum of `Transaction` rows where `type = 'fee'` with the platform portion only
- Instant Buy revenue = platform spread fee per order
- Withdrawal revenue = `platformFee` column per withdrawal
- Do NOT count network fees as revenue (those go to miners)
- Referral payouts = sum of `Transaction` rows where `type = 'referral_reward'`

```
GET /api/admin/revenue?period=30d
```

Admin also sees this as the "Revenue" card already present on the main admin dashboard (`/admin`) which links to this page.

---

### 17.14 Analytics Dashboard — `/admin/analytics`

**Purpose:** Platform health — badge distribution, trader growth, merchant performance. Access: all admin roles.

**Purpose:** Platform health — badge distribution, trader growth, merchant performance. Access: all admin roles.

**Data to fetch:**
```
GET /api/admin/analytics?period=7d|30d|90d|all
→ {
    userGrowth: [{ date, newUsers, newMerchants }],    ← daily signups
    badgeDistribution: {                                ← how many users at each badge tier
      new: number,
      active: number,
      trusted: number,
      top: number,
      elite: number
    },
    merchantRankDistribution: {
      bronze: number,
      silver: number,
      gold: number,
      platinum: number
    },
    topTraders: [{ username, badge, totalTrades, completionRate, totalVolumePKR }],  ← top 10
    topMerchants: [{ username, merchantRank, totalVolumePKR, avgRating, disputeRate }], ← top 10
    tradeVolume: [{ date, volumePKR, tradeCount }],    ← daily trade volume
    kycStats: { none: n, pending: n, basic: n, enhanced: n, rejected: n },
    disputeRate: number,                                ← platform-wide dispute rate %
    avgCompletionRate: number,                          ← platform-wide completion rate %
  }
```

**UI Sections:**
1. **User Growth Chart** — line chart of daily new registrations (users + merchants separately) over selected period
2. **Badge Distribution** — donut or bar chart showing count per badge tier
3. **Merchant Rank Distribution** — donut chart: Bronze / Silver / Gold / Platinum counts
4. **Trade Volume Chart** — daily bar chart: trade count + PKR volume
5. **KYC Funnel** — horizontal funnel: Registered → KYC Submitted → Basic Approved → Enhanced Approved
6. **Top 10 Traders** — table: rank, username (clickable → admin user detail), badge, trades, completion %, volume
7. **Top 10 Merchants** — table: rank, name (clickable → admin merchant detail), merchant rank, volume, rating, dispute rate
8. **Platform Health** — two big numbers: Overall Completion Rate | Overall Dispute Rate

**Backend endpoint:** `GET /api/admin/analytics`
- Aggregates from `TradeStats`, `User`, `Merchant`, `Trade`, `KycSubmission` tables
- Period filter narrows `Trade.createdAt` and `User.createdAt`
- Top traders/merchants always show all-time stats (period filter only affects charts)

---

### 17.15 Platform Wallet Management — `/admin/wallet`

**Access:** `super_admin` only. See full spec in Section 11b.

```
GET  /api/admin/wallet/addresses
POST /api/admin/wallet/addresses { coin, network, address, label? }
GET  /api/admin/wallet/balance-summary
POST /api/admin/wallet/balance-summary { coin, network, estimatedBalance }
GET  /api/admin/wallet/pending-payouts
→ { withdrawals: [{ coin, total, count }], instantBuy: [{ coin, total, count }] }
```

Link from admin dashboard sidebar and from every withdrawal/instant-buy approval page (operator needs to see their balance before sending).

---

### 17.16 Gas Fee Operations — `/admin/gas`

> 📄 **Full spec:** [GAS_FEE_SPEC.md](GAS_FEE_SPEC.md) Section 13

**Access:** `admin`, `super_admin`

Dashboard showing gas fee order volume, hot wallet TRX balance, and failed orders. Automated system — admins intervene only for failures and unattributed payments.

```
GET    /api/admin/gas/orders                     → paginated order list with filters
GET    /api/admin/gas/orders/:orderRef           → order detail
POST   /api/admin/gas/orders/:id/retry           → retry failed delivery
POST   /api/admin/gas/orders/:id/refund          → manual refund (admin marks as refunded)
GET    /api/admin/gas/unattributed               → payments received with no matching order
POST   /api/admin/gas/unattributed/:id/attribute → manually attribute to an order
GET    /api/admin/gas/wallets                    → hot wallet balances per chain
POST   /api/admin/gas/chains/:chain/toggle       → pause/resume orders for a chain (super_admin)
```

Key metrics shown at top: total orders today, revenue today, pending orders, failed orders, TRX hot wallet balance.

---

## 18. Database — Key Tables

```
User
  id, email, fullName, username, passwordHash
  role: user|merchant|kyc_reviewer|dispute_agent|admin|super_admin
  intendedRole: user|merchant              ← set on registration, never shown to others
  kycStatus: none|pending|approved|rejected
  kycLevel: none|basic|enhanced
  referralCode, referredById
  twoFaEnabled, twoFaSecret
  isEmailVerified
  isSuspended, isBanned, suspendReason
  dailyBuyUsed, dailyBuyReset (date)
  monthlyBuyUsed, monthlyBuyReset (date)
  completedSellTrades: Int default 0       ← incremented on each completed sell trade; triggers collateral prompt at threshold
  firstTradeBonusPaid: Boolean default false  ← set true after PKR 50 first-trade bonus paid (Section 27.40)
  marketingEmailsEnabled: Boolean default true ← user-controlled unsubscribe (Section 27.20)
  socialLinks: Json                        ← { twitter?, facebook?, linkedin?, instagram?, website? }
  socialLinksPublic: Boolean default false ← controlled by platformConfig globally, or per-user by admin
  createdAt

Wallet
  id, userId, coin, network
  balance, lockedBalance, depositAddress
  unique(userId, coin, network)

Transaction
  id, walletId, type: deposit|withdrawal|trade|fee|referral_reward
  amount, fee, txHash, status, createdAt

Ad
  id, userId, side: buy|sell, coin, network
  priceType: fixed|float
  price (PKR per coin — recalculated if float)
  floatOffset (percentage, e.g. 1.5 means +1.5%)
  totalAmount, availableAmount
  minOrder, maxOrder (PKR)
  paymentMethods[], tradeWindow, terms
  status: active|paused|completed
  lastPriceUpdate

Trade
  id, adId, buyerId, sellerId
  coin, network, amount, price, fiatAmount
  paymentMethod
  status: payment_pending|payment_uploaded|payment_confirmed|crypto_sent|crypto_released|cancelled|disputed
  paymentProofUrl, orderRef
  buyerWalletAddress    ← buyer's crypto address, provided at trade initiation
  sellerTxHash          ← optional, provided by seller when marking crypto sent
  createdAt, expiresAt
  escrowReleased (bool)

InstantBuyOrder
  id, userId, orderRef
  coin, network, paymentMode: pkr|crypto
  fiatAmount, coinAmount, rate, fee
  status: payment_pending|payment_uploaded|admin_review|completed|rejected|expired
  verificationStatus: pending_layer1|layer1_passed|layer1_failed|layer2_approved|layer2_rejected
  paymentProofUrl, incomingTxHash
  toAddress, quoteExpiresAt, rejectionReason
  ocrConfidence (0-100, from Layer 1)
  ocrExtractedAmount

Dispute
  id, tradeId, openedById
  reason, description, status: open|resolved
  resolution, winner: buyer|seller
  escalatedAt, resolvedAt

DisputeMessage
  id, disputeId, senderId, message, evidenceUrl, createdAt

TradeMessage
  id, tradeId, senderId, message
  attachmentUrl: String?    ← S3 URL for optional image/PDF attachment in chat
  createdAt

PaymentMethod
  id, userId, type: jazzcash|easypaisa|bank_transfer
  displayName, accountName
  mobileNumber, bankName, ibanNumber, accountNumber
  isActive

KycSubmission
  id, userId, status: pending|approved|rejected
  tier: 'basic'|'enhanced'
  frontUrl, backUrl, selfieUrl
  cnicNumberHash: String (HMAC-SHA256 of cnicNumber using server secret — NEVER store plaintext CNIC)
  ← cnicNumber is shown to admin during review from the uploaded document image only; it is NEVER persisted to DB
  ← on duplicate check: compare cnicNumberHash values only
  socialLinks: Json     ← [{ platform, url }] — only for enhanced tier, min 2 max 3
  rejectionReason
  reviewedAt, reviewedBy

ReferralReward
  id, referrerId, referredId
  status: pending|paid
  rewardAmount, paidAt

Notification
  id, userId, title, body, type, isRead, createdAt

PlatformConfig
  id, key (unique), value, updatedAt

Merchant
  id, userId, businessName
  status: pending|pending_collateral|approved|rejected|suspended
  spreadBps (max spread admin allows), approvedAt
  rank: 'bronze'|'silver'|'gold'|'platinum'  ← auto-assigned weekly, default 'bronze' on approval
  rankUpdatedAt
  disputeRate (computed: disputes / totalTrades)
  socialLinks: Json   ← { instagram?, facebook?, website?, whatsapp? }

MerchantInventory
  id, merchantId, coin, network
  availableAmount, pricePerUnit

OtpCode
  id, userId, type: email_verify|forgot_password
  codeHash, expiresAt, usedAt

Session
  id, userId, token, userAgent, ip, createdAt, expiresAt

AuditLog
  id, actorId, action, targetType, targetId, metadata (JSON), createdAt

FraudFlag
  id, userId, reason, severity: low|medium|high
  status: open|reviewed
  reviewedAt, actionTaken

TradeStats
  id, userId (unique)
  totalTrades, completedTrades, cancelledTrades
  completionRate, avgRating, totalReviews
  totalVolumePKR, trustScore
  badge: 'new'|'active'|'trusted'|'top'|'elite'   ← auto-assigned
  badgeLabel: string                               ← human-readable e.g. "Elite Trader"
  lastUpdated

TradeRating
  id, tradeId, ratedByUserId, ratedUserId
  rating (1-5), comment, tags (string[])
  createdAt
  unique(tradeId, ratedByUserId)     ← one rating per person per trade

MerchantKycSubmission
  id, userId, businessName, businessDescription, contactPhone
  businessProofType: ntn|bank_statement|trade_license
  cnicFrontUrl, cnicBackUrl, selfieUrl, businessProofUrl
  socialLinks: Json    ← [{ platform: 'facebook'|'instagram'|'twitter'|'linkedin'|'website', url: string }]
  status: pending|approved|rejected|pending_collateral
  rejectionReason, reviewedAt, reviewedBy

SavedAddress
  id, userId, coin, network, address, label
  unique(userId, coin, network, address)

EmailLog
  id, userId, template, sentAt, status: sent|failed

CollateralLock
  id, userId, coin, amount
  status: locked|unlocked|seized
  lockedAt, unlockedAt, seizedAt, seizeReason

PushSubscription
  id, userId, endpoint, keys: Json (p256dh, auth), userAgent
  createdAt
  unique(userId, endpoint)

RateAlert
  id, userId, coin, network
  direction: above|below, targetRate (PKR)
  status: active|triggered|cancelled
  triggeredAt, createdAt

AdminNote
  id, targetUserId, authorAdminId
  note (text, max 2000 chars)
  isInternal: Boolean default true    ← never shown to user
  createdAt

GasFeeOrder
  id, orderRef (unique), userId?       ← null for guest orders
  ipAddress?                           ← for guest rate limiting
  chain: TRON|BSC|ETH|SOL|MATIC|ARB|BASE|TON
  tier: SMALL|MEDIUM|LARGE
  gasAmountNative, gasAmountUSD, priceAtOrder
  paymentCoin: USDT, paymentNetwork: TRC20|BEP20
  paymentAmount, paymentTxHash?
  toAddress, fromHotWallet
  deliveryTxHash?, deliveryConfirmed: Boolean
  status: created|payment_pending|payment_detected|sending|delivered|expired|failed|refunded
  failureReason?, retryCount, expiresAt
  createdAt, updatedAt, deliveredAt?, refundedAt?
  → Full schema in GAS_FEE_SPEC.md Section 7

GasHotWallet
  id, chain (unique), address, isActive: Boolean
  createdAt
  → Private key stored in AWS Secrets Manager (NEVER in DB)
```

> **Schema note:** `GasFeeOrder` and `GasHotWallet` are fully specified in [GAS_FEE_SPEC.md](GAS_FEE_SPEC.md) Section 7 with complete Prisma model definitions. The above is a summary for cross-reference.

---

## 19. Two-Layer Verification (Instant Buy)

**Layer 1 — Automated (BullMQ job):**
- PKR: OCR reads screenshot, verifies amount matches `order.fiatAmount` within 5% tolerance
- Crypto: blockchain webhook or tx hash lookup verifies amount and confirmation count
- Result stored in: `order.ocrConfidence`, `order.ocrExtractedAmount`
- On pass: `verificationStatus → 'layer1_passed'`, `status → 'admin_review'`
- On fail: `verificationStatus → 'layer1_failed'` — still goes to admin_review, but flagged

**Layer 2 — Human (ALWAYS required):**
- Admin sees order in queue with Layer 1 result shown
- Admin reviews payment proof + Layer 1 result
- Admin approves → platform operator manually sends crypto → `status: 'completed'`
- Admin rejects → `status: 'rejected'`, `rejectionReason` saved, email sent to user

**No auto-release ever.** Even perfect Layer 1 pass requires admin approval.

---

## 20. Real-Time / Polling Strategy

| Page | Interval | Condition |
|------|----------|-----------|
| Trade `/trade/[id]` | 10s | While status is active |
| Instant Buy status | 15s | While `payment_uploaded` or `admin_review` |
| Admin queues | 30s | On tab focus or always |
| Notification bell unread count | 60s | While user is logged in, on any page |
| Rate display | — | Refetch on button click only, show `updatedAt` |
| Withdrawal fee | — | Refetch on button click, auto-expire after 60s |
| Home page stats | 5min | On page focus |
| Marketplace/config (site notice) | 60s | Cache in memory, re-fetch on tab focus |

---

## 21. Design System

> 📄 **Full component standards:** [FRONTEND_STANDARDS.md](FRONTEND_STANDARDS.md)
> This section defines the color palette and layout constants. FRONTEND_STANDARDS.md contains the complete Tailwind config, atomic component library, custom hooks, and form standards.
>
> **Styling rule:** Use Tailwind CSS for all styling. Never use inline styles. The design tokens below map directly to the Tailwind config in FRONTEND_STANDARDS.md.

### Colors
```
Primary blue:    #2563eb   → Tailwind: primary / primary-hover / primary-light
Dark text:       #1e293b   → Tailwind: text-primary
Gray text:       #64748b   → Tailwind: text-secondary
Light bg:        #f8fafc   → Tailwind: surface-alt
Border:          #e2e8f0   → Tailwind: border
Success green:   #10b981   → Tailwind: success / success-light
Warning amber:   #d97706   → Tailwind: warning / warning-light
Error red:       #ef4444   → Tailwind: danger / danger-light
Gold accent:     #f59e0b   → Tailwind: gold / gold-light (for badges, trust indicators)
```

### Layout
- Max content width: `900px` or `1200px`, centered, `padding: 24px`
- Navbar height: `64px`, white, bottom border `1px solid #e2e8f0`
- Card: `background: white, borderRadius: 16px, border: 1px solid #e2e8f0, padding: 24px`

### Global Navbar (shown on every authenticated page)

**Layout:**
- Left: PakSwap logo (`/` link)
- Center: nav links with active state
- Right: notification bell + user avatar

**Notification Bell:**
- Fetch `GET /api/notifications?limit=1&unread=true` → use `pagination.total` as unread count
- If `unreadCount > 0`: show red badge circle on bell icon with the count (cap display at `99+`)
- Click bell → dropdown shows last 5 notifications from `GET /api/notifications?limit=5`
- Each item: icon (by type), title, time ago — click goes to relevant page (trade, dispute, etc.)
- "View all" link → `/notifications`
- Bell is always visible regardless of KYC status

**User Avatar (right side):**
- Circle with first letter of `user.fullName` — gradient background
- Shows `user.fullName.split(' ')[0]` + dropdown arrow
- Dropdown: My Profile | Dashboard | Settings | Referral | Logout
- All data from Zustand store — never hardcoded

**Nav Links (center):**
| Link | Route | Visible when |
|------|-------|-------------|
| Marketplace | `/marketplace` | Always |
| Buy Crypto | `/instant-buy` | Always |
| My Trades | `/orders` | Logged in |
| Wallet | `/wallet` | Logged in |
| Leaderboard | `/leaderboard` | Always |
| Referral | `/referral` | Logged in |

**Public navbar (not logged in):**
- Right side: "Login" + "Register" buttons instead of avatar
- No notification bell

### Standard States

Use the components from FRONTEND_STANDARDS.md — do NOT write inline styles. Import `<LoadingState>`, `<ErrorState>`, `<EmptyState>` from `@/components/ui`.

```tsx
// Loading — use <LoadingState> component
<LoadingState message="Loading..." />

// Error — use <ErrorState> component
<ErrorState title="Failed to load. Please try again." onRetry={retry} />

// Empty — use <EmptyState> component
<EmptyState icon={<SomeIcon />} title="No results" description={message} />
```

### Fee / Rate Display Pattern (always use this)
```tsx
// Always show when and where a number came from
<div className="flex items-center gap-2 text-sm">
  <span className="text-text-primary">Network fee: 0.001 ETH (PKR 840)</span>
  <span className="text-text-muted text-xs">· updated 30s ago</span>
  <button onClick={refetchFee} className="text-primary hover:text-primary-hover">↻</button>
</div>
```

### Mobile Responsiveness
All pages must be usable on a 375px wide screen (iPhone SE minimum). Key rules:
- Navbar: collapse center links into a hamburger menu on mobile (show only logo + bell + avatar)
- Tables: horizontally scrollable on mobile (`overflow-x-auto`)
- Cards: stack vertically on mobile (`flex flex-col md:flex-row`)
- Buttons: minimum touch target 44×44px (`min-h-[44px] min-w-[44px]`)
- Modals: full-screen on mobile (handled by `<Modal>` component in FRONTEND_STANDARDS.md)
- Forms: inputs full-width on mobile (`w-full`)

### Global Footer (required on ALL pages — public and authenticated)

The footer must appear at the bottom of every page. It is legally required (terms/privacy links) and provides critical trust signals to new visitors.

**Layout (two-row footer):**
```
Row 1 — Links (centered, horizontal on desktop / stacked on mobile):
  Marketplace | Fees | Leaderboard | About | Help | Terms of Service | Privacy Policy

Row 2 — Bottom bar (dark background #1e293b):
  Left:  © {new Date().getFullYear()} PakSwap. All rights reserved.
  Right: Registered in Pakistan  ·  support@pakswap.pk  ·  WhatsApp: {support_whatsapp from API}
```

**Data to fetch (cached 60s, same as marketplace/config call):**
```
GET /api/marketplace/config → support_whatsapp (used in footer WhatsApp link)
```

**Implementation rules:**
- Footer `support_whatsapp` number comes from `platformConfig` via API — never hardcoded
- WhatsApp link format: `https://wa.me/{support_whatsapp.replace(/[^0-9]/g, '')}` — opens WhatsApp chat
- Footer is included in `app/layout.tsx` so it renders on every route automatically
- On mobile (≤ 640px): links stack in two columns, WhatsApp/email drop to separate lines
- Footer background: white with `borderTop: '1px solid #e2e8f0'`, padding `32px 24px`
- Bottom bar background: `#1e293b` (dark), text white, font size 13px

**Social media links (optional — shown only if platformConfig `show_footer_social_links = true`):**
- Twitter/X icon linking to `platformConfig.social_twitter`
- Facebook icon linking to `platformConfig.social_facebook`
- Instagram icon linking to `platformConfig.social_instagram`

**New platformConfig keys:**
```
social_twitter   → https://twitter.com/pakswap
social_facebook  → https://facebook.com/pakswap
social_instagram → https://instagram.com/pakswap
show_footer_social_links → false
```

---

### Error Pages
Build these two pages in Next.js:
- **`app/not-found.tsx`** (404): "Page not found" with logo, message, and "Go to Home" button
- **`app/error.tsx`** (500): "Something went wrong" with logo, message, "Retry" button (calls `reset()`)
Both pages must not make any API calls. Styled consistently with the design system.

### Copy-to-Clipboard Pattern
Any reference number, address, or code shown to the user must have a 📋 copy button beside it.
On click: copy to clipboard + show "Copied!" tooltip for 2 seconds, then revert.
Applied to: order refs, wallet addresses, referral codes, tx hashes, deposit addresses.

### Notification Bell Behaviour
- Bell icon in navbar, visible on all authenticated pages
- Unread count: red badge (cap at 99+), fetched every 60s
- Click bell: dropdown opens with last 5 notifications
- Clicking outside the dropdown closes it (`useEffect` with document click listener)
- Each notification row: click → navigate to relevant page → mark as read
- "Mark all read" button at bottom of dropdown

---

## 22. Rules for Developers — NO EXCEPTIONS

1. **Never initialize state with fake data.** Use `null`, `[]`, or `''`.
2. **Never hardcode a person's name.** Always use `user.fullName` from auth store.
3. **Never hardcode rates, prices, or fees.** Always fetch from API. Show `updatedAt`.
4. **Never hardcode counts or statistics.** Always fetch from API.
5. **Never hardcode payment account numbers.** Always fetch from `/api/instant-buy/payment-config`.
6. **Never hardcode a referral list.** Fetch from `/api/referral`.
7. **Every `const data = [{ ... }, { ... }]` with real-looking data is a red flag.** Challenge it — it needs an API endpoint.
8. **If an API endpoint doesn't exist for data you need, build it.** Don't fake the data.
9. **Timer countdowns must be computed from a server timestamp** (`expiresAt - Date.now()`), never a hardcoded number of seconds.
10. **Fees must be fetched live for volatile networks (ERC20, BTC, SOL).** Never use platformConfig flat fee for these — always combine live network fee + platform fee.
11. **Rates must be shown with their `updatedAt` timestamp.** User must always know how fresh the rate is.
12. **Trust badges and trade stats must come from `TradeStats` table.** Never assign or fake a badge.
13. **KYC limits must be enforced on the backend** — frontend shows them as guidance but backend always validates.
14. **Merchant rank must come from `Merchant.rank`.** Never compute it on the frontend. It is set by the weekly cron job only.
15. **Every notification shown in-app must be a real `Notification` DB row.** Never show a hardcoded banner that says "You earned a badge" without a real DB entry.
16. **Auth guards must use the `?next=` redirect pattern.** After login, redirect to `next` or role dashboard — never always go to `/`.
17. **All admin actions must be logged to `AuditLog`.** actorId, action, targetType, targetId, metadata (JSON with before/after state).
18. **Collateral prompt must fire on the backend**, not just the frontend. Backend must reject new sell-ad creation when `user.completedSellTrades >= collateral_free_sell_trades` AND no active `CollateralLock` exists for that user.
19. **Never store hot wallet private keys in the database or codebase.** Only store public deposit addresses in `platformConfig`. Private keys stay with the operator offline.
20. **Platform deposit addresses must be fetched from `platformConfig`**, not hardcoded. If `deposit_address_{coin}_{network}` is missing from config, return a clear error — do not show a fake/empty address.
21. **Every clickable element must have a visible destination.** No dead links. If a feature is not built yet, hide the button — do not show it disabled with no explanation.
22. **Mobile-first for all pages.** Test every page at 375px width before marking complete.
23. **Rate limiting must be applied to ALL write endpoints and all sensitive read endpoints.** Use the table in Section 27.1. A backend without rate limits is an open invitation to bot abuse. Return `429 Too Many Requests` with `Retry-After` header.
24. **Every BullMQ job must have `attempts: 3`, exponential backoff, and an `onFailed` handler** that alerts admin on final failure. Silent job failures are a launch-blocker — a stuck OCR job means a user's Instant Buy order never progresses.
25. **File uploads must be validated by real MIME type (from file buffer bytes, not extension).** Use the `file-type` npm package. Max 10MB. Rename to UUID before S3 path. Never use user-provided filenames. Apply to all upload endpoints.
26. **Pre-signed S3 URLs must be used for all file uploads.** The backend must never receive raw file bytes in production. Frontend uploads directly to S3 using a pre-signed URL obtained from `POST /api/upload/presign`. See Section 27.13.
27. **Analytics events must be fired for every major user action.** Use Posthog or Mixpanel. See Section 27.8. Without event tracking, post-launch product decisions are guesswork.
28. **The `/r/[referralCode]` referral landing page must store the code in localStorage and pre-fill the registration form automatically.** A referral link that doesn't pre-fill the code loses 60–80% of referred conversions.
29. **CNIC numbers must NEVER be stored in plaintext.** Store only `cnicNumberHash` (HMAC-SHA256 with server secret). The CNIC is visible to admins in the uploaded document image but must never be written to a database column in plain form.
30. **Wallet addresses must be validated per-network using cryptographic validation libraries**, not just length/prefix checks. Wrong-network addresses sent to blockchain result in permanently lost funds — there is no recovery.
31. **Webhook endpoints must verify HMAC signatures before processing any payload.** An unsigned webhook is indistinguishable from an attacker's request. Apply signature verification to all `/api/webhooks/*` routes. See Section 27.25.
32. **Admin accounts must have 2FA enabled before accessing the admin panel.** Enforce this at the route level — if `user.twoFaEnabled === false` and `role` is admin/super_admin, redirect to 2FA setup before granting panel access. See Section 27.7.
33. **All irreversible user actions must have a confirmation modal.** Cancelling a trade, deleting an ad, submitting a dispute, and initiating a withdrawal must all require explicit user confirmation. See Section 27.32.
34. **The registration form must include a Terms of Service acceptance checkbox.** Store `termsAcceptedAt` and `termsVersion` in the User table. Without this, the platform has no legal basis for collateral seizure, account bans, or data retention.
35. **All balance-critical operations MUST use `db.$transaction()`.** Any service method that reads a balance, limit, or counter AND writes to it must wrap both operations in a Prisma transaction with `SELECT FOR UPDATE`. See Section 32 and DB_TRANSACTION_RULES.md for the complete catalog. Non-atomic balance operations are a race condition waiting to happen.
36. **All text input fields MUST have max-length validation.** Apply Zod `.max()` on every string field in every request schema. See the input validation catalog in Section 27 (Rule 8 addition). Unbounded text inputs are a DB bloat and DoS vector.
37. **Webhook endpoints MUST store `webhookEventId` in Redis to prevent replay attacks.** Before processing any `/api/webhooks/*` payload, check `redis.get('webhook_event:{eventId}')`. If present, return `200` silently. If absent, set with 24h TTL and then process. A valid signed webhook can be replayed indefinitely without this guard.

---

## 23. First-Time Setup Checklist

### Backend
- [ ] `npx prisma migrate dev` or `npx prisma db push`
- [ ] Set all env vars (see Section 24)
- [ ] Start BullMQ workers: `npm run workers`
- [ ] Start rate updater cron: runs automatically on server start

### Create First Admin
1. Register at `/register`
2. `UPDATE "User" SET role = 'super_admin' WHERE email = 'your@email.com';`
   Or: `npx prisma studio` → User → change role
3. Log in at `/login`

### Set Up Platform Hot Wallet (CRITICAL — do this before accepting any deposits)
1. Create blockchain wallets for each supported coin/network (use Trust Wallet, MetaMask, or Binance)
2. Save the private keys SECURELY offline (hardware wallet or encrypted backup) — NEVER put private keys in code or env
3. Log in as super_admin → go to `/admin/wallet`
4. Enter each deposit address for each coin/network combination
5. Or set the `PLATFORM_DEPOSIT_*` env vars (backend seeds config on startup)
6. Verify: go to `/wallet` as a test user → "Deposit" → address should show correctly
7. Test with a small real deposit before going live

### Seed platformConfig
Log in as super_admin → `/admin/config` → add all keys from Section 17.11.
Or run SQL seed script:
```sql
INSERT INTO "PlatformConfig" (key, value) VALUES
('ib_jazzcash_number', '03001234567'),
('ib_easypaisa_number', '03001234567'),
('ib_account_name', 'PakSwap (Pvt) Ltd'),
('support_whatsapp', '+923001234567'),
('fee_network_TRC20', '1'),
('fee_network_BEP20', '0.5'),
('platform_fee_ERC20', '1.2'),
('platform_fee_TRC20', '0.5'),
('kyc_limit_basic_daily', '50000'),
('kyc_limit_enhanced_daily', '500000'),
('kyc_basic_monthly_limit', '500000'),
('kyc_enhanced_monthly_limit', '5000000'),
('trade_auto_cancel_hours', '4'),
('referral_reward_pkr', '500'),
('instant_buy_pkr_fee_pct', '1'),
('instant_buy_crypto_fee_pct', '0.5'),
('collateral_free_sell_trades', '3'),
('collateral_min_sell', '50'),
('collateral_merchant', '100'),
('merchant_max_spread_bps', '300'),
('dispute_escalate_hours', '48'),
('inventory_low_stock_threshold', '10'),
('site_notice', ''),
('site_notice_type', 'info'),
('show_user_social_links', 'false'),
('show_merchant_social_links', 'false')
ON CONFLICT (key) DO NOTHING;
```

### External API Keys Required
- Binance API (for rate fetching) — free tier works
- ExchangeRate-API (USD/PKR) — free tier works
- Etherscan API key (for live gas fees) — free
- Moralis / Tatum API key (for on-chain deposit monitoring) — paid, Phase 2
- AWS S3 (for file uploads) — paid

---

## 24. Environment Variables

### Backend (.env)
```
DATABASE_URL=postgresql://...
JWT_SECRET=your-secret-min-32-chars
JWT_EXPIRES_IN=7d
REDIS_URL=redis://...

# File Storage
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=ap-south-1
AWS_S3_BUCKET=pakswap-uploads

# Email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=noreply@pakswap.pk

# External APIs
BINANCE_API_URL=https://api.binance.com
EXCHANGE_RATE_API_KEY=...
ETHERSCAN_API_KEY=...
MORALIS_API_KEY=...        # Phase 2

# Geo-blocking
CLOUDFLARE_ENABLED=true    # use CF-IPCountry header

# App
FRONTEND_URL=https://pakswap.vercel.app
APP_NAME=PakSwap
ADMIN_ALERT_EMAIL=ops@pakswap.pk
COMPLIANCE_OFFICER_EMAIL=compliance@pakswap.pk
PORT=3000

# Security — CRITICAL: must be set before launch
JWT_SECRET=<random 64-char string>
JWT_REFRESH_SECRET=<random 64-char string — different from JWT_SECRET>
CSRF_SECRET=<random 32-char string>
CNIC_HASH_SECRET=<random 64-char string — used for HMAC-SHA256 of CNIC numbers>
# If CNIC_HASH_SECRET is missing at startup: server must throw and refuse to start
# Reason: without it, CNIC hashes are computed with undefined key → all hashes are identical → CNIC dedup check fails silently

# Webhook verification (see Section 12 and Section 27.25)
MORALIS_WEBHOOK_SECRET=...      # from Moralis Streams dashboard
TATUM_WEBHOOK_SECRET=...        # from Tatum webhook settings
BLOCKCYPHER_TOKEN=...           # from BlockCypher dashboard

# Error monitoring (Section 27.15)
SENTRY_DSN=https://...@sentry.io/...

# Analytics (Section 27.8)
POSTHOG_API_KEY=phc_...        # server-side Posthog key

# Bot detection (Section 27.27)
TURNSTILE_SECRET_KEY=...        # from Cloudflare dashboard

# Push notifications (Section 27.37)
FCM_SERVER_KEY=...              # from Firebase Console → Project Settings → Cloud Messaging
VAPID_PUBLIC_KEY=...            # generated with: npx web-push generate-vapid-keys
VAPID_PRIVATE_KEY=...           # same command — keep private, server-side only
VAPID_SUBJECT=mailto:ops@pakswap.pk

# Platform hot wallet deposit addresses (public addresses only — private keys stay with operator)
# Backend seeds platformConfig with these on startup if the keys are missing
PLATFORM_DEPOSIT_USDT_TRC20=
PLATFORM_DEPOSIT_USDT_BEP20=
PLATFORM_DEPOSIT_USDT_ERC20=
PLATFORM_DEPOSIT_BTC=
PLATFORM_DEPOSIT_ETH=
PLATFORM_DEPOSIT_SOL=

# Gas Fee System (Section 31, see GAS_FEE_SPEC.md Section 15 for full list)
TRON_FULL_NODE_URL=https://api.trongrid.io
TRONGRID_API_KEY=                         # from trongrid.io — required for production rate limits
GAS_FEE_DEPOSIT_ADDRESS_TRC20=            # separate from PLATFORM_DEPOSIT_USDT_TRC20
GAS_WALLET_SECRET_ARN_TRON=              # AWS Secrets Manager ARN for TRX hot wallet private key
GAS_WALLET_ALERT_THRESHOLD_TRON=5000     # alert when TRX balance below this
GAS_WALLET_PAUSE_THRESHOLD_TRON=1000     # auto-pause gas fee orders when below this
GAS_MARKUP_MULTIPLIER_TRON=1.50
COINGECKO_API_KEY=                        # fallback price feed (primary: Binance API)
```

### Frontend (.env.local)
```
NEXT_PUBLIC_API_URL=https://your-backend.railway.app
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=...   # get from cloud.walletconnect.com

# Analytics
NEXT_PUBLIC_POSTHOG_KEY=phc_...
NEXT_PUBLIC_POSTHOG_HOST=https://app.posthog.com

# Error monitoring
NEXT_PUBLIC_SENTRY_DSN=https://...@sentry.io/...

# Bot detection
NEXT_PUBLIC_TURNSTILE_SITE_KEY=...         # from Cloudflare dashboard (public-safe)

# Push notifications
NEXT_PUBLIC_VAPID_PUBLIC_KEY=...           # must match server VAPID_PUBLIC_KEY
```

### Startup Validation (backend)
Add a startup check that throws and exits if any critical secret is missing or too short:
```typescript
// backend/src/startup.ts
const REQUIRED_ENV = [
  { key: 'JWT_SECRET', minLen: 32 },
  { key: 'JWT_REFRESH_SECRET', minLen: 32 },
  { key: 'CNIC_HASH_SECRET', minLen: 32 },
  { key: 'CSRF_SECRET', minLen: 16 },
  { key: 'DATABASE_URL', minLen: 10 },
  { key: 'REDIS_URL', minLen: 10 },
  { key: 'AWS_S3_BUCKET', minLen: 3 },
]
for (const { key, minLen } of REQUIRED_ENV) {
  const val = process.env[key]
  if (!val || val.length < minLen) {
    console.error(`FATAL: env var ${key} is missing or too short (min ${minLen} chars). Refusing to start.`)
    process.exit(1)
  }
}
```

---

## 25. API Response Format

**Success:**
```json
{ "success": true, "data": { ... } }
{ "success": true, "data": [...], "pagination": { "page": 1, "limit": 20, "total": 100, "pages": 5 } }
```

**Error:**
```json
{ "success": false, "error": "ERROR_CODE", "message": "Human readable message" }
```

**Error codes:**
- `KYC_REQUIRED` — user must complete KYC first
- `DAILY_LIMIT_EXCEEDED` — daily PKR buy limit reached for this KYC level
- `MONTHLY_LIMIT_EXCEEDED` — monthly limit reached
- `INVALID_STATE` — wrong order/trade state for this action
- `ORDER_NOT_FOUND` — resource not found
- `RATE_UNAVAILABLE` — rate not yet set in platformConfig
- `INSUFFICIENT_BALANCE` — wallet balance too low
- `CNIC_ALREADY_REGISTERED` — CNIC is linked to another approved account
- `SERVICE_UNAVAILABLE_IN_YOUR_REGION` — geo-blocked country
- `FEE_FETCH_FAILED` — could not fetch live network fee (retry)
- `DEPOSIT_ADDRESS_NOT_CONFIGURED` — admin has not set a platform deposit address for this coin/network
- `COLLATERAL_REQUIRED` — user must lock collateral before posting more sell ads
- `WALLET_ADDRESS_REQUIRED` — buyer must provide a wallet address to receive crypto
- `INVALID_WALLET_ADDRESS` — wallet address failed per-network cryptographic validation
- `WRONG_NETWORK_ADDRESS` — address format matches a different network than selected
- `TERMS_NOT_ACCEPTED` — registration attempted without ToS acceptance
- `ACCOUNT_DELETION_PENDING` — account is scheduled for deletion and cannot perform actions
- `ACTIVE_TRADES_EXIST` — cannot delete account or unlock collateral while trades are active
- `IDEMPOTENCY_CONFLICT` — same idempotency key used for a different request body
- `KYC_REQUIRED_TO_SELL` — user must complete basic KYC before posting sell ads
- `REFERRAL_REWARD_CAP_REACHED` — referrer has hit daily referral reward cap
- `INVALID_WEBHOOK_SIGNATURE` — webhook rejected: HMAC signature verification failed
- `SCREENSHOT_TOO_LARGE` — uploaded file exceeds 10MB limit
- `UNSUPPORTED_FILE_TYPE` — uploaded file MIME type is not allowed
- `WITHDRAWAL_REQUIRES_REAUTH` — high-value withdrawal requires 2FA re-verification

---

## 26. Feature Phases

### HARD BLOCKERS — Must Complete Before Accepting Any Live Funds

These are not features. They are legal prerequisites. Do NOT launch to real users until all are checked.

- [ ] **Business entity registered** — SMC-Pvt Ltd or Pvt Ltd. Operating as an individual = personal liability for all user funds.
- [ ] **Legal opinion obtained** — Pakistan-qualified fintech/crypto attorney confirming SECP registration requirements, SBP No-Objection Certificate status, and FBR reporting thresholds (see Section 27.34).
- [ ] **Compliance Officer designated** — responsible for filing STRs with FMU for suspicious transactions.
- [ ] **Terms of Service published** — must include: "PakSwap is not a bank, money exchanger, or financial institution." Must have user acceptance checkbox at registration (`termsAcceptedAt`, `termsVersion` stored — Rule 34).
- [ ] **KYC data retention policy documented** — 5 years after account closure (PDPA 2023).
- [ ] **Privacy Policy published** — disclosure that KYC data may be stored on international cloud servers (PDPA 2023 cross-border consent).
- [ ] **S3 bucket verified private** — run `curl {S3_URL}` test as per Section 27.13. A public bucket leaks user KYC documents.
- [ ] **Admin 2FA enforced** — backend blocks panel access without TOTP (Rule 32).
- [ ] **CNIC_HASH_SECRET validated on startup** — server refuses to start without it (Section 24).

---

### Phase 1 — Build Everything Below Before Launch

**Auth & Accounts**
- [x] Register with one-time account type selection (Trader vs Merchant card — asked only on registration)
- [x] Login, email OTP, 2FA (TOTP)
- [x] Role-based portal routing (User → /dashboard, Merchant → /merchant/dashboard, Admin → /admin)
- [x] User Dashboard (balances, recent trades, quick actions, limits bar)
- [x] Merchant Dashboard (spread, inventory, revenue stats, collateral status, dispute rate)

**KYC**
- [x] Regular User KYC (CNIC + selfie + 2–3 social media links, all 30+ days old — admin verifies manually)
- [x] Merchant KYC (CNIC + business proof + 2–3 social/business links, all 30+ days old) — separate admin queue, no pre-KYC needed
- [x] Social links asked during KYC only — never during registration
- [x] CNIC uniqueness check on approval
- [x] KYC buy limits enforced (basic = 50k/day, enhanced = 500k/day)

**P2P Trading**
- [x] Marketplace (ads, filters, live rates, float pricing)
- [x] Create/Edit/Pause/Delete ads (fixed or float price)
- [x] Trade page (chat, screenshot upload, timer from server timestamp, auto-cancel)
- [x] Trade dispute flow (open, chat, evidence upload)
- [x] Trade auto-escalation (BullMQ job)
- [x] Rating system — both buyer AND seller rate after each trade (stars + tags + comment)
- [x] TradeStats recalculation after each rating
- [x] Trust badges auto-assigned from real TradeStats
- [x] Merchant rank tiers (Bronze/Silver/Gold/Platinum) — weekly cron recalculation
- [x] Badge upgrade/downgrade notifications (in-app + email)
- [x] Merchant rank upgrade/downgrade notifications (in-app + email)
- [x] Public leaderboard `/leaderboard` — top traders + top merchants, all data from DB
- [x] User public profile `/profile/[username]` with badge progress bar
- [x] Admin analytics dashboard `/admin/analytics` — badge distribution, growth charts, top performers

**Collateral**
- [x] Seller collateral lock (50 USDT min to post sell ads)
- [x] Merchant collateral (100 USDT auto-locked on approval, held pending collateral deposit)
- [x] Collateral auto-doubles if merchant dispute rate > 10%
- [x] Admin can seize collateral on ban

**Instant Buy (OTC)**
- [x] Two-layer verification (OCR Layer 1 + Admin Layer 2, no auto-release)
- [x] PKR payment flow (screenshot upload)
- [x] Crypto-to-crypto flow (tx hash + optional Wallet Connect)

**Wallet & Fees**
- [x] Deposit (address + QR code)
- [x] Withdraw with live fee (Etherscan for ERC20, mempool.space for BTC, flat for TRC20/BEP20)
- [x] Fee = live network fee + platform fixed fee — shown with `updatedAt` timestamp
- [x] Withdrawal requires min amount > total fee

**Rates**
- [x] Live rate cron job (Binance → DB every 5 min)
- [x] Rate shown with `updatedAt` on every page
- [x] Admin rate monitor page + manual override
- [x] Admin rate-refresh button

**Referral**
- [x] Referral code, link, share buttons (WhatsApp, Telegram, Facebook)
- [x] Real referred users table — masked names from API, no fake data

**Security & Compliance**
- [x] Geo-blocking (FATF high-risk countries)
- [x] Merchant spread control with admin-set max
- [x] Audit log for all admin actions
- [x] Fraud flags + review workflow

**Navigation & UX**
- [x] Global navbar with notification bell (unread count badge), notification dropdown
- [x] Full page interconnection map — every link goes to the right destination
- [x] Auth guard with `?next=` redirect after login
- [x] Role-based sidebar in admin (visibility per role)
- [x] Site notice banner on all pages (from `GET /api/marketplace/config`)
- [x] Public pages (marketplace, home, leaderboard, fees, profiles) accessible without login
- [x] Mobile responsive — all pages usable at 375px width
- [x] Copy-to-clipboard on all reference numbers, addresses, codes
- [x] Trade history search by order ref or counterparty username
- [x] Buyer provides wallet address at trade initiation (required for sell ads)
- [x] 404 and 500 error pages (Next.js `not-found.tsx` + `error.tsx`)

**Platform Wallet (Admin/Owner)**
- [x] Admin wallet management page `/admin/wallet` (super_admin only)
- [x] Deposit addresses stored in `platformConfig` — set via admin UI or env vars
- [x] Pending payouts summary — shows how much platform owes in pending withdrawals/instant buy
- [x] Manual balance tracking (operator enters current holdings)
- [x] Hot wallet setup guide in First-Time Setup Checklist
- [x] `DEPOSIT_ADDRESS_NOT_CONFIGURED` error when address is missing

**Admin Panel**
- [x] Dashboard with live stats + escalation alerts + revenue card + site notice control
- [x] KYC queue (user) + Merchant KYC queue (separate) — both with filters
- [x] Payments queue, Withdrawals queue, Disputes queue, Instant Buy queue (all with filters)
- [x] User management (suspend, ban, seize collateral) with filters
- [x] Platform config editor (all keys editable, with descriptions)
- [x] Rate monitor page + manual override + refresh
- [x] Team management (invite staff, set roles, revoke)
- [x] Revenue dashboard `/admin/revenue` (period charts, by coin, recent transactions)
- [x] Analytics dashboard `/admin/analytics` (badge distribution, merchant ranks, growth charts, top performers)
- [x] Wallet management `/admin/wallet` (deposit addresses, pending payouts, estimated holdings)

---

### Phase 2 — After Launch (When Budget / Time Allows)
- [ ] **SMS/WhatsApp OTP** — currently email only; add when budget allows (Twilio or Jazz API)
- [ ] **On-chain deposit monitoring** — Moralis/Tatum webhooks auto-detect deposits without manual tx hash entry
- [ ] **OCR CNIC extraction** — auto-extract CNIC number from KYC photo during Layer 1 review
- [ ] **Mobile app** — React Native, same API, same backend
- [ ] **Automated crypto payout** — integrate Fireblocks or similar custodial solution to auto-send withdrawals and Instant Buy payouts without manual operator action
- [ ] **Fiat on/off ramp** — bank integration for direct PKR deposits/withdrawals

---

## 27. B2C Launch Audit — Critical Additions

This section captures everything identified in the pre-launch audit that was missing or underspecified. All items below are **Phase 1 requirements** unless marked otherwise.

---

### 27.1 Security — Rate Limiting & Brute Force Protection

**Must be implemented before launch.** No rate limiting = your auth endpoints can be enumerated by bots in minutes.

Apply the following limits using a Redis-backed counter (BullMQ rate limiter or `fastify-rate-limit`):

| Endpoint | Limit | Window | Lock |
|----------|-------|--------|------|
| `POST /api/auth/login` | 5 attempts | per IP per 15 min | block IP for 30 min after 5 fails |
| `POST /api/auth/register` | 10 registrations | per IP per hour | block if exceeded |
| `POST /api/auth/verify-email` | 5 attempts | per email per 30 min | invalidate OTP after 5 fails |
| `POST /api/auth/resend-email-otp` | 3 resends | per email per hour | — |
| `POST /api/auth/forgot-password` | 3 requests | per email per hour | — |
| `GET /api/wallet/live-fee` | 30 requests | per user per minute | return 429 |
| `GET /api/marketplace/rate/:coin` | 60 requests | per IP per minute | — |
| `POST /api/kyc/submit` | 3 submissions | per user per 24h | reject with `KYC_SUBMISSION_LIMIT` |
| `POST /api/trades` | 20 trades | per user per hour | — |
| All admin write endpoints | 100 actions | per admin per minute | alert super_admin if exceeded |

**Frontend:** On receiving `429 Too Many Requests` → show: "Too many attempts. Please wait X minutes." with countdown from `Retry-After` header.

---

### 27.2 Security — JWT Refresh Token Pattern

**Current spec has 7-day JWT.** A stolen token = 7 days of full access. Fix:

```
Access token:  15 minutes  (short-lived)
Refresh token: 7 days      (stored in httpOnly cookie — NOT localStorage)
```

**Auth flow:**
```
POST /api/auth/login → { accessToken (15min), refreshToken set as httpOnly cookie }
POST /api/auth/refresh → { new accessToken } (called automatically when 401 received)
POST /api/auth/logout → clears refresh token cookie, invalidates session in DB
```

**Frontend changes:**
- Store `access_token` in memory (Zustand), not localStorage
- On 401: try `POST /api/auth/refresh` once before redirecting to login
- If refresh fails: clear state, redirect to `/login?next=...`

**New DB field:** `Session.refreshTokenHash` (hashed, not stored plain)

**Rule added to Section 22:** `localStorage` must NEVER store the access token in production. Use memory + httpOnly cookie for refresh.

---

### 27.3 Security — File Upload Protection

Every file upload endpoint (`/api/kyc/submit`, `/api/trades/:id/confirm-payment`, `/api/disputes/:id/evidence`, `/api/instant-buy/orders/:id/submit-payment`) must enforce:

```
Max file size:    10 MB per file
Allowed MIME:     image/jpeg, image/png, image/webp, application/pdf
Validation:       Check MIME type from file buffer (not just extension — extension can be faked)
Library:          Use `file-type` npm package to detect real MIME from first bytes
Filename:         Rename to UUID on save — never use user-provided filename
S3 path:          /{type}/{userId}/{uuid}.{ext} — never expose original name
Virus scan:       Phase 2 — integrate ClamAV or S3 malware scanning
```

**Frontend:** Show file size error before upload. `if (file.size > 10 * 1024 * 1024) return "File must be under 10MB"`

**Image compression before upload (mobile critical):**
```typescript
// Use browser-image-compression or canvas resize before upload
// Target: max 2MB, max 2000px on longest side
// This is critical for mobile users with 20-40MP cameras
```

---

### 27.4 Security — Referral Abuse Prevention

**Attack:** User creates 10 accounts with VPN + temp emails → self-refers → earns 5,000 PKR free.

**Defenses (implement all):**

1. **Referral reward is only paid after the referred user completes KYC AND 1 trade.** — Already specced. Ensures at least some verification.
2. **CNIC uniqueness:** When referred user completes KYC, backend checks: has this CNIC already received a referral reward? If yes, block the reward. `ReferralReward.blockedReason = 'cnic_duplicate'`
3. **IP match check:** If referrer and referred share the same IP during registration, flag for admin review. Do NOT auto-block (shared WiFi is common in Pakistan), but add a `FraudFlag` with `type = 'referral_same_ip'`
4. **Reward holds for 7 days:** Already specced. Admin can investigate before payout.
5. **Max referrals per day:** Config key `max_referral_rewards_per_day` (default: 10). If referrer claims more than 10 rewards in one day → hold all pending, alert admin.
6. **New config key:** `referral_reward_max_per_day = 10`

---

### 27.5 Security — OCR Confidence Threshold

The spec says OCR verifies screenshots but never defines what "pass" means.

```
ocrConfidence:    0–100 (stored on InstantBuyOrder)
Threshold rules:
  >= 85           → layer1_passed (shown to admin as "✅ High confidence")
  60–84           → layer1_flagged (shown as "⚠️ Low confidence — verify manually")
  < 60            → layer1_failed (shown as "❌ OCR failed — admin must verify")

All three → go to Layer 2 admin review (no auto-release)
The threshold only changes the visual indicator for admin — admin always decides
```

**New platformConfig key:** `ocr_pass_threshold = 85`

**What OCR must extract and verify:**
- Amount transferred (matches `order.fiatAmount` ± 5%)
- Date (within last 24 hours)
- Sender/receiver account partially matching platform's JazzCash/Easypaisa number

---

### 27.6 Security — Idempotency on Critical Operations

**Problem:** Double-click on "Buy" creates two trades. Slow connection + impatient user = two Instant Buy orders for the same coin.

**Fix:** Require idempotency key on all trade/order creation endpoints:

```
POST /api/trades                → require header: Idempotency-Key: {uuid}
POST /api/instant-buy/orders   → require header: Idempotency-Key: {uuid}
POST /api/wallet/withdraw       → require header: Idempotency-Key: {uuid}
```

Backend stores `IdempotencyKey` in Redis for 24h. If same key arrives twice → return the same response (not a new resource).

**Frontend:** Generate `crypto.randomUUID()` before each submit. Disable button immediately on first click. Re-enable after response.

**New DB / Redis key:** `idempotency:{key}` → stores `{ status, responseBody }`, TTL 24h.

---

### 27.7 Security — Admin Account Protection

**Risk:** A compromised admin account can approve fraudulent KYC, release funds, and ban users.

**Required:**
1. **2FA required for all admin roles** — when a user with `role = admin | super_admin | kyc_reviewer | dispute_agent` tries to log in without 2FA enabled → force 2FA setup before accessing admin panel
2. **Admin login alerts:** Every admin login → email to `ADMIN_ALERT_EMAIL` with IP, device, timestamp
3. **KYC approval race condition fix:** When admin opens a KYC submission, backend sets `reviewingBy = adminId` + `reviewingAt = now()`. If another admin opens same submission → show "⚠️ Being reviewed by {adminUsername} since X min ago". Only one admin can approve/reject.
4. **Withdrawal approval:** Same lock pattern — only one admin can approve a withdrawal at a time.

**New DB fields:**
```
KycSubmission.reviewingBy  (userId, nullable, cleared on approve/reject)
KycSubmission.reviewingAt  (timestamp, nullable)
```

**New config key:** `require_admin_2fa = true`

---

### 27.8 Analytics & Event Tracking

**Nothing is tracked. Flying blind after launch.** Add Posthog (free, open-source, self-hostable) or Mixpanel.

**Frontend — track these events:**

```typescript
// Every call: posthog.capture('event_name', { properties })
'page_viewed'           → { page: '/marketplace' }
'registered'            → { role: 'user'|'merchant' }
'kyc_started'           → { tier: 'basic'|'enhanced' }
'kyc_submitted'         → { tier }
'ad_created'            → { coin, side, priceType }
'trade_initiated'       → { coin, fiatAmount }
'trade_completed'       → { coin, fiatAmount, durationMinutes }
'instant_buy_started'   → { coin, payWith: 'pkr'|'crypto' }
'instant_buy_completed' → { coin, fiatAmount }
'referral_shared'       → { platform: 'whatsapp'|'telegram'|'facebook'|'copy' }
'dispute_opened'        → { tradeAge: minutes }
'collateral_locked'     → { amount }
'withdrawal_initiated'  → { coin, amount }
'leaderboard_viewed'    → { tab: 'traders'|'merchants' }
'profile_viewed'        → { own: boolean }
```

**Backend — track KPIs in DB (store in a `PlatformMetric` table or use Posthog server-side):**
```
daily_new_users
daily_new_merchants
daily_trades_completed
daily_instant_buy_completed
daily_disputes_opened
kyc_submission_to_approval_hours  (avg)
trade_initiation_to_completion_hours  (avg)
```

**New env var:** `NEXT_PUBLIC_POSTHOG_KEY=phc_...`

**New env var:** `NEXT_PUBLIC_POSTHOG_HOST=https://app.posthog.com`

---

### 27.9 Missing Legal Pages

**These pages are required before any public launch.**

#### `/terms` — Terms of Service
- What the platform is (P2P exchange, not a bank)
- User eligibility (must be 18+, Pakistan resident)
- What PakSwap is NOT responsible for (P2P trades between users — seller sends from their own wallet)
- Collateral policy (may be seized for fraud — users agree to this)
- Fee structure (link to `/fees`)
- Account termination conditions
- Dispute resolution process
- Governing law (Pakistan)

**API:** No API needed — static page. Show link in footer on all pages.

#### `/privacy` — Privacy Policy
- What data is collected: email, fullName, CNIC (for KYC), IP address, trade history
- How it's stored: encrypted at rest (S3, PostgreSQL)
- Who sees it: admins only for KYC, law enforcement if legally required
- Retention: KYC documents kept for 5 years (AML requirement), account data deleted after 30-day deletion request
- User rights: right to access, right to delete, right to export

**API:** No API needed — static page.

#### `/about` — About Page
- Who runs PakSwap (company name, city)
- Mission statement
- How the platform works (simple explainer)
- Contact email / WhatsApp
- Registration number (if registered business)

**Footer links** (must appear on all public pages): Terms | Privacy | About | Fees | Support

---

### 27.10 User Onboarding Checklist Widget

**New dashboard widget for users who have not yet completed all setup steps.**

Shown at the top of `/dashboard` only if user has incomplete steps. Hidden once all steps done.

```
GET /api/auth/me → check these fields:
```

| Step | Condition | CTA |
|------|-----------|-----|
| ✅ Email Verified | `isEmailVerified === true` | — |
| ⬜ Complete KYC | `kycStatus !== 'approved'` | "Verify Identity →" → `/kyc` |
| ⬜ Fund Your Wallet | `wallet balances all zero` | "Deposit Crypto →" → `/wallet` |
| ⬜ Add Payment Method | `paymentMethods.length === 0` | "Add JazzCash/Bank →" → `/payment-methods` |
| ⬜ Make First Trade | `tradeStats.totalTrades === 0` | "Browse Marketplace →" → `/marketplace` |

Show as a horizontal stepper or vertical checklist card. Progress bar: "3 of 5 steps complete".

**This is the single most impactful retention feature for new users.** Users who complete onboarding convert to active traders at 3–5× higher rate than users who don't.

---

### 27.11 Referral Landing Page — `/r/[code]`

**This page is currently unspecced but the referral link points to it.**

`pakswap.pk/r/{referralCode}` must:

1. Store `referralCode` in `localStorage` or a cookie (30-day expiry)
2. Redirect to `/register`
3. On the register form: show "🎁 You were referred by a friend! You'll both earn 500 PKR after your first trade."
4. Pre-fill the referral code field in the registration form

**Backend:** `POST /api/auth/register { referralCode }` already accepts this — just make sure the frontend passes the stored code.

**This page is public and no auth required.**

---

### 27.12 Database Index Strategy

**Without indexes, these queries will become dangerously slow above 10,000 rows:**

Add to Prisma schema `@@index([...])`:

```prisma
model Trade {
  @@index([buyerId])
  @@index([sellerId])
  @@index([status])
  @@index([createdAt])
  @@index([adId])
}

model Ad {
  @@index([userId])
  @@index([status])
  @@index([side, coin, status])   ← compound: marketplace main query
  @@index([createdAt])
}

model Transaction {
  @@index([walletId])
  @@index([type])
  @@index([createdAt])
}

model Notification {
  @@index([userId, isRead])
  @@index([userId, createdAt])
}

model InstantBuyOrder {
  @@index([userId])
  @@index([status])
  @@index([createdAt])
}

model KycSubmission {
  @@index([userId])
  @@index([status])
  @@index([cnicNumberHash])      ← dedup check
}
```

---

### 27.13 S3 Pre-Signed URLs

**Current spec has backend receiving raw files.** This is slow (double bandwidth) and puts file-handling load on the backend.

**Fix — Pre-signed URL pattern:**

```
1. Frontend requests upload URL:
   POST /api/upload/presign { fileType: 'image/jpeg', purpose: 'kyc_front' | 'payment_proof' | 'dispute_evidence' }
   → { uploadUrl: 'https://s3.amazonaws.com/...?X-Amz-Signature=...', fileKey: 'kyc/userId/uuid.jpg' }

2. Frontend uploads DIRECTLY to S3 using the pre-signed URL (PUT request to S3)

3. Frontend sends the fileKey to the actual endpoint:
   POST /api/kyc/submit { cnicFrontKey: 'kyc/userId/uuid.jpg', ... }

4. Backend NEVER touches the raw file bytes — only stores the S3 key
```

**Benefits:** 10× faster uploads, no backend memory pressure, works with large files.

**New endpoint:** `POST /api/upload/presign` — validates fileType, generates signed URL with 5-minute expiry.

---

### 27.14 Image Compression (Mobile Critical)

Specify in the frontend before any file upload:

```typescript
import imageCompression from 'browser-image-compression'

const compress = async (file: File): Promise<File> => {
  if (!file.type.startsWith('image/')) return file  // don't compress PDFs
  return imageCompression(file, {
    maxSizeMB: 2,
    maxWidthOrHeight: 2000,
    useWebWorker: true,
  })
}

// Usage: compress file before getting pre-signed URL
const compressed = await compress(selectedFile)
```

This is critical for Pakistani mobile users who commonly have 12–50MP cameras producing 15–40MB photos.

---

### 27.15 Error Monitoring — Sentry

**No error monitoring = silent failures in production.**

```
npm install @sentry/nextjs @sentry/node
```

**Frontend (`sentry.client.config.ts`):**
```typescript
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,   // 10% of transactions
})
```

**Backend:**
```typescript
Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV })
// Add to Fastify error handler
```

**What to capture:**
- All unhandled exceptions (automatic)
- Failed BullMQ jobs (manual: `Sentry.captureException(error)` in job error handler)
- Failed email sends
- Rate fetcher failures

**New env vars:**
```
SENTRY_DSN=https://...@sentry.io/...
NEXT_PUBLIC_SENTRY_DSN=https://...@sentry.io/...
```

---

### 27.16 BullMQ Dead Letter Queue

**If a BullMQ job fails 3 times, it silently disappears.** The Instant Buy OCR never runs. KYC Layer 1 never runs. User's order is stuck forever.

**Fix:**

```typescript
// Every job queue must have:
const queue = new Queue('ocr-verification', { connection: redis })
const worker = new Worker('ocr-verification', processor, {
  connection: redis,
  limiter: { max: 10, duration: 1000 },
})

worker.on('failed', (job, err) => {
  Sentry.captureException(err, { extra: { jobId: job?.id, data: job?.data } })
  // After maxAttempts (3), move to dead letter:
  if (job?.attemptsMade >= 3) {
    // Send alert email to admin
    sendEmail(ADMIN_ALERT_EMAIL, 'Job Failed', `Job ${job.id} failed after 3 attempts: ${err.message}`)
    // Mark the related order/submission as 'manual_review_required'
  }
})

// All queues must have:
defaultJobOptions: {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
}
```

**Affected queues:** `ocr-verification`, `rate-updater`, `trade-escalation`, `merchant-rank-updater`, `referral-payout`, `badge-recalculate`, `gas-fee`

**Complete BullMQ Queue Registry:**

| Queue Name | Key Jobs | Trigger | Priority | Retries | Backoff |
|------------|---------|---------|---------|---------|---------|
| `ocr-verification` | `verify-payment` | Instant buy screenshot upload | 1 (highest) | 3 | exponential 5s |
| `gas-fee` | `send-gas`, `expire-order`, `check-delivery`, `monitor-balances` | Payment detected / timer / cron | 1 | 3 | exponential 10s |
| `push-notifications` | `send-push` | Trade events, payment alerts | 1 | 3 | exponential 5s |
| `trade-escalation` | `escalate-trade` | 4h timer after payment_uploaded | 2 | 3 | exponential 30s |
| `badge-recalculate` | `recalculate` | Trade completion | 2 | 3 | fixed 5s |
| `email-sender` | `send-email` | User events | 3 | 3 | exponential 30s |
| `rate-updater` | `update-rates` | Cron every 5min | 3 | 3 | exponential 10s |
| `referral-payout` | `process-reward` | Trade completion | 3 | 3 | exponential 30s |
| `fraud-detector` | `check-fraud` | User actions | 4 | 3 | exponential 60s |
| `leaderboard-cache` | `rebuild-cache` | Cron every 1h | 4 | 1 | fixed 60s |
| `merchant-rank-updater` | `update-ranks` | Cron Sunday midnight PKT | 4 | 3 | fixed 5min |
| `database-backup` | `backup` | Cron daily 3am PKT | 4 | 2 | fixed 30min |

---

### 27.17 Customer Support Widget

**Spec currently only has a `support_whatsapp` config key.** Users who have problems will have no way to get help in-app.

**Add:**

1. **In-app support chat** — embed Crisp (free for up to 2 agents) or Tawk.to (free forever):
   ```html
   <!-- In _app or layout.tsx -->
   <script src="https://embed.tawk.to/{TAWK_PROPERTY_ID}/{TAWK_WIDGET_ID}"></script>
   ```
   New env var: `NEXT_PUBLIC_TAWK_PROPERTY_ID=...`

2. **Help page `/help`** — static page with:
   - Common questions (pulls from `platformConfig: home_faqs` already specced)
   - WhatsApp button: `https://wa.me/{support_whatsapp}` (from API config)
   - Email: `support@pakswap.pk`
   - "Open a dispute" button (links to dispute flow for trade-related issues)
   - Response time notice: "We respond within 2–4 hours on business days"

3. **Floating help button** on all user pages (bottom-right corner): opens Tawk.to chat or `/help`

4. **Footer links** on all public pages: `Help | Contact | Terms | Privacy`

---

### 27.18 SEO & Meta Tags

All public pages must have proper `<head>` metadata. In Next.js App Router, use the `metadata` export.

**Per-page metadata:**

```typescript
// app/layout.tsx — global defaults
export const metadata: Metadata = {
  title: { default: 'PakSwap — Buy & Sell Crypto in Pakistan', template: '%s | PakSwap' },
  description: 'Pakistan\'s P2P crypto exchange. Buy and sell USDT, BTC, ETH with JazzCash, Easypaisa, and bank transfer.',
  keywords: ['crypto Pakistan', 'buy USDT Pakistan', 'p2p crypto exchange', 'JazzCash crypto'],
  openGraph: {
    type: 'website',
    siteName: 'PakSwap',
    images: [{ url: '/og-image.png', width: 1200, height: 630 }],
  },
  twitter: { card: 'summary_large_image' },
}

// app/marketplace/page.tsx
export const metadata = { title: 'Marketplace — Buy & Sell Crypto P2P' }

// app/leaderboard/page.tsx
export const metadata = { title: 'Leaderboard — Top Traders & Merchants' }

// app/profile/[username]/page.tsx — dynamic
export async function generateMetadata({ params }) {
  return { title: `${params.username}'s Profile` }
}
```

**robots.txt** (`public/robots.txt`):
```
User-agent: *
Allow: /
Disallow: /dashboard
Disallow: /admin
Disallow: /wallet
Disallow: /trade/
Sitemap: https://pakswap.pk/sitemap.xml
```

**sitemap.xml** — generate via `app/sitemap.ts` (Next.js built-in):
```typescript
// Static public pages: /, /marketplace, /leaderboard, /fees, /about, /terms, /privacy, /help
// Dynamic: /profile/[username], /merchant/[id] — only approved ones
```

---

### 27.19 Account Deletion & Data Export

**Legal requirement (Pakistan PDPA 2023, and expected by any serious user).**

```
POST /api/auth/delete-account { password, reason? }
  → Marks account as 'deletion_requested', schedules deletion in 30 days
  → Email sent: "Your account will be deleted in 30 days. Log in to cancel."
  → If user has active trades: reject with 'ACTIVE_TRADES_EXIST'
  → If user has locked collateral: reject with 'COLLATERAL_LOCKED'

POST /api/auth/cancel-deletion
  → Cancels the scheduled deletion if within 30-day window

GET /api/auth/export-data
  → Returns a ZIP file (via signed S3 URL) containing:
    - profile JSON (fullName, email, username, createdAt)
    - trade history CSV
    - wallet transaction history CSV
    - notifications JSON
    (NOT KYC photos — those are retained 5 years for AML)
```

**Backend:** Cron job runs daily, permanently deletes accounts where `deletionRequestedAt < now() - 30 days`.

**New DB fields:** `User.deletionRequestedAt (DateTime?)`, `User.deletionScheduledAt (DateTime?)`

**Settings page addition:** "Delete Account" section with red button at bottom, confirmation modal.

---

### 27.20 Idle User Reactivation Emails

**Users who register but don't trade are lost revenue.** Spec a re-engagement email sequence:

| Trigger | Delay | Subject | Content |
|---------|-------|---------|---------|
| Registered but no KYC after 24h | +24h | "One step to start trading on PakSwap" | "Complete your KYC in 2 minutes" + CTA |
| KYC approved but no first trade after 48h | +48h | "Your account is ready — make your first trade" | Show current USDT rate, top ad, CTA to marketplace |
| No login in 7 days (was active before) | +7 days | "Rates have moved since you were last here" | Show rate change, any pending referrals |
| Referred a friend, friend hasn't traded after 5 days | +5 days | "Remind your friend — you're both 500 PKR away!" | Show referral status, share button |

**Implementation:** BullMQ delayed jobs. When user registers → schedule `+24h` check. When KYC approved → schedule `+48h` check. Cancel job if the triggering action completes.

**Unsubscribe:** These are marketing emails — must include unsubscribe link. Add `User.marketingEmailsEnabled (Boolean default true)`.

---

### 27.21 PWA Support (Progressive Web App)

Pakistani users primarily use mobile. Add to home screen capability dramatically increases return visits.

**Add to `public/manifest.json`:**
```json
{
  "name": "PakSwap",
  "short_name": "PakSwap",
  "description": "Buy & Sell Crypto in Pakistan",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#2563eb",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

**Add in `app/layout.tsx`:**
```typescript
export const metadata = {
  manifest: '/manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'PakSwap' },
}
```

This enables "Add to Home Screen" on Safari (iOS) and Chrome (Android) — no App Store needed.

---

### 27.22 Admin Internal Notes on Users

**Admin needs to add investigation notes to user accounts without the user seeing them.**

```
GET  /api/admin/users/:id/notes
POST /api/admin/users/:id/notes { note }
DELETE /api/admin/users/:id/notes/:noteId
```

**New DB table:**
```
AdminNote
  id, targetUserId, authorId (admin), note (text), createdAt
```

**Shown on admin user detail page** below the user's stats. Each note shows: admin username, timestamp, note text. Non-destructive — notes are never deleted (even if admin tries), they are soft-deleted (`isDeleted: true`).

---

### 27.23 Final Developer Rules Addition (Section 22 Additions)

Add rules 23–28 to Section 22:

```
23. Rate limiting must be applied to ALL write endpoints and sensitive read endpoints.
    Use the table in Section 27.1. A backend without rate limits is an open invitation to abuse.

24. Every BullMQ job must have: attempts: 3, exponential backoff, error handler that
    alerts admin on final failure. Silent job failures are launch-blockers.

25. File uploads must be validated by real MIME type (file buffer, not extension).
    Max 10MB. Rename to UUID. Never use user-provided filename in S3 path.

26. Pre-signed S3 URLs must be used for all file uploads.
    The backend must never receive raw file bytes in production.

27. Analytics events must be fired for every major user action.
    Use Posthog or Mixpanel. Without tracking, product decisions are guesses.

28. The /r/[referralCode] referral landing page must store the code in localStorage
    and pass it to /register automatically. A referral link that doesn't pre-fill
    the code loses 60–80% of referrals.
```

---

### 27.25 Security — CSRF Protection

**Applies when:** JWT is stored in an httpOnly cookie (per Section 27.2). Cookie-based auth makes CSRF possible — a malicious site can trigger cross-origin requests that carry the cookie automatically.

**Implementation:**

```typescript
// Register @fastify/csrf-protection on the Fastify server
import fastifyCsrf from '@fastify/csrf-protection'
await fastify.register(fastifyCsrf)

// Frontend: on app load, fetch CSRF token:
// GET /api/auth/csrf-token → { csrfToken: string }
// Store in memory (Zustand), NOT localStorage
// Include in every mutating request as header: X-CSRF-Token: {token}
```

**Which endpoints require CSRF token header:**
All `POST`, `PATCH`, `DELETE`, `PUT` endpoints. Read-only `GET` endpoints are exempt.

**Defense-in-depth:** The `SameSite=Strict` cookie attribute is the primary defense. The CSRF token is a secondary layer for environments where SameSite behaviour is inconsistent (older Android browsers, some Safari versions).

**New endpoint:** `GET /api/auth/csrf-token` → `{ csrfToken: string }` — returns a per-session token. Frontend calls this once on app load and stores the token in Zustand.

---

### 27.26 Security — Wallet Address Validation Per Network + 2FA on High-Value Withdrawals

#### Per-Network Cryptographic Address Validation

Already integrated into Section 16.5 (trade initiation) and Section 16.9 (wallet withdrawal). Apply the same validation to:
- `POST /api/instant-buy/orders { toAddress }` — Instant Buy destination
- `POST /api/wallet/withdraw { toAddress }` — withdrawal
- `POST /api/wallet/saved-addresses { address }` — saved address creation

**Backend implementation (validate server-side — never trust frontend-only validation):**

```typescript
import { isAddress } from 'viem'                          // EVM
import { validate as validateBtc } from 'bitcoin-address-validation'  // BTC
import { PublicKey } from '@solana/web3.js'                // SOL

function validateAddress(address: string, coin: string, network: string): boolean {
  if (['ETH','BNB','ARB','OP','AVAX','MATIC'].includes(coin) || network === 'ERC20' || network === 'BEP20') {
    return isAddress(address)
  }
  if (coin === 'BTC') return validateBtc(address)
  if (coin === 'SOL') { try { new PublicKey(address); return true } catch { return false } }
  if (network === 'TRC20') return /^T[a-zA-Z0-9]{33}$/.test(address)
  return address.length > 10  // fallback for unlisted networks
}
```

Return `INVALID_WALLET_ADDRESS` with a human-readable message if validation fails.

#### 2FA Re-Authentication on High-Value Withdrawals

For any withdrawal where `amount × rate > PKR 50,000` (configurable via `platformConfig: withdrawal_reauth_threshold_pkr`):

1. Backend checks `Session.lastHighValueAuthAt`
2. If `lastHighValueAuthAt` is null or `> 4 hours ago`: return `WITHDRAWAL_REQUIRES_REAUTH`
3. Frontend shows: "Security check: confirm your identity to continue"
   - If 2FA enabled: TOTP code input → `POST /api/auth/2fa/verify-action { totpCode }` → updates `lastHighValueAuthAt`
   - If 2FA not enabled: email OTP sent automatically → user enters 6-digit code
4. After successful re-auth: retry the withdrawal

**New DB field:** `Session.lastHighValueAuthAt (DateTime?)`
**New config key:** `withdrawal_reauth_threshold_pkr = 50000`
**New endpoint:** `POST /api/auth/verify-action { totpCode? | emailCode? }` → `{ verified: true }` + sets `lastHighValueAuthAt`

---

### 27.27 Security — Bot Detection, Registration CAPTCHA & Disposable Email Blocking

**Why:** Without friction at registration, bots can create thousands of accounts in minutes to abuse referrals, manipulate the leaderboard, or flood the KYC queue with fake submissions.

#### Cloudflare Turnstile (Registration & Login)

```typescript
// Frontend: add Turnstile widget to /register and /login forms
// <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async></script>
// <div class="cf-turnstile" data-sitekey={NEXT_PUBLIC_TURNSTILE_SITE_KEY}></div>
// On form submit: include cf-turnstile-response token in POST body

// Backend: verify token before creating account
const verifyTurnstile = async (token: string, ip: string) => {
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
  })
  const data = await res.json()
  if (!data.success) throw new AppError('CAPTCHA_FAILED', 'Bot check failed')
}
```

**New env vars:**
```
NEXT_PUBLIC_TURNSTILE_SITE_KEY=...   # from Cloudflare dashboard
TURNSTILE_SECRET_KEY=...
```

#### Disposable Email Blocking

```typescript
import disposableDomains from 'disposable-email-domains'

const blockDisposableEmail = (email: string) => {
  const domain = email.split('@')[1].toLowerCase()
  if (disposableDomains.includes(domain)) {
    throw new AppError('DISPOSABLE_EMAIL_NOT_ALLOWED', 'Temporary email addresses are not permitted')
  }
}
// Call in: POST /api/auth/register
```

#### New Error Codes

- `CAPTCHA_FAILED` — Turnstile verification failed (bot suspected)
- `DISPOSABLE_EMAIL_NOT_ALLOWED` — email domain is a known disposable provider

#### New platformConfig key

```
registration_captcha_enabled = true   ← set false during development/testing
```

---

### 27.28 Infrastructure — Hot Wallet Risk Mitigation & Cold Storage Policy

**The risk:** PakSwap operates a single hot wallet per network. A single compromised key = total loss of all user deposits and payout reserves.

#### Required Operational Controls (Phase 1)

1. **Two-person rule on payouts:** Every withdrawal or Instant Buy payout requires two staff members — one initiates, one confirms in the admin panel. Implement as:
   - `PATCH /api/admin/withdrawals/:id/approve` requires two separate admin sessions (first admin sets `firstApprovedBy`, second admin completes approval)
   - New DB fields: `Withdrawal.firstApprovedBy (userId?)`, `Withdrawal.firstApprovedAt (DateTime?)`
   - Admin panel shows: "Awaiting second approval from another admin"

2. **Hot wallet daily limit:** Admin sets `platformConfig: hot_wallet_daily_payout_limit_usdt` (e.g. 10,000 USDT). If the sum of approved payouts in the last 24h exceeds this limit, block further approvals and alert `ADMIN_ALERT_EMAIL`. Operator must manually increase the limit for large days.

3. **Cold storage sweep:** Operator should manually sweep excess funds from hot wallet to cold storage daily. Target: hot wallet holds ≤ 2 days of average payout volume. Document this as a daily operational task in the admin runbook.

4. **Separate deposit addresses:** Use unique deposit addresses per user per coin (HD wallet derivation) rather than a single shared address — this prevents cross-contamination and makes forensics easier. *This is a Phase 2 enhancement; Phase 1 uses the single shared address per coin/network.*

#### New platformConfig keys

```
hot_wallet_daily_payout_limit_usdt = 10000
require_dual_approval_withdrawals = true    ← enforces two-admin sign-off
require_dual_approval_instant_buy = false   ← enable when volumes grow
```

#### Phase 2 — Custodial Solution

When volume exceeds 50 withdrawals/day, integrate a custodial solution:
- **Fireblocks** — enterprise-grade MPC wallet with policy engine and dual-approval workflows
- **Copper.co** — similar, good for emerging markets
- Both eliminate manual payout process and hot key exposure entirely

---

### 27.29 Infrastructure — Circuit Breaker for External APIs + Redis High Availability

#### Circuit Breaker Pattern

All external API calls (Binance rates, Etherscan gas, mempool.space BTC fees, ExchangeRate-API) must use a circuit breaker to prevent cascade failures.

```typescript
import CircuitBreaker from 'opossum'

const fetchBinanceRate = async (coin: string) => { /* ... fetch ... */ }

const binanceBreaker = new CircuitBreaker(fetchBinanceRate, {
  timeout: 5000,           // 5s timeout per call
  errorThresholdPercentage: 50,  // open circuit after 50% failure rate
  resetTimeout: 60000,     // try again after 60s
})

binanceBreaker.on('open', () => {
  logger.error('Binance circuit breaker OPEN — using cached rates')
  sendAdminAlert('Binance API circuit open — rates are stale')
})

binanceBreaker.fallback(() => {
  // Return last known rate from Redis cache
  return redis.get(`rate_cache:${coin}`)
})
```

**Apply circuit breakers to:**
| External Service | Fallback Behaviour |
|---|---|
| Binance rates | Serve cached rate from Redis (up to 1h old) |
| ExchangeRate-API (USD/PKR) | Use `platformConfig: usd_pkr_rate` manual override |
| Etherscan gas | Serve last known gas estimate; show "estimated" label in UI |
| mempool.space BTC fees | Same as Etherscan |
| Moralis/Tatum webhooks | Already async — no circuit breaker needed |

**Frontend:** If API returns `source: 'cached'` on any fee or rate endpoint, show the staleness warning per Section 27.31.

#### Redis High Availability

```
# Railway: use Redis Pro plan with AOF persistence enabled
# Configure via Redis dashboard:
appendonly yes
appendfsync everysec    # flush to disk every second (balance between safety and performance)
save 900 1             # RDB snapshot every 15 min if ≥1 key changed
```

**BullMQ job idempotency under Redis restart:** All jobs must be idempotent — safe to re-run after a crash. Before processing, check `redis.get('job_processed:{jobId}')`. After processing, set it with 24h TTL.

**Redis memory alert:** Use Railway's alerting or add a BullMQ scheduled job that checks `redis.info('memory')` every 5 minutes and emails `ADMIN_ALERT_EMAIL` if `used_memory_rss` > 80% of `maxmemory`.

---

### 27.30 Performance — Dashboard Aggregation Endpoint + Leaderboard Cache

#### Dashboard Aggregation Endpoint

**New backend endpoint — Phase 1 required:**

```
GET /api/dashboard/summary
Authorization: Bearer token required

→ {
    user: User,                           // from auth/me
    wallets: Wallet[],                    // from wallet
    recentTrades: Trade[5],               // trades?limit=5
    recentInstantBuy: InstantBuyOrder[3], // instant-buy/orders?limit=3
    usdtRate: { rate, updatedAt },        // marketplace/rate/USDT
    notifications: {
      items: Notification[5],
      unreadCount: number
    },
    rank: {                               // users/me/rank
      badge, badgeLabel, badgeIcon,
      trustScore, totalTrades, completionRate,
      nextBadge: { label, tradesNeeded, completionRequired } | null
    }
  }
```

**Backend implementation:** Run all sub-queries in parallel using `Promise.all`. Total response time ≈ slowest sub-query (~100–200ms on warm DB). Compared to 7 sequential client calls on mobile (4–8s), this is a 20–40× improvement.

```typescript
// backend: GET /api/dashboard/summary
const [user, wallets, trades, iboOrders, usdtRate, notifs, rank] = await Promise.all([
  db.user.findUnique({ where: { id: userId } }),
  db.wallet.findMany({ where: { userId } }),
  db.trade.findMany({ where: { OR: [{ buyerId: userId }, { sellerId: userId }] }, take: 5, orderBy: { createdAt: 'desc' } }),
  db.instantBuyOrder.findMany({ where: { userId }, take: 3, orderBy: { createdAt: 'desc' } }),
  getUsdtRate(),   // from platformConfig or Redis cache
  getNotifications(userId, 5),
  getUserRank(userId),
])
```

#### Leaderboard Redis Cache

The leaderboard query joins `TradeStats`, `User`, and `Merchant` across potentially tens of thousands of rows. It must be pre-computed.

```typescript
// BullMQ repeatable job: leaderboard-cache-refresher
// Schedule: every hour
const LEADERBOARD_CACHE_TTL = 3600  // 1 hour

const refreshLeaderboard = async () => {
  const traders = await db.$queryRaw`
    SELECT u.username, ts.badge, ts."totalTrades", ts."completionRate", ts."avgRating", ts."totalVolumePKR"
    FROM "TradeStats" ts JOIN "User" u ON ts."userId" = u.id
    ORDER BY ts."totalVolumePKR" DESC LIMIT 100
  `
  await redis.set('leaderboard:traders:all', JSON.stringify(traders), 'EX', LEADERBOARD_CACHE_TTL)
  // Similarly for merchants, 30d, 7d variants
}
```

`GET /api/leaderboard` reads from Redis cache first. Falls back to DB query if cache is cold. Marks response with `source: 'cached'` and `cachedAt` timestamp.

---

### 27.31 UX — Rate Staleness Warning + Trade Expiry Race Condition Fix

#### Rate Staleness Warning

When a rate or fee has not been refreshed recently, users must see a clear signal — not a broken experience.

**Frontend rule:** For any displayed rate or fee, compute `ageMinutes = (Date.now() - new Date(updatedAt).getTime()) / 60000`. Apply:

```typescript
const getStalenessLabel = (updatedAt: string) => {
  const age = (Date.now() - new Date(updatedAt).getTime()) / 60000
  if (age < 2)   return { color: '#10b981', label: `updated ${Math.round(age * 60)}s ago` }
  if (age < 10)  return { color: '#64748b', label: `updated ${Math.round(age)} min ago` }
  if (age < 30)  return { color: '#d97706', label: `⚠️ rate is ${Math.round(age)} min old` }
  return         { color: '#ef4444',  label: `⚠️ rate data is stale — please refresh` }
}
```

If `age > 15 minutes`, also show a non-blocking yellow banner on any page that shows a rate:
> "⚠️ Rate data is delayed. Prices shown may not be current. [Refresh]"

This applies to: marketplace rate display, Instant Buy form, withdrawal fee display, dashboard rate display.

#### Trade Expiry Race Condition Fix

**The bug:** The BullMQ escalation job runs every 30 minutes. A trade whose `expiresAt` passed 29 minutes ago is still `payment_pending`. A buyer uploads a screenshot — the trade auto-cancels 1 minute later, but the payment screenshot is already submitted. Buyer has paid but trade is cancelled.

**Fix — backend enforcement on `POST /api/trades/:id/confirm-payment`:**

```typescript
// Before processing the payment upload:
if (trade.expiresAt < new Date()) {
  // Cancel the trade immediately
  await db.trade.update({ where: { id }, data: { status: 'cancelled', cancelReason: 'expired' } })
  return reply.status(409).send({ error: 'TRADE_EXPIRED', message: 'This trade has expired and has been cancelled.' })
}
```

**Frontend enforcement:** The upload button on the trade page must be visually disabled when `trade.expiresAt < Date.now()`:

```typescript
const isExpired = trade.expiresAt && new Date(trade.expiresAt) < new Date()
// <button disabled={isExpired}>{isExpired ? 'Trade Expired' : 'Upload Payment Proof'}</button>
```

Both checks together close the race window completely.

---

### 27.32 UX — Mandatory Username Setup + Confirmation Dialogs for Irreversible Actions

#### Mandatory Username Setup

Auto-generated usernames like `user_a4f2b1` look like bots and destroy marketplace trust. Username setup must be mandatory, not optional.

**Revised flow (replaces "Skip for now" option from Section 16.0b):**

1. After email verification → redirect to `/setup-username`
2. Form pre-filled with auto-generated username (e.g. `user_a4f2b1`)
3. User can accept the auto-generated name with one click, or type a new one
4. Live availability check (debounced 500ms): `GET /api/auth/check-username?username=xyz`
5. **"Continue" is the only button — no skip.** The username field defaults to the auto-generated value so the user can always just press Continue without typing anything.
6. After submit → redirect to `/dashboard` or `?next=` param

This creates zero friction (user can just press Continue) while ensuring every marketplace user has a human-readable identifier.

**Backend:** `PATCH /api/auth/profile { username }` — no change needed. The existing endpoint handles this.

#### Confirmation Dialogs for Irreversible Actions

Every destructive or irreversible user action must show a confirmation modal before execution. No exceptions.

| Action | Confirmation Text | Extra Step |
|--------|------------------|------------|
| Cancel a trade | "Cancel this trade? This cannot be undone. The buyer's payment proof will be lost." | — |
| Delete an ad | "Delete this ad? All settings will be lost. Active trades on this ad will not be affected." | — |
| Open a dispute | "Open a dispute? The admin will be notified. Disputes are reviewed within 24–48 hours." | — |
| Submit a withdrawal | "Withdraw {amount} {coin} to {address truncated}? Crypto withdrawals cannot be reversed." | Show full address |
| Lock collateral | "Lock {amount} USDT as collateral? This amount will not be withdrawable while you have active sell ads." | — |
| Unlock collateral | "Unlock your {amount} USDT collateral? You will need to re-lock it to post sell ads." | — |
| Delete account | "Delete your account? All your data will be permanently removed in 30 days. This cannot be undone while you have active trades." | Type "DELETE" |

**Admin-side confirmations:**
| Action | Confirmation Text | Extra Step |
|--------|------------------|------------|
| Seize collateral | "Seize {amount} USDT collateral from {username}? This is permanent and logged in the audit trail." | Type reason |
| Ban a user | "Ban {username}? They will lose access to their account immediately." | Type reason |
| Reject KYC | "Reject KYC for {name}? They will be notified and can resubmit." | Select/type reason |

**Implementation:** Build a reusable `<ConfirmModal>` component that accepts: `title`, `description`, `confirmLabel`, `confirmVariant ('danger'|'warning')`, `onConfirm`, `requireTypedConfirmation?: string`. Used everywhere above.

---

### 27.33 Fraud — Automated Fraud Detection Rules

**Problem:** Fraud is currently detected only after a victim reports it. Automated rules catch bad actors before damage spreads.

**New BullMQ repeatable job:** `fraud-detector` — runs every 15 minutes.

```typescript
// Rules checked on every run:

// Rule 1: High dispute rate in short window
const highDisputeUsers = await db.$queryRaw`
  SELECT "userId", COUNT(*) as disputes
  FROM "Dispute" d JOIN "Trade" t ON d."tradeId" = t.id
  WHERE d."createdAt" > NOW() - INTERVAL '7 days'
  AND (t."buyerId" = "userId" OR t."sellerId" = "userId")
  GROUP BY "userId"
  HAVING COUNT(*) >= 3
`
// → Create FraudFlag for each; alert admin

// Rule 2: Rapid account + large sell ad (new account fraud pattern)
const newLargeSellers = await db.ad.findMany({
  where: {
    side: 'sell',
    createdAt: { gt: subDays(new Date(), 1) },
    user: { createdAt: { gt: subDays(new Date(), 7) } },
    totalAmount: { gt: 500 },  // > 500 USDT on account < 7 days old
  },
})
// → Create FraudFlag severity: 'high'

// Rule 3: Multiple accounts same IP
// Checked during registration (not a cron job — see Section 27.4 referral abuse rules)

// Rule 4: Velocity — many trades in short time
const velocityAbusers = await db.$queryRaw`
  SELECT "buyerId", COUNT(*) as trades
  FROM "Trade"
  WHERE "createdAt" > NOW() - INTERVAL '1 hour'
  GROUP BY "buyerId"
  HAVING COUNT(*) >= 10
`
// → FraudFlag severity: 'medium'

// Rule 5: Withdrawal to new address after long dormancy
// Handled in Section 27.26 (2FA re-auth on high-value withdrawals)
```

**Admin notification:** If any `FraudFlag` with `severity = 'high'` is created → immediate email to `ADMIN_ALERT_EMAIL`.

**New platformConfig keys:**
```
fraud_dispute_rate_window_days = 7
fraud_dispute_count_threshold = 3
fraud_new_account_days = 7
fraud_new_account_sell_usdt_threshold = 500
fraud_velocity_trades_per_hour = 10
```

#### KYC Required Before First Sell Trade

This is the most important fraud prevention for Phase 1. Currently the spec allows 3 free sell trades before requiring collateral — but does not require KYC at all before selling.

**Fix:** Require basic KYC approval before a user can post ANY sell ad, including the 3 collateral-free ones.

```typescript
// POST /api/ads — before creating ad:
if (ad.side === 'sell') {
  if (user.kycStatus !== 'approved') {
    return reply.status(403).send({ error: 'KYC_REQUIRED_TO_SELL', message: 'Complete KYC to post sell ads' })
  }
}
```

**Frontend:** On `/create-ad`, if user selects `side = 'sell'` and `user.kycStatus !== 'approved'`: disable submit, show: "KYC verification is required to post sell ads. [Complete KYC →]"

**Rationale:** A scammer who completes KYC has their CNIC on file. The CNIC uniqueness check means each real person gets at most one set of free trades before collateral is required. This does not block buyers — only sellers.

---

### 27.34 Legal & Compliance — AML, Sanctions Screening & Pakistan Regulatory Posture

#### Sanctions Screening

Before approving any KYC submission, run the user's full name against the UNSC consolidated sanctions list and the US OFAC SDN list.

**Implementation (free + self-hosted):**

```typescript
// Download UNSC list: https://www.un.org/securitycouncil/content/un-sc-consolidated-list
// Parse and store in DB table: SanctionedEntity { name, aliases[], dateOfBirth?, nationality? }
// Fuzzy-match on KYC approval:

const checkSanctions = async (fullName: string): Promise<boolean> => {
  const results = await db.$queryRaw`
    SELECT name FROM "SanctionedEntity"
    WHERE similarity(name, ${fullName}) > 0.8
    OR similarity(ANY(aliases), ${fullName}) > 0.8
  `
  return results.length > 0
}

// POST /api/admin/kyc/:id/approve → run checkSanctions(submission.fullName)
// If match found: block approval, create FraudFlag severity='high', alert admin
```

**Paid alternative (Phase 2):** Integrate [Chainalysis KYT](https://www.chainalysis.com/) or [ComplyAdvantage](https://complyadvantage.com/) for real-time screening with AML scoring.

#### AML Transaction Monitoring (Structuring Detection)

```typescript
// Detect structuring: multiple just-under-limit transactions from the same user
// Run daily BullMQ job: aml-monitor

// Pattern 1: Multiple transactions near the KYC daily limit
const nearLimitTransactions = await db.$queryRaw`
  SELECT "userId", COUNT(*) as count, SUM("fiatAmount") as total
  FROM "InstantBuyOrder"
  WHERE "createdAt" > NOW() - INTERVAL '24 hours'
  AND "fiatAmount" BETWEEN (SELECT value::numeric FROM "PlatformConfig" WHERE key='kyc_limit_basic_daily') * 0.85
                        AND (SELECT value::numeric FROM "PlatformConfig" WHERE key='kyc_limit_basic_daily') * 0.99
  GROUP BY "userId"
  HAVING COUNT(*) >= 3
`
// → Create FraudFlag type: 'structuring_suspected'

// Pattern 2: Rapid buy-then-withdraw (possible layering)
// If user completes Instant Buy AND submits a withdrawal within 2 hours → flag for review
```

#### Pakistan Regulatory Compliance Posture

The platform operator must, before accepting real user funds:

1. **Obtain legal opinion** from a Pakistan-qualified fintech/crypto attorney on whether the platform requires:
   - SECP registration as a Digital Asset Service Provider
   - SBP No-Objection Certificate for handling PKR transfers
   - FBR registration for PKR transaction reporting thresholds

2. **Business registration:** Platform must operate under a registered company (SMC-Pvt or Pvt Ltd). Operations under an individual are legally exposed.

3. **Terms of Service** must explicitly state: "PakSwap is a P2P exchange technology platform. PakSwap does not operate as a bank, money exchanger, or financial institution. All P2P trades are between independent users. PakSwap's Instant Buy service is operated as an OTC desk."

4. **KYC data retention:** Under Pakistan's AML Act and FATF guidelines, KYC records must be retained for **5 years** after account closure. Store `KycSubmission` records with `deletedAt` null even after account deletion.

5. **Suspicious Transaction Reporting:** Designate a Compliance Officer responsible for filing STRs with FMU (Financial Monitoring Unit of Pakistan) for flagged transactions above PKR 1,000,000 that exhibit AML patterns.

**New platformConfig key:**
```
aml_structuring_threshold_count = 3    ← flagged if N near-limit transactions in 24h
aml_buy_then_withdraw_hours = 2        ← flag if withdrawal within N hours of Instant Buy
compliance_officer_email = compliance@pakswap.pk
```

---

### 27.35 UX — Failed Instant Buy Payment Retry Flow

**The problem:** When an Instant Buy payment is rejected (wrong amount, expired timer, forged screenshot, Layer 1 fail), the order is marked `rejected` and the user must start the entire wizard from scratch: choose coin, choose network, choose payment method, enter amount, enter wallet address. This creates maximum friction at the worst moment — a frustrated user who genuinely wanted to complete the purchase.

**Fix: Retry flow on the status page**

On `/instant-buy/status/:id` when `order.status === 'rejected'`:

```
┌──────────────────────────────────────────────────────┐
│  ❌ Order Rejected                                    │
│                                                      │
│  Reason: {order.rejectionReason}                     │
│                                                      │
│  Your order for {coinAmount} {coin} was not          │
│  completed. No funds were taken from you.            │
│                                                      │
│  What would you like to do?                          │
│                                                      │
│  [Re-upload Payment Proof]   [Start New Order]       │
└──────────────────────────────────────────────────────┘
```

**Option A — Re-upload (if rejection was due to bad screenshot, within 30 min of original order):**
- Only available if `rejectionReason` is one of: `SCREENSHOT_UNCLEAR`, `AMOUNT_MISMATCH`, `WRONG_ACCOUNT`
- And `order.createdAt` is within the last 30 minutes (rate still valid)
- Button → re-opens the payment upload screen for the same order
- New endpoint: `POST /api/instant-buy/orders/:id/resubmit-payment (multipart: screenshot)` — resets `status → 'payment_uploaded'`, `verificationStatus → 'pending_layer1'`

**Option B — New order (pre-filled):**
- Button → `/instant-buy?prefill={orderId}`
- Instant Buy wizard skips step 1 and 2, pre-fills coin/network/payWith/amount/walletAddress from rejected order
- User only needs to re-enter payment on step 3

**New endpoint:**
```
POST /api/instant-buy/orders/:id/resubmit-payment (multipart: screenshot)
  → validates: order.status === 'rejected' AND order.createdAt > now - 30min
  → resets order to payment_uploaded, queues Layer 1 OCR again
  → returns updated order
```

**New error code:** `RESUBMIT_WINDOW_EXPIRED` — retry window has passed, user must create new order.

---

### 27.36 Growth — Home Page Trust Content + Merchant Acquisition Landing Page

#### Home Page Trust Content

The current home page spec lists stats, top ads, and FAQs. New users arriving from search or social ads have no reason to trust the platform. Add two new sections to the home page spec (Section 16.1).

**New Section in `/` (home page) — "How PakSwap Works"**

```
GET /api/marketplace/stats → already fetched; use for social proof numbers
```

UI structure — 3-step explainer (static content, no API needed):

```
┌─────────────────────────────────────────────────────────────────┐
│  How It Works                                                   │
│                                                                 │
│  1. Verify Your Identity    2. Post or Browse Ads   3. Trade   │
│  Complete KYC in minutes.  Find the best P2P rate.  Admin-     │
│  Your CNIC stays private.  JazzCash, Easypaisa,     verified   │
│  Admin-reviewed manually.  or Bank Transfer.        payments.  │
└─────────────────────────────────────────────────────────────────┘
```

**New Section — "Why PakSwap is Safe"** (static, but reference live stats):

```
✅ CNIC-Verified Traders         — every seller verified by admin
🔒 Collateral-Backed Sellers     — sellers lock funds as security deposit
👮 Admin-Reviewed Payments       — every payment manually verified before crypto released
⭐ {totalUsers} Verified Members  — from GET /api/marketplace/stats
📊 {completionRate}% Completion   — from GET /api/admin/analytics (public endpoint or cache)
```

#### Merchant Acquisition Landing Page — `/become-a-merchant`

New public page to drive merchant supply. Merchants provide the inventory for Instant Buy — without them, the most profitable feature of the platform has no supply.

**Data to fetch:**
```
GET /api/marketplace/stats     → activeMerchants count
GET /api/marketplace/rate/USDT → live rate (for earnings calculator)
```

**Page sections:**

1. **Hero:** "Turn Your Crypto Into a Business. Set your spread. Earn on every trade."

2. **Earnings Calculator (interactive, client-side):**
   - Input: "How much USDT do you have?" (default empty)
   - Input: "Spread %:" (default 1.5%, range 0.5–3%)
   - Output: "Estimated monthly earnings: PKR {input × spread × 100 orders}"
   - Note: "Based on typical merchant activity. Your earnings depend on order volume."

3. **Benefits:**
   - Own pricing (spread control)
   - Admin handles payment verification
   - Withdraw anytime (collateral unlocks when no active trades)
   - Priority support

4. **Requirements:**
   - CNIC + business proof
   - 100 USDT collateral (refundable)
   - WhatsApp/Phone for verification

5. **CTA:** "Apply Now →" → `/merchant-apply`
   - If logged in as user: direct link
   - If not logged in: `/register?intent=merchant` → sets `intended_role = 'merchant'` in localStorage

**New route:** `GET /become-a-merchant` — public, no auth required.

---

### 27.37 Push Notifications — Web Push via FCM (Phase 1 Required)

**Problem:** The entire notification system is email + in-app polling. Email open rates are 15–25%. In-app polling only works when the user has the browser tab open. For time-sensitive trading events, this is insufficient — a seller who misses "payment confirmed" means the trade expires and causes a dispute.

**Solution:** Web Push Notifications via Firebase Cloud Messaging (FCM). Works on Android Chrome, desktop Chrome/Firefox, and Safari 16.4+ on iOS. No App Store needed — works in the browser.

#### Backend — Push Infrastructure

**New BullMQ worker:** `push-notification-sender`

```typescript
// backend/src/workers/pushNotifications.ts
import * as admin from 'firebase-admin'
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT!)) })

export const sendPushNotification = async (userId: string, notification: {
  title: string
  body: string
  icon?: string
  url?: string  // where to navigate on click
  tag?: string  // deduplication key (same tag = replace old notification)
}) => {
  const subscriptions = await db.pushSubscription.findMany({ where: { userId, isActive: true } })
  const results = await Promise.allSettled(
    subscriptions.map(sub =>
      admin.messaging().send({
        token: sub.fcmToken,
        notification: { title: notification.title, body: notification.body },
        webpush: {
          notification: { icon: '/icon-192.png', tag: notification.tag, data: { url: notification.url } },
          fcmOptions: { link: notification.url },
        },
      })
    )
  )
  // Remove subscriptions that returned 'registration-token-not-registered' (device unregistered)
  results.forEach((result, i) => {
    if (result.status === 'rejected' && result.reason?.code === 'messaging/registration-token-not-registered') {
      db.pushSubscription.update({ where: { id: subscriptions[i].id }, data: { isActive: false } })
    }
  })
}
```

**New DB table:**
```
PushSubscription
  id, userId, fcmToken (string), userAgent (string?), isActive (bool default true)
  createdAt, lastUsedAt
  unique(userId, fcmToken)
```

**New API endpoints:**
```
POST /api/notifications/push/subscribe   { fcmToken: string }  → saves subscription, returns { subscribed: true }
DELETE /api/notifications/push/subscribe { fcmToken: string }  → marks isActive = false
```

#### Frontend — Service Worker + Subscription

**Step 1 — Service worker (`public/sw.js`):**
```javascript
// public/sw.js — handles push events when tab is closed
self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      tag: data.tag,
      data: { url: data.url },
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url ?? '/'
  event.waitUntil(clients.openWindow(url))
})
```

Register in `app/layout.tsx`:
```typescript
useEffect(() => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
  }
}, [])
```

**Step 2 — Permission prompt component (`components/PushPermissionBanner.tsx`):**
- Show once after first login, dismissed state stored in `localStorage: push_permission_dismissed`
- Do NOT show the native browser prompt on page load — show a friendly banner first
- Banner: "🔔 Enable notifications to know instantly when your trades update. [Enable] [Not now]"
- On "Enable" click: call `Notification.requestPermission()` → if granted, call FCM → save token via API

```typescript
const subscribeToNotifications = async () => {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
  })
  // Convert to FCM token via Firebase SDK
  const { getToken } = await import('firebase/messaging')
  const fcmToken = await getToken(messaging, { vapidKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, serviceWorkerRegistration: registration })
  await api.post('/notifications/push/subscribe', { fcmToken })
}
```

#### Which Events Trigger Push Notifications

| Event | Recipient | Title | Body | URL |
|-------|-----------|-------|------|-----|
| `trade_started` | Seller | "New trade started" | "Buyer wants to buy {amount} {coin}" | `/trade/{id}` |
| `payment_uploaded` | Seller | "Payment uploaded" | "Buyer uploaded payment for {orderRef}" | `/trade/{id}` |
| `payment_confirmed` | Seller | "⚡ Send crypto now!" | "Admin verified payment. Send {amount} {coin} to buyer." | `/trade/{id}` |
| `crypto_sent` | Buyer | "Seller sent crypto" | "Check your wallet and confirm receipt" | `/trade/{id}` |
| `trade_expiring` | Buyer | "⚠️ Trade expires soon" | "Upload payment in {minutes} min or trade cancels" | `/trade/{id}` |
| `dispute_opened` | Buyer + Seller | "Dispute opened" | "A dispute was raised on trade {orderRef}" | `/dispute/{id}` |
| `instant_buy_approved` | Buyer | "✅ Order complete!" | "Your {amount} {coin} order is done" | `/instant-buy/status/{id}` |
| `kyc_approved` | User | "KYC approved ✅" | "You can now trade up to PKR {limit}/day" | `/dashboard` |
| `badge_upgraded` | User | "🎉 New badge!" | "You've earned: {badgeLabel}" | `/profile/{username}` |
| `withdrawal_approved` | User | "Withdrawal sent" | "{amount} {coin} sent — check your wallet" | `/wallet` |

**Push notifications are fired by the same backend events that trigger email notifications** — add `sendPushNotification(userId, ...)` call alongside `sendEmail(...)` in each handler. Both fire in parallel.

#### New env vars (already added to Section 24):
```
FCM_SERVER_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
NEXT_PUBLIC_VAPID_PUBLIC_KEY, FIREBASE_SERVICE_ACCOUNT (JSON string)
```

---

### 27.38 Infrastructure — S3 Private Bucket + HTTPS Security Headers + Security Headers

#### S3 Bucket Security

**The bucket MUST be private.** KYC documents (CNIC photos, selfies) and payment screenshots cannot be publicly accessible. Misconfiguration is the most common cause of data breaches for platforms built on S3.

**Required S3 configuration:**

```json
// Bucket Policy — paste into AWS S3 → your bucket → Permissions → Bucket Policy
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyPublicRead",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::pakswap-uploads/*",
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    },
    {
      "Sid": "AllowBackendOnly",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::{account-id}:user/pakswap-backend" },
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::pakswap-uploads/*"
    }
  ]
}
```

**Block Public Access settings (must ALL be enabled):**
- ✅ Block all public access
- ✅ Block public ACLs
- ✅ Ignore public ACLs
- ✅ Block public bucket policies
- ✅ Restrict public buckets

**How KYC documents and screenshots are served:**
- Backend generates a signed URL with 15-minute expiry: `aws s3 presignedUrl GET key --expires-in 900`
- Frontend receives this signed URL and displays the image — the URL expires and cannot be shared
- Never store the signed URL — always re-request from backend when viewing

**S3 key structure (enforced in presign endpoint):**
```
kyc/{userId}/{uuid}.jpg          → KYC documents
payment-proofs/{userId}/{uuid}.jpg → trade payment screenshots
disputes/{disputeId}/{uuid}.jpg  → dispute evidence
merchant-docs/{userId}/{uuid}.pdf → merchant business proof
```

**Verification before launch:**
```bash
# This must return AccessDenied — if it returns file content, bucket is PUBLIC (critical breach)
curl -I https://pakswap-uploads.s3.ap-south-1.amazonaws.com/kyc/test.jpg
# Expected: HTTP 403 AccessDenied
```

#### HTTPS Enforcement + Security Headers

Add to the Fastify backend as a global hook (applies to ALL responses):

```typescript
// backend/src/plugins/securityHeaders.ts
import fp from 'fastify-plugin'

export default fp(async (fastify) => {
  fastify.addHook('onSend', async (request, reply) => {
    reply.headers({
      // Force HTTPS for 1 year (including subdomains)
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
      // Prevent MIME type sniffing (stops content-type attacks)
      'X-Content-Type-Options': 'nosniff',
      // Block clickjacking
      'X-Frame-Options': 'DENY',
      // XSS protection (legacy browsers)
      'X-XSS-Protection': '1; mode=block',
      // Prevent info leakage via referrer on cross-origin requests
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      // Remove server identity header
      'X-Powered-By': undefined,
      // Permissions policy — restrict dangerous browser APIs
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      // Content Security Policy — adjust as features are added
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",  // Turnstile
        "connect-src 'self' https://api.binance.com https://api.etherscan.io",   // external APIs
        "img-src 'self' data: blob: https://pakswap-uploads.s3.amazonaws.com",   // S3 images (signed URLs)
        "frame-src https://challenges.cloudflare.com",  // Turnstile iframe
      ].join('; '),
    })
  })
})
```

**Apply on Vercel (frontend) via `next.config.ts`:**
```typescript
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
]
// nextConfig.headers = async () => [{ source: '/(.*)', headers: securityHeaders }]
```

**Cookie security flags (for the httpOnly refresh token cookie):**
```typescript
reply.setCookie('refresh_token', token, {
  httpOnly: true,         // JavaScript cannot read this
  secure: true,           // only sent over HTTPS
  sameSite: 'strict',     // never sent on cross-site requests (CSRF protection)
  path: '/api/auth',      // only sent to /api/auth/* routes (minimizes exposure)
  maxAge: 7 * 24 * 60 * 60,  // 7 days in seconds
})
```

---

### 27.39 Infrastructure — Database Backup Strategy + Operational Runbook

#### Database Backup Strategy

**Why this matters:** Railway's default free-tier database has NO automated backups. A single bad migration, accidental `DELETE`, or hardware failure = permanent data loss. User wallet balances, KYC records, and trade history are irreplaceable.

**Required setup (before accepting live funds):**

**1. Railway PostgreSQL Pro Plan:**
- Enable automated daily backups (7-day retention)
- Enable point-in-time recovery (PITR) if available on your plan

**2. Offsite backup via cron (daily):**
```typescript
// backend/src/jobs/databaseBackup.ts
// BullMQ repeatable job: runs daily at 2am PKT
import { exec } from 'child_process'
import { S3 } from '@aws-sdk/client-s3'

const runDailyBackup = async () => {
  const timestamp = new Date().toISOString().split('T')[0]  // YYYY-MM-DD
  const filename = `pakswap-db-backup-${timestamp}.sql.gz`

  // pg_dump → gzip → S3
  await new Promise((resolve, reject) => {
    exec(
      `pg_dump "${process.env.DATABASE_URL}" | gzip | aws s3 cp - s3://pakswap-backups/${filename}`,
      (err) => err ? reject(err) : resolve(null)
    )
  })

  // Verify backup was uploaded
  const s3 = new S3({})
  await s3.headObject({ Bucket: 'pakswap-backups', Key: filename })

  // Alert admin on success with file size
  await sendAdminEmail('Daily backup complete', `Backup ${filename} uploaded to S3`)

  // Clean up backups older than 90 days
  // ... list objects, delete those older than 90 days
}
```

**3. Separate S3 bucket for backups:**
- Bucket: `pakswap-backups` (separate from `pakswap-uploads`)
- Enable S3 Versioning on backup bucket
- Enable S3 Lifecycle rule: transition to Glacier after 30 days, delete after 365 days

**4. Weekly restore test (operational checklist):**
```
Every Sunday:
  1. Download latest backup from pakswap-backups S3 bucket
  2. Restore to a staging PostgreSQL instance
  3. Run: SELECT COUNT(*) FROM "User"; SELECT COUNT(*) FROM "Trade"; SELECT SUM(balance) FROM "Wallet";
  4. Verify counts are reasonable vs expected
  5. Log the test result in the ops runbook
```

**5. Schema migration safety policy:**
- Never run `prisma migrate deploy` directly on production without:
  1. Running it on staging first
  2. Verifying staging works for 30+ minutes
  3. Taking a manual snapshot before running on production
- Use `--preview-feature` shadow database for development

#### Operational Runbook (daily + weekly tasks)

**Daily (operator must complete before end of business day Pakistan time):**
```
□ Check admin dashboard → zero unresolved escalated trades
□ Check admin dashboard → pending KYC queue < 50 (review if exceeded)
□ Check admin dashboard → pending withdrawals approved or actioned
□ Check /admin/rates → cronStatus must be 'healthy' (not 'stale')
□ Check /admin/wallet → pending payouts vs estimated hot wallet balance
□ Sweep hot wallet: if balance > 3× daily avg payout → move excess to cold storage
□ Check ADMIN_ALERT_EMAIL inbox → no critical BullMQ job failures
□ Verify daily backup email received from backup job
```

**Weekly (every Sunday):**
```
□ Restore staging from latest backup → verify data integrity
□ Review fraud flags from /admin/fraud → action any high-severity flags
□ Review AML structuring alerts → file STR with FMU if required
□ Merchant rank recalculation runs automatically (Sunday midnight PKT via BullMQ cron)
□ Review platform analytics: new users, trade volume, dispute rate vs previous week
□ Check leaderboard cache refreshed correctly
```

---

### 27.40 Retention Systems — Rate Alerts, First-Trade Bonus, Referral Progress Tracker

#### Rate Alert Subscription

Users set a target rate. When the USDT rate crosses their threshold, they get a push notification and email.

**New DB table:**
```
RateAlert
  id, userId, coin (default 'USDT'), targetRate (PKR), direction: 'above'|'below'
  isActive (bool), triggeredAt (DateTime?), createdAt
```

**New API endpoints:**
```
GET    /api/rate-alerts            → list user's active alerts
POST   /api/rate-alerts            { coin, targetRate, direction }  → create alert
DELETE /api/rate-alerts/:id        → remove alert
```

**Backend: check alerts in rate updater cron (runs every 5 min):**
```typescript
// After updating rates in DB, check all active alerts:
const newUsdtRate = ...  // freshly fetched rate

const triggeredAlerts = await db.rateAlert.findMany({
  where: {
    isActive: true,
    coin: 'USDT',
    OR: [
      { direction: 'above', targetRate: { lte: newUsdtRate } },
      { direction: 'below', targetRate: { gte: newUsdtRate } },
    ],
  },
  include: { user: true },
})

for (const alert of triggeredAlerts) {
  // Send push notification + email
  await sendPushNotification(alert.userId, {
    title: `USDT rate alert 🔔`,
    body: `USDT is now PKR ${newUsdtRate} — your target was PKR ${alert.targetRate}`,
    url: '/instant-buy',
    tag: `rate-alert-${alert.id}`,
  })
  await sendEmail(alert.user.email, 'rate_alert', { rate: newUsdtRate, target: alert.targetRate })
  await db.rateAlert.update({ where: { id: alert.id }, data: { isActive: false, triggeredAt: new Date() } })
}
```

**Frontend — Rate Alert widget on Dashboard and Instant Buy page:**
```
┌────────────────────────────────────────────────┐
│  🔔 Rate Alert                                  │
│  Current: 1 USDT = PKR 278.5                   │
│  Notify me when USDT reaches: [___] PKR [Set] │
└────────────────────────────────────────────────┘
```
After setting: "✅ Alert set for PKR 285. We'll notify you when USDT crosses that price."
User's active alerts shown as chips: "Above PKR 285 [×]" — tap × to remove.

**New email template:**
| Template | Subject | Content |
|----------|---------|---------|
| `rate_alert` | "🔔 USDT rate alert — your target reached!" | Current rate, target rate, CTA to buy now |

**New platformConfig key:**
```
rate_alert_max_per_user = 3    ← prevent alert spam abuse
```

---

#### First-Trade Bonus — PKR Credit After First Completed Trade

**Goal:** Convert new users (who have done KYC but not traded) into active traders. A small reward at the right moment is the highest-ROI retention tool.

**Implementation:**
- When a user's first P2P trade OR first Instant Buy order completes → credit PKR 50 to their platform account
- "Platform account balance" = a new `Wallet` entry with `coin = 'PKR'` and `network = 'platform_credit'`
- This credit can only be used to offset Instant Buy fees (not withdrawable) — prevents abuse

**New DB field:** `User.firstTradeBonusPaid (Boolean default false)` — ensure bonus paid only once

**New platformConfig keys:**
```
first_trade_bonus_pkr = 50        ← amount of the bonus (0 = disabled)
first_trade_bonus_enabled = true
```

**Backend trigger (after trade/order completion):**
```typescript
if (!user.firstTradeBonusPaid && config.first_trade_bonus_enabled) {
  await db.wallet.upsert({
    where: { userId_coin_network: { userId, coin: 'PKR', network: 'platform_credit' } },
    create: { userId, coin: 'PKR', network: 'platform_credit', balance: config.first_trade_bonus_pkr },
    update: { balance: { increment: config.first_trade_bonus_pkr } },
  })
  await db.user.update({ where: { id: userId }, data: { firstTradeBonusPaid: true } })
  await sendNotification(userId, 'first_trade_bonus', { amount: config.first_trade_bonus_pkr })
}
```

**Frontend display:** Banner on Dashboard after first trade: "🎉 You've earned PKR 50 credit! It will be applied to your next Instant Buy order."

---

#### Referral Progress Tracker — Per-Referred-User Status

**Goal:** Give referrers real-time visibility into their referred users' progress — encouraging them to follow up and nudge friends to complete their first trade.

**Update `GET /api/referral` response:**
```typescript
{
  rewards: ReferralReward[],
  totalEarned: number,
  totalReferrals: number,
  activeReferrals: number,
  referredUsers: [
    {
      id: string,            // referred user's DB id (for reference)
      maskedName: string,    // e.g. "A*** K***"
      joinedAt: string,
      status: 'registered' | 'kyc_pending' | 'kyc_approved' | 'first_trade_done' | 'reward_paid',
      progressLabel: string, // "Registered — waiting for KYC"
      rewardEligible: boolean,
      rewardAmount: number | null,
      rewardPaidAt: string | null,
    }
  ]
}
```

**Frontend referral page — per-user progress:**
```
┌─────────────────────────────────────────────────────────────┐
│  Your Referrals                           3 of 5 rewarded   │
│                                                             │
│  A*** K***  ·  Joined 3 days ago                            │
│  ⬜ Registered → ⬜ KYC → ⬜ First Trade → ⬜ Reward         │
│  📍 "Needs to complete KYC"   [Remind via WhatsApp]        │
│                                                             │
│  M*** A***  ·  Joined 10 days ago                           │
│  ✅ Registered → ✅ KYC → ✅ First Trade → ✅ PKR 500 Paid  │
└─────────────────────────────────────────────────────────────┘
```

**"Remind via WhatsApp" button:**
Opens WhatsApp with pre-composed message: `https://wa.me/?text=Hey! Complete your KYC on PakSwap and we'll both earn PKR 500 after your first trade. pakswap.pk/r/{referralCode}`

**Backend notification to referrer when referred user completes KYC:**
- In-app notification + email: "Ahmad just verified on PakSwap — one trade away from your PKR 500 reward!"
- This drives referrer engagement at exactly the right moment.

**New email template:**
| Template | Subject | Content |
|----------|---------|---------|
| `referral_kyc_completed` | "Your referral just verified! One trade away from PKR {amount}" | Friend's masked name, CTA to share reminder |

---

### 27.41 Pre-Launch Strategy — Supply Seeding + Explore Mode for Unverified Users

#### Pre-Launch Merchant & Liquidity Seeding

**Problem:** A new P2P exchange with 0 ads is immediately perceived as dead or a scam. No user will complete KYC just to check if there's anything to trade.

**Required before opening to the public:**

**Step 1 — Merchant seeding (2–4 weeks before public launch):**
1. Recruit 5–10 crypto OTC dealers, money changers, or informal traders from Karachi, Lahore, Islamabad
2. Fast-track their merchant KYC (2-hour review SLA instead of 24h)
3. Waive the first 30 days of collateral requirement (admin `override_collateral = true` flag)
4. Help them post initial buy + sell ads at competitive rates

**Step 2 — Platform starter inventory:**
- Platform operator creates 1–2 merchant accounts representing the platform itself
- Posts buy + sell ads for USDT/TRC20 at competitive spread (1.5–2%)
- Ensures marketplace is never empty — platform acts as market maker of last resort

**Step 3 — Soft launch to a 50-person test group:**
- Invite 50 people (friends, family, crypto community members)
- Confirm KYC flow, trade flow, admin review, and email notifications work end-to-end
- Fix all critical bugs from soft launch before public launch

**New platformConfig key:**
```
override_collateral_for_new_merchants = false   ← set true during seeding phase, false after launch
```

#### Explore Mode for Unverified Users

**Problem:** Current spec blocks all meaningful interaction until KYC is approved. A new user who can't see anything interesting has no reason to submit KYC.

**Explore mode allows unverified users to:**
- Browse `/marketplace` — see all ads, prices, merchant profiles
- Use the rate calculator on home page
- View `/leaderboard` and `/profile/[username]` pages
- View `/fees` and `/about`
- See the trade initiation form — but clicking "Buy" shows: "Verify your identity to start trading → [Complete KYC]"

**Explore mode blocks unverified users from:**
- Initiating any trade
- Placing any Instant Buy order
- Making any deposit or withdrawal
- Posting any ad
- Opening disputes

**Frontend implementation:**
- Public pages already work without auth (already specced in Section 16)
- On marketplace "Buy" button click: if `user.kycStatus !== 'approved'` → show inline message: "Complete KYC to buy — takes about 2 minutes. [Start KYC →]"
- Do NOT redirect away — keep the user on the marketplace page so they see what they're missing

**Psychology rationale:** Showing users what they can't access (but could with KYC) is more motivating than a blank "you must verify" page. This pattern increases KYC submission rate by 40–60% based on industry data.

---

### 27.24 Phase Roadmap Update

**Phase 1 additions (must fix before launch):**
- [x] Rate limiting on all auth and sensitive endpoints (Section 27.1)
- [x] JWT refresh token pattern with httpOnly cookie — access token in Zustand memory only (Section 27.2 + Section 4)
- [x] File upload MIME validation + 10MB limit + UUID rename (Section 27.3)
- [x] Referral abuse prevention (CNIC dedup + IP flagging + daily cap) (Section 27.4)
- [x] OCR confidence threshold defined (Section 27.5)
- [x] Idempotency keys on trade/order/withdrawal creation (Section 27.6)
- [x] Admin 2FA required + login alerts + KYC review race condition lock + withdrawal review lock (Section 27.7)
- [x] Analytics event tracking (Posthog) — 6 critical funnel events minimum (Section 27.8) ← **Phase 1, not 2**
- [x] Terms of Service page `/terms` + ToS acceptance checkbox at registration (Section 27.9 + Section 3)
- [x] Privacy Policy page `/privacy` (Section 27.9)
- [x] About page `/about` with company name, contact info, registration number (Section 27.9)
- [x] Global footer on all pages with legal links (Section 21 Design System)
- [x] User onboarding checklist widget on dashboard (Section 27.10) ← **Phase 1, not 2** (highest-impact new-user retention)
- [x] Referral landing page `/r/[code]` with localStorage pre-fill (Section 27.11)
- [x] Database indexes on Trade, Ad, Transaction, Notification, KycSubmission, InstantBuyOrder (Section 27.12)
- [x] S3 pre-signed URL pattern for all uploads (Section 27.13)
- [x] S3 bucket private — block all public access + signed URL serving (Section 27.38)
- [x] Image compression before upload (Section 27.14)
- [x] Sentry error monitoring frontend + backend (Section 27.15)
- [x] BullMQ dead letter queue + job failure alerts + Sentry capture (Section 27.16)
- [x] Customer support widget (Tawk.to or Crisp) + `/help` page (Section 27.17) ← **Phase 1** (users need help on first launch)
- [x] SEO meta tags + robots.txt + sitemap.xml (Section 27.18)
- [x] Account deletion + data export endpoints (Section 27.19)
- [x] CSRF protection paired with httpOnly cookie auth (Section 27.25)
- [x] Webhook signature verification for all `/api/webhooks/*` routes (Section 27.25 + Section 12)
- [x] Per-network wallet address validation (EIP-55, bech32, base58check) backend + frontend (Section 27.26 + Section 16.5)
- [x] 2FA re-auth on high-value withdrawals (Section 27.26)
- [x] Bot detection: Cloudflare Turnstile on register + login (Section 27.27)
- [x] Disposable email domain blocking on registration (Section 27.27)
- [x] Hot wallet two-person approval rule + daily payout limit (Section 27.28)
- [x] Circuit breakers for all external API calls with graceful fallbacks (Section 27.29)
- [x] Redis AOF persistence enabled (Section 27.29)
- [x] User Dashboard aggregation endpoint `GET /api/dashboard/summary` (Section 27.30 + Section 16.22)
- [x] Merchant Dashboard aggregation endpoint `GET /api/merchants/dashboard/summary` (Section 16.23)
- [x] Trade expiry race condition fix — backend enforces expiresAt on payment upload (Section 27.31)
- [x] Trade page step indicator ("What happens next?") for first-time traders (Section 16.3)
- [x] Trade expiry proactive warning banner (< 30 min remaining) + push notification (Section 16.3)
- [x] Rate staleness warning banner when `updatedAt` > 15 min; disable Instant Buy if > 1h stale (Section 27.31)
- [x] CNIC stored as HMAC-SHA256 hash only — no plaintext in DB, `CNIC_HASH_SECRET` env var (Section 13)
- [x] Mandatory username setup (no skip option — pre-filled with auto-generated name) (Section 27.32)
- [x] Confirmation dialogs for all irreversible user and admin actions (Section 27.32)
- [x] KYC required before first sell ad (including the 3 free collateral trades) (Section 27.33)
- [x] AML sanctions screening (UNSC + OFAC) on KYC approval (Section 27.34)
- [x] Pakistan regulatory legal opinion obtained before accepting live funds (Section 27.34)
- [x] Failed Instant Buy retry flow on status page (Section 27.35)
- [x] Home page "How PakSwap Works" + "Why PakSwap is Safe" trust content (Section 27.36)
- [x] Web Push Notifications via FCM — for payment_confirmed, trade_started, dispute_opened (Section 27.37)
- [x] HTTPS HSTS headers + security headers on all responses (Section 27.38)
- [x] Cookie security flags: httpOnly, Secure, SameSite=Strict (Section 27.38)
- [x] Database backup strategy: Railway Pro + daily offsite S3 backup + weekly restore test (Section 27.39)
- [x] Backend startup validation — refuse to start if critical env vars missing (Section 24)
- [x] Explore mode for unverified users — can browse but not trade (Section 27.41)
- [x] Pre-launch merchant seeding — 5–10 merchants recruited before public launch (Section 27.41)
- [x] Business entity registered (SMC-Pvt Ltd or Pvt Ltd) before accepting live funds (Section 27.34)
- [x] Merchant acquisition landing page `/become-a-merchant` (Section 27.36) ← **Phase 1** (needed to recruit seed merchants)

**Phase 2 additions (beta stability — within first 4 weeks of launch):**
- [x] Idle user reactivation email sequence (Section 27.20)
- [x] PWA manifest + service worker + Add to Home Screen (Section 27.21)
- [x] Admin internal notes on user accounts (Section 27.22)
- [x] Automated fraud detection rules BullMQ `fraud-detector` job (Section 27.33)
- [x] AML transaction monitoring — structuring detection (Section 27.34)
- [x] Leaderboard Redis cache (pre-computed hourly) (Section 27.30)
- [x] Rate alert subscriptions — user sets PKR threshold, receives push + email (Section 27.40)
- [x] First-trade bonus (PKR 50 credit after first completed trade) (Section 27.40)
- [x] Referral progress tracker — per-referred-user status on referral page (Section 27.40)
- [x] Tailwind CSS from Day 1 — inline styles are NOT used (see FRONTEND_STANDARDS.md)
- [x] Polling optimization — pause when tab hidden, backoff on errors, stop at terminal state (Section 20)
- [x] Analytics: add remaining Posthog events beyond the 6 Phase 1 events (Section 27.8)
- [x] Admin conversion funnel view in analytics dashboard (Section 17.14)

**Phase 3 additions (growth & scale — months 2–6):**
- [ ] WebSocket/SSE to replace polling on trade page and notifications
- [ ] Per-user HD wallet deposit addresses (eliminates shared address tracking complexity)
- [ ] JazzCash/Easypaisa receipt verification API (server-side payment verification beyond OCR)
- [ ] "Share my rank" OG image card generator (virality mechanic)
- [ ] CloudFront CDN in front of S3 (image delivery at Pakistani PoPs)
- [ ] Read replica PostgreSQL for analytics queries (separate from transactional DB)
- [ ] Redis cluster for high availability (current single Redis = SPOF)
- [ ] SMS OTP as alternative to email OTP (Twilio or Jazz API)
- [ ] Merchant subscription tier (premium features, featured marketplace placement)
- [ ] P2P taker fee consideration (0.2–0.5%) for revenue diversification
- [ ] Auto-scaling configuration on Railway (multiple instances + load balancer)

**Phase 4 additions (enterprise / scale — 6+ months):**
- [ ] Fireblocks or Copper.co custodial wallet — eliminates manual hot wallet management entirely
- [ ] React Native mobile app (iOS + Android) — same API, same backend
- [ ] Automated crypto payout pipeline — no manual operator sends
- [ ] Fiat on/off ramp via bank integration (SBP-compliant)
- [ ] Chainalysis KYT for real-time AML/wallet screening
- [ ] SECP DASP registration when Pakistan regulatory framework matures
- [ ] ComplyAdvantage for enhanced sanctions and PEP screening
- [ ] AI-powered fake screenshot detection (ELA image forensics)
- [ ] Merchant credit scoring system based on trading history

---

---

## 28. Canonical Backend Folder/File Structure

This is the authoritative folder layout for the Fastify/TypeScript/Prisma/BullMQ backend. Every developer on the team follows this structure. No exceptions without a team decision. Deviating from it creates architecture drift that compounds into unmaintainable code.

```
backend/
├── src/
│   ├── server.ts                   ← entry point: creates Fastify app, registers plugins, starts HTTP + BullMQ workers
│   ├── app.ts                      ← Fastify app factory (exported for testing)
│   │
│   ├── config/                     ← all configuration, env vars, external client singletons
│   │   ├── env.ts                  ← Zod-validated env schema + startup validation (throws if required vars missing)
│   │   ├── constants.ts            ← SUPPORTED_COINS, SUPPORTED_NETWORKS, BADGE_TIERS, MERCHANT_RANKS, etc.
│   │   ├── redis.ts                ← ioredis client singleton (shared by BullMQ + rate cache + idempotency)
│   │   ├── s3.ts                   ← AWS S3Client singleton
│   │   ├── email.ts                ← Nodemailer transporter singleton
│   │   ├── firebase.ts             ← Firebase Admin SDK singleton (push notifications)
│   │   └── sentry.ts               ← Sentry.init() called once here, imported by server.ts
│   │
│   ├── plugins/                    ← Fastify plugins registered globally in app.ts
│   │   ├── auth.plugin.ts          ← JWT verification: sets req.user on all authenticated routes
│   │   ├── csrf.plugin.ts          ← @fastify/csrf-protection registration + token endpoint
│   │   ├── rateLimit.plugin.ts     ← fastify-rate-limit with Redis store; per-route limits from Section 27.1
│   │   ├── securityHeaders.plugin.ts ← HSTS, CSP, X-Frame-Options, Referrer-Policy (Section 27.38)
│   │   ├── multipart.plugin.ts     ← @fastify/multipart; sets max file size 10MB
│   │   ├── cors.plugin.ts          ← CORS: allow FRONTEND_URL origin only
│   │   ├── errorHandler.plugin.ts  ← global error handler: maps AppError codes to HTTP status, captures to Sentry
│   │   └── geoblock.plugin.ts      ← reads CF-IPCountry header; blocks FATF countries (Section 14)
│   │
│   ├── routes/                     ← thin HTTP layer: parse → validate → call controller → return response
│   │   ├── index.ts                ← registers all route modules with fastify
│   │   ├── auth.routes.ts          ← /api/auth/*
│   │   ├── marketplace.routes.ts   ← /api/marketplace/*
│   │   ├── trades.routes.ts        ← /api/trades/*
│   │   ├── ads.routes.ts           ← /api/ads/*
│   │   ├── wallet.routes.ts        ← /api/wallet/*
│   │   ├── instantBuy.routes.ts    ← /api/instant-buy/*
│   │   ├── kyc.routes.ts           ← /api/kyc/*
│   │   ├── disputes.routes.ts      ← /api/disputes/*
│   │   ├── merchants.routes.ts     ← /api/merchants/*
│   │   ├── notifications.routes.ts ← /api/notifications/*
│   │   ├── referral.routes.ts      ← /api/referral
│   │   ├── rateAlerts.routes.ts    ← /api/rate-alerts/*
│   │   ├── leaderboard.routes.ts   ← /api/leaderboard
│   │   ├── users.routes.ts         ← /api/users/*
│   │   ├── upload.routes.ts        ← /api/upload/presign
│   │   ├── webhooks.routes.ts      ← /api/webhooks/* (Moralis, Tatum, BlockCypher) — signature-verified
│   │   ├── gasFee.routes.ts        ← /api/gas-fee/* (no auth required — public endpoints)
│   │   ├── dashboard.routes.ts     ← /api/dashboard/summary + /api/merchants/dashboard/summary
│   │   └── admin/
│   │       ├── index.routes.ts     ← /api/admin/* (registers all sub-routes below)
│   │       ├── kyc.routes.ts       ← /api/admin/kyc/*
│   │       ├── merchantKyc.routes.ts ← /api/admin/merchants/*
│   │       ├── payments.routes.ts  ← /api/admin/payments/*
│   │       ├── instantBuy.routes.ts← /api/admin/instant-buy/*
│   │       ├── withdrawals.routes.ts← /api/admin/withdrawals/*
│   │       ├── disputes.routes.ts  ← /api/admin/disputes/*
│   │       ├── users.routes.ts     ← /api/admin/users/*
│   │       ├── fraud.routes.ts     ← /api/admin/fraud/*
│   │       ├── audit.routes.ts     ← /api/admin/audit/*
│   │       ├── rates.routes.ts     ← /api/admin/rates/*
│   │       ├── revenue.routes.ts   ← /api/admin/revenue
│   │       ├── analytics.routes.ts ← /api/admin/analytics
│   │       ├── config.routes.ts    ← /api/admin/config
│   │       ├── team.routes.ts      ← /api/admin/team/*
│   │       ├── wallet.routes.ts    ← /api/admin/wallet/*
│   │       └── gasFee.routes.ts    ← /api/admin/gas/* (orders, retry, refund, wallets, chains)
│   │
│   ├── controllers/                ← one per routes file; no business logic; only: call service, format response
│   │   ├── auth.controller.ts
│   │   ├── trades.controller.ts
│   │   ├── wallet.controller.ts
│   │   ├── instantBuy.controller.ts
│   │   ├── kyc.controller.ts
│   │   ├── merchants.controller.ts
│   │   ├── notifications.controller.ts
│   │   ├── dashboard.controller.ts
│   │   └── admin/
│   │       ├── kyc.controller.ts
│   │       ├── withdrawals.controller.ts
│   │       └── ... (one per admin route file)
│   │
│   ├── services/                   ← ALL business logic lives here; no req/res objects; fully testable in isolation
│   │   ├── auth.service.ts         ← register, login, token generation, OTP, 2FA, session management
│   │   ├── trade.service.ts        ← create trade, state transitions (payment_pending→…→crypto_released), validation
│   │   ├── wallet.service.ts       ← balance checks, deposit crediting, withdrawal initiation, collateral lock/unlock
│   │   ├── fee.service.ts          ← live fee fetch (Etherscan/mempool/SOL), platform fee add, circuit breaker wrap
│   │   ├── instantBuy.service.ts   ← order creation, quote expiry, OCR layer1 trigger, layer2 approval
│   │   ├── kyc.service.ts          ← submission, CNIC hash dedup, sanctions screen, tier upgrade
│   │   ├── dispute.service.ts      ← open dispute, message, evidence, resolve, escalation timer
│   │   ├── merchant.service.ts     ← apply, activate, spread update, inventory, rank evaluation
│   │   ├── collateral.service.ts   ← lock, unlock, seize, auto-double-on-high-dispute-rate
│   │   ├── referral.service.ts     ← reward eligibility, CNIC dedup check, IP flag, daily cap, payout
│   │   ├── notification.service.ts ← createNotification() → writes DB row + enqueues push job + enqueues email job
│   │   ├── email.service.ts        ← render template, Nodemailer send, EmailLog write, retry on failure
│   │   ├── push.service.ts         ← FCM send via Firebase Admin, handle unregistered token cleanup
│   │   ├── rate.service.ts         ← fetch Binance, compute PKR, write platformConfig, Redis cache
│   │   ├── rateAlert.service.ts    ← create/delete alerts, check triggers after rate update
│   │   ├── upload.service.ts       ← S3 presign URL, MIME validation, path construction
│   │   ├── dashboard.service.ts    ← Promise.all aggregation for user + merchant dashboard
│   │   ├── leaderboard.service.ts  ← Redis cache read/write, DB fallback query
│   │   ├── fraud.service.ts        ← FraudFlag creation, rule engine, admin alert
│   │   ├── aml.service.ts          ← structuring detection, buy-then-withdraw flagging, STR threshold
│   │   ├── sanctions.service.ts    ← fuzzy name match against SanctionedEntity table
│   │   ├── tradeStats.service.ts   ← recalculate completionRate, avgRating, trustScore, badge after rating
│   │   ├── audit.service.ts        ← writeAuditLog(actorId, action, targetType, targetId, metadata)
│   │   └── gasFee/                 ← gas fee system (Section 31, GAS_FEE_SPEC.md)
│   │       ├── gasFeeOrder.service.ts   ← create order, status transitions, guest limits
│   │       ├── pricing.service.ts       ← quote calculation, real-time TRX price, markup
│   │       ├── hotWallet.service.ts     ← AWS Secrets Manager key retrieval, balance check
│   │       └── chains/
│   │           └── tron.service.ts      ← TronWeb send TRX, address validation, tx confirmation
│   │
│   ├── repositories/               ← raw Prisma queries only; no business logic; one file per major Prisma model
│   │   ├── user.repository.ts
│   │   ├── trade.repository.ts
│   │   ├── ad.repository.ts
│   │   ├── wallet.repository.ts
│   │   ├── transaction.repository.ts
│   │   ├── instantBuyOrder.repository.ts
│   │   ├── kycSubmission.repository.ts
│   │   ├── dispute.repository.ts
│   │   ├── merchant.repository.ts
│   │   ├── merchantInventory.repository.ts
│   │   ├── notification.repository.ts
│   │   ├── tradeStats.repository.ts
│   │   ├── tradeRating.repository.ts
│   │   ├── referralReward.repository.ts
│   │   ├── collateralLock.repository.ts
│   │   ├── pushSubscription.repository.ts
│   │   ├── rateAlert.repository.ts
│   │   ├── fraudFlag.repository.ts
│   │   ├── auditLog.repository.ts
│   │   ├── session.repository.ts
│   │   └── platformConfig.repository.ts  ← get(key), set(key, value), getAll() — with Redis L1 cache (60s TTL)
│   │
│   ├── validators/                 ← Zod schemas for ALL request bodies; imported by both routes (for type inference) and services (for re-validation)
│   │   ├── auth.schema.ts          ← RegisterDto, LoginDto, ResetPasswordDto, etc.
│   │   ├── trade.schema.ts         ← CreateTradeDto, MarkCryptoSentDto, RateTradeDto, etc.
│   │   ├── ad.schema.ts            ← CreateAdDto, UpdateAdDto
│   │   ├── wallet.schema.ts        ← WithdrawDto, LockCollateralDto, SavedAddressDto
│   │   ├── instantBuy.schema.ts    ← CreateOrderDto, ConfirmDepositDto, ResubmitPaymentDto
│   │   ├── kyc.schema.ts           ← SubmitKycDto (basic + enhanced variants)
│   │   ├── merchant.schema.ts      ← ApplyMerchantDto, UpdateSpreadDto, UpdateInventoryDto
│   │   ├── notification.schema.ts  ← PushSubscribeDto
│   │   ├── rateAlert.schema.ts     ← CreateRateAlertDto
│   │   ├── dispute.schema.ts       ← OpenDisputeDto, ResolveDisputeDto
│   │   └── admin.schema.ts         ← ApproveKycDto, RejectKycDto, BanUserDto, SeizeCollateralDto, etc.
│   │
│   ├── jobs/                       ← BullMQ job processor functions; imported by workers.ts
│   │   ├── ocr.job.ts              ← Layer 1: reads S3 screenshot, runs OCR, updates order status
│   │   ├── rateUpdater.job.ts      ← Binance fetch → DB write → float ad recalc → rate alert check
│   │   ├── tradeEscalation.job.ts  ← auto-cancel expired trades, escalation emails
│   │   ├── merchantRankUpdater.job.ts ← weekly rank recalc for all merchants
│   │   ├── badgeRecalculate.job.ts ← recalc trustScore + badge after TradeRating insert
│   │   ├── referralPayout.job.ts   ← release 7-day held referral rewards after eligibility confirmed
│   │   ├── fraudDetector.job.ts    ← 15-min rule engine (high dispute rate, new-account large sell, velocity)
│   │   ├── amlMonitor.job.ts       ← daily structuring detection, buy-then-withdraw flags
│   │   ├── leaderboardCache.job.ts ← hourly pre-compute top traders/merchants into Redis
│   │   ├── databaseBackup.job.ts   ← daily pg_dump → gzip → S3 + admin email confirmation
│   │   ├── idleReactivation.job.ts ← check dormant users, enqueue reactivation emails
│   │   ├── pushNotification.job.ts ← FCM send via Firebase Admin SDK, handle token cleanup
│   │   └── gasFee/                 ← gas fee BullMQ jobs (GAS_FEE_SPEC.md Section 10)
│   │       ├── sendGas.job.ts      ← auto-send TRX via TronWeb after payment detected
│   │       ├── expireOrder.job.ts  ← expire orders that time out before payment received
│   │       ├── checkDelivery.job.ts ← confirm delivery TX on-chain (retries up to 10 times)
│   │       └── monitorBalances.job.ts ← every 5min: check hot wallet balances, alert if low
│   │
│   ├── queues/
│   │   ├── index.ts                ← exports: ocrQueue, rateUpdaterQueue, escalationQueue, etc.
│   │   ├── definitions.ts          ← all Queue instances with defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
│   │   └── workers.ts              ← entry point called from server.ts; registers all Worker instances + onFailed handlers
│   │
│   ├── notifications/
│   │   ├── templates/              ← one file per notification/email type; returns { subject, html, text, pushTitle, pushBody }
│   │   │   ├── tradeStarted.ts
│   │   │   ├── paymentConfirmed.ts
│   │   │   ├── cryptoSent.ts
│   │   │   ├── tradeCompleted.ts
│   │   │   ├── tradeCancelled.ts
│   │   │   ├── disputeOpened.ts
│   │   │   ├── disputeResolved.ts
│   │   │   ├── kycApproved.ts
│   │   │   ├── kycRejected.ts
│   │   │   ├── withdrawalApproved.ts
│   │   │   ├── withdrawalRejected.ts
│   │   │   ├── referralReward.ts
│   │   │   ├── referralKycCompleted.ts
│   │   │   ├── badgeUpgraded.ts
│   │   │   ├── merchantRankUpgraded.ts
│   │   │   ├── collateralPrompt.ts
│   │   │   ├── rateAlert.ts
│   │   │   ├── tradeExpiringSoon.ts
│   │   │   └── instantBuyApproved.ts
│   │   └── dispatcher.ts           ← notifyUser(userId, type, data): writes Notification row + enqueues email job + enqueues push job
│   │
│   ├── payments/
│   │   ├── ocr.ts                  ← screenshot OCR: calls OCR library/API, extracts amount, date, account
│   │   ├── webhook.ts              ← verifyMoralisWebhook(), verifyTatumWebhook(), verifyBlockCypherToken()
│   │   └── feeProviders.ts         ← fetchEthGas(), fetchBtcFee(), fetchSolFee() — all wrapped in circuit breakers
│   │
│   ├── security/
│   │   ├── captcha.ts              ← verifyTurnstileToken(token, ip) → throws CAPTCHA_FAILED if invalid
│   │   ├── disposableEmail.ts      ← isDisposableDomain(email) → boolean
│   │   ├── sanctions.ts            ← checkSanctions(fullName) → { matched: bool, matchedName?: string }
│   │   ├── geoblock.ts             ← getCountryCode(req) → string; BLOCKED_COUNTRIES list
│   │   ├── cnicHash.ts             ← hashCnic(rawCnic) → HMAC-SHA256 with CNIC_HASH_SECRET; throws if secret missing
│   │   └── idempotency.ts          ← checkIdempotency(key) → cached response | null; storeIdempotency(key, response, ttlMs)
│   │
│   ├── utils/
│   │   ├── addressValidation.ts    ← validateAddress(address, coin, network) — uses viem, bitcoinjs-lib, @solana/web3.js
│   │   ├── pagination.ts           ← buildPaginationMeta(page, limit, total) → { page, limit, total, pages }
│   │   ├── response.ts             ← success(data, pagination?) and error(code, message, statusCode) response builders
│   │   ├── logger.ts               ← Pino logger instance with PKT timezone
│   │   ├── dateHelpers.ts          ← toPKT(date), isWithinLast(date, hours), startOfDayPKT()
│   │   ├── pkrFormat.ts            ← formatPKR(amount) → "PKR 1,23,456" (Pakistani number format)
│   │   ├── circuitBreaker.ts       ← createBreaker(fn, options): wraps external API calls with opossum
│   │   └── errors.ts               ← AppError class: new AppError('DAILY_LIMIT_EXCEEDED', 'message', 429); all error codes from Section 25 defined as constants here
│   │
│   ├── monitoring/
│   │   ├── health.ts               ← GET /health → { status: 'ok', db: 'ok', redis: 'ok', version: string }
│   │   ├── redisMemory.ts          ← BullMQ repeatable job: check Redis memory usage, email admin if > 80%
│   │   └── cronHealth.ts           ← checks lastCronRun for rate updater; sets cronStatus: 'stale' if > 10 min
│   │
│   ├── audit/
│   │   ├── auditLog.ts             ← writeAuditLog(actorId, action, targetType, targetId, metadata): append-only, never deletes
│   │   └── actions.ts              ← enum AuditAction { APPROVE_KYC, REJECT_KYC, BAN_USER, SEIZE_COLLATERAL, APPROVE_WITHDRAWAL, REJECT_WITHDRAWAL, RESOLVE_DISPUTE, UPDATE_CONFIG, OVERRIDE_RATE, CHANGE_TEAM_ROLE, ... }
│   │
│   └── types/
│       ├── index.ts                ← shared TypeScript interfaces (User, Trade, Wallet, etc.)
│       └── fastify.d.ts            ← declare module 'fastify' { interface FastifyRequest { user: JwtPayload } }
│
├── prisma/
│   ├── schema.prisma               ← single source of truth for all models (Section 18)
│   ├── migrations/                 ← generated by prisma migrate dev; never manually edited
│   └── seed.ts                     ← seeds platformConfig defaults (Section 23 SQL seed)
│
└── tests/
    ├── helpers/
    │   ├── testApp.ts              ← creates isolated Fastify instance for tests; uses test DB
    │   ├── testDb.ts               ← beforeAll/afterAll hooks; truncate tables between tests; Prisma test client
    │   ├── testRedis.ts            ← flush Redis between test suites
    │   ├── factories.ts            ← createUser(), createTrade(), createAd(), createMerchant(), etc.
    │   └── mockApis.ts             ← nock stubs for Binance, Etherscan, mempool.space, Moralis, Turnstile
    ├── unit/                       ← pure function tests; no DB, no Redis; fast
    ├── integration/                ← real test DB + Redis; mocked external APIs; most important test layer
    └── e2e/                        ← Playwright; runs against staging environment only
```

### Architecture Rules (enforced via code review)

1. **Routes never contain business logic.** If a route handler is more than 15 lines, move logic to a service.
2. **Services never import `FastifyRequest` or `FastifyReply`.** Services are HTTP-agnostic and fully testable in isolation.
3. **Repositories never contain business logic.** A repository function that does anything more complex than a Prisma query belongs in a service.
4. **All errors go through `AppError`.** Never `throw new Error('some string')` — always `throw new AppError('ERROR_CODE', 'message', httpStatus)`. The global error handler formats these correctly.
5. **All notifications go through `dispatcher.ts`.** Never call `sendEmail()` or `sendPushNotification()` directly from a service — call `notifyUser(userId, type, data)` which handles DB write + email + push atomically.
6. **All external API calls use circuit breakers.** Never call Binance, Etherscan, or any external service without wrapping in `createBreaker()`.
7. **All admin actions call `writeAuditLog()`.** If an admin action doesn't appear in the audit log, it shouldn't be possible.
8. **platformConfig is never read directly from DB in hot paths.** Always use `platformConfig.repository.ts` which has a 60-second Redis L1 cache — config is read hundreds of times per minute.

---

## 29. Testing Architecture & Minimum Coverage Strategy

### Technology Stack

| Layer | Tool | Why |
|-------|------|-----|
| Unit + Integration | **Vitest** | Native ESM, TypeScript-first, fast, compatible with Fastify test patterns |
| E2E (browser) | **Playwright** | Cross-browser, mobile emulation, network interception |
| API mocking | **nock** | Intercept HTTP calls to Binance, Etherscan, etc. in integration tests |
| DB in tests | **Real PostgreSQL** (test schema) | Mock DBs hide real query bugs; a test DB is cheap on Railway |
| Test data | **Factory functions** (`tests/helpers/factories.ts`) | Consistent, reusable test data; never hardcode test user IDs |

### Test Environment Setup

```typescript
// tests/helpers/testApp.ts
import { buildApp } from '../../src/app'
import { prisma } from '../../src/config/db'
import { redis } from '../../src/config/redis'

export const getTestApp = async () => {
  const app = await buildApp({ testing: true })
  await app.ready()
  return app
}

// tests/helpers/testDb.ts
beforeAll(async () => {
  // Run migrations on TEST_DATABASE_URL
  await prisma.$executeRaw`TRUNCATE TABLE "User", "Trade", "Wallet", ... RESTART IDENTITY CASCADE`
})

afterAll(async () => {
  await prisma.$disconnect()
  await redis.quit()
})
```

**Env vars for tests (.env.test):**
```
TEST_DATABASE_URL=postgresql://localhost:5432/pakswap_test
REDIS_URL=redis://localhost:6379/1   ← DB index 1 (not 0) to avoid clobbering dev data
CNIC_HASH_SECRET=test-secret-32-chars-minimum
JWT_SECRET=test-jwt-secret-32-chars
JWT_REFRESH_SECRET=test-refresh-secret
```

---

### Critical Flows — MUST Have Tests Before Production

These flows involve real money. A bug here causes direct financial loss or legal liability. No exceptions.

#### 1. Authentication & Session Security
```
tests/integration/auth/
  register.test.ts
    ✓ registers with valid data → user created, OTP email sent
    ✓ blocks disposable email domains
    ✓ blocks registration without ToS checkbox
    ✓ blocks duplicate email
    ✓ blocks CAPTCHA failure (mocked Turnstile returning failure)

  login.test.ts
    ✓ login returns accessToken in body + sets httpOnly refresh cookie
    ✓ login with wrong password returns 401 (no token)
    ✓ after 5 failed logins → 429 with Retry-After header
    ✓ 2FA flow: login returns preAuthToken → TOTP verify → real access token
    ✓ admin without 2FA enabled → redirected to setup, cannot access /admin

  refresh.test.ts
    ✓ POST /api/auth/refresh with valid cookie → new access token
    ✓ POST /api/auth/refresh with expired/missing cookie → 401
    ✓ POST /api/auth/logout → cookie cleared + session invalidated in DB
    ✓ old access token rejected after logout (session revoked)

  csrf.test.ts
    ✓ POST without X-CSRF-Token header → 403
    ✓ POST with valid CSRF token → proceeds normally
    ✓ CSRF token from one session rejected by another session
```

#### 2. P2P Trade Lifecycle
```
tests/integration/trades/
  tradeLifecycle.test.ts
    ✓ buyer creates trade → status: payment_pending
    ✓ buyer uploads payment proof → status: payment_uploaded
    ✓ admin confirms payment → status: payment_confirmed, email sent to seller
    ✓ seller marks crypto sent → status: crypto_sent, email sent to buyer
    ✓ buyer confirms receipt → status: crypto_released, rating prompt triggered
    ✓ trade completion → TradeStats recalculated, badge re-evaluated
    ✓ both buyer + seller can submit ratings independently
    ✓ ratings hidden until both submitted OR 48h pass

  tradeExpiry.test.ts
    ✓ trade in payment_pending > 4 hours → auto-cancelled by escalation job
    ✓ buyer tries to upload proof on expired trade → TRADE_EXPIRED error
    ✓ trade expiry warning push notification sent at < 1 hour remaining

  raceCondition.test.ts  ← Section 27.31 specific
    ✓ concurrent payment upload + auto-cancel: only one succeeds, no double-state
    ✓ idempotency key prevents duplicate trade creation on double-click

  disputeFlow.test.ts
    ✓ buyer opens dispute → status: disputed, emails sent to both + admin
    ✓ admin resolves dispute (winner: buyer) → correct fund/status outcome
    ✓ dispute > 48h → escalation email to super_admin
```

#### 3. Instant Buy (OTC) — Highest Financial Risk Flow
```
tests/integration/instantBuy/
  pkrFlow.test.ts
    ✓ create order → status: payment_pending
    ✓ submit payment screenshot → Layer 1 OCR job enqueued
    ✓ OCR passes (confidence >= 85) → status: admin_review, OCR result shown in admin queue
    ✓ OCR fails (confidence < 60) → status: admin_review, flagged for admin
    ✓ admin approves → status: completed, email + push to user
    ✓ admin rejects → status: rejected, rejectionReason saved, email sent
    ✓ NO auto-release ever — even 100% OCR confidence requires admin approval

  resubmitPayment.test.ts
    ✓ resubmit within 30 min of rejection → resets to payment_uploaded, re-enqueues OCR
    ✓ resubmit after 30 min → RESUBMIT_WINDOW_EXPIRED error
    ✓ resubmit on non-rejected order → INVALID_STATE error
    ✓ cannot resubmit if rejectionReason is FRAUD_DETECTED (only SCREENSHOT_UNCLEAR, AMOUNT_MISMATCH, WRONG_ACCOUNT allowed)

  quoteExpiry.test.ts
    ✓ order creation sets quoteExpiresAt = now + 30 min
    ✓ submit payment after quoteExpiresAt → QUOTE_EXPIRED error
    ✓ timer displayed from server timestamp (not client clock)

  ocrVerification.test.ts
    ✓ OCR confidence threshold: >= 85 = passed, 60-84 = flagged, < 60 = failed
    ✓ OCR extracted amount within 5% of order.fiatAmount → pass
    ✓ OCR extracted amount > 5% difference → fail
    ✓ screenshot date > 24h old → fail
```

#### 4. Wallet & Withdrawals
```
tests/integration/wallet/
  collateral.test.ts
    ✓ seller with 0 completed sells: can post sell ad without collateral
    ✓ seller with >= 3 completed sells and no CollateralLock: blocked with COLLATERAL_REQUIRED
    ✓ lock collateral → Wallet.balance decreases, Wallet.lockedBalance increases
    ✓ unlock collateral with active trades → ACTIVE_TRADES_EXIST error
    ✓ unlock collateral with no active trades → succeeds
    ✓ admin seizes collateral → CollateralLock.status = 'seized', balance zeroed, AuditLog written

  withdraw.test.ts
    ✓ withdrawal with valid address → status: pending, admin notification
    ✓ withdrawal with invalid EVM address → INVALID_WALLET_ADDRESS error
    ✓ withdrawal amount <= total fee → rejected with clear error
    ✓ withdrawal > PKR 50,000 threshold → WITHDRAWAL_REQUIRES_REAUTH (2FA re-verify)
    ✓ idempotency key prevents duplicate withdrawal on double-submit
    ✓ dual approval: first admin approves → awaiting second; second admin approves → completed
    ✓ same admin cannot give both approvals

  feeCalculation.test.ts
    ✓ ERC20 fee = live Etherscan gas + platform_fee_ERC20 config
    ✓ TRC20 fee = flat fee_network_TRC20 + platform_fee_TRC20 (no live fetch)
    ✓ Etherscan API down → circuit breaker opens → cached fee served with 'estimated' label
    ✓ fee refresh within 60s returns cached value; after 60s triggers new fetch
```

#### 5. KYC
```
tests/integration/kyc/
  basicKyc.test.ts
    ✓ submit basic KYC → files uploaded to S3, KycSubmission created, email sent
    ✓ S3 URLs are signed (not public) — HEAD request to raw URL returns 403
    ✓ admin approves basic KYC → user.kycStatus = 'approved', kycLevel = 'basic', email sent
    ✓ admin approval requires cnicNumber → triggers CNIC hash dedup check
    ✓ duplicate CNIC → CNIC_ALREADY_REGISTERED error blocks approval

  sanctionsScreen.test.ts
    ✓ full name matches UNSC list (fuzzy ≥ 0.8) → approval blocked, FraudFlag created, admin alerted
    ✓ no match → approval proceeds normally

  cnicHash.test.ts
    ✓ same CNIC always produces same hash (deterministic)
    ✓ different CINCs produce different hashes
    ✓ hash function throws if CNIC_HASH_SECRET env var is missing
    ✓ plaintext CNIC is never written to any DB column
```

#### 6. Security
```
tests/integration/security/
  rateLimiting.test.ts
    ✓ 6th login attempt within 15 min → 429 with Retry-After header
    ✓ 4th KYC submission within 24h → 429
    ✓ rate limit counter resets after window expires

  webhookSignature.test.ts
    ✓ POST /api/webhooks/deposit without signature → 401 INVALID_WEBHOOK_SIGNATURE
    ✓ POST with wrong signature → 401
    ✓ POST with correct HMAC signature → 200, processed
    ✓ replayed webhook (same payload, same signature) → idempotency check prevents double-credit

  idempotency.test.ts
    ✓ POST /api/trades with Idempotency-Key → first call creates trade
    ✓ same Idempotency-Key again within 24h → returns cached response, no new trade
    ✓ same key, different body → IDEMPOTENCY_CONFLICT error
```

#### 7. BullMQ Jobs
```
tests/integration/jobs/
  deadLetterQueue.test.ts
    ✓ OCR job fails 3 times → admin email sent, order status set to manual_review_required
    ✓ rate updater job fails → alert email, cached rate continues to serve
    ✓ failed job captured to Sentry (mock Sentry SDK, assert captureException called)

  tradeEscalation.test.ts
    ✓ trade payment_pending > 4h → auto-cancelled, both parties emailed
    ✓ trade payment_uploaded > 2h with no admin action → admin email sent
    ✓ disputed trade > 48h → super_admin email sent

  rateUpdater.test.ts
    ✓ successful Binance fetch → platformConfig updated, float ad prices recalculated
    ✓ Binance unreachable → circuit breaker opens, cached rate preserved, admin alerted
    ✓ rate triggers active RateAlert → push + email sent, alert marked triggered
```

---

### Minimum Test Coverage Philosophy

**The goal is not 100% coverage. The goal is: zero untested paths that touch money or identity.**

| Category | Minimum acceptable | Rationale |
|----------|-------------------|-----------|
| Auth flows | 100% of happy path + 100% of error paths | A missed edge case = account takeover |
| Payment flows | 100% of state transitions | A missed state = funds stuck or double-paid |
| Withdrawal | 100% of validation + dual approval | Direct financial loss on failure |
| KYC | 100% of approval + CNIC dedup + sanctions | Identity fraud |
| Webhook | 100% of signature verification | Fake deposits trigger fund release |
| Rate limiting | All rate-limited endpoints | DoS and brute-force protection |
| BullMQ jobs | All jobs: success + fail-3-times scenarios | Silent failures = stuck orders |
| Admin actions | All irreversible actions | Collateral seizure, bans, KYC approval |
| Utility functions | address validation, CNIC hash | Wrong address = permanent fund loss |

**Coverage tooling:**
```json
// vitest.config.ts
coverage: {
  provider: 'v8',
  thresholds: {
    'src/services/**': { lines: 85 },
    'src/security/**': { lines: 100 },
    'src/utils/addressValidation.ts': { lines: 100 },
    'src/security/cnicHash.ts': { lines: 100 },
    'src/payments/webhook.ts': { lines: 100 },
  }
}
```

---

### Staging / Pre-Production Validation (before each deploy to production)

**Automated (CI pipeline — must pass before merge to main):**
```
1. npm run lint          ← TypeScript strict mode, ESLint
2. npm run test:unit     ← Vitest unit tests (< 30s)
3. npm run test:integration  ← Vitest integration tests against test DB (< 3 min)
4. npm run build         ← tsc --noEmit (type check passes)
```

**Manual staging checklist (run on staging once per week and before every major release):**
```
□ Register a new user → receive OTP email → verify → redirected to /setup-username
□ Complete basic KYC → submit → admin approves → limits updated
□ Create a sell ad → collateral prompt at trade 4 → lock collateral
□ Initiate a P2P trade → upload screenshot → admin confirms → seller sends → buyer confirms
□ Complete an Instant Buy (PKR) → OCR runs → admin approves → status: completed
□ Initiate a withdrawal → dual approval flow → approved → withdrawal confirmed
□ Open a dispute → admin resolves → both parties notified
□ Test rate staleness: kill Binance mock → wait 16 min → verify warning banner appears
□ Test push notification: trigger payment_confirmed event → verify push arrives on test device
□ Test idempotency: submit trade form twice rapidly → only one trade created
□ Test 2FA: enable on test admin → log in → TOTP required
□ Verify S3 bucket: curl raw file URL → must return 403
□ Verify HSTS header: curl any API endpoint → Strict-Transport-Security present
```

---

## 30. Complete API Contracts — Missing Endpoint Schemas

All 6 endpoints introduced in Sections 27.37–27.40 are fully specified here. These schemas are authoritative. Validators in `src/validators/` must match these exactly.

---

### 30.1 `POST /api/notifications/push/subscribe`

**Purpose:** Register a device's FCM token for push notifications.

**Auth:** Required (Bearer token)

**Rate limit:** 10 requests per user per minute (prevents token flooding)

**Request body:**
```typescript
{
  fcmToken: string   // min 100 chars (FCM tokens are ~150 chars); validates it is a non-empty string
}
```

**Validation rules:**
- `fcmToken` must be a non-empty string, minimum 50 characters
- If the same `fcmToken` already exists for this user → update `lastUsedAt`, return success (idempotent)
- If the same `fcmToken` exists for a DIFFERENT user → reassign to current user (device changed accounts)

**Success response `200`:**
```json
{
  "success": true,
  "data": {
    "subscribed": true,
    "tokenId": "sub_abc123"
  }
}
```

**Error responses:**
| HTTP | Error Code | When |
|------|-----------|------|
| 400 | `VALIDATION_ERROR` | `fcmToken` missing or too short |
| 429 | `TOO_MANY_REQUESTS` | Rate limit exceeded |

**Edge cases:**
- If `Notification.requestPermission()` was denied by user and they later re-enable, the same endpoint is called again — must be idempotent.
- Backend periodically cleans `PushSubscription` rows where `isActive = false` and `updatedAt < now - 30 days`.

---

### 30.2 `DELETE /api/notifications/push/subscribe`

**Purpose:** Unregister a device's FCM token (user logs out or disables push).

**Auth:** Required (Bearer token)

**Request body:**
```typescript
{
  fcmToken: string
}
```

**Success response `200`:**
```json
{
  "success": true,
  "data": { "unsubscribed": true }
}
```

**Error responses:**
| HTTP | Error Code | When |
|------|-----------|------|
| 400 | `VALIDATION_ERROR` | `fcmToken` missing |
| 404 | `NOT_FOUND` | Token not found for this user — return 200 anyway (idempotent) |

**Behavior note:** This endpoint also called automatically on `POST /api/auth/logout` — logout unregisters ALL of the user's push tokens for that device session.

---

### 30.3 `GET /api/rate-alerts`

**Purpose:** List the authenticated user's active rate alerts.

**Auth:** Required (Bearer token)

**Query params:** None

**Success response `200`:**
```json
{
  "success": true,
  "data": [
    {
      "id": "alert_abc123",
      "coin": "USDT",
      "targetRate": 285.00,
      "direction": "above",
      "isActive": true,
      "createdAt": "2026-05-07T10:00:00Z",
      "triggeredAt": null
    }
  ]
}
```

**Notes:**
- Returns both active (`isActive: true`) and recently triggered (`isActive: false`) alerts — frontend shows triggered alerts as "✅ Triggered at PKR 285" with option to re-create.
- Maximum 5 records returned (all user's alerts — no pagination needed).

---

### 30.4 `POST /api/rate-alerts`

**Purpose:** Create a new rate alert for a coin reaching a target PKR price.

**Auth:** Required (Bearer token)

**Rate limit:** 5 requests per user per hour

**Request body:**
```typescript
{
  coin: string        // must be in SUPPORTED_COINS list (USDT, BTC, ETH, etc.)
  targetRate: number  // PKR value; must be > 0; max 10 decimal places
  direction: 'above' | 'below'
}
```

**Validation rules:**
- `coin` must be in the supported coins list
- `targetRate` must be a positive number
- `direction` must be `'above'` or `'below'`
- If `direction = 'above'`: `targetRate` must be > current rate (no point alerting for a rate already exceeded)
- If `direction = 'below'`: `targetRate` must be < current rate
- User may not have more than `platformConfig.rate_alert_max_per_user` (default: 3) active alerts per coin

**Success response `201`:**
```json
{
  "success": true,
  "data": {
    "id": "alert_xyz789",
    "coin": "USDT",
    "targetRate": 285.00,
    "direction": "above",
    "isActive": true,
    "createdAt": "2026-05-07T10:00:00Z"
  }
}
```

**Error responses:**
| HTTP | Error Code | When |
|------|-----------|------|
| 400 | `VALIDATION_ERROR` | Missing/invalid fields |
| 400 | `RATE_ALERT_ALREADY_EXCEEDED` | `direction=above` but `targetRate` ≤ current rate, or vice versa |
| 429 | `RATE_ALERT_LIMIT_REACHED` | User has reached `rate_alert_max_per_user` active alerts for this coin |
| 429 | `TOO_MANY_REQUESTS` | Endpoint rate limit exceeded |

**Edge cases:**
- If rate is unavailable (`RATE_UNAVAILABLE`): reject with 503 — cannot validate direction against current rate.
- Triggered alerts do not count toward the per-user limit (only `isActive: true` alerts count).

---

### 30.5 `DELETE /api/rate-alerts/:id`

**Purpose:** Remove a rate alert.

**Auth:** Required (Bearer token)

**Path params:** `id` — the alert ID

**Validation rules:**
- Alert must belong to the authenticated user (not another user's alert)

**Success response `200`:**
```json
{
  "success": true,
  "data": { "deleted": true }
}
```

**Error responses:**
| HTTP | Error Code | When |
|------|-----------|------|
| 404 | `NOT_FOUND` | Alert not found OR belongs to different user |

---

### 30.6 `GET /api/merchants/dashboard/summary`

**Purpose:** Single aggregated call for the Merchant Dashboard — replaces 9 individual API calls.

**Auth:** Required (Bearer token); user must have `role === 'merchant'`

**Rate limit:** 60 requests per user per minute

**Success response `200`:**
```typescript
{
  "success": true,
  "data": {
    "merchant": {
      "id": string,
      "businessName": string,
      "status": "pending" | "pending_collateral" | "approved" | "rejected" | "suspended",
      "spreadBps": number,
      "rank": "bronze" | "silver" | "gold" | "platinum",
      "rankUpdatedAt": string,
      "disputeRate": number,          // float 0–1; show as percentage
      "approvedAt": string | null
    },
    "user": {
      // same as GET /api/auth/me User object (Section 4)
    },
    "wallets": [
      {
        "coin": string,
        "network": string,
        "balance": number,
        "lockedBalance": number,
        "depositAddress": string | null
      }
    ],
    "collateral": {
      "locked": boolean,
      "amount": number,             // USDT amount locked
      "coin": "USDT",
      "canUnlock": boolean,         // false if active trades exist
      "activeTradesCount": number
    },
    "recentTrades": Trade[],        // last 10 trades (same schema as GET /api/trades)
    "inventory": [
      {
        "id": string,
        "coin": string,
        "network": string,
        "availableAmount": number,
        "pricePerUnit": number,
        "pkrValue": number          // computed: availableAmount × rates[coin]; never hardcoded
      }
    ],
    "stats": {
      "totalTrades": number,
      "totalVolumePKR": number,
      "totalRevenuePKR": number,
      "avgRating": number,
      "completionRate": number,     // float 0–1
      "trades24h": number,
      "volume24h": number,
      "revenue24h": number
    },
    "rates": {
      "USDT": number,
      "BTC": number,
      "ETH": number,
      "BNB": number,
      "SOL": number,
      // ...all supported coins
      "updatedAt": string           // ISO timestamp — frontend shows staleness warning
    },
    "notifications": {
      "items": Notification[],      // last 5 unread notifications
      "unreadCount": number
    },
    "rank": {
      "badge": string,
      "badgeLabel": string,
      "badgeIcon": string,
      "trustScore": number,
      "totalTrades": number,
      "completionRate": number,
      "nextBadge": { "label": string, "tradesNeeded": number, "completionRequired": number } | null
    }
  }
}
```

**Error responses:**
| HTTP | Error Code | When |
|------|-----------|------|
| 403 | `FORBIDDEN` | User is not a merchant (`role !== 'merchant'`) |
| 503 | `RATE_UNAVAILABLE` | Rate data missing from platformConfig AND Redis cache empty |

**Performance requirement:** Backend must use `Promise.all` for all sub-queries. Target response time ≤ 600ms on Railway. Log a warning if > 1000ms.

**Note on `pkrValue` in inventory:** Computed server-side using the same rates fetched in the `rates` field. Frontend must NOT recompute this — use the value from the response directly to ensure consistency.

---

### 30.7 `POST /api/instant-buy/orders/:id/resubmit-payment`

**Purpose:** Re-upload a payment screenshot for a previously rejected Instant Buy order. Resets the order back into the verification queue without requiring the user to create a new order.

**Auth:** Required (Bearer token); must be the order owner

**Rate limit:** 3 requests per order (tracked in Redis: `resubmit_attempts:{orderId}`)

**Path params:** `id` — the InstantBuyOrder ID

**Request:** `multipart/form-data`
```
screenshot: File   ← new payment screenshot; same validation as original upload
                     max 10MB; MIME: image/jpeg, image/png, image/webp, application/pdf
                     validated by file buffer (file-type npm package), not extension
```

**Server-side validation (all must pass before processing):**
1. `order.userId === req.user.id` — must be the order owner
2. `order.status === 'rejected'` — can only resubmit rejected orders
3. `order.rejectionReason` must be one of: `SCREENSHOT_UNCLEAR`, `AMOUNT_MISMATCH`, `WRONG_ACCOUNT` — orders rejected for `FRAUD_DETECTED` or `KYC_REQUIRED` cannot be resubmitted (user must create new order or resolve the underlying issue)
4. `order.createdAt > now - 30 minutes` — resubmit window has not expired (rate may have changed beyond acceptable tolerance after 30 min)
5. `resubmit_attempts:{orderId}` in Redis < 3 — maximum 3 resubmission attempts per order

**Processing flow on success:**
1. Compress and validate the screenshot (Section 27.14)
2. Upload to S3: `payment-proofs/{userId}/{uuid}.jpg` — replaces previous paymentProofUrl in DB
3. Update order: `status = 'payment_uploaded'`, `verificationStatus = 'pending_layer1'`, `ocrConfidence = null`, `ocrExtractedAmount = null`, `rejectionReason = null`
4. Increment `resubmit_attempts:{orderId}` in Redis (TTL: 24h)
5. Enqueue new OCR Layer 1 job
6. Return updated order object

**Success response `200`:**
```json
{
  "success": true,
  "data": {
    "orderId": "ibo_abc123",
    "orderRef": "IB-20260507-0042",
    "status": "payment_uploaded",
    "verificationStatus": "pending_layer1",
    "resubmitAttemptsRemaining": 2,
    "message": "Payment screenshot submitted. We're verifying it now."
  }
}
```

**Error responses:**
| HTTP | Error Code | When |
|------|-----------|------|
| 400 | `VALIDATION_ERROR` | No file uploaded, file too large, unsupported MIME type |
| 403 | `FORBIDDEN` | Order belongs to different user |
| 404 | `ORDER_NOT_FOUND` | Order ID does not exist |
| 409 | `INVALID_STATE` | Order is not in `rejected` status |
| 409 | `RESUBMIT_WINDOW_EXPIRED` | `order.createdAt` > 30 minutes ago |
| 409 | `RESUBMIT_NOT_ALLOWED` | `rejectionReason` is `FRAUD_DETECTED` or `KYC_REQUIRED` (cannot resubmit) |
| 429 | `RESUBMIT_LIMIT_REACHED` | 3 resubmission attempts already used for this order |
| 429 | `TOO_MANY_REQUESTS` | Endpoint rate limit exceeded |

**Idempotency:** This endpoint does NOT use the `Idempotency-Key` header (each resubmission is intentionally a new attempt). The 3-attempt counter in Redis provides the equivalent protection.

**Admin visibility:** When an admin views this order in `/admin/instant-buy`, they see:
- "Resubmission #{n}" label on the payment proof
- Original rejection reason visible for context
- Resubmission timestamp

---

## 31. Gas Fee Infrastructure

> 📄 **Full specification:** [GAS_FEE_SPEC.md](GAS_FEE_SPEC.md)
> This section contains the architectural summary only. All developers building the gas fee system MUST read GAS_FEE_SPEC.md.

### What It Is

The Gas Fee Supply System is PakSwap's second core product. Users globally can purchase native blockchain gas tokens (e.g., TRX, ETH, BNB) instantly by paying USDT. No account required for small orders.

### MVP Scope (Phase 1)

- **Chain:** TRON only (TRX gas)
- **Payment in:** USDT/TRC20
- **Tiers:** 10 TRX ($1.20), 50 TRX ($5.50), 100 TRX ($10.00)
- **KYC:** Not required for orders ≤ $10 USD
- **Automation:** Fully automated payout via TronWeb SDK (no manual operator step)
- **Delivery SLA:** ≤ 60 seconds after payment confirmed

### Key Architecture Decisions

1. **Separate deposit address** — Gas fee payments go to a different USDT address than P2P deposits. Mixing creates unreconcilable payment attribution.
2. **Automated from Day 1** — Unlike P2P withdrawals, gas fees cannot be manual. A user requesting gas needs it within seconds, not hours.
3. **Hot wallet per chain** — Gas fee hot wallets are separate from P2P hot wallets. Different risk profiles and balance requirements.
4. **No-KYC for small orders** — Critical for capturing the global market without friction. KYC requirement only above $25 USD.
5. **Price lock: 5 minutes** — Quote expires after 5 minutes. Platform absorbs price movement within the window.

### Order States

```
created → payment_pending → payment_detected → sending → delivered
                          ↓                             ↓
                       expired                       failed → refunded
```

### New Database Table

```prisma
model GasFeeOrder {
  id              String            @id @default(cuid())
  orderRef        String            @unique
  userId          String?           // null for guest orders
  chain           GasChain
  tier            GasFeeTier
  gasAmountNative Decimal
  paymentAmount   Decimal           // USDT charged
  toAddress       String
  status          GasFeeOrderStatus
  deliveryTxHash  String?
  expiresAt       DateTime
  // ... (full schema in GAS_FEE_SPEC.md Section 7)
}
```

### New API Endpoints

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | `/api/gas-fee/orders` | None | Create gas fee order |
| GET | `/api/gas-fee/orders/:orderRef` | None | Poll order status |
| GET | `/api/gas-fee/prices` | None | Current prices for all tiers |

### New Admin Pages

- `/admin/gas` — Dashboard: order volume, hot wallet balance, failed orders
- `/admin/gas/orders/:orderRef` — Order detail with retry/refund actions
- `/admin/gas/unattributed` — Payments received after order expiry (manual reconciliation)

### Revenue Potential

At 500 orders/day with avg $0.90 margin: **$13,500/month fully automated.**

---

## 32. Database Transaction Safety

> 📄 **Full specification:** [DB_TRANSACTION_RULES.md](DB_TRANSACTION_RULES.md)
> This section states the non-negotiable rule. DB_TRANSACTION_RULES.md contains every operation that requires `db.$transaction()` with implementation code.

### The Rule (Non-Negotiable)

> **Any service method that reads a balance, limit, or counter AND writes to it MUST wrap both operations in `db.$transaction()` with `SELECT FOR UPDATE`.**

This is Rule 35 in Section 22. It applies without exception.

### Why This Is Critical

Without explicit transactions, PostgreSQL allows concurrent requests to interleave:

```
Time 0ms: Request A reads dailyBuyUsed = 45,000 PKR (limit: 50,000)
Time 1ms: Request B reads dailyBuyUsed = 45,000 PKR (same value — A hasn't written yet)
Time 2ms: Both pass the limit check (45,000 + 5,000 = 50,000 ≤ 50,000)
Time 3ms: Both trades created → user spent PKR 55,000 against a PKR 50,000 limit
```

### Operations That MUST Use `db.$transaction()`

| Operation | Service File | Race Prevented |
|-----------|-------------|----------------|
| Trade creation | `trade.service.ts` | Daily limit double-spend |
| Collateral lock | `collateral.service.ts` | Negative collateral balance |
| Withdrawal first approval | `withdrawal.service.ts` | Duplicate first approval |
| Withdrawal second approval | `withdrawal.service.ts` | Double-spend + same-admin approval |
| Referral reward claim | `referral.service.ts` | Daily cap exceeded concurrently |
| Instant buy payment credit | `payment.service.ts` | Duplicate webhook credit |
| Trade cancellation | `trade.service.ts` | Cancel-while-confirming race |
| Collateral seizure | `seizure.service.ts` | Negative balance on seizure |
| KYC level upgrade | `kyc.service.ts` | Limit update atomicity |
| Badge recalculation | `badge.service.ts` | Badge/notification split-brain |

### Required Transaction Pattern

```typescript
// Pattern A: Read-Lock-Modify (for all balance operations)
await db.$transaction(async (tx) => {
  const [user] = await tx.$queryRaw`
    SELECT "dailyBuyUsed", "dailyBuyLimit"
    FROM "User"
    WHERE id = ${userId}
    FOR UPDATE  ← This is the lock. Without it, the transaction does nothing.
  `
  if (user.dailyBuyUsed + amount > user.dailyBuyLimit) throw new AppError('DAILY_LIMIT_EXCEEDED')
  await tx.user.update({ where: { id: userId }, data: { dailyBuyUsed: { increment: amount } } })
  await tx.trade.create({ data: tradeData })
}, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
```

See DB_TRANSACTION_RULES.md for all 10 operations with complete implementation code and test patterns.

---

*End of specification. Every page, every API call, every data source is defined above.*
*Any data shown to a user that is not in this document needs a new API endpoint — never fake it.*

---

*Version 8 — final handover-readiness pass (backend folder structure, testing architecture, complete API contracts, naming consistency):*

*Added Section 28:* Canonical backend folder/file structure with annotated file tree covering all 17 repositories, 22 services, 12 BullMQ jobs, notification dispatcher, security layer, audit trail, and 8 enforced architecture rules (no direct Prisma in routes, no business logic in controllers, AppError class only, dispatcher.ts single notification entry point).

*Added Section 29:* Testing architecture — Vitest + Playwright + nock stack; `.env.test` config; 7 critical flow categories with specific test cases (including "NO auto-release ever" enforced by test); coverage thresholds (`src/security/**` = 100%); CI pipeline (lint → unit → integration → build); 15-item manual staging checklist.

*Added Section 30:* Complete API contracts for 7 endpoints — `POST/DELETE /api/notifications/push/subscribe`, `GET/POST/DELETE /api/rate-alerts`, `GET /api/merchants/dashboard/summary` (full nested response schema + ≤600ms SLA), `POST /api/instant-buy/orders/:id/resubmit-payment` (5 validation rules + 3-attempt Redis counter).

*Consistency fix:* `/api/merchant/dashboard/summary` → `/api/merchants/dashboard/summary` corrected in 4 locations (Section 16.23 ×3, Phase 1 checklist ×1).

---

*Version 7 — full B2C launch audit integration (complete pass):*

*Security:* Resolved JWT localStorage conflict — access token now in Zustand memory only, refresh token in httpOnly+SameSite=Strict cookie; added Zustand store auth slice with CSRF token; added HTTPS HSTS + full security headers plugin for Fastify; added cookie security flags (httpOnly, Secure, SameSite=Strict); added S3 private bucket policy + signed URL serving specification + pre-launch verification command; added CNIC_HASH_SECRET startup validation (server refuses to start if missing); added all missing env vars (CNIC_HASH_SECRET, MORALIS_WEBHOOK_SECRET, TATUM_WEBHOOK_SECRET, BLOCKCYPHER_TOKEN, SENTRY_DSN, POSTHOG_API_KEY, TURNSTILE_SECRET_KEY, FCM_SERVER_KEY, VAPID keys, FIREBASE_SERVICE_ACCOUNT, CSRF_SECRET, JWT_REFRESH_SECRET); added backend startup validation block for all critical env vars.

*Infrastructure:* Added database backup strategy (Railway Pro + daily pg_dump → S3 + 90-day retention + weekly restore test); added operational runbook (daily + weekly operator checklist including hot wallet sweep, rate health check, fraud flag review, AML review); added merchant dashboard aggregation endpoint `GET /api/merchant/dashboard/summary` (parallel Promise.all — eliminates 9 sequential mobile API calls).

*UX/Product:* Added global footer specification with legal links + dynamic WhatsApp number from API; added trade page step indicator ("What happens next?" stepper for first-time traders); added proactive trade expiry warning banners (< 30 min = yellow, < 10 min = red); added explore mode for unverified users (browse marketplace but CTAs gated behind KYC); moved onboarding checklist widget and customer support to Phase 1 (highest-impact early retention).

*Retention/Growth:* Added Web Push Notifications via FCM (Section 27.37) — service worker, push subscription API, per-event notification table, FCM admin SDK implementation; added rate alert subscription system (Section 27.40) — DB table, API endpoints, rate updater integration, frontend widget; added first-trade bonus (PKR 50 credit, Section 27.40); added referral progress tracker (per-referred-user status + "Remind via WhatsApp" button, Section 27.40); added pre-launch supply seeding strategy + explore mode (Section 27.41); moved Posthog analytics to Phase 1 (6 critical funnel events required before launch).

*Roadmap:* Expanded Phase 1 from 35 to 52 items; added Phase 2 (13 items), Phase 3 (9 items), Phase 4 (9 items); added 5 new platformConfig keys (rate_alert_max_per_user, first_trade_bonus_pkr, first_trade_bonus_enabled, override_collateral_for_new_merchants, show_footer_social_links + social_twitter/facebook/instagram); added PushSubscription and RateAlert DB tables; added 1 new email template (rate_alert, referral_kyc_completed).*
