import type { Job } from 'bullmq'
import { db } from '../lib/prisma'
import { logger } from '../lib/logger'

export async function processOcrVerification(job: Job<{ orderId: string }>) {
  const { orderId } = job.data

  logger.info({ orderId }, 'Processing OCR verification')

  const order = await db.instantBuyOrder.findUnique({ where: { id: orderId } })
  if (!order) {
    logger.warn({ orderId }, 'OCR job: order not found')
    return
  }

  if (!order.paymentProofUrl) {
    logger.warn({ orderId }, 'OCR job: no proof URL')
    await db.instantBuyOrder.update({
      where: { id: orderId },
      data: {
        status: 'admin_review',
        verificationStatus: 'layer1_failed',
        ocrConfidence: 0,
      },
    })
    return
  }

  // Simulate OCR: confidence 75 if proofUrl exists, 0 if not
  // Real implementation would call an external OCR API (e.g., Google Vision, AWS Textract)
  const ocrConfidence = order.paymentProofUrl ? 75 : 0

  // Simulate extracted amount — real OCR would parse this from the receipt image
  const ocrExtractedAmount = order.fiatAmount ?? null

  const verificationStatus = ocrConfidence >= 85 ? 'layer1_passed' : 'layer1_failed'

  // Always sets status to admin_review — human always reviews
  await db.instantBuyOrder.update({
    where: { id: orderId },
    data: {
      status: 'admin_review',
      verificationStatus,
      ocrConfidence,
      ocrExtractedAmount,
    },
  })

  logger.info({ orderId, ocrConfidence, verificationStatus }, 'OCR verification complete')
}
