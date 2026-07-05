# Phase 1 — Taker-First BUY-Ad Settlement (implementation spec)

Status: **foundation shipped, reflow NOT built.** Do not flip
`taker_first_settlement_enabled` for a market until that market's reflow is built
AND end-to-end QA'd on staging, then flip its readiness in
`settlementMode.service.ts` (`TAKER_FIRST_MARKET_READY`).

## Goal

The taker (party responding to an ad/listing) always transfers their leg FIRST;
the maker (ad owner, always KYC'd) moves second — in both directions.

- **SELL ad** (maker sells crypto, taker buys): taker pays fiat first → already
  taker-first today. **No change.**
- **BUY ad** (maker buys crypto, taker sells): today the maker pays fiat first.
  **Flip** so the taker sends crypto first, then the maker pays fiat.

## What's already in place (foundation)

- `taker_first_settlement_enabled` flag + `isTakerFirstForMarket(market)` gate
  (flag AND per-market readiness). All buy-side callers use the per-market gate.
- `Trade.takerFirst` / `CtmTrade.takerFirst` (migration `20260705140000`), stamped
  at creation = `isBuyAd && isTakerFirstForMarket(market)`. Always false today.
- Phase 2 buy-side no-KYC already keys off the same gate, so it activates in
  lockstep only once a market is ready.

## The reordered flow (BUY ad, takerFirst = true)

Four actions; same five status values, reordered by role/artifact:

| status transition        | classic (fiat-first)          | taker-first (buy ad)              |
|--------------------------|-------------------------------|-----------------------------------|
| pending → uploaded       | buyer sends FIAT + proof      | seller(taker) sends CRYPTO + tx   |
| uploaded → confirmed     | seller confirms FIAT          | buyer(maker) confirms CRYPTO recv |
| confirmed → crypto_sent  | seller sends CRYPTO (+verify) | buyer(maker) sends FIAT + proof   |
| crypto_sent → released   | buyer confirms CRYPTO recv    | seller(taker) confirms FIAT       |

**Critical:** on-chain verification (currently in `markCryptoSent`) must move to
the CRYPTO-send action — which in taker-first is the FIRST transition
(pending→uploaded), not the third. Keep verification attached to the action, not
the status name.

## Build checklist

Backend — **USDT DONE + inert** (`trade.service.ts`); CTM remains (`ctm.trade.service.ts`, 6-status ladder — needs its own flow model):
- [x] Flow resolver — `settlementFlow.ts` + 11 passing tests. Actor-invariant.
- [x] **USDT** transitions reworked through the resolver (status guards + terminality
      flow-derived; actor checks unchanged since invariant); verification rides the
      `send_crypto` action (→ moves to step 1 in taker-first). Commit `b4247f0`.
- [x] **USDT** completion extracted to `finalizeUsdtTrade` (terminal is always
      crypto_sent→released; caller authorizes actor). Fires from `releaseTrade`
      (classic) or `confirmPayment` (taker-first).
- [x] **USDT** dispute-lock recomputed (locks whoever confirmed the counterparty's
      leg — classic seller / taker-first buyer) + abandon penalty hits the real
      first mover. Commit `62d1b57`.
- [ ] **CTM** equivalent (its ladder has separate seller_transferring/proof_submitted
      steps → a 5-action, 6-status flow model, not the USDT 4/5 one).
- [ ] Bond on taker-first buy ads (currently skipped on buy ads) — revisit.

Frontend (`(platform)/trade/[id]/page.tsx` and CTM twin) — **REMAINING; needs a
running app**. The page is built as fixed StepCards (Step 1 Payment → 2 Confirm →
3 Crypto) with actions nested inside each card, so taker-first requires
restructuring/relabeling the cards per flow, not just swapping conditions. The
backend is authoritative on order, so this is presentation only — but it's shared
with classic trades and must be visually QA'd. Gate ALL taker-first UI on
`trade.takerFirst` so the classic render path is untouched.

Rollout:
- [ ] Build CTM backend + the frontend (both pages), gated on `takerFirst`.
- [ ] QA all steps end-to-end on staging for a buy ad (both markets), incl.
      dispute + expiry, with the flag ON and readiness true for that market only.
- [ ] Flip `TAKER_FIRST_MARKET_READY[market] = true`, deploy, then flip the flag.
