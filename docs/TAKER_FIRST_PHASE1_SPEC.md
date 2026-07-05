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

Backend (both `trade.service.ts` and `ctm.trade.service.ts`):
- [ ] A flow resolver: given `trade.takerFirst` + side, return per-transition
      `{ actorRole, action: 'send_fiat'|'confirm_fiat'|'send_crypto'|'confirm_crypto' }`.
- [ ] Rework each transition fn to authorize the acting party from the resolver
      (not hardcoded buyer/seller), store into the right field (fiat proof vs tx),
      and run verification on the `send_crypto` action wherever it lands.
- [ ] Opening system message + `notify()` wording per flow.
- [ ] Dispute windows (`sellerLockedStatuses`) recomputed for the reordered flow.
- [ ] Expiry/auto-cancel semantics: in taker-first the first mover is the taker
      sending crypto — decide the abandon/cooldown target accordingly.
- [ ] Bond: on a buy ad in taker-first, revisit whether the maker bond applies
      (currently skipped on buy ads).

Frontend (`(platform)/trade/[id]/page.tsx` and CTM twin):
- [ ] A mode-aware step resolver so each status shows the right instruction +
      button for the right party (34 status branches today assume fiat-first).
- [ ] Status badge labels: neutralize "Awaiting Payment"/"Crypto Sent" or vary by
      `takerFirst` so they read correctly for a crypto-first flow.

Rollout:
- [ ] QA all four steps end-to-end on staging for a buy ad (both markets), incl.
      dispute + expiry, with the flag ON and readiness true for that market only.
- [ ] Flip `TAKER_FIRST_MARKET_READY[market] = true`, deploy, then flip the flag.
