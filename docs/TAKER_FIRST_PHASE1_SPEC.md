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

Backend — **USDT DONE + inert** (`trade.service.ts`); **CTM DONE + inert** (`ctm.trade.service.ts`, via its own 5-action/6-status `ctmSettlementFlow.ts`):
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
- [x] **CTM** equivalent — its own 5-action/6-status resolver `ctmSettlementFlow.ts`
      (11 tests). All five CTM transitions (`uploadPaymentProof`/`confirmPayment`/
      `markSellerTransferring`/`uploadTokenProof`/`confirmReceipt`) route through the
      resolver; completion extracted to `finalizeCtmTrade` (terminal is always
      `proof_submitted→completed` in both flows — fired by the buyer's confirm_crypto
      in classic, the taker's confirm_fiat in taker-first); dispute-lock derived from
      `ctmDisputeLock` (classic seller / taker-first buyer). Classic byte-identical.
- [x] Bond on taker-first buy ads — RESOLVED (no code change; skip is correct).
      The USDT buy-ad maker is the fiat-paying buyer with no USDT to bond, and
      bonding the taker (crypto first-mover) would only lock the honest party's own
      funds without protecting them. CTM already bonds its maker from the platform
      USDT balance on BOTH sides, so CTM taker-first buy listings ARE bonded.
- [x] CTM jobs (`ctm.jobs.ts`) made flow-aware (inert): `runCtmProofDeadline` now
      derives the pending step from `ctmStepFromStatus(takerFirst, status)` —
      non-terminal missed step → auto-dispute opened by the counterparty (reason
      keyed to the missed actor); terminal missed step → auto-complete if the
      DELIVERING merchant (counterparty of the pending confirmer) is trusted, else
      admin review. Never wrongly releases: the taker-first non-terminal buyer
      confirm (payment_confirmed) is skipped by the terminal branch and escalated by
      the dispute branch instead. `confirmReceipt` sets a maker-fiat deadline in
      taker-first so the buyer's payment step is enforced. Expiry wording flow-aware.
      Classic behavior byte-identical (payment_uploaded/seller_transferring →
      seller dispute; proof_submitted → auto-complete trusting the seller).

Frontend — **DONE + inert (both pages)**. USDT (`(platform)/trade/[id]/page.tsx`)
and CTM (`(platform)/ctm/trade/[ref]/page.tsx`) each render a standalone taker-first
action panel above the StepCards, gated on `trade.takerFirst` and driven by the
frontend flow mirror (`lib/settlementFlow.ts` / `lib/ctmSettlementFlow.ts`). Every
classic StepCard action control is gated with `!trade.takerFirst`, so the classic
render path is byte-identical (takerFirst always false in prod). StepCards still
show order details/proofs in both flows. Panels reuse the existing action handlers —
backend stays authoritative on order.

Rollout:
- [x] Build CTM backend + the frontend (both pages), gated on `takerFirst`.
- [ ] QA all steps end-to-end on staging for a buy ad (both markets), incl.
      dispute + expiry + jobs, with the flag ON and readiness true for that market only.
- [ ] Flip `TAKER_FIRST_MARKET_READY[market] = true`, deploy, then flip the flag.
