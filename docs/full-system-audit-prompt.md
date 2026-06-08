# FULL-SYSTEM BREAKAGE AUDIT — PakSwap (everything that can break now or in the future)

> Paste this whole file as the instructions for a fresh Claude session or `/code-review ultra`.
> It is pre-loaded with the REAL routes, models, pages, jobs, and external services of this
> codebase so the auditor goes straight to the high-risk areas instead of rediscovering them.

---

## MISSION

You are auditing a LIVE P2P crypto marketplace ("PakSwap"). The owner says "most things look
fine from my end." Assume that is the trap. Your job is NOT to confirm it works — it is to find
what is quietly fragile: things that work today but WILL break under load, edge cases, race
conditions, stale data, scale, provider outages, or the next code change. **Latent and future
risk is priority #1.** Treat every passing surface as guilty until proven robust.

Do NOT modify any code in this pass. Audit and plan only. Read the real code. Cite real file
paths and line numbers as clickable links. Prefer "this WILL break when X" over "could be
improved." If you cannot verify something, say so and name exactly what you'd need to check.

---

## THE REAL SYSTEM (verified map — start here, do not rediscover)

### Stack
- **Frontend:** Next.js (App Router, TypeScript), deployed on **Vercel**. API client in
  `frontend/src/lib/api.ts`. Auth state in `frontend/src/store/auth.store.ts`. Realtime via
  SSE (`frontend/src/hooks/useSSE.ts`) and polling (`frontend/src/hooks/usePolling.ts`).
  Web3/wallet connect via wagmi/appkit (`frontend/src/lib/web3/`).
- **Backend:** **Fastify** + TypeScript + Prisma, deployed on **Railway**. Routes registered in
  `backend/src/routes/index.ts`, almost all under prefix `/api/v1`.
- **Database:** PostgreSQL via Prisma — `backend/prisma/schema.prisma` (**72 models, 42 enums**).
- **Queue/cache:** Redis (`backend/src/lib/redis.ts`), queues in `backend/src/queues/`.

### Three product pillars
1. **P2P Marketplace** — ads, trades, escrow, disputes, ratings, KYC, wallets, withdrawals.
2. **Gas Station** — sells gas/fees across many chains; treasury + hot-wallet + ledger + refill
   + reconciliation system. Largest job surface. Heavy external-RPC dependence.
3. **CTM (Community Token Market)** — listings, bids, requests, trades, escrow, disputes for
   community tokens. NOTE: CTM dispute resolution records a ruling + audit log only; it does
   **NOT** move funds (manual settlement). Verify the UI ack still enforces this.

### Backend route files (all under `/api/v1` unless noted)
```
health.routes (no prefix)   auth.routes (/api/v1/auth)   marketplace.routes (/api/v1/marketplace)
ad.routes   ad.bid.routes   trade.routes   wallet.routes   kyc.routes   user.routes
dashboard.routes   merchant.routes   merchantGas.routes   instantBuy.routes   dispute.routes
notification.routes   adminNotification.routes   referral.routes   leaderboard.routes
upload.routes   webhook.routes   rateAlert.routes   gasFee.routes   admin.routes
push.routes   sse.routes   logos.routes   support.routes
ctm.token.routes   ctm.listing.routes   ctm.request.routes   ctm.trade.routes
ctm.merchant.routes   ctm.admin.routes   ctm.bid.routes
```

### Frontend page routes (App Router)
- **Auth:** `/login` `/register` `/forgot-password` `/verify-email` `/setup-username` `/2fa`
  `/auth/google/success`
- **Platform:** `/dashboard` `/marketplace` `/marketplace/listings/[id]` `/create-ad` `/my-ads`
  `/trade/new` `/trade/[id]` `/orders` `/wallet` `/payment-methods` `/kyc` `/favorites`
  `/notifications` `/profile/[username]` `/settings` `/referral` `/merchant-apply`
- **Instant Buy:** `/instant-buy` `/instant-buy/payment/[id]` `/instant-buy/crypto-deposit/[id]`
  `/instant-buy/status/[id]`
