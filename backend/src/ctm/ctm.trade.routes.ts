import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { AppError } from '../lib/errors'
import { createAdminNotif } from '../services/adminNotification.service'
import { cloudinary, CLOUDINARY_FOLDERS, UPLOAD_LIMITS } from '../lib/cloudinary'
import { createHash } from 'node:crypto'
import {
  getMyTrades,
  getTradeByRef,
  uploadPaymentProof,
  confirmPayment,
  markSellerTransferring,
  uploadTokenProof,
  confirmReceipt,
  openDispute,
  cancelTrade,
  adminResolveDispute,
  adminAddDisputeMessage,
  adminConfirmPayment,
  getAllTradesAdmin,
  sendMessage,
  getMessages,
  rateTrade,
  selectTradePaymentAccount,
} from './ctm.trade.service'
import { db } from '../lib/prisma'
import { releaseMakerBond } from '../services/makerBond.service'
import { incrementTradeStreak } from '../services/tradeStreak.service'
import { awardTradePointsTx } from '../services/airdrop.service'
import { logger } from '../lib/logger'

const disputeSchema = z.object({
  reason: z.enum(['proof_fake', 'not_received', 'amount_mismatch', 'wrong_token', 'seller_unresponsive', 'buyer_unresponsive', 'other']),
  description: z.string().min(10).max(5000),
})

const cancelSchema = z.object({ reason: z.string().min(1).max(500) })

const messageSchema = z.object({
  message: z.string().min(1).max(1000),
  attachmentUrl: z.string().url().optional(),
})

const rateSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
  tags: z.array(z.string()).optional().default([]),
})

const resolveDisputeSchema = z.object({
  winner: z.enum(['buyer', 'seller', 'split']),
  resolution: z.string().min(10).max(2000),
})

const tokenProofSchema = z.object({
  txHash: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  proofType: z.enum(['screenshot', 'txhash', 'uid_receipt', 'video', 'other']).default('screenshot'),
})

function detectImageMime(buf: Buffer): string | null {
  if (buf.length < 4) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  return null
}

async function uploadToCloudinary(buffer: Buffer, folder: string): Promise<string> {
  const publicId = randomUUID()
  return new Promise<string>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, public_id: publicId, resource_type: 'image' },
      (err, result) => {
        if (err || !result) return reject(err instanceof Error ? err : new Error('Upload failed'))
        resolve(result.secure_url)
      },
    )
    stream.end(buffer)
  })
}

