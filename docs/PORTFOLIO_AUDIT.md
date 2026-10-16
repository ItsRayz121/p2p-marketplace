# Portfolio — Phase 0 audit (read-only, partial)

Prepared 2026-10-16 against `main` @ 905a427a. Nothing was changed, deployed, or queried in production. No secrets were read.
Scope covered so far: Wallet page, frontend stack, schema for CTM/Wallet, service worker, test tooling. **Not yet audited:** settlement/reconciliation workers, gas-order flow, USDT marketplace `Trade` lifecycle, auth/tenant isolation middleware, price sources behind public CTM rates, historical data completeness (needs redacted counts, which need data access). Those are listed under "Still to do before Phase A calc/ingestion work".

## 1. Facts found (with references)

| Area | Finding | Reference |
|---|---|---|
| Wallet tabs | Tab is plain `useState<'methods'\|'balance'>`; **not in the URL**. Default is `methods`. | `frontend/src/app/(platform)/wallet/page.tsx:1715` |
| Tab visibility | The balance tab (and its tablist) only renders when `hasFunds \|\| isMaker`. New users see no tabs at all. | `wallet/page.tsx:1782-1794` |
| Deep links | Every inbound link uses the **hash** `/wallet#payment-methods` (marketplace listing, CTM requests, create-ad, `/payment-methods` redirect). The page has an element `id="payment-methods"` but no hash→tab logic. Today it works only because `methods` is the default tab. | `wallet/page.tsx:1902`, `payment-methods/page.tsx:10` |
| Navigation | Single entry "Wallet & Payment Methods" in Navbar and dashboard. | `components/layout/Navbar.tsx:53`, `dashboard/page.tsx:34` |
| Balance section | Rendered as `<section>` titled "RupChain balance" inside the balance tab, followed by `RecentDeposits` and the transaction list. Deposit/Withdraw modals are page-level state. | `wallet/page.tsx:1828-1919` |
| Custody ledger | `Wallet` (Decimal 18,8, per user/coin/network) and `Transaction`. Fully separate from any analytical data, as required. | `schema.prisma:603` |
| Asset registry | `CtmToken`: cuid `id`, unique `slug`, `symbol` (not unique), `name`, `network`, `contractAddress`, `settlementType`, `status`, `logoUrl`, `officialWebsite`. Identity = id (+ network/contract), never symbol. | `schema.prisma:2812` |
| Trade economics | `CtmTrade` has buyer/seller, `tokenAmount` Decimal(28,8), `pricePerUnit`, `fiatAmount`, `paymentCurrency` (PKR/USDT), `usdtAmount`, `platformFeePkr/Usdt`, `completedAt`, status enum with `disputed`, `dispute_resolved`, `expired`. One trade = one fill (no partial-fill rows seen yet). | `schema.prisma:3016` |
| Decimal handling | Backend: Prisma `Decimal` (decimal.js) already used in CTM services. **Frontend has no decimal library**; wallet page uses `parseFloat/toFixed`. | `ctm.listing.service.ts:154,216` |
| Charts | No chart library in `frontend/package.json`. | `frontend/package.json` |
| Tests | Frontend: `node --test` on three `.mjs/.mts` files, no component/DOM test runner, no Playwright. Backend: vitest, 35 test files. | `frontend/package.json` scripts |
| Service worker | No fetch caching of documents/APIs; only `/offline.html`. Authenticated finance endpoints are not cached today. Good baseline; Phase E must not weaken it. | `frontend/public/sw.js` header |
| Logos | `EntityLogo` resolves by `type`/`slug` (and optional `logoUrl`). It must **not** be used for custom tokens (rule 7: no logo fetches). | `components/ui/EntityLogo.tsx` |

## 2. Issues / risks for this change