- **CTM:** `/ctm` `/ctm/dashboard` `/ctm/tokens` `/ctm/tokens/[slug]` `/ctm/listings`
  `/ctm/listings/[id]` `/ctm/listings/create` `/ctm/requests` `/ctm/requests/create`
  `/ctm/my-listings` `/ctm/my-bids` `/ctm/my-requests` `/ctm/my-trades` `/ctm/incoming-bids`
  `/ctm/trade/[ref]` `/ctm/merchant-setup`
- **Gas:** `/gas` `/gas/orders` `/gas/orders/[orderRef]`
- **Merchant:** `/merchant/[id]` `/merchant/dashboard`
- **Public/SEO:** `/about` `/fees` `/help` `/leaderboard` `/levels` `/terms` `/privacy`
  `/r/[code]` (referral) `/confirm-withdrawal`
- **Admin:** `/admin` + analytics, audit-log, chains, chains/[slug]/tokens, config, disputes,
  gas (+ analytics/chains/flagged/merchants/orders/[orderRef]/reconciliation/requests/
  wallet-activity), instant-buy, kyc, logos, merchant-kyc, notifications, platform-revenue,
  ratings, referrals, settings, support, trades(+/[id]), users(+/[id]), withdrawals(+/[id]),
  wallet, ctm (+ disputes/merchants/proofs/tokens/tokens-queue/trades/[ref]).

### Background jobs (`backend/src/jobs/`) — verify each is scheduled, idempotent, and recovers
```
badgeRecalculate   gasDeliveryCheck   gasExpiry   gasFee   gasHotWalletDepositPoller
gasMerchantSettlement   gasMonitorBalances   gasPaymentPoller   gasRefund   gasWebhook
ocrVerification   rateUpdater   referralPayout   tradeEscalation   withdrawalConfirmationWatcher
```
(NOTE from project history: `referralPayout` auto-payout is intentionally DISABLED — confirm it
is actually inert and not silently half-running.)

### Services (`backend/src/services/`)
```
auth   ad   ad.bid   adminNotification   blockchainVerification   chainRegistry
depositAddress   depositReconcile   depositWatcher   email   instantBuy   kyc
marketplace   merchant   moralisStreams   trade   wallet
withdrawal-risk   withdrawal-security
```

### Key Prisma models (72 total — high-risk subset)
- **Money/escrow:** Wallet, Transaction, Trade, TradeMessage, Withdrawal, WithdrawalTierConfig,
  Deposit, DepositAddress, DepositChain, DepositToken, CollateralLock, InstantBuyOrder.
- **Trust/identity:** User, Session, OtpCode, KycSubmission, MerchantKycSubmission, Merchant,
  MerchantInventory, PaymentMethod, TrustedWithdrawalAddress, SavedAddress, FraudFlag,
  SanctionedEntity.
- **Reputation (drift-prone):** TradeStats, TradeRating, TraderBadge(enum), ReferralReward,
  UserFavorite, Notification, PushSubscription.
- **Gas:** GasFeeOrder, GasChainConfig, GasTokenConfig, GasTreasuryWallet, GasHotWallet,
  GasLedgerEntry, GasRefillRequest, GasRefillThreshold, GasMerchantAccount,
  GasMerchantSettlement, GasReconciliationRun, GasReconciliationDiscrepancy, GasCustomRequest,
  GasFlaggedOrder.
- **CTM:** CtmToken, CtmTokenRequest, CtmListing, CtmListingBid, CtmBid, CtmRequest, CtmTrade,
  CtmTradeMessage, CtmTradeProof, CtmTradeRating, CtmDispute, CtmDisputeMessage,
  CtmMerchantProfile.
- **Platform:** Ad, AdBid, Dispute, DisputeMessage, PlatformConfig, AuditLog, AdminNote,
  AdminNotification, SupportConversation, SupportMessage, LogoRegistry, RateAlert,
  MoralisStreamSubscription, EmailLog, MerchantApiKey.

### External dependencies (every one is a potential breakage point)
- **Blockchain RPC / data:** Alchemy, Etherscan, Moralis (+ Streams webhooks, 6 chain stream
  IDs), Tatum (+ webhooks), TronGrid / TRON full node, BlockCypher. Wallet derivation:
  EVM + TON + Solana + SUI + Aptos (`backend/src/lib/gas/*WalletService.ts`).
