import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import { createAdminNotif } from '../services/adminNotification.service'
import {
  createTrade,
  getTrades,
  getTradeById,
  uploadPaymentProof,
  confirmPayment,
  rejectPaymentProof,
  PROOF_REJECT_REASONS,
  markCryptoSent,
  releaseTrade,
  cancelTrade,
  openDispute,
  sendMessage,
  getMessages,
  rateTrade,
} from '../services/trade.service'
import { getNoKycTakerStatus } from '../services/nokycTaker.service'
import { AppError } from '../lib/errors'

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const createTradeSchema = z.object({
  adId: z.string().min(1),
  amount: z.number().positive(),
  paymentMethod: z.string().min(1),
  buyerWalletAddress: z.string().optional().default(''),
  buyerDeliveryMethod: z.string().max(30).optional(),
  buyerDeliveryAddress: z.string().max(500).optional(),
  network: z.string().max(30).optional(),
  buyerPayFromMethodId: z.string().max(60).optional(),
})

// Either a tx hash or a transfer screenshot (or both) constitutes valid proof.
// Manual / exchange-UID deliveries have no on-chain hash, so the screenshot is
// the proof; on-chain wallet deliveries use the hash.
const cryptoSentSchema = z.object({
  txHash: z.string().optional().default(''),
  screenshotUrl: z.string().url().optional(),
}).refine((d) => d.txHash.trim().length > 0 || !!d.screenshotUrl, {
  message: 'Provide a transaction hash or a transfer screenshot as proof.',
})

const cancelSchema = z.object({
  reason: z.string().min(1).max(500),
})

const rejectPaymentSchema = z.object({
  reason: z.enum(PROOF_REJECT_REASONS),
  detail: z.string().min(10).max(500),
})

const disputeSchema = z.object({
  reason: z.string().min(1),
  description: z.string().min(10).max(5000),
})

const messageSchema = z.object({
  message: z.string().min(1).max(500),
  attachmentUrl: z.string().url().optional(),
})

const rateSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
  tags: z.array(z.string()).optional().default([]),
})

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function tradeRoutes(app: FastifyInstance) {
  // POST /api/trades
  app.post('/trades', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const parsed = createTradeSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const { adId, amount, paymentMethod, buyerWalletAddress, buyerDeliveryMethod, buyerDeliveryAddress, network, buyerPayFromMethodId } = parsed.data
    const trade = await createTrade(userId, adId, {
      amount,
      paymentMethod,
      buyerWalletAddress: buyerWalletAddress ?? '',
      ...(buyerDeliveryMethod !== undefined ? { buyerDeliveryMethod } : {}),
      ...(buyerDeliveryAddress !== undefined ? { buyerDeliveryAddress } : {}),
      ...(network !== undefined ? { network } : {}),
      ...(buyerPayFromMethodId !== undefined ? { buyerPayFromMethodId } : {}),
    })
    return reply.code(201).send({ success: true, data: trade })
  })

  // GET /api/trades/nokyc-status — the caller's no-KYC taker headroom, so the UI
  // can show remaining unverified limits and nudge toward KYC. Verified users get
  // { verified: true } and no caps apply.
  app.get('/trades/nokyc-status', { preHandler: [authenticate] }, async (req, reply) => {
    const status = await getNoKycTakerStatus(req.user!.id)
    return reply.send({ success: true, data: status })
  })

  // GET /api/trades and /api/trades/me (alias) — current user's trades
  for (const path of ['/trades', '/trades/me'] as const) {
    app.get(path, { preHandler: [authenticate] }, async (req, reply) => {
      const userId = req.user!.id
      const query = req.query as Record<string, string>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any = {
        page: query.page ? parseInt(query.page, 10) : 1,
        limit: query.limit ? parseInt(query.limit, 10) : 20,
      }
      if (query.status) params.status = query.status
      if (query.role) params.role = query.role as 'buyer' | 'seller'
      const result = await getTrades(userId, params)
      const { items, ...rest } = result
      return reply.send({ success: true, data: { trades: items, ...rest } })
    })
  }

  // GET /api/trades/:id
  app.get('/trades/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const role = req.user!.role
    const { id } = req.params as { id: string }
    const trade = await getTradeById(id, userId, role)
    return reply.send({ success: true, data: trade })
  })

  // POST /api/trades/:id/payment-proof — accepts JSON { paymentProofUrl } from presign+Cloudinary upload
  app.post('/trades/:id/payment-proof', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }

    const proofSchema = z.object({
      paymentProofUrl: z.string().url('Invalid proof URL'),
    })
    const parsed = proofSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }

    const updated = await uploadPaymentProof(id, userId, parsed.data.paymentProofUrl)
    return reply.send({ success: true, data: updated })
  })

  // POST /api/trades/:id/confirm-payment (also /mark-paid alias used by frontend)
  for (const path of ['/trades/:id/confirm-payment', '/trades/:id/mark-paid'] as const) {
    app.post(path, { preHandler: [authenticate] }, async (req, reply) => {
      const userId = req.user!.id
      const role = req.user!.role
      const { id } = req.params as { id: string }
      const confirmedReceipt = (req.body as { confirmedReceipt?: boolean } | undefined)?.confirmedReceipt === true
      const trade = await confirmPayment(id, userId, role, { confirmedReceipt })
      return reply.send({ success: true, data: trade })
    })
  }

  // POST /api/trades/:id/reject-payment — seller: "payment not received"
  app.post('/trades/:id/reject-payment', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const role = req.user!.role
    const { id } = req.params as { id: string }
    const parsed = rejectPaymentSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const result = await rejectPaymentProof(id, userId, role, parsed.data.reason, parsed.data.detail)
    return reply.send({ success: true, data: result })
  })

  // POST /api/trades/:id/crypto-sent
  app.post('/trades/:id/crypto-sent', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const parsed = cryptoSentSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const trade = await markCryptoSent(id, userId, parsed.data.txHash, parsed.data.screenshotUrl)
    return reply.send({ success: true, data: trade })
  })

  // POST /api/trades/:id/release
  app.post('/trades/:id/release', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const trade = await releaseTrade(id, userId)
    return reply.send({ success: true, data: trade })
  })

  // POST /api/trades/:id/cancel
  app.post('/trades/:id/cancel', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const role = req.user!.role
    const { id } = req.params as { id: string }
    const parsed = cancelSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const trade = await cancelTrade(id, userId, role, parsed.data.reason)
    return reply.send({ success: true, data: trade })
  })

  // POST /api/trades/:id/dispute
  app.post('/trades/:id/dispute', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const parsed = disputeSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const dispute = await openDispute(id, userId, parsed.data.reason, parsed.data.description)
    void createAdminNotif({
      category: 'DISPUTE',
      title:    'Trade Dispute Opened',
      body:     `A dispute was opened on trade ${id}. Reason: ${parsed.data.reason}`,
      href:     `/admin/disputes`,
      metadata: { tradeId: id, userId, reason: parsed.data.reason },
    })
    return reply.code(201).send({ success: true, data: dispute })
  })

  // POST /api/trades/:id/messages
  app.post('/trades/:id/messages', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const parsed = messageSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const msg = await sendMessage(id, userId, parsed.data.message, parsed.data.attachmentUrl)
    return reply.code(201).send({ success: true, data: msg })
  })

  // GET /api/trades/:id/messages
  app.get('/trades/:id/messages', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const role = req.user!.role
    const { id } = req.params as { id: string }
    const messages = await getMessages(id, userId, role)
    return reply.send({ success: true, data: messages })
  })

  // POST /api/trades/:id/rate
  app.post('/trades/:id/rate', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const parsed = rateSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const result = await rateTrade(
      id,
      userId,
      parsed.data.rating,
      parsed.data.comment ?? '',
      parsed.data.tags,
    )
    return reply.code(201).send({ success: true, data: result })
  })
}
