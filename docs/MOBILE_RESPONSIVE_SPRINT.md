# Mobile Responsive Sprint — Problem Inventory & Plan

> Scope rule (user-stated): **Mobile only. Do NOT change the desktop/website** — desktop is already good.
> Rule: never REMOVE any information/logos/details from a card unless explicitly told. Only rearrange/compact.
> Workflow: build a phase → self cross-check (typecheck/build) → commit to `main` → **STOP and wait for user permission** before next phase.

Status legend: ⬜ not started · 🟦 in progress · ✅ shipped · ⏸️ deferred

---

## A. Bottom navigation (user app)
- ✅ **A1. CTM tab missing on Telegram Mini App & flickers on mobile.** (Phase 1) CTM now always rendered for all users, no `useAuth` dependency → no flicker, present on Telegram. Root cause: `BottomNav.tsx` only renders the CTM item when `user.kycStatus === 'approved'`, and `useAuth()` returns `null` on first paint (so it shows the 5-item nav until auth resolves → "becomes visible after refresh"). Fix: make CTM always visible prominently + remove the flicker (stable render regardless of auth load state). *(Decision needed: show CTM to everyone, or keep gating but fix flicker — see Decisions.)*
- ✅ **A2. Gas center FAB too large/bulged.** (Phase 1) Reduced to 44px circle, lifted less; stays distinct via filled primary color. Currently `-top-5 w-12 h-12` popped circle. Reduce its prominence so the other 5 tabs read evenly; keep it slightly raised but not dominating. *(Decision: how much to reduce — see Decisions.)*

## B. Marketplace & CTM ad cards (mobile only)
- ✅ **B1. Each ad card consumes ~the whole screen.** (Phase 5) Added a dedicated compact mobile layout (`sm:hidden`) to both the USDT Marketplace card and the CTM market card; desktop row kept untouched (`hidden sm:flex`). Mobile now packs ALL data (identity, since, badges, trust metrics, activity, coin/network, price, available, limits+PKR, window, listed age, payment chips w/ logos, CTA) into ~5 tight rows so ~3 ads fit per screen. No data removed. Goal: show **3–4 ads per screen** on mobile by compacting the card layout. Keep ALL data (trader name, badges, rating, trades, price, limits, available, payment methods, logo/icon, CTA). Just tighter spacing / regrouped rows. Applies to USDT Marketplace cards AND CTM market cards. (Binance screenshot given only as density reference — not a copy.)

## C. Admin panel — global shell
- ✅ **C1. Top bar (hamburger + "Admin Panel" + search + bell) scrolls away on mobile.** (Phase 2) Shell now uses `h-[100dvh]` so the body never overflows and the header stays pinned. Root cause: outer uses `h-screen` (`100vh`) with inner `overflow-y-auto`; on mobile the browser chrome makes 100vh taller than the visible viewport, pushing the header out of view. Fix: use dynamic viewport height (`100dvh`/`h-dvh`) so the header stays pinned at all times.
- ✅ **C2. Add "external/push notifications" toggle in Admin Settings.** (Phase 2) New Notifications tab with `PushToggle`; backend `createAdminNotif` now fans OS push to all staff via `sendPushToAdmins`. Mirror the push-notification opt-in that already exists in the user app/settings, so admins can receive OS-level push (like app notifications), not just the in-app bell. Add to `/admin/settings`.

