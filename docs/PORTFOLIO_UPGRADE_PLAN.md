# RupChain Portfolio Upgrade: brief, decisions and progress tracker

Keep this file current. Tick a step only after its in-depth cross-check is done.

## Owner decisions (final)
1. Platform price used for valuation: only from trades the import itself accepts as proven (not auto-completed, admin-forced, disputed, unverified on-chain). Show its age; mark stale.
2. Manual records can be edited, with a full revision history. Imported (ctm) records stay read-only.
3. Per-record price source choice: "RupChain price" or "Price I got" (own price). Already agreed.
4. No invented cost bases. Unknown stays unknown. Use short, neutral wording that says "not known yet" (not "unknown cost" jargon, not 0).
5. "Total Tracked Assets" = active (non-archived) tokens with quantity above zero... plus show total token count in the note.
6. Execute all steps in order, cross-check each in depth, then commit + push to `main` once at the end (owner pre-approved; no further questions).

## Steps and status
- [x] 1. Unknown-vs-zero: tri-state values in summary API + UI (PortfolioHeadline, token rows). Mirror in frontend/src/lib/portfolio/engine.
- [x] 2. Platform price rule: restrict to proven trades, add observedAt/age/stale flag, stale warnings in UI.
- [x] 3. Edit manual records with revision history (new table, PATCH endpoint, UI, oversold warning on delete/edit).
- [x] 4. Excluded-trade review + duplicate guard (linkedTradeRef on manual entries, read-only excluded list endpoint, "Record manually" prefilled).
- [x] 5. Dashboard: 4 summary cards (Estimated Value, Realized, Unrealized, Total Tracked Assets), "Needs attention" action center, token cards, portfolio-wide transaction history (search/filter/pagination), price-source toggle in the record form.
- [x] 6. Analytics: metric renames, clearer chart empty states with actions, accessible tables kept, tests, final regression, commit + push.

## Rules carried from the brief
- Analytical only: never touch Wallet, Transaction, escrow, deposits, withdrawals, gas fee delivery, disputes.
- Keep navigation: Wallet & Payment Methods > Payment methods | Portfolio. No new top-level nav.
- Never show 0 for unknown. Distinguish genuine zero / unavailable.
- FIFO unchanged in method; decimals only; historical fx rate per record.
- Frontend engine (frontend/src/lib/portfolio/engine) is a copy of backend/src/lib/portfolio: change both, parity tests must pass.
- Additive, reversible migrations only. Do not edit historical production data.
- Do not add cloud services or paid APIs. NASB Cloud is not referenced anywhere in the repo.
- Preserve CSV export, JSON backup export/import, offline/local mode.
- Custom tokens: name required; symbol/website/network/contract optional; no logo fetching; a website is not identity.

## Original brief (verbatim summary of sections)
1. Audit existing project first (done: see audit in chat; infra = Railway backend, Vercel frontend, Cloudflare, Redis via REDIS_URL, Postgres via Prisma; no NASB Cloud).
2. Overview: Estimated Portfolio Value, Known Realized P/L, Unrealized P/L, Total Tracked Assets; PKR with PKR/USDT control; labels "Value Unavailable", "Cost Basis Incomplete", "Return Unavailable"; genuine zero stays zero.
3. "Portfolio Needs Attention": missing prices, incomplete acquisition history, sales exceeding recorded quantity, excluded/unsettled trades, missing cost basis, stale valuations; actions Add Price / Add Opening Holdings / Review Excluded Trades / Review Transaction History. Never auto-create entries. Excluded trades (completed/closed/disputed alone never prove settlement) can be reviewed and recorded manually without touching marketplace records; no double counting.
4. Token cards/table: name, symbol, quantity, price + currency, value, average cost when known, realized, unrealized, price status + updated time; initials placeholder; contextual actions (View Details, Add/Update Price, Record Buy/Sell, Add Opening Holdings, View History). Preserve custom-token workflow.
5. Calculations: keep FIFO; fees; partial sales; lots; historical fx; opening holdings; oversold warning; decimal precision; manual prices with price, currency, timestamp, optional source; stale warnings; no fabricated prices.
6. Results over time: keep 7D/30D/90D/All/Custom; metrics Known Realized P/L, Buy Costs + Fees, Sales Proceeds After Fees, Portfolio Value Change After Cash Flows, % Return only when supportable; charts with empty states, no fabricated zero history; table views kept; no new chart dependency.
7. Wallet safety: portfolio never changes spendable balances or authorizes anything.
8. History: date, token, buy/sell, quantity, unit price, fees, total, source, status; search/filter/pagination; manual vs imported separated; corrections keep provenance; keep CSV/JSON export + import with validation; keep offline.
9. UI: modern fintech, compact cards, responsive, accessible, tooltips, existing design system.
10. Security: server-side isolation, validation, transactions, race/duplicate review, safe logs, indexes, pagination, no new infra.
11. Tests: FIFO, fees, partial, unknown/zero cost, missing/stale prices, fx, excluded trades, idempotent import, duplicates, openings, wallet separation, authorization, JSON integrity, charts with incomplete data, responsive, regression.
12. Process: audit -> plan -> approval (given) -> implement in order -> report.

## Completion notes (2026-10-16)
All six steps are implemented, cross-checked and covered by tests (backend unit 476, frontend 382, typecheck and lint clean, production frontend build passes).

Known limits, by design:
- Correcting an entry and recording a left-out trade need a connection; they are not queued offline (a queued edit could collide with a newer version; the server uses a conditional update to prevent silent overwrites).
- Backups (JSON/CSV) keep the price basis but not the edit history, edit time or trade link. Restoring a backup re-creates entries as plain manual entries.
- The value-over-time chart uses prices you entered plus proven RupChain trade prices of linked tokens (last 200 trades); older dates stay blank, never estimated.
- Platform trade prices are cached in memory for 60 seconds per token.
- Visual/responsive layout was checked structurally (grid, scrollable tables), not in a real browser.