- **Prices:** CoinGecko, CMC, CoinStats, FreeCryptoAPI, Binance, ExchangeRate.
- **Infra/comms:** Redis, Cloudinary (uploads), Resend (email), FCM + Firebase + VAPID/WebPush,
  Turnstile (captcha), Sentry, PostHog.
- **Secrets that break things when wrong/rotated/expired:** JWT_SECRET, JWT_REFRESH_SECRET,
  CSRF_SECRET, WALLET_MASTER_KEY, WALLET_MASTER_SEED_CIPHERTEXT, CNIC_HASH_SECRET, all
  GAS_WALLET_* keys, every *_WEBHOOK_SECRET.

---

## METHOD

1. Confirm/extend the dependency graph above: for each high-traffic page, list the exact API
   endpoints it calls, the models touched, and the external services involved.
2. Walk each FAILURE DOMAIN below. For EVERY finding use exactly this format:
   ```
   [SEVERITY] Title (one line)
   Where:   path/to/file.ts:line   (clickable)
   Breaks:  what fails
   Trigger: the exact condition (load / race / null / stale cache / provider down / long input /
            concurrent click / token expiry / scale / migration)
   Now or Future: breaks today, or only later — and at what threshold
   Fix:     concrete change
   ```
3. SEVERITY: **P0** = fund error / data loss / security / core flow dead · **P1** = broken or
   fragile connection, will fail in production soon · **P2** = degraded UX/SEO/perf/a11y ·
   **P3** = polish.

---

## FAILURE DOMAIN 1 — FRONTEND ↔ BACKEND DISCONNECTIONS (highest priority)
Using `frontend/src/lib/api.ts` as the entry point, for every API call:
- Does the endpoint exist under the right `/api/v1` prefix? Find orphaned/renamed/dead routes
  and frontend calls to endpoints that no longer exist.
- Does the request shape (body/params/query/headers) match what the Fastify route reads, and the
  response shape match what the UI destructures? (missing/renamed fields, array vs object, null
  vs [], string vs number, Decimal-as-string, date format).
- Are all states handled in the UI: loading, empty, 400/401/403/404/409/422/429/500, network
  timeout, aborted request?
- Base-URL / env mismatch between local, Vercel, and Railway. CORS, credentials, cookie domain,
  SameSite between the two deploy targets. Any hardcoded URL or `NEXT_PUBLIC_` fallback to
  localhost/undefined.
- Broken internal links, dead `[id]`/`[ref]`/`[slug]`/`[code]` dynamic routes, buttons to nowhere.
**Output a consolidated DISCONNECTION MAP.**

## FAILURE DOMAIN 2 — REALTIME (SSE / polling / push)
- `sse.routes` + `useSSE`: what happens on disconnect, redeploy, idle timeout, proxy buffering on
  Vercel/Railway? Does it reconnect? Are events idempotent? Memory growth from open connections?
- `usePolling`: intervals that never stop, thundering-herd on many tabs, polling after the user
  left the page.
- Push (`push.routes`, VAPID/FCM): stale/expired subscriptions, failures that block the flow,
  duplicate notifications.

## FAILURE DOMAIN 3 — MONEY, ESCROW & DATA INTEGRITY (P0 territory)
- Trade/escrow state machine (`trade.service`, TradeStatus enum): every transition — can it
  double-release, double-refund, or get stuck? Partial-failure leaving inconsistent state.
- Multi-step writes that MUST be atomic but aren't (Prisma `$transaction` missing where balance +
  ledger + status all change together).
- Decimal/BigInt precision on money; rounding; sign errors; balance computed in two places that
  can disagree (Wallet vs Transaction sum vs GasLedgerEntry).
- Withdrawals: `withdrawal-risk` + `withdrawal-security` + `withdrawalConfirmationWatcher` +
  `confirm-withdrawal` page + TrustedWithdrawalAddress — any path that releases funds without the
  full check chain. Confirmation watcher idempotency.
