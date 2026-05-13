import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { authenticate } from '../middleware/auth.middleware'
import {
  createTrade,
  getTrades,
  getTradeById,
  uploadPaymentProof,
  confirmPayment,
  markCryptoSent,
  releaseTrade,
  cancelTrade,
  openDispute,
  sendMessage,
  getMessages,
  rateTrade,
} from '../services/trade.service'
import { cloudinary, CLOUDINARY_FOLDERS, UPLOAD_LIMITS } from '../lib/cloudinary'
import { AppError } from '../lib/errors'

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const createTradeSchema = z.object({
  adId: z.string().min(1),
  amount: z.number().positive(),
  paymentMethod: z.string().min(1),
  buyerWalletAddress: z.string().min(1),
})

const cryptoSentSchema = z.object({
  txHash: z.string().min(1),
})

const cancelSchema = z.object({
  reason: z.string().min(1).max(500),
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

// ─── Magic-byte MIME validation ───────────────────────────────────────────────

function detectImageMime(buf: Buffer): string | null {
  if (buf.length < 4) return null
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  // WebP: 52 49 46 46 .. .. .. .. 57 45 42 50
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf.length >= 12 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return 'image/webp'
  return null
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function tradeRoutes(app: FastifyInstance) {
  // POST /api/trades
  app.post('/trades', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const parsed = createTradeSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const { adId, amount, paymentMethod, buyerWalletAddress } = parsed.data
    const trade = await createTrade(userId, adId, { amount, paymentMethod, buyerWalletAddress })
    return reply.code(201).send({ success: true, data: trade })
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
      return reply.send({ success: true, data: result })
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

  // POST /api/trades/:id/payment-proof — multipart file upload
  app.post('/trades/:id/payment-proof', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }

    // Get multipart file
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const file = await (req as any).file()
    if (!file) throw new AppError('VALIDATION_ERROR', 'No file uploaded', 400)

    // Read file into buffer for magic-byte check
    const chunks: Buffer[] = []
    let totalSize = 0
    for await (const chunk of file.file) {
      totalSize += chunk.length
      if (totalSize > UPLOAD_LIMITS.PAYMENT_PROOF) {
        throw new AppError('FILE_TOO_LARGE', 'File exceeds 10MB limit', 400)
      }
      chunks.push(chunk)
    }
    const buffer = Buffer.concat(chunks)

    // Validate MIME via magic bytes
    const mime = detectImageMime(buffer)
    if (!mime) {
      throw new AppError('INVALID_FILE_TYPE', 'Only JPEG, PNG, and WebP images are allowed', 400)
    }

    // Upload to Cloudinary
    const publicId = randomUUID()
    const uploadResult = await new Promise<{ secure_url: string }>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: CLOUDINARY_FOLDERS.PAYMENT_PROOF,
          public_id: publicId,
          resource_type: 'image',
        },
        (error, result) => {
          if (error || !result) return reject(error instanceof Error ? error : new Error('Upload failed'))
          resolve(result as { secure_url: string })
        },
      )
      uploadStream.end(buffer)
    })

    const updated = await uploadPaymentProof(id, userId, uploadResult.secure_url)
    return reply.send({ success: true, data: updated })
  })

  // POST /api/trades/:id/confirm-payment (also /mark-paid alias used by frontend)
  for (const path of ['/trades/:id/confirm-payment', '/trades/:id/mark-paid'] as const) {
    app.post(path, { preHandler: [authenticate] }, async (req, reply) => {
      const userId = req.user!.id
      const role = req.user!.role
      const { id } = req.params as { id: string }
      const trade = await confirmPayment(id, userId, role)
      return reply.send({ success: true, data: trade })
    })
  }

  // POST /api/trades/:id/crypto-sent
  app.post('/trades/:id/crypto-sent', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const parsed = cryptoSentSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const trade = await markCryptoSent(id, userId, parsed.data.txHash)
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
