# Local test stack (no Docker needed)

Runs the real backend against a throwaway Postgres and Redis on your own machine, so you can click
through the app, take screenshots and run the opt-in database tests without touching production.
Everything here refuses to run against a database that is not on `localhost`.

## One-time setup

1. **Postgres** (embedded, no install):
   ```
   cd <any scratch folder>
   npm init -y && npm i embedded-postgres
   ```
   Copy `start-db.mjs` next to it and run `node start-db.mjs` (leave it running). It listens on
   `localhost:54329`, database `rup`, user `postgres`, password `pw`, UTF-8.
2. **Redis** (Windows): download `Redis-x64-5.0.14.1.zip` from
   https://github.com/tporadowski/redis/releases, unzip, run `redis-server.exe --port 63799`.
   On macOS/Linux just run `redis-server --port 63799`. Version 5 works (BullMQ prints a warning).
3. **`backend/.env`** (gitignored). Copy `.env.example` and set:
   ```
   DATABASE_URL=postgresql://postgres:pw@localhost:54329/rup
   DIRECT_DATABASE_URL=postgresql://postgres:pw@localhost:54329/rup
   REDIS_URL=redis://localhost:63799
   JWT_SECRET=local-test-jwt-secret-0123456789abcdef
   JWT_REFRESH_SECRET=local-test-refresh-secret-0123456789ab
   CSRF_SECRET=local-test-csrf-secret-0123456789abcd
   CNIC_HASH_SECRET=local-test-cnic-secret-0123456789abc
   RESEND_API_KEY=re_dummy_local
   FRONTEND_URL=http://localhost:3000
   ```
   and `frontend/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:3001`.
4. **Create the tables**: `cd backend && npx prisma migrate deploy` (if that fails on a fresh database,
   see the note below, then use `npx prisma db push --skip-generate`).

## Every time

```
cd backend
npx tsx scripts/local-stack/seed-test-user.ts tester@example.com 'Test1234!pass'   # once per user
npx tsx scripts/local-stack/serve-local.ts                                         # API on http://127.0.0.1:3001
cd ../frontend && npm run dev                                                      # app on http://localhost:3000
```

`serve-local.ts` starts only the API (no payment workers, no blockchain watchers, no gas wallet), which is
what you want for UI and API checks.

Database tests that need a real Postgres (e.g. the portfolio restore race):

```
cd backend
TEST_DATABASE_URL=postgresql://postgres:pw@localhost:54329/rup npm run test:integration
```

## Traps

- **Browsers autofill your real login** on `/login`. Overwrite both fields with the test user before submitting.
- **Phone width**: resizing the window does not change the page width, and the app's security headers stop it
  being framed. Use Chrome DevTools device mode, or put a small local proxy in front of `next dev` that strips
  `X-Frame-Options` / `Content-Security-Policy` and serves a 390px `<iframe>` (never change the app's own headers).
- **Requests are rate limited**: after a few calls to a limited route you get an error until the window passes.
- **Every non-GET request needs a CSRF token**: `GET /api/v1/auth/csrf`, send it as `x-csrf-token`.
- **Encoding**: Postgres must be UTF-8 (`start-db.mjs` sets it); the default on Windows is not, and migrations fail.
