# Future Plans / Leftover Work — Non-Custodial P2P

Context: the non-custodial P2P rebuild shipped 2026-06-18 (Phases 0–4, 6, 7, 9),
all behind the `noncustodial_p2p_enabled` flag, toggled from
**Admin → Config → Non-Custodial P2P**. Two phases were deliberately deferred,
plus a couple of minor UX-polish items. They are **not blocking** — the platform
runs fully without them.

---

## Phase 5 — Maker Collateral Bond (deferred by product decision)

**What it is:** a small, refundable stake ("bond") posted by a maker (ad creator),
which is *slashed* if they're found to have committed fraud. It gives makers
skin-in-the-game and provides partial victim recovery, on top of the existing
identity + reputation + dispute system.

**Why deferred:** decided at launch to **hold nothing** so onboarding stays
frictionless and we acquire makers/merchants faster.

**The thing to be careful about:** the bond is the **one place the platform takes
custody** — we'd hold the staked funds and the keys to them. That brings:
- Key-management responsibility (a hot wallet / custodial balance for bonds).
- A small **regulatory footprint** (holding user funds = money-transmission-ish).
- It is a **deterrent + partial recovery, NOT insurance** — a ~1% bond never makes
  a victim whole; never message it as a guarantee.

**Design when we build it:**
- Ratio: ~1% (user's "$0.1 backs $10" idea) — make it a config value.
- Scope decision needed: **per-merchant** (one stake covers all their ads) vs
  **per-ad** (locked per active listing).
- Held in what / where: USDT on-platform hot wallet, or a fiat deposit?
- Slash flow: tie into the dispute resolution (`loserPenalty`) so a lost dispute
  can slash the bond + record it in moderation/audit history.

**Decisions needed from owner before building:** bond ratio, per-merchant vs
per-ad, and the custody location/asset.

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
