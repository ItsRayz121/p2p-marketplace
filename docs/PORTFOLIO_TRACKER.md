# Portfolio corrections v2 â€” tracker

Workflow: build phase â†’ cross-check phase â†’ next phase â†’ â€¦ â†’ one in-depth cross-check of everything â†’ fix â†’ single commit + push.
Status: [ ] todo Â· [~] in progress Â· [x] done and cross-checked

## Corrections (verbatim from RupChain_Portfolio_Corrections_v2.md)
1. Keep the existing Wallet & Payment Methods page and main navigation. Rename its Balance & deposits tab to Portfolio, beside Payment methods. Do not add Portfolio to the global navigation or create a third local tab. Keep the existing route and deep links compatible.
2. Put the complete portfolio overview, token-level detail, transaction history, and entry forms inside that Portfolio tab. Token detail needs a Back to portfolio control; the Portfolio tab stays selected.
3. Preserve the existing spendable RupChain balance and Deposit/Withdraw controls in a clearly labeled wallet section inside the renamed tab. Custody balances and analytical holdings remain separate data/permission domains; do not duplicate or merge their totals. Payment methods remains unchanged.
4. For Add custom token, require a user-entered Token name. Show: "Copy the exact token name from its official website or another trusted source." Symbol/ticker is optional for manual-only tracking. Generate a neutral initial-based icon when no canonical logo exists.
5. Add Official website / source as an optional field. Show: "Helps identify similarly named tokens. Leave blank when unsure. A link does not verify the token." Do not block creation when it is empty. Network/contract details can be progressively disclosed when known; unknown identity remains manual-only.
6. Save the name, optional symbol/source, and applicable identity fields under a stable user-scoped asset ID. Display the name consistently. Editing metadata must not change quantities, existing transactions, cost basis, or P&L. Same name/symbol/URL must not silently merge assets.
7. Validate and render custom input safely. Accept http/https source URLs without embedded credentials; reject executable URL schemes. Do not fetch websites/logos/favicons, claim verification, auto-list assets, or opt users into analytics. Keep source metadata private under existing purpose-specific permissions.
8. Add tests for the local tab placement, preserved wallet/payment flows, mobile/keyboard navigation, name-only custom creation, optional URL handling, safe text rendering, no remote requests, stable metadata edits, and unchanged financial fixtures.

## Phases
### P1 â€” Tab shell (corrections 1, 2 shell, 3)
- [x] Test tooling (vitest + jsdom + RTL) in frontend
- [x] Tabs always visible; `Payment methods | Portfolio`; default Payment methods
- [x] Hash/`?tab=` compatibility (`#payment-methods`, `#portfolio`, legacy `#balance`)
- [x] Accessible tabs (roving tabindex, arrows, tabpanel roles)
- [x] Existing wallet section moved intact under "RupChain wallet" heading, same gate
- [x] Portfolio container with overview / token-detail (Back to portfolio) / history / entry panels
- [x] Global nav untouched
### P2 â€” Validation + safe rendering (4, 5, 7)
- [x] Shared zod schema: name, optional symbol, optional http/https URL w/o credentials
- [x] Monogram icon (no network)
- [x] Add custom token form with required copy texts, progressive network/contract disclosure
- [x] Safe text rendering, no remote requests
### P3 â€” Backend storage (6, 7 privacy)
- [x] Non-destructive migration: user-scoped asset ref table, no unique on name/symbol/URL
- [x] CRUD API with ownership checks + server-side validation
- [x] Metadata edit touches only the asset row
- [x] Frontend wired to API
### P4 â€” Financial integrity fixtures (8)
- [x] FIFO fixture tests (spec Â§10.1) unchanged by metadata edit
- [x] Aggregate fixture (Â§10.13) with partial-data warning for unpriced custom asset
### P6 — Transactions, history, overview numbers (correction 2 remainder)  [added after cross-check found the gap]
- [x] Schema + additive migration: PortfolioEvent (BUY/SELL/OPENING), PortfolioPriceObservation (manual marks)
- [x] API: list/record/delete manual events (idempotent client id), record price, summary via FIFO engine
- [x] Overview: priced holdings, realized, unrealized, total known; partial-data warnings; holdings rows
- [x] Token detail: position numbers, history table, Record buy / sell / opening form, update price
- [x] Tests: API (ownership, validation, idempotency), UI (forms, partial warnings), engine fixtures through the API
- [x] Limitation to disclose: PKR only; USDT quote + FX, transfers, other fee assets, charts deferred
### P5 â€” Tests (8) and final in-depth cross-check
- [x] Tab placement, preserved wallet/payment flows, keyboard/mobile
- [x] Name-only creation, optional URL, scheme rejection, hostile text, zero fetches
- [x] typecheck + lint + build (frontend, backend); backend tests
- [x] Full review of all diffs against all 8 corrections
- [x] Commit + push, report hash/build status/auto-deploy

