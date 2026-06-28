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
- ⬜ **B1. Each ad card consumes ~the whole screen.** Goal: show **3–4 ads per screen** on mobile by compacting the card layout. Keep ALL data (trader name, badges, rating, trades, price, limits, available, payment methods, logo/icon, CTA). Just tighter spacing / regrouped rows. Applies to USDT Marketplace cards AND CTM market cards. (Binance screenshot given only as density reference — not a copy.)

## C. Admin panel — global shell
- ✅ **C1. Top bar (hamburger + "Admin Panel" + search + bell) scrolls away on mobile.** (Phase 2) Shell now uses `h-[100dvh]` so the body never overflows and the header stays pinned. Root cause: outer uses `h-screen` (`100vh`) with inner `overflow-y-auto`; on mobile the browser chrome makes 100vh taller than the visible viewport, pushing the header out of view. Fix: use dynamic viewport height (`100dvh`/`h-dvh`) so the header stays pinned at all times.
- ✅ **C2. Add "external/push notifications" toggle in Admin Settings.** (Phase 2) New Notifications tab with `PushToggle`; backend `createAdminNotif` now fans OS push to all staff via `sendPushToAdmins`. Mirror the push-notification opt-in that already exists in the user app/settings, so admins can receive OS-level push (like app notifications), not just the in-app bell. Add to `/admin/settings`.

## D. Admin panel — per-page mobile layout (text half-cut, tabs wrapping, buttons overlapping)
- ✅ **D1. Sub-tab rows wrap to a second line / push content off-screen.** (Phase 3) New `.admin-toolbar` CSS util (single-line horizontal scroll, hidden scrollbar, non-shrinking children). Applied to Disputes filters, Referrals tabs, KYC status filter, Gas page header actions + payment-type + status filters, Gas Custom Requests filters, Withdrawals status tabs. Gas page header now stacks title/actions on mobile. Affected: Disputes (Open/Resolved/Escalated/All), Referrals (Referred Users/Top Inviters/Network Map/Suspicious), Gas Chain & Token Config / Token Diagnostics / Promo Codes / Free Gas, KYC filters, etc. Fix: make admin sub-tab rows a single horizontally-scrollable row OR fit-in-one-line, modeled on the Analytics "Today / 7 Days / 30 Days / 12 Months" row which already fits perfectly. Use that as the canonical pattern.
- 🟦 **D2. Tables cut off / columns half-visible (raw horizontal clipping).** (Phase 3) Admin tables already sit in `overflow-x-auto` wrappers with the global scroll-shadow affordance, so they scroll cleanly without page-level overflow rather than silently chopping. No data removed (per rule). Will revisit specific tables in Phase 4 sweep if any are found unwrapped. Affected: Referrals (Inviter/KYC/Referred By columns clipped), Trade Ratings, KYC queue, etc. Fix: proper responsive table treatment on mobile (horizontal scroll with visible affordance, or stacked card rows) so all columns are reachable without content being silently chopped.
- ⬜ **D3. Wallet / Chain config action buttons overlap.** Affected: Treasury / Gas Wallet cards (e.g. "View tokens", "Refund Gas", "Refresh Balance", "Test RPC", "Pause Chain" overlapping on Ethereum/BNB/etc. cards). Fix: stack/space buttons cleanly on mobile.
- ⬜ **D4. Admin user profile view** (e.g. cwf_trader detail) — compact the header/identity block + stat cards to reduce wasted vertical space and arrange neatly on mobile.
- ⬜ **D5. General sweep of remaining admin pages** for the same three failure modes (wrapping tabs, clipped tables, overlapping/oversized controls). Screenshots were examples; full audit required.

## E. Leaderboard (mobile only — small label changes)
- ⬜ **E1. Rename category tab "Tokens" → "CTM".**
- ⬜ **E2. Rename category tab "Gas" → "Gas Fee"** (optional polish; keep one word if it breaks layout).

## F. Referral page (user)
- ⬜ **F1. Newly created custom link should appear directly ABOVE the "Your custom links" section heading** (so the just-created link surfaces at top).
- ⬜ **F2. "Your custom links" list (each custom link card, e.g. CWFAZAL) should be collapsible.**
- ⬜ **F3. (Decision) Optionally move the "Referral rewards / Active" explainer card to the bottom of the page** (mobile + desktop). User leaning "okay to keep at top" — see Decisions.

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
