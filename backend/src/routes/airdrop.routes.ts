import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth.middleware'
import {
  getAirdropStatus,
  getAirdropLedger,
  dailyCheckin,
  repairStreak,
  resetStreak,
} from '../services/airdrop.service'

export async function airdropRoutes(app: FastifyInstance) {
  // GET /api/v1/airdrop — status for the Airdrop tab. Always 200; `enabled:false`
  // tells the frontend to render the "Coming soon" locked state.
  app.get('/airdrop', { preHandler: [authenticate] }, async (req, reply) => {
    const data = await getAirdropStatus(req.user!.id)
    return reply.send({ success: true, data })
  })

  // GET /api/v1/airdrop/ledger — the user's recent point-earning history (the
  // "where did my points come from" feed). Empty when the system is off.
  app.get('/airdrop/ledger', { preHandler: [authenticate] }, async (req, reply) => {
    const entries = await getAirdropLedger(req.user!.id, 50)
    return reply.send({ success: true, data: { entries } })
  })

  // POST /api/v1/airdrop/checkin — daily check-in: advance the streak (+ small
  // point). Idempotent per UTC day.
  app.post('/airdrop/checkin', { preHandler: [authenticate] }, async (req, reply) => {
    const data = await dailyCheckin(req.user!.id)
    return reply.send({ success: true, data })
  })

  // POST /api/v1/airdrop/streak/repair — spend points to restore a broken streak.
  app.post('/airdrop/streak/repair', { preHandler: [authenticate] }, async (req, reply) => {
    const data = await repairStreak(req.user!.id)
    return reply.send({ success: true, data })
  })

  // POST /api/v1/airdrop/streak/reset — voluntarily reset the streak to zero.
  app.post('/airdrop/streak/reset', { preHandler: [authenticate] }, async (req, reply) => {
    await resetStreak(req.user!.id)
    return reply.send({ success: true })
  })
}
