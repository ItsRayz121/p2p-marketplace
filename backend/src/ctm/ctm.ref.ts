/**
 * Human-readable CTM trade reference generator.
 *
 * Produces refs of the form `CTM-YYYYMMDD-NNNN` (e.g. CTM-20260607-0001).
 * The cuid `tradeRef` remains the canonical URL/routing key; `displayRef` is
 * what we surface to users so they never see raw database IDs.
 */
import type { Prisma, PrismaClient } from '@prisma/client'

type Tx = Prisma.TransactionClient | PrismaClient

function datePart(when: Date): string {
  const y = when.getFullYear()
  const m = String(when.getMonth() + 1).padStart(2, '0')
  const d = String(when.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/**
 * Generate a unique displayRef. Uses a per-day sequence with a small retry
 * loop; the `displayRef @unique` constraint is the ultimate guard against
 * concurrent collisions.
 */
export async function generateCtmDisplayRef(tx: Tx, when: Date = new Date()): Promise<string> {
  const prefix = `CTM-${datePart(when)}-`
  const count = await tx.ctmTrade.count({ where: { displayRef: { startsWith: prefix } } })
  let seq = count + 1
  for (let attempt = 0; attempt < 25; attempt++) {
    const ref = `${prefix}${String(seq).padStart(4, '0')}`
    const existing = await tx.ctmTrade.findUnique({ where: { displayRef: ref }, select: { id: true } })
    if (!existing) return ref
    seq++
  }
  // Extremely unlikely fallback: random 4-digit suffix.
  return `${prefix}${Math.floor(1000 + Math.random() * 9000)}`
}
