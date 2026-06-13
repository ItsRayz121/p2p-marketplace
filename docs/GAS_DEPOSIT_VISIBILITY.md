# Gas Hot-Wallet — Incoming Transaction Visibility

What shows up for admins when funds land in a gas hot wallet, and what does not.

## Two detection systems

1. **Payment poller** (`gasPaymentPoller.job.ts`, ~60s) — scans the configured
   payment networks (BEP20, ERC20, TRC20, APTOS) for incoming **USDT** to the gas
   deposit address and attributes it to an order.
   - Matched → order moves to `payment_detected`, an `order_payment` ledger row is
     written, delivery is auto-queued. Visible in **Wallet Activity**, the order
     detail + audit journal, and Dashboard totals.
   - No matching order → **parked as "unattributed"** and shown at
     `/admin/gas/flagged`. (Scans only while there are pending/recently-expired
     orders on that network.)

2. **Hot-wallet deposit balance-diff poller** (`gasHotWalletDepositPoller.job.ts`,
   ~2 min) — for each hot wallet it diffs the **native** balance and the **configured
   non-native token** balances, recording increases as `external_hot_wallet_deposit`
   ledger rows. This is the safety net for direct top-ups (admin funding, etc.).
   - Covers every `GasHotWallet` row (TRON, BSC, ETH, BASE, ARB, OP, MATIC, AVAX,
     SOL, TON, SUI) **and** the Aptos hot wallet (handled explicitly — Aptos has no
     `GasHotWallet` row). For Aptos USDT/USDC the increase is reconciled against
     recent `order_payment` rows so order payments aren't double-counted.

## Visibility matrix

| Incoming | Tracked? | Where |
|---|---|---|
| Native coin to any gas hot wallet (incl. APT) | ✅ | Wallet Activity, live wallet view |
| **Configured** token (USDT/USDC) to any gas hot wallet | ✅ | Wallet Activity, live wallet view |
| USDT payment matching an order | ✅ | order_payment + order detail/audit + Wallet Activity + Dashboard |
| USDT payment with no matching order | ✅ | `/admin/gas/flagged` (Unattributed) |
| **Unlisted / unknown** token to any wallet | ❌ | Not tracked (see below) |

## Why unlisted tokens are not auto-tracked

Listing *every* token that could ever be sent to a wallet would require a per-chain
indexer/explorer API (with API keys) — public RPC nodes cannot enumerate "all token
transfers to an address," and the previous Moralis path is retired. We deliberately
track only the **native coin + the tokens configured for each chain** (the assets we
actually accept/deliver), which covers all real operational flows.

**Workaround for a one-off unlisted-token deposit:** a super-admin can record it via
the manual ledger entry tool (`POST /admin/gas/wallet-activity/manual`, surfaced on
the Wallet Activity page). To track a token going forward, add it under
`/admin/gas/chains` for that chain — it then appears automatically.
