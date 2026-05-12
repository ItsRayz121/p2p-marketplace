# PakSwap — P2P Crypto Marketplace

Pakistan-focused P2P crypto exchange + Global Gas Fee Supply System.

## Monorepo Structure

```
pakswap/
├── frontend/          → Next.js 14 (Vercel)
├── backend/           → Fastify + Prisma (Railway)
├── docs/              → Full specification documents
│   ├── FULL_SPEC.md
│   ├── GAS_FEE_SPEC.md
│   ├── DB_TRANSACTION_RULES.md
│   └── FRONTEND_STANDARDS.md
├── .gitignore
├── package.json       → npm workspaces root
└── README.md
```

## Quick Start (Local Development)

### Prerequisites
- Node.js 20+
- PostgreSQL 15+
- Redis 7+

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/pakswap.git
cd pakswap
npm install
```

### 2. Set up backend environment

```bash
cp backend/.env.example backend/.env
# Edit backend/.env with your local DB, Redis, and secret values
```

### 3. Set up frontend environment

```bash
cp frontend/.env.local.example frontend/.env.local
# Edit frontend/.env.local — set NEXT_PUBLIC_API_URL
```

### 4. Initialize the database

```bash
cd backend
npx prisma migrate dev --name init
npx prisma generate
cd ..
```

### 5. Run locally

```bash
# Both services in one terminal:
npm run dev

# Or separately:
npm run dev:backend   # http://localhost:3001
npm run dev:frontend  # http://localhost:3000
```

### 6. Verify it works

```bash
# Backend health check:
curl http://localhost:3001/health

# Frontend: open http://localhost:3000 — shows API connection status
```

---

## Deployment

### Backend → Railway

1. Create a new Railway project at [railway.app](https://railway.app)
2. Add services: **PostgreSQL** and **Redis** (Railway provides both)
3. Connect your GitHub repo → select the `backend/` root directory
4. Railway auto-detects `railway.toml` and uses it
5. Add all env vars from `backend/.env.example` in Railway dashboard
6. `DATABASE_URL` and `REDIS_URL` are auto-injected by Railway — do not set them manually
7. First deploy runs `prisma migrate deploy` automatically (see `railway.toml`)

```bash
# Check backend is live:
curl https://YOUR_BACKEND.up.railway.app/health
```

### Frontend → Vercel

1. Go to [vercel.com](https://vercel.com) → New Project → Import from GitHub
2. Set **Root Directory** to `frontend`
3. Framework preset: **Next.js** (auto-detected)
4. Add env vars:
   ```
   NEXT_PUBLIC_API_URL=https://YOUR_BACKEND.up.railway.app
   ```
5. Deploy — Vercel handles everything else

```bash
# Verify frontend is live and connected to backend:
# Open https://YOUR_PROJECT.vercel.app — the status page shows API health
```

---

## Required Environment Variables

### Backend (Railway / backend/.env)

| Variable | Where to get it | Required |
|----------|----------------|----------|
| `DATABASE_URL` | Auto-injected by Railway PostgreSQL | Yes |
| `REDIS_URL` | Auto-injected by Railway Redis | Yes |
| `JWT_SECRET` | Generate: `openssl rand -hex 32` | Yes |
| `JWT_REFRESH_SECRET` | Generate: `openssl rand -hex 32` | Yes |
| `CSRF_SECRET` | Generate: `openssl rand -hex 32` | Yes |
| `CNIC_HASH_SECRET` | Generate: `openssl rand -hex 32` | **Server won't start without this** |
| `AWS_ACCESS_KEY_ID` | AWS IAM console | Yes |
| `AWS_SECRET_ACCESS_KEY` | AWS IAM console | Yes |
| `AWS_S3_BUCKET` | Create an S3 bucket | Yes |
| `AWS_REGION` | e.g. `ap-south-1` | Yes |
| `ADMIN_ALERT_EMAIL` | Your ops email | Yes |
| See `backend/.env.example` for full list | — | — |

### Frontend (Vercel / frontend/.env.local)

| Variable | Value | Required |
|----------|-------|----------|
| `NEXT_PUBLIC_API_URL` | Your Railway backend URL | Yes |
| See `frontend/.env.local.example` for full list | — | — |

---

## Documentation

All product and technical specifications are in `/docs`:

- [FULL_SPEC.md](docs/FULL_SPEC.md) — Complete platform specification (32 sections)
- [GAS_FEE_SPEC.md](docs/GAS_FEE_SPEC.md) — Gas fee infrastructure
- [DB_TRANSACTION_RULES.md](docs/DB_TRANSACTION_RULES.md) — Atomic operation rules
- [FRONTEND_STANDARDS.md](docs/FRONTEND_STANDARDS.md) — Component and styling standards

---

## First Admin Account

After first deploy:

```sql
-- After running prisma migrate, promote your account to super_admin:
UPDATE "User" SET role = 'super_admin' WHERE email = 'your@email.com';
```

Or via Prisma Studio: `cd backend && npx prisma studio`

---

## Legal Notice

This platform must be operated by a registered business entity (SMC-Pvt Ltd or Pvt Ltd) in Pakistan. 
Do not accept live funds without completing the legal checklist in `docs/FULL_SPEC.md` Section 26.