## Round 2 — remaining scope (approved: build in order, cross-check each, one final review, then commit + push)
### P7 — PKR / USDT switch
- [x] Per-record currency + exchange rate stamped from the platform `rate_USDT_PKR` (user can override); price marks carry a currency
- [x] Summary in PKR or USDT: each record converted at ITS OWN rate; missing rate => asset excluded + flagged, never today's rate
- [x] UI: currency switch, record form currency/rate, labels follow currency
### P8 — Archive / delete tokens
- [x] Delete only when a token has no records; otherwise archive (history + realized P&L kept); unarchive; archived hidden by default
### P9 — Charts and time periods
- [x] Periods: this month, 7D, 30D, 90D, all time, custom; realized-in-period, money in/out; value only where genuinely priced (gaps, no interpolation)
- [x] Accessible SVG charts with data-table fallback; percentage return shown unavailable unless valid
### P10 — Import RupChain trades (read-only)
- [x] Settlement eligibility from the real CTM completion path; ineligible/pending shown as "needs attention", never imported
- [x] Idempotent import keyed by trade id; auto-creates linked token; imported records read-only; later reversal => voided, not deleted
### P11 — CSV export
- [x] CSV with formula-injection protection; versioned JSON backup
### P12 — Optional listing interest (admin, aggregate only)
- [x] User consent + withdraw; identity = network+contract; admin sees only groups >= threshold, bucketed, audited
### P13 — Guest / offline (spec phase E)
- [x] Shared decimal engine in the browser; local-only guest tracker (IndexedDB), encrypted backup, explicit migration to account
- [x] Signed-in offline: last-saved view with timestamp, queued analytical edits (idempotent), cleared on logout
### P14 — Feature flag (default ON, kill switch)
### P15 — Final in-depth cross-check of everything, then ONE commit + push
## Log
- 2026-10-16: audit written (docs/PORTFOLIO_AUDIT.md); plan approved by user.
- 2026-10-16: P1 (tab shell) and P2 (validation, monogram, form) built and cross-checked: 51 UI tests pass, tsc clean. Not pushed yet by design.
- 2026-10-16: P3 (storage+API, 24 backend tests) and P4 (FIFO engine, all spec fixtures match, 29 tests) done. Cross-check found correction 2 incomplete (no transaction records/history/forms) -> P6 added. Build, bundle budget and 45 legacy tests pass.
- 2026-10-16: P6 done (events API + engine summary, entry/history/price forms, overview numbers). Final cross-check: FE 82 UI tests + 45 legacy pass, BE 92 unit tests pass, both tsc clean, next build OK, wallet bundle 177/190 KB, Prisma-generated SQL == hand-written migrations (additive only). Real-browser pass and staging migration NOT done (no DB/login available locally).
- 2026-10-16: Round 2 complete (P7-P14) and final cross-check done: FE 293 UI + 45 legacy tests, BE 372 unit tests, both tsc/eslint clean, next build OK, wallet bundle 170/190 KB, migrations == Prisma-generated diff (18 additive ops). Cross-check fixes: label/number mismatch during currency switch, focus loss after closing a form, emoji-initial bug, price-history cap, same-request-id race, hostile backup validation, stray empty files removed. NOT verified: real browser, real database (migrations and the CTM import queries ran only against mocks / Prisma-generated SQL).
