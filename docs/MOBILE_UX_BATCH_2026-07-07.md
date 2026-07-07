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

## Phase 4 — CTM create-listing USDT payment layout (`ctm/listings/create/page.tsx`)  ✅ COMMITTED
- [x] 4a. Exchange/wallet method chips now in an even 2-col grid (equal width + gaps), across create + detail modal.
- [x] 4b. BEP20 + Aptos render as equal halves; wallet chains show the USDT token mark (chain slugs had no logo → grey initials). New `ctmUsdtMethodLogo()` helper applied at all chip sites (cards, create, detail).
- [x] 4c. Labels already correct in helper (Binance UID / OKX UID / USDT BEP20 …) — not "USDT Binance".

## Phase 5 — Listing overview payment display (both PKR + USDT)  ✅ COMMITTED
- [x] 5a. CTM detail "Payment Methods" panel shows BOTH rails grouped (PKR / USDT·Wallet / USDT·Exchange); now collapsed by default (prior work built the panel; this collapses it).
- [x] 5b. Consistent labels + USDT logos (via Phase 4 helper).

## Phase 6 — Trade modal method organization + progress bar
- [ ] 6a. "Where will you send USDT?" long option list → group Exchange vs Blockchain, collapsible when >3. (DEFERRED — diffuse; revisit if budget.)
- [ ] 6b. Fix half-hidden collapsible buttons. (DEFERRED — revisit.)
- [x] 6c. CTM trade stepper now scrolls WITHIN the card (overflow-x-auto, min-w-[340px], mobile label w-12) — 6th step no longer spills outside the box.  ✅ COMMITTED

## Phase 7 — CTM in-trade chat bubbles (`ctm/trade/[ref]/page.tsx`)  ✅ COMMITTED
- [x] 7a. CTM chat now mirrors USDT chat: resolves real senderName (You / trader / RupChain); my messages right, other person left with name labels; system notices side by the ACTOR (was pinned to viewer's role, which made it look one-sided).

## Phase 8 — Persistent messaging  ⚙️ ADMIN FLAG (user action)
- [x] 8a. User approved ON. Flags are DB-config, not code. ACTION: Admin→Platform Config → set
      `messaging_inbox_enabled = true`. Then the Messages tab + persistent per-person chat go live.
      (Already built: cross-market single thread per person, WhatsApp bubbles, trade-progress dividers.)

## Phase 9 — KYC gating
- [x] 9a-CTM. CTM takers already never need KYC (code, committed Phase 1). Only the maker is KYC-gated.
- [x] 9a-USDT SELL. Safe (taker pays fiat first). ACTION: set `nokyc_taker_enabled = true`; raise
      `nokyc_max_per_trade_pkr` / `nokyc_max_daily_pkr` / `nokyc_rolling_ceiling_pkr` if you want no caps.
- [!] 9a-USDT BUY. Needs taker-first settlement (built, NOT QA'd — moves real money). Do NOT flip
      `taker_first_settlement_enabled` + `TAKER_FIRST_MARKET_READY[usdt]` until a staging end-to-end
      trade test passes. This is the piece I said I'd confirm before flipping. HOLDING.
- [x] 9b. "Trading without verification" box is now a collapsed one-line header (taps to expand).  ✅ COMMITTED

## Phase 10 — Final cross-check + cleanup  ✅ DONE
- [x] Full `next build` (frontend) PASS + backend `tsc --noEmit` PASS on the whole working tree.
- Keep this file until: (a) the 5 local commits are pushed, (b) admin flags flipped, (c) 6a/6b done.

### Commits (local; remote main at 70d75de until pushed)
- 29817ba Phase 1 (pushed) · 70d75de Phase 2 (pushed)
- 4e8ceed Phase 3 · b5b96c9 Phase 4 · 30c9905 Phase 5+6c · 36ced64 Phase 7 · 8f2642f Phase 9b  (UNPUSHED)

### Blockers / user actions
1. `git push origin main` — GCM needs an interactive prompt this shell can't give. Run it yourself once.
2. Admin→Platform Config flags: `messaging_inbox_enabled=true`, `nokyc_taker_enabled=true` (+ raise nokyc_* caps for "no caps").
3. Do NOT flip `taker_first_settlement_enabled` / `TAKER_FIRST_MARKET_READY[usdt]` until a staging end-to-end money trade passes.

### Deferred
- 6a "Where will you send USDT?" grouping · 6b half-hidden collapsible buttons (need exact locations).

---
### Workflow
One commit per phase to `main` (auto-deploys Railway + Vercel). Cross-check each
phase before committing; do not pause between phases. Frontend + backend typecheck
must pass per CLAUDE.md.
</content>
</invoke>