- Gas ledger & reconciliation: GasLedgerEntry / GasReconciliationRun / Discrepancy — what makes
  the ledger drift from on-chain reality, and does reconciliation actually catch it?
- Deposits: `depositWatcher` + `depositReconcile` + Moralis/Tatum webhooks — double-credit on
  duplicate webhook delivery, missed deposit on provider downtime, wrong chain/token mapping.

## FAILURE DOMAIN 4 — REPUTATION & CACHED/DENORMALIZED VALUES (known drift area)
- **TradeStats vs live counts:** project history confirms leaderboard (live) and badge/dashboard
  (cached TradeStats) can disagree = stale cache. Find every reader/writer of TradeStats,
  TraderBadge, avgReleaseMinutes, response-time fields. What recomputes them, what can make them
  drift, and how stale they get. (`badgeRecalculate.job`, `npm run stats:backfill`,
  `POST /admin/stats/recalculate`.)
- Ratings (TradeRating/CtmTradeRating) aggregation correctness.

## FAILURE DOMAIN 5 — CONCURRENCY, RACES & STATE
- Double-submit / double-click / rapid retry on: create-ad, open-trade, release escrow, place
  bid (AdBid/CtmBid), withdraw, gas order. Idempotency keys present?
- Two users (or two tabs) acting on the same trade/order/listing simultaneously.
- Optimistic UI desync on failure. Caches (Redis TTL, React Query/SWR, localStorage): what
  invalidates each, what the user sees stale, caches that never invalidate.
- Background job + user action on the same row at once. Webhook ordering & idempotency
  (`gasWebhook.job`, `webhook.routes`, Moralis/Tatum).
- Session/token expiry MID-FLOW (during a trade, KYC upload, or multi-step gas/CTM flow);
  refresh-token rotation races.

## FAILURE DOMAIN 6 — EXTERNAL DEPENDENCIES & SINGLE POINTS OF FAILURE
- For each RPC/data/price provider: timeout, retry, fallback, circuit breaker — or does it hang
  and block the user? (`evmRpc.ts`, `gas/rpcFallback.ts`, `moralisClient.ts`.)
- Any chain/service with only ONE node/provider = SPOF. Price feeds: what if the primary returns
  a stale or absurd price (and that price drives a trade or gas markup)?
- Outbound calls with no timeout. Provider rate-limit (429) handling. Webhook-secret validation
  on every inbound webhook. Key rotation/expiry blast radius.
- Non-EVM wallet services (TON/SOL/SUI/Aptos): derivation correctness, what breaks if a library
  or node changes behavior.

## FAILURE DOMAIN 7 — SECURITY
- Authorization enforced SERVER-side on every endpoint (esp. all `/admin/*`, gas, CTM admin,
  withdrawals) — not just hidden UI buttons. Run the IDOR test: can user A read/modify user B's
  trade/order/wallet/listing by changing an id/ref/slug?
- Internal IDs / PII / CNIC / wallet keys / email leaking in API responses or logs (project
  history flagged ID leaks before — re-verify).
- Input validation/sanitization (injection, XSS, oversized payload). Secrets in client bundle or
  `NEXT_PUBLIC_`. Rate limiting on auth/OTP/withdrawal/payout/expensive endpoints.
- CSRF (`csrf.ts`) + CORS + cookie flags (HttpOnly/Secure/SameSite). File-upload validation
  (type/size/content) on KYC, avatars, CTM proofs, logos (Cloudinary).
- Captcha (Turnstile) actually enforced where intended. MerchantApiKey scoping & leakage.

## FAILURE DOMAIN 8 — SCALE & PERFORMANCE (what breaks as data grows)
- Queries fine at 100 rows, fatal at 1M: N+1, full scans, unbounded SELECT, pagination that loads
  everything. Check marketplace listing, leaderboard, admin tables, notifications, ledger.
- Missing Prisma indexes on columns used in where/order/join. Lists with no pagination/virtual.
- Bundle size, unnecessary client components, web3/wagmi weight on pages that don't need it,
  image weight (Cloudinary transforms used?). Core Web Vitals: LCP/CLS/INP.
