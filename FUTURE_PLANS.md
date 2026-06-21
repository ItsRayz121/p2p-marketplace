# Future Plans / Leftover Work — Non-Custodial P2P

Context: the non-custodial P2P rebuild shipped 2026-06-18 (Phases 0–4, 6, 7, 9),
all behind the `noncustodial_p2p_enabled` flag, toggled from
**Admin → Config → Non-Custodial P2P**. Phase 5 (Maker Collateral Bond) has since
shipped (2026-06-19, behind its own `maker_bond_enabled` flag — see below). One
phase (Phase 8) remains deferred, plus a couple of minor UX-polish items. They are
**not blocking** — the platform runs fully without them.

---

## Phase 5 — Maker Collateral Bond — ✅ SHIPPED 2026-06-19

**What it is:** a small, refundable stake ("bond") locked from a maker's
*deposited USDT* when a trade opens. Released on a clean close; **seized to the
wronged counterparty** if the maker loses a dispute. It gives makers
skin-in-the-game and provides partial victim recovery, on top of the existing
identity + reputation + dispute system.

**Status:** built across commits `c62a263`…`95956ea` and live behind the
`maker_bond_enabled` flag (default OFF). Covers BOTH the USDT marketplace and CTM
trades.

**How it works (as built):**
- **Scope:** per-trade. On trade open we lock `ratio% × tradeUsdt` from the
  maker's available USDT into `lockedBalance` (one `BondHold` row per trade,
  unique on `(tradeType, tradeId)`). CTM is priced in PKR, so the bond is computed
  on the USDT-equivalent via `rate_USDT_PKR`; if that rate is missing the bond is
  skipped (fail-open).
- **Asset / custody:** the maker's existing on-platform USDT balance — no new hot
  wallet. The lock is just `lockedBalance`; a seizure debits the maker's
  balance + lock and credits the victim's USDT on the same network, writing
  `bond_seized` / `bond_received` ledger Transactions.
- **Slash flow:** wired into dispute resolution. Maker loses → seize to winner;
  maker wins / split / no-winner close → release. All terminal trade paths
  (complete, cancel, auto-cancel, expire, dispute-resolve, dispute-close) release
  or seize; `disputed` keeps the bond held. Exactly-once + idempotent via a
  `held → released | seized` status gate and `SELECT … FOR UPDATE`.

**It is a deterrent + partial recovery, NOT insurance** — a small bond never makes
a victim whole; never message it as a guarantee.

**Operate it at Admin → Config → Maker collateral bond:**
- `maker_bond_enabled` — master on/off (default OFF).
- `maker_bond_ratio_pct` — bond as % of trade size (default 10 → $1 bond per $10).
- `maker_bond_min_usdt` — floor per bond regardless of ratio (default 0).
- Fully reversible: untick Enable + Save. Bonds already held are unaffected and
  still release/seize on their trade's terminal path.

---

## Phase 8 — CTM Explorer Auto-Verification + Price Oracle (deferred — needs external resources)

Two parts, both genuinely need things only the owner can provide + live testing.

### 8a. Per-explorer delivery auto-verification (Sidra / RBL / MetaEarth / MeePass …)
**What it is:** when a CTM token has its own blockchain explorer, automatically
verify that the seller actually delivered the token (sender + receiver address +
amount + confirmations) and surface it as a green "verified" signal.

**Why deferred / be careful:**
- Each token lives on its **own chain with its own explorer** — different API (or
  none), different finality rules, different reliability. This is **N separate,
  fragile integrations**, each needing real **API keys** and **testing against the
  live chain**. Cannot be written + verified without those.
- Small-chain explorers go down — must degrade gracefully.

**Design when we build it:**
- A **pluggable verifier interface** keyed by token/chain; tokens without an
  explorer fall back to the existing manual proof flow.
- Treat the explorer result as **evidence feeding a one-click human confirm —
  NEVER an auto-release trigger** (an explorer false-positive must not move funds).
- Match on sender + receiver address + amount + a time window + confirmation depth;
  prefer a memo/tag where the chain supports it to avoid false matches.

### 8b. CTM price oracle ("indicative" average price)
**What it is:** publish a platform average/index price for CTM tokens to guide
trades.

**Why deferred / be careful:**
- The moment we publish a price, **the platform becomes the price oracle** →
  manipulation / peg liability.

**Design when we build it:**
- Label it **"indicative, P2P-negotiated"** everywhere; never present as a quote.
- Keep order caps small (already enforced: L1 $50 / L2 $500 USDT-equiv).
- Decide **governance**: who sets/updates the index, how often, and the
  manipulation guard.

**Decisions/resources needed from owner before building:** explorer API keys +
live-chain access per token; pricing-governance policy.

---

## Minor UX polish (non-blocking — backend already enforces these)

1. **Seller verified-receipt wording/checkbox** on the trade confirm button
   ("I confirm the funds have actually arrived in my account — a screenshot is not
   enough"). The server already requires the `confirmedReceipt` acknowledgment.
2. **Hide the create-ad button** for Level-1 users who've hit their ad cap, instead
   of showing an error after they try. The server already blocks it.

---

## How to operate what's already live
- Toggle + tune everything at **Admin → Config → Non-Custodial P2P**:
  enable on/off, L1 max order (USDT, default 50), L2 max order (USDT, default 500),
  L1 ads — USDT (default 1), L1 ads — CTM (default 2).
- Fully reversible: untick Enable + Save returns to pre-launch behavior instantly.

---

## Deferred from the 2026-06-21 delivery-integrity + dispute sprint

These were consciously left out during that sprint (the rest shipped — address
validation, network labels, tx-hash explorer links, saved-address reuse,
multi-network ads, dispute overview/strikes, CTM token address guardrails). None
are blocking.

1. **Optional escrow / custody mode.** Owner raised it; deferred by recommendation
   — a real USDT escrow means custody (hot wallets, key security, regulatory
   exposure) and contradicts the shipped non-custodial design. If ever built, make
   it a clearly-flagged **optional** mode for high-value trades only, not the
   default. Decision pending from owner.

2. **Bid → confirm path multi-network picker.** Multi-network USDT ads are fully
   wired on the **instant-buy** path (taker picks BEP20/Aptos in the modal, drives
   validation + the trade's `network`). The **bid → confirm-details** path
   (`confirmBidDetails`) still locks to the ad's *primary* network — no per-network
   picker. To finish: thread a chosen `network` through `confirmBidDetails`
   (backend) and add the picker to the confirm modal in
   `marketplace/listings/[id]/page.tsx` (mirror the instant-buy block).

3. **Automated on-chain verification for Aptos & CTM/Sidra.** `verifyTradeTx`
   auto-verifies EVM + TRON only; Aptos returns `skipped` and CTM/Sidra has no
   verifier. Both fall back to the explorer link + manual review (owner confirmed
   manual is acceptable). CTM got a per-token **address-format regex guardrail**
   (`CtmToken.addressRegex`/`addressExample`) instead of on-chain checking. To
   close: add an Aptos verifier (fullnode REST) and, if a CTM chain exposes a
   public API, a CTM verifier — wire both into `verifyTradeTx`.
