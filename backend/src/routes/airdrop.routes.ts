import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import {
  getAirdropStatus,
  getAirdropLedger,
  dailyCheckin,
  repairStreak,
  resetStreak,
  getRedeemQuote,
  redeemPointsForUsdt,
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

  // GET /api/v1/airdrop/redeem/quote — rate, caps, and eligibility for the
  // points→USDT redemption card. Always 200; `enabled:false` locks the form.
  app.get('/airdrop/redeem/quote', { preHandler: [authenticate] }, async (req, reply) => {
    const data = await getRedeemQuote(req.user!.id)
    return reply.send({ success: true, data })
  })

  // POST /api/v1/airdrop/redeem — burn points into a real USDT credit on the
  // user's internal wallet balance, subject to the monthly budget + per-user cap.
  app.post('/airdrop/redeem', { preHandler: [authenticate] }, async (req, reply) => {
    const schema = z.object({ points: z.number().positive() })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const data = await redeemPointsForUsdt(req.user!.id, parsed.data.points)
    return reply.send({ success: true, data })
  })
}
