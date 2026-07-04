import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../lib/prisma'
import { authenticate, requireRole } from '../middleware/auth.middleware'

const adminOrSuper = [authenticate, requireRole('admin', 'super_admin')]

// ── Types ──────────────────────────────────────────────────────────────────────

export interface LogoMap {
  chain:          Record<string, string>
  token:          Record<string, string>
  payment_method: Record<string, string>
  bank:           Record<string, string>
  wallet_provider: Record<string, string>
  exchange:       Record<string, string>
  social:         Record<string, string>
}

// ── In-memory cache (5 min TTL) ────────────────────────────────────────────────

let _cache: LogoMap | null = null
let _cachedAt = 0
const CACHE_TTL_MS = 5 * 60 * 1000

export function invalidateLogosCache(): void {
  _cache = null
}

async function buildLogosMap(): Promise<LogoMap> {
  const [chainConfigs, tokenConfigs, ctmTokens, registry] = await Promise.all([
    db.gasChainConfig.findMany({
      where:  { logoUrl: { not: null } },
      select: { slug: true, logoUrl: true },
    }),
    db.gasTokenConfig.findMany({
      where:  { logoUrl: { not: null } },
      select: { symbol: true, logoUrl: true },
    }),
    db.ctmToken.findMany({
      where:  { logoUrl: { not: null } },
      select: { symbol: true, logoUrl: true },
    }),
    db.logoRegistry.findMany(),
  ])

  const chain:          Record<string, string> = {}
  const token:          Record<string, string> = {}
  const payment_method: Record<string, string> = {}
  const bank:           Record<string, string> = {}
  const wallet_provider: Record<string, string> = {}
  const exchange:       Record<string, string> = {}
  const social:         Record<string, string> = {}

  // Gas chain configs — keyed by slug uppercased (e.g. "BSC", "TRON", "MATIC")
  for (const c of chainConfigs) {
    if (c.logoUrl) chain[c.slug.toUpperCase()] = c.logoUrl
  }

  // Gas token configs — keyed by symbol uppercased
  for (const t of tokenConfigs) {
    if (t.logoUrl) token[t.symbol.toUpperCase()] = t.logoUrl
  }

  // CTM tokens — keyed by symbol uppercased (may overlap with gas tokens, CTM wins)
  for (const ct of ctmTokens) {
    if (ct.logoUrl) token[ct.symbol.toUpperCase()] = ct.logoUrl
  }

  // LogoRegistry — the override / catch-all layer
  for (const r of registry) {
    switch (r.type) {
      case 'chain':          chain[r.slug.toUpperCase()]          = r.logoUrl; break
      case 'token':          token[r.slug.toUpperCase()]          = r.logoUrl; break
      case 'payment_method': payment_method[r.slug.toLowerCase()] = r.logoUrl; break
      case 'bank':           bank[r.slug.toLowerCase()]           = r.logoUrl; break
      case 'wallet_provider': wallet_provider[r.slug.toLowerCase()] = r.logoUrl; break
      case 'exchange':       exchange[r.slug.toLowerCase()]       = r.logoUrl; break
      case 'social':         social[r.slug.toLowerCase()]         = r.logoUrl; break
    }
  }

  return { chain, token, payment_method, bank, wallet_provider, exchange, social }
}

// ── Route registration ─────────────────────────────────────────────────────────

const upsertSchema = z.object({
  type:    z.enum(['chain', 'token', 'payment_method', 'bank', 'wallet_provider', 'exchange', 'social']),
  slug:    z.string().min(1).max(100).trim(),
  logoUrl: z.string().url().max(1000),
})

export async function logosRoutes(app: FastifyInstance) {
  // Public: returns merged logo map (chain/token/payment_method/bank/wallet_provider)
  app.get('/logos', async () => {
    if (!_cache || Date.now() - _cachedAt > CACHE_TTL_MS) {
      _cache    = await buildLogosMap()
      _cachedAt = Date.now()
    }
    return _cache
  })

  // Admin: list all LogoRegistry rows (for management UI)
  app.get('/admin/logos', { preHandler: adminOrSuper }, async () => {
    return db.logoRegistry.findMany({
      orderBy: [{ type: 'asc' }, { slug: 'asc' }],
    })
  })

  // Admin: upsert a logo registry entry
  app.post('/admin/logos', { preHandler: adminOrSuper }, async (req, _reply) => {
    const body = upsertSchema.parse(req.body)

    // Normalize slug: uppercase for chain/token, lowercase for the rest
    const normalizedSlug = (body.type === 'chain' || body.type === 'token')
      ? body.slug.toUpperCase()
      : body.slug.toLowerCase()

    const entry = await db.logoRegistry.upsert({
      where:  { type_slug: { type: body.type, slug: normalizedSlug } },
      create: { type: body.type, slug: normalizedSlug, logoUrl: body.logoUrl },
      update: { logoUrl: body.logoUrl },
    })

    invalidateLogosCache()
    return entry
  })

  // Admin: delete a logo registry entry
  app.delete('/admin/logos/:id', { preHandler: adminOrSuper }, async (req, rep) => {
    const { id } = req.params as { id: string }
    await db.logoRegistry.delete({ where: { id } })
    invalidateLogosCache()
    rep.code(204).send()
  })
}
