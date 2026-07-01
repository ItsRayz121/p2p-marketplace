import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { recordAuditLog } from '../lib/audit'
import {
  listSeasons,
  createSeason,
  setSeasonTokenPool,
  closeSeason,
  computeAllocations,
  exportAllocationsCsv,
} from '../services/airdropAdmin.service'

export async function airdropAdminRoutes(app: FastifyInstance) {
  const superAdmin = requireRole('super_admin')

  // GET /api/v1/admin/airdrop/seasons — list seasons with participants + totals.
  app.get('/admin/airdrop/seasons', { preHandler: [authenticate, superAdmin] }, async (_req, reply) => {
    const seasons = await listSeasons()
    return reply.send({ success: true, data: { seasons } })
  })

  // POST /api/v1/admin/airdrop/seasons — start a new season (closes the active one).
  app.post('/admin/airdrop/seasons', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const parsed = z.object({ name: z.string().min(1).max(60) }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'Invalid name' })
    const season = await createSeason(parsed.data.name)
    await recordAuditLog(req.user!.id, 'AIRDROP_SEASON_CREATE', 'AirdropSeason', season.id, { name: season.name, index: season.index })
    return reply.send({ success: true, data: season })
  })

  // PATCH /api/v1/admin/airdrop/seasons/:id/pool — set the token pool for a season.
  app.patch('/admin/airdrop/seasons/:id/pool', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = z.object({ tokenPool: z.number().nonnegative() }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'Invalid tokenPool' })
    await setSeasonTokenPool(id, parsed.data.tokenPool)
    await recordAuditLog(req.user!.id, 'AIRDROP_SEASON_SET_POOL', 'AirdropSeason', id, { tokenPool: parsed.data.tokenPool })
    return reply.send({ success: true })
  })

  // POST /api/v1/admin/airdrop/seasons/:id/close — close a season.
  app.post('/admin/airdrop/seasons/:id/close', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    await closeSeason(id)
    await recordAuditLog(req.user!.id, 'AIRDROP_SEASON_CLOSE', 'AirdropSeason', id, {})
    return reply.send({ success: true })
  })

  // GET /api/v1/admin/airdrop/seasons/:id/allocations — the TGE share-of-pool table.
  app.get('/admin/airdrop/seasons/:id/allocations', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const data = await computeAllocations(id)
    return reply.send({ success: true, data })
  })

  // GET /api/v1/admin/airdrop/seasons/:id/allocations.csv — CSV export for distribution.
  app.get('/admin/airdrop/seasons/:id/allocations.csv', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const csv = await exportAllocationsCsv(id)
    reply.header('Content-Type', 'text/csv')
    reply.header('Content-Disposition', `attachment; filename="airdrop-allocations-${id}.csv"`)
    return reply.send(csv)
  })
}
