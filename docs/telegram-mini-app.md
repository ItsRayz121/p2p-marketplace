# Telegram Mini App — Setup & Operations

RupChain runs as a **Telegram Mini App** in addition to the web app. A user who
opens the app *inside Telegram* is **auto-authenticated** from their verified
Telegram identity and never sees a signup/login screen. Web (browser) users keep
the normal email/password flow. Both produce the same account and dashboard.

This document is the single source of truth for configuring and operating it.

---

## 1. How it works (architecture)

```
Telegram client ──opens──▶  https://<frontend>/mini-app#tgWebAppData=...
                                   │
   layout.tsx TELEGRAM_DETECT_SCRIPT (synchronous, before any script)
   sets window.__IS_TELEGRAM__ + window.__TG_INIT_DATA__ from the launch hash
                                   │
   /mini-app bridge  ──POST /api/v1/miniapp/auth { initData }──▶  backend
                                   │                                  │
                                   │            validateInitData() HMAC-SHA256
                                   │            get-or-create by telegramId
                                   │            issue session (access + refresh)
                                   ◀────── { accessToken, user, isNew } ──────┘
   store token (in-memory Bearer) → router.replace('/dashboard')
```

**The golden rule:** the launch hash is the source of truth for **both detection
AND auth**. The `telegram-web-app.js` SDK is optional polish only — detection
never sniffs the User-Agent (Telegram's Android WebView omits "Telegram"), and
auth never waits for the SDK to load.

### Where the 6 rules live in this codebase
| Rule | Implementation |
|---|---|
| 1. Detect via launch hash, not UA | `TELEGRAM_DETECT_SCRIPT` in `frontend/src/app/layout.tsx`; `isTelegramMiniApp()` in `frontend/src/lib/telegram.ts` |
| 2. Read initData from the hash, not the SDK | `window.__TG_INIT_DATA__` + `getInitData()` (live-hash fallback; SDK is last resort) |
| 3. Server validates HMAC, auto-creates, issues session | `backend/src/lib/telegram.ts` `validateInitData()`; `loginOrRegisterWithTelegram()`; `POST /api/v1/miniapp/auth` |
| 4. Cookieless WebView → Bearer token | Backend already accepts `Authorization: Bearer` (`auth.middleware.ts`); client re-auths via `miniAppAuthenticate()` on 401 (`frontend/src/lib/api.ts`) |
| 5. Guard every public route | Client-side guard in `frontend/src/components/providers/Providers.tsx` (the launch hash never reaches the Vercel edge middleware) |
| 6. BotFather + domain | See §3 below |

> **Note on Rule 5 / middleware:** route guarding for Telegram runs **client-side**,
> not in `frontend/src/middleware.ts`, because `location.hash` is never sent to
> the server — the Vercel edge middleware physically cannot see `tgWebAppData`.

---

## 2. Environment variables

### Backend (Railway)
| Var | Required | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | for Mini App | BotFather token. HMAC key for initData + drives the bot. When unset, `/miniapp/auth` returns 503 and the bot is not started — the rest of the app is unaffected. |
| `TELEGRAM_BOT_USERNAME` | for deep links | Bot @handle **without** the leading `@` (e.g. `RupChainBot`). |
| `TELEGRAM_WEBHOOK_SECRET` | recommended | Random 32+ hex. Echoed by Telegram in `X-Telegram-Bot-Api-Secret-Token`; the webhook rejects mismatches. |
| `TELEGRAM_WEBHOOK_URL` | to enable bot | Public HTTPS base that receives updates (e.g. `https://api.rupchain.com`). Full path = `${URL}/api/v1/telegram/webhook`. Webhook is registered on boot when set. |
| `TELEGRAM_MINI_APP_URL` | optional | Exact Mini App URL used in the bot's button. Defaults to `${FRONTEND_URL}/mini-app`. |

### Frontend (Vercel)
| Var | Required | Purpose |
|---|---|---|
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | for the Telegram referral link | Bot @handle without `@`. The Telegram referral link is hidden until this is set. |

---

## 3. BotFather setup (the silent killer)

The Mini App URL / Menu Button URL in BotFather **must point at the EXACT domain
that actually receives your deploys** (e.g. `https://rupchain.pk/mini-app`). If it
points at a dead/typo domain, none of the code fixes ever load.

1. **@BotFather → /newbot** (or use an existing bot). Copy the token →
   `TELEGRAM_BOT_TOKEN` (Railway) + `TELEGRAM_BOT_USERNAME` /
   `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` = the bot's @handle (no `@`).
2. **/setdomain** → set the bot's domain to your frontend domain (e.g.
   `rupchain.pk`). Required for `web_app` buttons to open.