- Memory growth in long-running backend, in-memory caches, open SSE connections. Cold starts.

## FAILURE DOMAIN 9 — USER JOURNEYS & CONVERSION
Walk each journey end-to-end; find dead-ends, loops, confusing forks, steps assuming prior state
that may not exist, irreversible/financial actions without confirmation:
- signup → verify-email → setup-username → 2FA → KYC → first trade → dispute → withdrawal.
- marketplace browse → open trade → escrow → release → rate.
- gas order → pay → deliver. CTM: list/bid → trade → proof → dispute.
- Conversion friction: unclear CTAs, missing trust signals at the decision moment, form fields
  that kill signups, the gentle/delayed push opt-in (verify it's not annoying or broken).

## FAILURE DOMAIN 10 — UI ROBUSTNESS, SEO, ACCESSIBILITY
- UI breaks with REAL content: long usernames, empty data, missing images/avatars (fallbacks),
  huge numbers, zero/negative, unicode/emoji. Light/dark contrast & theme tokens (recent audit
  area — re-verify). Responsive at real mobile widths.
- SEO: metadata/title/description/canonical/OG/structured data on public pages (`/about` `/fees`
  `/help` `/leaderboard` `/levels` `/terms` `/privacy`, merchant/profile pages); sitemap, robots,
  server-vs-client rendering for indexable content, heading hierarchy, broken links, redirect
  chains, `/r/[code]` referral handling.
- a11y: keyboard nav, focus order/traps/visible focus, ARIA, alt text, contrast ratios, form
  labels, screen-reader flow, motion safety.

## FAILURE DOMAIN 11 — EDGE CASES & NASTY INPUTS (QA)
Empty / zero / negative / max-int / huge string / whitespace-only / unicode-emoji inputs;
network drop mid-transaction; back button after submit; refresh mid-flow; timezone/DST/date
boundaries; expired or revoked token mid-session; same user in two tabs; pasting a wrong-chain
address; uploading a non-image; a trade/order that expires while the user is on the page.

## FAILURE DOMAIN 12 — DEPLOYMENT, BUILD & OBSERVABILITY
- Env-var parity across local / Vercel / Railway — anything defined in one, missing or different
  in another (cross-check `backend/.env.example`). Frontend↔backend URL config.
- Build/typecheck issues waiting to fail the next deploy (this project targets zero TS errors).
- Health checks (`health.routes`), graceful shutdown, queue/job reliability after redeploy, what
  happens to in-flight SSE/jobs on Railway restart.
- Observability: are errors swallowed silently anywhere? Is Sentry/PostHog actually wired so a
  production break is visible? Logging gaps around money paths.
- Content/microcopy: scary/unhelpful error messages, leftover placeholder text, inconsistent
  terminology, untranslated strings.

---

## THE DIRECTOR — final deliverable (the one who controls all of the above)

After covering every domain, switch to Chief Architect and produce:

- **A. TOP 15 THINGS MOST LIKELY TO BREAK**, ranked by (likelihood × blast radius). For each:
  what breaks, the trigger, now-or-future, and the fix.
- **B. THE DISCONNECTION MAP** — every frontend↔backend↔DB mismatch, consolidated.
- **C. LATENT / FUTURE-RISK REGISTER** — works today, will break later; state the trigger and
  the threshold (data size, traffic, provider event, next feature).
- **D. SINGLE POINTS OF FAILURE** — anything whose outage takes the site (or a money flow) down.
- **E. CONFLICTS** — where two fixes fight (e.g. SEO server-render vs perf vs security); decide
  each trade-off and justify it.
- **F. PRIORITIZED FIX PLAN** — P0 → P3, grouped so related fixes ship together, each with a
  one-line effort estimate.

**Final line:** the SINGLE most important thing to fix first, and exactly why it outranks
everything else.

---

## HARD RULES
- Read the real code; cite real file paths + line numbers as clickable links.
- Prefer "this WILL break when X" over "this could be improved."
- Do not modify any code in this pass — audit and plan only.
- If something can't be verified, say so and name what you'd need to confirm it.