## D. Admin panel — per-page mobile layout (text half-cut, tabs wrapping, buttons overlapping)
- ✅ **D1. Sub-tab rows wrap to a second line / push content off-screen.** (Phase 3) New `.admin-toolbar` CSS util (single-line horizontal scroll, hidden scrollbar, non-shrinking children). Applied to Disputes filters, Referrals tabs, KYC status filter, Gas page header actions + payment-type + status filters, Gas Custom Requests filters, Withdrawals status tabs. Gas page header now stacks title/actions on mobile. Affected: Disputes (Open/Resolved/Escalated/All), Referrals (Referred Users/Top Inviters/Network Map/Suspicious), Gas Chain & Token Config / Token Diagnostics / Promo Codes / Free Gas, KYC filters, etc. Fix: make admin sub-tab rows a single horizontally-scrollable row OR fit-in-one-line, modeled on the Analytics "Today / 7 Days / 30 Days / 12 Months" row which already fits perfectly. Use that as the canonical pattern.
- ✅ **D2. Tables cut off / columns half-visible (raw horizontal clipping).** (Phase 7 audit) Audited all 29 admin pages containing `<table>` — every one is wrapped in an `overflow-x-auto` scroller within 3 lines of the table, plus the global scroll-shadow affordance. None unwrapped. Tables scroll cleanly without page-level overflow; no data removed (per rule). Affected: Referrals (Inviter/KYC/Referred By columns clipped), Trade Ratings, KYC queue, etc. Fix: proper responsive table treatment on mobile (horizontal scroll with visible affordance, or stacked card rows) so all columns are reachable without content being silently chopped.
- ✅ **D3. Wallet / Chain config action buttons overlap.** (Phase 4) Gas `WalletCard` actions now stack below the info as a wrapping row on mobile (column on desktop); title badges wrap. No more overlap with the title/Refund-Gas badge. Affected: Treasury / Gas Wallet cards (e.g. "View tokens", "Refund Gas", "Refresh Balance", "Test RPC", "Pause Chain" overlapping on Ethereum/BNB/etc. cards). Fix: stack/space buttons cleanly on mobile.
- ✅ **D4. Admin user profile view** (Phase 4) Identity meta block (Joined/Reg IP/Country/Ref) is now a clean left-aligned full-width list on mobile instead of an awkward right-aligned wrap; long merchant-name badge truncates so it can't stretch the row. Stat cards already 2-up on mobile. (e.g. cwf_trader detail) — compact the header/identity block + stat cards to reduce wasted vertical space and arrange neatly on mobile.
- ✅ **D5. General sweep of remaining admin pages** (Phase 7 audit) Full pass over every admin page. Additional tab/filter strips converted to `.admin-toolbar`: Merchant-KYC status filter, Appeals status filter, Ratings status filter, Admin Notifications category tabs (split tabs into a scroll strip + kept the "Unread only" toggle visible). Verified the rest are non-issues: `<select>` dropdowns (gas/flagged, ctm/tokens, logos), 2-tab strips (ctm/merchants, gas/chains), modal footers, metric rows, and resolution-template chips (intentionally wrap). All headers checked for button-cluster overflow — only the Gas Fee Operations header needed stacking (done Phase 3). for the same three failure modes (wrapping tabs, clipped tables, overlapping/oversized controls). Screenshots were examples; full audit required.

## E. Leaderboard (mobile only — small label changes)
- ✅ **E1. Rename category tab "Tokens" → "CTM".** (Phase 6) Mobile `short` label now "CTM".
- ✅ **E2. Rename category tab "Gas" → "Gas Fee"** (Phase 6) Mobile `short` label now "Gas Fee" (fits the equal-width tab). Full labels unchanged.

## F. Referral page (user)
- ✅ **F1. Newly created custom link surfaces at the top.** (Phase 6) After create, the list diffs old vs new ids, pins the new link to the top of the list (right under the heading), auto-expands it, and flags it with a "New" badge + highlight ring.
- ✅ **F2. "Your custom links" list cards collapsible.** (Phase 6) Already implemented via `openLinks`/chevron; verified. New links also auto-open.
- 🟦 **F3. (Decision) Keep "Referral rewards / Active" explainer at top.** Per user — no change; left at top so users see what they're doing first.

## G. Deferred (do not start yet)
- ⏸️ **G1. "Back" / browser back navigation not working properly.** User will provide reproduction details later. Skip for now.

---

## Open decisions (need user confirmation before/along Phase 1)
1. **CTM nav visibility:** Show CTM to ALL users always (recommended, fixes both the missing-on-Telegram and the flicker) — vs keep KYC-gated but only fix the flicker?
2. **Gas FAB size:** Reduce to a smaller raised circle (recommended) vs keep current size.
3. **Ad card density target:** 3 ads/screen (recommended) vs 4 ads/screen (denser).
4. **Referral rewards card position:** Keep at top (recommended) vs move to bottom.

---

## Proposed phase order
- **Phase 1 — Bottom nav:** A1 (CTM always visible + no flicker), A2 (FAB size). Small, high-visibility, low-risk.
- **Phase 2 — Admin shell:** C1 (sticky header via dvh), C2 (admin push-notification toggle).
- **Phase 3 — Admin sub-tabs + tables:** D1 (one-line/scroll tab pattern), D2 (responsive tables).
- **Phase 4 — Admin wallet/profile/controls:** D3 (button overlap), D4 (profile compaction), D5 (sweep remaining pages).
- **Phase 5 — Marketplace/CTM ad cards:** B1 (compact 3-up cards).
- **Phase 6 — Leaderboard + Referral polish:** E1/E2, F1/F2/F3.

Each phase: implement → typecheck/build → commit to `main` → STOP for approval.
