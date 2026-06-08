# Phase 9 — Admin Navigation Architecture Audit (Recommendations)

> **Status: PROPOSAL — awaiting approval. No navigation has been restructured.**
> Per the Phase 9 brief, this document only recommends. Nothing ships until you approve a target structure.

## 1. Current structure

```
Overview        Dashboard · Analytics · Notifications · Support Chat · Audit Log
Users & KYC     Users · KYC Queue · Appeals · Merchant KYC (hidden) · Referrals
Trading         Trades · Disputes · Withdrawals · Platform Revenue · Ratings
Gas             Gas Fee · Deposit Chains · Gas Analytics · Gas Flagged · Wallet Activity ·
                Reconciliation · Custom Requests · Gas Merchants
CTM             CTM Tokens · CTM Queue · CTM Merchants · CTM Trades · CTM Disputes
System          Wallet · Config · Logo Registry · Settings
```

6 sections, ~31 visible items.

## 2. Problems observed

1. **Finance is scattered across 3 sections.** Money-movement tools live under Trading
   (Withdrawals, Platform Revenue), Gas (Wallet Activity, Reconciliation), and System
   (Wallet → now the Treasury Overview from Phase 6). An admin doing a financial review
   has to hop between three menus.
2. **"Gas" is overloaded (8 items).** It mixes *operations* (Gas Fee, Custom Requests,
   Gas Flagged), *configuration* (Deposit Chains, Gas Merchants), and *finance*
   (Wallet Activity, Reconciliation, Gas Analytics).
3. **Moderation is split.** Users, Appeals, Disputes, Ratings, and Gas Flagged are all
   trust-and-safety surfaces but live under three different sections.
4. **Two analytics entry points** (Overview → Analytics, Gas → Gas Analytics) with no
   cross-link.
5. **Withdrawals under "Trading"** is misleading — withdrawals are a treasury/payout
   concern, not P2P trading.

## 3. Recommendations

### R1 — Introduce a **Treasury & Finance** section (RECOMMENDED)
Answer to the brief's first question: **yes, merge them.** Group every money-movement
surface in one place:

```
Treasury & Finance
  Treasury Overview      (System → Wallet, now Phase 6 dashboard)
  Wallet Activity        (from Gas)
  Reconciliation         (from Gas)
  Withdrawals            (from Trading)
  Platform Revenue       (from Trading)
```
Rationale: a single mental model for "where is the money, what moved, does it
reconcile, what did we pay out, what did we earn." This is the highest-value change.

### R2 — Slim **Gas** down to operations + config
```
Gas Operations
  Gas Fee · Custom Requests · Gas Flagged · Deposit Chains · Gas Merchants · Gas Analytics
```
(Wallet Activity + Reconciliation move to Treasury & Finance per R1.)

### R3 — Group **Trust & Safety** (answer to brief Q2 + Q3)
Moderation + user investigation tools belong together. Two viable options:

- **Option A (lighter):** keep Users under "Users & KYC", but co-locate the *queues*:
  Appeals, Disputes, CTM Disputes, Ratings, Gas Flagged under a **Trust & Safety** group.
- **Option B (fuller):** a dedicated **Trust & Safety** section:
  ```
  Trust & Safety
    Users · Appeals · Disputes · CTM Disputes · Ratings · Fraud/Flagged
  ```
  with KYC Queue + Merchant KYC + Referrals staying under "Onboarding/KYC".

Recommendation: **Option A** first (low risk, no relocation of the heavily-used Users
page), revisit B later. User *investigation* is already consolidated into the user
profile (Phase 2) and the trade investigation page (Phase 3), so a separate
"investigation" section is unnecessary — the grouping need is about the *review queues*.

### R4 — One Analytics home
Make Overview → Analytics the canonical analytics page and surface Gas Analytics as a
tab within it (or cross-link). Avoids two disconnected analytics entry points.

### R5 — Naming
- "Users & KYC" → **"Users & Onboarding"** (KYC, Merchant KYC, Referrals are onboarding).
- "System" → **"Platform Settings"** (Config, Logo Registry, Settings) once Wallet leaves.

## 4. Proposed target structure (if R1–R5 approved)

```
Overview           Dashboard · Analytics · Notifications · Support Chat · Audit Log
Users & Onboarding Users · KYC Queue · Merchant KYC · Referrals
Trust & Safety     Appeals · Disputes · CTM Disputes · Ratings · Gas Flagged
Trading            Trades · CTM Trades · CTM Tokens · CTM Queue · CTM Merchants
Treasury & Finance Treasury Overview · Wallet Activity · Reconciliation · Withdrawals · Platform Revenue
Gas Operations     Gas Fee · Custom Requests · Deposit Chains · Gas Merchants · Gas Analytics
Platform Settings  Config · Logo Registry · Settings
```

7 sections, more balanced (4–5 items each), finance unified, T&S unified.

## 5. Risk / effort
- **Low risk.** This is a pure nav reshuffle in `frontend/src/app/admin/layout.tsx` — no
  route URLs change (pages keep their paths), so deep links and bookmarks still work.
- **Effort:** ~1 small commit. Reversible.
- **Caveat:** moving the Users page out of its current group could disrupt admin muscle
  memory — hence Option A keeps Users put.

## 6. Decision needed from you
1. Approve **R1** (Treasury & Finance)? [recommended]
2. Trust & Safety as **Option A** (group queues) or **Option B** (full section)?
3. Approve the renames (R5)?
4. Approve **R4** (single analytics home)?

On your answers I'll implement the approved structure in one commit.