3. **/newapp** (or **Bot Settings → Configure Mini App**) → set the Web App URL
   to `https://<frontend>/mini-app`.
4. **Menu Button** → **Bot Settings → Menu Button → Configure menu button** →
   URL `https://<frontend>/mini-app`, label e.g. "Open RupChain".
5. Set Railway envs `TELEGRAM_WEBHOOK_URL` (your backend base) +
   `TELEGRAM_WEBHOOK_SECRET`. On the next deploy the backend auto-registers the
   webhook (look for `Telegram webhook registered` in logs).

> **Retesting caches hard:** the Telegram WebView caches `index.html` aggressively.
> To retest a deploy, clear the cache via the OS app settings — Android:
> *Settings → Apps → Telegram → Storage → Clear Cache* — not just inside Telegram.

---

## 4. Referral / deep links

Every user gets TWO links (shown side-by-side with copy buttons on the Referrals
page), both carrying the **same** referral code:

- **Telegram (primary):** `https://t.me/<bot>?start=ref_<code>` — one-tap auto-auth.
- **Website (fallback):** `https://<frontend>/r/<code>` (alias: `/invite/<code>`).

**Attribution**
- **Telegram path:** the account doesn't exist at `/start` time, so the bot stashes
  `ref_<code>` as a `TelegramPendingReferral` keyed by the Telegram id.
  `/miniapp/auth` resolves the code from **`initData.start_param` OR** the pending
  stash when creating a new user, and applies attribution **immediately** (the
  HMAC already proves identity — no email-verify wait).
- **Web path:** `/r/<code>` (and `/invite/<code>`) persist the code in
  `localStorage`; the register form submits it.

Self-referral is impossible at creation (the new user has no id yet); an unknown
code is ignored rather than blocking signup.

> Referral **rewards** are admin-reviewed on first trade for *all* users
> (auto-payouts are disabled) — the Telegram path only sets `referredById`, then
> the existing first-trade flow records the reward.

---

## 5. Acceptance tests

**A. Guard fires on the hash (no Telegram needed)**
Open `https://<frontend>/register#tgWebAppData=test` in a normal browser → it must
**redirect away** from the signup form (to `/mini-app`), proving the guard keys off
the hash. (`/mini-app` will then fail to authenticate with the fake initData and
show the "Try again" state — expected.)

**B. Real Telegram launch (Android, slow connection)**
Open the app from the bot's button/menu → must land on `/dashboard` with **no**
signup screen, even before `telegram-web-app.js` finishes loading.

**C. Telegram referral attribution**
Open `https://t.me/<bot>?start=ref_<code>` on a fresh Telegram account → a new
user is auto-created AND a credited referral appears for the referrer (no
email-verify wait).

**D. Web referral attribution**
Open `https://<frontend>/r/<code>` (or `/invite/<code>`) in a browser → the code
persists through signup → `referredById` is set per the normal web flow.

---

## 6. Local HMAC check

`backend/src/lib/__tests__/telegram.test.ts` covers `validateInitData` (genuine,
tampered, stale, malformed) + `parseReferralStartParam`. Run with the backend
test env configured:

```bash
npm run test --workspace=backend -- telegram
```
