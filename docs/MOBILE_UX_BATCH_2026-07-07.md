# Mobile / UX Batch — 2026-07-07

Short-term tracking file for the production issue batch reported by the user.
Delete once all phases are shipped + cross-checked.

Legend: [ ] todo · [~] in progress · [x] done+committed · [Q] needs user decision

Overarching goal on EVERY item: mobile/tablet responsiveness, equal box sizing,
equal vertical/horizontal spacing, one-line-where-possible, collapse long sections,
consistent wording, show logos, copy buttons where an address/number is shown.

---

## Phase 1 — CTM listing cards (marketplace list + detail)  ✅ COMMITTED
- [x] 1a. `ctm/page.tsx` card: USDT value shown alongside `PKR 430` (desktop + mobile).
- [x] 1b. Card payment methods: PKR + USDT chips both shown.
- [x] 1c. `ctm/listings/[id]/page.tsx`: title now flex-1 min-w-0 (no more 1-word-per-line); logo→xl, badge/share stay top-right.
- [x] 1d. Listing detail price header shows USDT ≈ alongside PKR.
- NOTE: a prior session already built the CTM hybrid PKR+USDT rails end-to-end (create/detail/trade + backend) and removed CTM taker KYC; landed together in this commit.

## Phase 2 — USDT marketplace price chart (`marketplace/page.tsx`)  ✅ COMMITTED
- [x] 2a. Chart collapsed by default; collapsed = single "USDT price chart" line (PKR value/% hidden until opened).
- [x] 2b. Added mb-4 gap between Price Chart box and Recent Trades ticker.

## Phase 3 — Address / number / value formatting (USDT + CTM trade pages)  ✅ COMMITTED
- [x] 3a. USDT Send Crypto UID/address now stacks full-width (label above, bordered box, copy inline) — no vertical column.
- [x] 3b. Wallet address + tx hash full-width boxes (wrap 1-2 lines); On-chain verified + explorer link flow left-aligned below.
- [x] 3c. CTM Row breakAll values (buyer address, IBAN, USDT address) now stack full-width.
- [x] 3d. Copy icon moved IN FRONT of value; "Mobile number" → "Payment number" (both trade pages).
- [x] 3e. "Account / Payment Number" → "Payment number" (CTM); inline rows use items-center (no collision).

## Phase 4 — CTM create-listing USDT payment layout (`ctm/listings/create/page.tsx`)
- [ ] 4a. Internal/Exchange transfer (6 chips): equal size, equal spacing, grid-aligned (not random widths).
- [ ] 4b. Wallet/Blockchain: USDT BEP20 + Aptos as equal half-width boxes; fix missing logos.
- [ ] 4c. Rename exchange methods to "Binance / OKX / Bitget / Gate / MEXC / Other" (it's internal transfer, not "USDT Binance") — also fixes logo lookups.

## Phase 5 — Listing overview payment display (both PKR + USDT) (both detail pages)
- [ ] 5a. Ad overview shows only one payment currency → show BOTH. "Payment Methods" → horizontal dropdowns: [PKR methods] [USDT methods → Exchange/Internal + Blockchain]. Collapse by default.
- [ ] 5b. Consistent naming + logos in these dropdowns.

## Phase 6 — Trade modal method organization + progress bar
- [ ] 6a. "Where will you send USDT?" long option list → group Exchange vs Blockchain, collapsible when >3. Consistent wording. (USDT + CTM start modals.)
- [ ] 6b. Fix half-hidden collapsible buttons.
- [ ] 6c. CTM trade progress bar: 5th step "Tokens Received" is cut off / outside the box → make it fit (responsive / scroll).

## Phase 7 — CTM in-trade chat bubbles (`ctm/trade/[ref]/page.tsx`)
- [ ] 7a. CTM trade chat: my messages right, other person left (like USDT chat). Name shown.

## Phase 8 — Persistent messaging [Q]
- [Q] 8a. Flip `messaging_inbox_enabled` ON (gives the persistent "chat anytime" + Messages tab). LIVE PROD decision.

## Phase 9 — KYC gating [Q]
- [Q] 9a. Only ad creators need KYC; takers don't. Maps to `nokyc_taker_enabled` + admin caps. Money-safety nuance: buy-side taker-moves-second is intentionally still gated.
- [ ] 9b. "Trading without verification" big box → tiny line / move just above Buy/Sell button / collapse.

## Phase 10 — Final cross-check + cleanup
- [ ] Re-verify every phase against a running build; delete this file.

---
### Workflow
One commit per phase to `main` (auto-deploys Railway + Vercel). Cross-check each
phase before committing; do not pause between phases. Frontend + backend typecheck
must pass per CLAUDE.md.
</content>
</invoke>