| # | Severity | Issue | Consequence | Remediation |
|---|---|---|---|---|
| 1 | High | Tab hidden for users without funds (`showBalanceTab`). Brief wants a Portfolio tab for everyone, including users who never traded or deposited. | Portfolio would be invisible to exactly the "never traded on RupChain" users. | Always render the tablist; show the custody wallet section inside Portfolio only when `showBalanceTab` is true (keeps the "deposits off for new users" product decision). |
| 2 | High | Hash links `/wallet#payment-methods` rely on default tab. If Portfolio were default, or the user last used it, they would land on the wrong tab. | Breaks existing deep links from listings/ads/CTM. | Keep `methods` as default; add `useEffect` mapping `#payment-methods`→methods and a new `#portfolio` (plus optional `?tab=`) →portfolio; sync tab to hash. |
| 3 | Medium | Internal id `'balance'` / label "Balance & deposits" appear in state only (not persisted, not referenced elsewhere). | Safe to rename id to `portfolio`; accept legacy `#balance` as alias. | Rename label + id, alias old hash. |
| 4 | Medium | Tab buttons lack `aria-controls`, `tabIndex` roving, arrow-key handling, and panels lack `role="tabpanel"`. | Fails the keyboard/mobile navigation requirement. | Implement WAI-ARIA tabs pattern; Back-to-portfolio focus return. |
| 5 | Medium | `wallet/page.tsx` is 1,886 lines. | Embedding portfolio inline would worsen it. | Portfolio lives in new `components/portfolio/*`, imported lazily into the tab. |
| 6 | Medium | No frontend decimal lib; `parseFloat` unsuitable for cost basis. | Spec forbids float math for financial values. | Phase A calc engine runs server-side with `Prisma.Decimal`/decimal strings; frontend only renders strings (or adds a small decimal lib if client-side preview is needed — decision requested). |
| 7 | Medium | No chart lib; no DOM test runner. | Required tests (tab placement, keyboard nav, safe rendering, no remote requests) need infrastructure. | Add `@testing-library/react` + `jsdom` (or Playwright) as dev deps — needs approval. Charts can be inline SVG initially. |
| 8 | Info | `CtmTrade` completion alone is not proof both legs settled (status includes `dispute_resolved`, manual flows). | Ingestion eligibility must be defined from settlement workers, not `status='completed'`. | Phase B only; see "Still to do". Phase A has no ingestion, so no risk now. |

No hypothesis in this document is a claim about the earlier "delivered but admin disagrees" incident; it was not investigated here.

## 3. Proposed approach for the corrections (Phase A scope, frontend + minimal backend)

**Tabs.** Always show `Payment methods | Portfolio` (never a third tab, nothing added to global nav). Default stays `methods`. Hash/`?tab=` compatible as in issue 2.

**Portfolio tab layout (top to bottom):**
1. "RupChain wallet" section — the *existing* balance cards, Deposit/Withdraw, RecentDeposits, transactions, unchanged code and data source, labelled as spendable custody balance. Shown under the same `hasFunds || isMaker` gate as today.
2. "Tracked portfolio" — analytical overview (separate API, separate totals; no sums across the two).
3. Token detail replaces the overview inside the same tab with a **Back to portfolio** button; tab stays selected; focus returns to the originating row.
4. Transaction history + entry forms inside the tab (dialogs/inline panels).

**Custom token data model** (new, non-destructive migration, user-scoped; Phase A):
`portfolio_asset_ref(id cuid, userId, name VARCHAR(80) NOT NULL, symbol VARCHAR(16) NULL, sourceUrl VARCHAR(2048) NULL, network NULL, contractAddress NULL, ctmTokenId NULL, createdAt, updatedAt)`; no unique constraint on name/symbol/url, so same name never silently merges. Quantities/transactions reference `id` only; metadata edits touch only this row.

**Validation (shared client+server, zod already present):** trim + NFC-normalize name, 1–80 chars, strip control/bidi characters; symbol optional, ≤16, same cleaning; URL via `new URL()`, protocol must be `http:`/`https:`, no `username/password`, ≤2048, stored as given (never fetched). Rendering: React text nodes only, `rel="noopener noreferrer nofollow"` on links, no `dangerouslySetInnerHTML`; source shown as text with hostname, link opens only on explicit user click. Monogram: deterministic initials + hash-based neutral tint, pure CSS/SVG, zero network.

**Privacy:** source URL stored only in the portfolio table behind the portfolio permission; excluded from analytics/PostHog payloads and from any admin interest aggregate (aggregates, if ever built, use reviewed canonical ids only).

**Tests (matching correction #8):** component tests for tab placement/order, hash back-compat, wallet+payment flows still mounted, roving-tabindex keyboard nav, 360px layout; form tests for name-only creation, optional URL, scheme rejection (`javascript:`, `data:`, `vbscript:`, credentials), hostile name rendering as text, network spy asserting zero fetches from custom-token creation/render, metadata edit leaving quantities/lots/P&L fixtures byte-identical; plus the spec's FIFO fixtures (MEC 100 @ 1,000 → realized 11,200 etc.) on the backend engine.

## 4. Still to do before ingestion / calculation phases
- Read settlement + reconciliation workers, `Transaction` finalization, gas orders, manual payout paths; produce the eligibility matrix.
- Confirm where the public CTM prices come from (listings vs settled trades vs manual).
- Auth/tenant-isolation pattern in backend routes (for portfolio ownership checks).
- Redacted aggregate dry-run counts (needs approved read access).

## 5. Rough phasing (assumptions: one engineer, staging available)
A (this correction set + calc engine + manual tracker): the largest chunk; split into A1 UI shell/tab/hash/a11y + custom-asset form with frozen fixtures, A2 backend schema + FIFO engine + APIs. B–E unchanged from the spec and not started.

## 6. Blockers / decisions needed
See the message accompanying this audit.