export async function ctmTradeRoutes(app: FastifyInstance) {
  // Deep links from the messages inbox and notifications address a CTM trade by its
  // human displayRef (CTM-YYYYMMDD-NNNN), whereas in-app navigation and every
  // service lookup key on the internal cuid `tradeRef`. Without this normalisation
  // a displayRef URL 404s as "Trade not found". Resolve any `:ref` param that looks
  // like a displayRef to its canonical cuid once, up front, so all downstream
  // handlers (service lookups, admin queries) work unchanged. cuids never start with
  // "CTM-", so the hot path (canonical refs) skips the extra query entirely.
  app.addHook('preHandler', async (req) => {
    const params = req.params as { ref?: string }
    const ref = params?.ref
    if (!ref || !ref.startsWith('CTM-')) return
    const found = await db.ctmTrade.findFirst({
      where: { OR: [{ displayRef: ref }, { tradeRef: ref }, { id: ref }] },
      select: { tradeRef: true },
    })
    if (found && found.tradeRef !== ref) params.ref = found.tradeRef
  })

  // GET /ctm/trades — my trades
  app.get('/ctm/trades', { preHandler: [authenticate] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const result = await getMyTrades(req.user!.id, {
      ...(q.status ? { status: q.status } : {}),
      ...(q.role ? { role: q.role as 'buyer' | 'seller' } : {}),
      page: q.page ? parseInt(q.page, 10) : 1,
      limit: q.limit ? parseInt(q.limit, 10) : 20,
    })
    return reply.send({ success: true, data: result })
  })

  // GET /ctm/trades/admin/all — admin view all trades
  app.get('/ctm/trades/admin/all', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    // `search` is the unified term; `ref` kept for backward compatibility.
    const searchTerm = q.search ?? q.ref
    const result = await getAllTradesAdmin({
      ...(q.status ? { status: q.status } : {}),
      ...(searchTerm ? { search: searchTerm } : {}),
      ...(q.token ? { token: q.token } : {}),
      ...(q.minAmount ? { minAmount: parseFloat(q.minAmount) } : {}),
      ...(q.maxAmount ? { maxAmount: parseFloat(q.maxAmount) } : {}),
      page: q.page ? parseInt(q.page, 10) : 1,
      limit: q.limit ? parseInt(q.limit, 10) : 20,
    })
    return reply.send({ success: true, data: result })
  })

  // GET /ctm/trades/:ref — trade detail
  app.get('/ctm/trades/:ref', { preHandler: [authenticate] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }
    const trade = await getTradeByRef(ref, req.user!.id, req.user!.role)
    return reply.send({ success: true, data: trade })
  })

  // POST /ctm/trades/:ref/payment-proof — buyer uploads PKR proof
  app.post('/ctm/trades/:ref/payment-proof', { preHandler: [authenticate] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const file = await (req as any).file()
    if (!file) throw new AppError('VALIDATION_ERROR', 'No file uploaded', 400)

    const chunks: Buffer[] = []
    let totalSize = 0
    for await (const chunk of file.file) {
      totalSize += chunk.length
      if (totalSize > UPLOAD_LIMITS.PAYMENT_PROOF) throw new AppError('FILE_TOO_LARGE', 'File exceeds 10MB limit', 400)
      chunks.push(chunk)
    }
    const buffer = Buffer.concat(chunks)

    const mime = detectImageMime(buffer)
    if (!mime) throw new AppError('INVALID_FILE_TYPE', 'Only JPEG, PNG, and WebP images are allowed', 400)

    const fileHash = createHash('sha256').update(buffer).digest('hex')
    const fileUrl = await uploadToCloudinary(buffer, CLOUDINARY_FOLDERS.CTM_PAYMENT_PROOF)

    await uploadPaymentProof(ref, req.user!.id, fileUrl, fileHash)
    return reply.send({ success: true, data: { fileUrl } })
  })

  // POST /ctm/trades/:ref/confirm-payment — seller confirms PKR received
  app.post('/ctm/trades/:ref/confirm-payment', { preHandler: [authenticate] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }
    await confirmPayment(ref, req.user!.id)
    db.ctmMerchantProfile.updateMany({ where: { userId: req.user!.id }, data: { lastActiveAt: new Date() } }).catch(() => {})
    return reply.send({ success: true })
  })

  // POST /ctm/trades/:ref/seller-transferring — seller marks token transfer started
  app.post('/ctm/trades/:ref/seller-transferring', { preHandler: [authenticate] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }
    await markSellerTransferring(ref, req.user!.id)
    db.ctmMerchantProfile.updateMany({ where: { userId: req.user!.id }, data: { lastActiveAt: new Date() } }).catch(() => {})
    return reply.send({ success: true })
  })

  // POST /ctm/trades/:ref/token-proof — seller uploads token transfer proof
  app.post('/ctm/trades/:ref/token-proof', { preHandler: [authenticate] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }

    // Check if multipart (file upload) or JSON (txhash only)
    const contentType = req.headers['content-type'] ?? ''
    let fileUrl: string | undefined
    let fileHash: string | undefined
    let proofBody: { txHash?: string; description?: string; proofType?: string } = {}

    if (contentType.includes('multipart')) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const file = await (req as any).file()
      if (file) {
        const chunks: Buffer[] = []
        let totalSize = 0
        for await (const chunk of file.file) {
          totalSize += chunk.length
          if (totalSize > UPLOAD_LIMITS.PAYMENT_PROOF) throw new AppError('FILE_TOO_LARGE', 'File exceeds 10MB limit', 400)
          chunks.push(chunk)
        }
        const buffer = Buffer.concat(chunks)
        const mime = detectImageMime(buffer)
        if (!mime) throw new AppError('INVALID_FILE_TYPE', 'Only JPEG, PNG, and WebP images are allowed', 400)
        fileHash = createHash('sha256').update(buffer).digest('hex')
        fileUrl = await uploadToCloudinary(buffer, CLOUDINARY_FOLDERS.CTM_TOKEN_PROOF)
        // Read extra fields from multipart form
        const fields = (file.fields ?? {}) as Record<string, { value: string }>
        proofBody = {
          ...(fields.txHash?.value ? { txHash: fields.txHash.value } : {}),
          ...(fields.description?.value ? { description: fields.description.value } : {}),
          ...(fields.proofType?.value ? { proofType: fields.proofType.value } : {}),
        }
      }
    } else {
      proofBody = req.body as typeof proofBody
    }

    const parsed = tokenProofSchema.safeParse(proofBody)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await uploadTokenProof(ref, req.user!.id, { fileUrl, fileHash, ...parsed.data } as any)
    return reply.send({ success: true, data: { fileUrl } })
  })

  // POST /ctm/trades/:ref/confirm-receipt — buyer confirms token received
  app.post('/ctm/trades/:ref/confirm-receipt', { preHandler: [authenticate] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }
    await confirmReceipt(ref, req.user!.id)
    return reply.send({ success: true })
  })

  // POST /ctm/trades/:ref/dispute — open dispute
  app.post('/ctm/trades/:ref/dispute', { preHandler: [authenticate] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }
    const parsed = disputeSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    await openDispute(ref, req.user!.id, parsed.data.reason, parsed.data.description)
    void createAdminNotif({
      category: 'CTM',
      title:    'CTM Trade Dispute Opened',
      body:     `Dispute opened on CTM trade ${ref}. Reason: ${parsed.data.reason}`,
      href:     `/admin/ctm/disputes`,
      metadata: { tradeRef: ref, userId: req.user!.id, reason: parsed.data.reason },
    })
    return reply.send({ success: true })
  })

  // POST /ctm/trades/:ref/cancel — cancel trade
  app.post('/ctm/trades/:ref/cancel', { preHandler: [authenticate] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }
    const parsed = cancelSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    await cancelTrade(ref, req.user!.id, parsed.data.reason)
    return reply.send({ success: true })
  })

  // POST /ctm/trades/:ref/messages — send message
  app.post('/ctm/trades/:ref/messages', { preHandler: [authenticate] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }
    const parsed = messageSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const msg = await sendMessage(ref, req.user!.id, parsed.data.message, parsed.data.attachmentUrl)
    return reply.code(201).send({ success: true, data: msg })
  })

  // GET /ctm/trades/:ref/messages — get messages
  app.get('/ctm/trades/:ref/messages', { preHandler: [authenticate] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }
    const messages = await getMessages(ref, req.user!.id, req.user!.role)
    return reply.send({ success: true, data: messages })
  })

  // POST /ctm/trades/:ref/rate — rate completed trade
  app.post('/ctm/trades/:ref/rate', { preHandler: [authenticate] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }
    const parsed = rateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rating = await rateTrade(ref, req.user!.id, parsed.data as any)
    return reply.code(201).send({ success: true, data: rating })
  })

  // POST /ctm/trades/:ref/select-payment-account — buyer locks one of multiple seller payment accounts
  app.post('/ctm/trades/:ref/select-payment-account', { preHandler: [authenticate] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }
    const parsed = z.object({ accountIndex: z.number().int().min(0) }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const result = await selectTradePaymentAccount(ref, req.user!.id, parsed.data.accountIndex)
    return reply.code(200).send({ success: true, data: result })
  })

  // GET /ctm/trades/:ref/escrow-info — escrow address for ON_CHAIN trades
  app.get('/ctm/trades/:ref/escrow-info', { preHandler: [authenticate] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }
    const trade = await db.ctmTrade.findUnique({
      where: { tradeRef: ref },
      select: { buyerId: true, sellerId: true, escrowAddress: true, escrowAmount: true, escrowCurrency: true, escrowConfirmedAt: true, escrowTxHash: true, settlementType: true },
    })
    if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
    if (trade.buyerId !== req.user!.id && trade.sellerId !== req.user!.id) throw new AppError('FORBIDDEN', 'Access denied', 403)
    return reply.send({ success: true, data: trade })
  })

  // POST /ctm/trades/admin/:ref/resolve-dispute — admin resolves dispute
  app.post('/ctm/trades/admin/:ref/resolve-dispute', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }
    const parsed = resolveDisputeSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    await adminResolveDispute(req.user!.id, ref, parsed.data)
    return reply.send({ success: true })
  })

  // POST /ctm/trades/admin/:ref/dispute-message — admin requests evidence in dispute
  app.post('/ctm/trades/admin/:ref/dispute-message', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }
    const parsed = z.object({ message: z.string().min(1).max(2000) }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const msg = await adminAddDisputeMessage(req.user!.id, ref, parsed.data.message)
    return reply.code(201).send({ success: true, data: msg })
  })

  // POST /ctm/trades/admin/:ref/confirm-payment — admin manually confirms payment
  app.post('/ctm/trades/admin/:ref/confirm-payment', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }
    await adminConfirmPayment(req.user!.id, ref)
    return reply.send({ success: true })
  })

  // POST /ctm/trades/admin/:ref/release — admin force completes trade
  app.post('/ctm/trades/admin/:ref/release', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }
    const trade = await db.ctmTrade.findUnique({ where: { tradeRef: ref } })
    if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)

    await db.$transaction(async (tx) => {
      // CAS guard: bump the streak only on a genuine transition INTO completed. A
      // re-run on an already-completed trade — or a race with the auto-complete job /
      // buyer confirm — claims 0 rows and skips the increment, so it can't double-count.
      // disputeResumeStatus is cleared alongside: this endpoint can force-complete a
      // DISPUTED trade, and leaving a stale resume rung on a completed trade would be
      // a dangling artifact (disputeResume.ts).
      const claimed = await tx.ctmTrade.updateMany({ where: { tradeRef: ref, status: { not: 'completed' } }, data: { status: 'completed', completedAt: new Date(), disputeResumeStatus: null } })
      if (claimed.count > 0) {
        await incrementTradeStreak(tx, trade.buyerId, trade.sellerId)
        await awardTradePointsTx(tx, { tradeType: 'ctm', tradeId: trade.id, buyerId: trade.buyerId, sellerId: trade.sellerId, fiatAmountPKR: trade.fiatAmount })
        // Force-completing a disputed trade must also close the dispute. Without
        // this the CtmDispute row stays `open` forever, which keeps the reduced
        // concurrency cap (tradeConcurrency.service keys off the dispute record,
        // not the trade status) stuck on BOTH parties permanently.
        await tx.ctmDispute.updateMany({
          where: { tradeId: trade.id, status: { not: 'resolved' } },
          data: {
            status: 'resolved',
            resolution: 'Closed by an admin force-completing the trade.',
            resolvedAt: new Date(),
            resolvedBy: req.user!.id,
          },
        })
      }
    })
    await db.auditLog.create({
      data: { actorId: req.user!.id, action: 'CTM_ADMIN_FORCE_RELEASE', metadata: { tradeRef: ref } },
    }).catch(() => {})

    // Force-release completes the trade in the maker's favour → return the bond
    // (idempotent; no-op when off or none held).
    await releaseMakerBond({ tradeType: 'ctm', tradeId: trade.id }).catch((err) =>
      logger.error({ err, tradeId: trade.id }, 'Failed to release maker bond on CTM force-release'),
    )

    return reply.send({ success: true })
  })

  // GET /ctm/trades/admin/proofs — list unreviewed CTM trade proofs
  app.get('/ctm/trades/admin/proofs', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const page = q.page ? parseInt(q.page, 10) : 1
    const limit = q.limit ? parseInt(q.limit, 10) : 20
    const skip = (page - 1) * limit
    const onlyUnreviewed = q.reviewed === 'false'

    const where = onlyUnreviewed ? { isAdminReviewed: false } : {}

    const [proofs, total] = await Promise.all([
      db.ctmTradeProof.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'asc' },
        include: {
          trade: {
            select: {
              tradeRef: true,
              buyer: { select: { username: true } },
              seller: { select: { username: true } },
            },
          },
        },
      }),
      db.ctmTradeProof.count({ where }),
    ])

    return reply.send({ success: true, data: { proofs, total, page, limit } })
  })

  const proofReviewSchema = z.object({
    action: z.enum(['ok', 'flag']),
    adminNote: z.string().max(500).optional(),
  })

  // POST /ctm/trades/admin/proofs/:id/review — admin marks proof ok or flags as suspicious
  app.post('/ctm/trades/admin/proofs/:id/review', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = proofReviewSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const proof = await db.ctmTradeProof.findUnique({
      where: { id },
      select: { id: true, uploadedBy: true, tradeId: true },
    })
    if (!proof) throw new AppError('NOT_FOUND', 'Proof not found', 404)

    await db.ctmTradeProof.update({
      where: { id },
      data: {
        isAdminReviewed: true,
        adminNote: parsed.data.adminNote ?? null,
      },
    })

    if (parsed.data.action === 'flag') {
      await db.fraudFlag.create({
        data: {
          userId: proof.uploadedBy,
          reason: `CTM trade proof flagged as suspicious by admin (proofId: ${id}, tradeId: ${proof.tradeId})`,
        },
      }).catch(() => {})
    }

    await db.auditLog.create({
      data: {
        actorId: req.user!.id,
        action: parsed.data.action === 'flag' ? 'CTM_PROOF_FLAGGED' : 'CTM_PROOF_REVIEWED_OK',
        metadata: { proofId: id, tradeId: proof.tradeId, action: parsed.data.action },
      },
    }).catch(() => {})

    return reply.send({ success: true })
  })
}
