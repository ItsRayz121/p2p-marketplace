/**
 * Unified "Deposits & Withdrawals" admin view. Reads the existing Deposit and
 * Withdrawal tables directly — no second ledger — and merges them into one
 * direction-tagged feed plus a summary / time series computed from the same rows.
 */
import { Prisma } from '@prisma/client'
import { db } from './prisma'
import {
  CHAIN_TO_NETWORKS, DEPOSIT_STATUS, chainForWithdrawalNetwork, depositStatusGroup, mergePage, withdrawalStatusGroup,
  type TxDirection, type TxRow, type TxSource, type TxStatusGroup,
} from './walletTransactionsCore'

export type { TxDirection, TxRow, TxSource, TxStatusGroup }
export { mergePage } from './walletTransactionsCore'

// Withdrawal statuses that mean "money actually left" (mirrors withdrawalStatusGroup).
const WITHDRAWAL_SENT_SQL = Prisma.sql`("status"::text IN ('sent','completed') OR ("status"::text = 'auto_approved' AND "txHash" IS NOT NULL))`

export interface TxFilters {
  direction: 'all' | TxDirection
  chain?: string
  source?: TxSource
  status?: TxStatusGroup
  from?: Date
  to?: Date
  q?: string
  asset?: string
}

function dateRange(f: TxFilters) {
  if (!f.from && !f.to) return undefined
  return { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) }
}

function userSearch(q: string): Prisma.UserWhereInput {
  return {
    OR: [
      { username: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
    ],
  }
}

function depositWhere(f: TxFilters): Prisma.DepositWhereInput {
  const and: Prisma.DepositWhereInput[] = []
  if (f.chain) and.push({ chain: f.chain })
  if (f.asset) and.push({ symbol: f.asset })
  const range = dateRange(f)
  if (range) and.push({ detectedAt: range })
  if (f.status) {
    and.push({ status: { in: Object.entries(DEPOSIT_STATUS).filter(([, g]) => g === f.status).map(([s]) => s) } })
  }
  if (f.q) {
    and.push({
      OR: [
        { txHash: { contains: f.q, mode: 'insensitive' } },
        { toAddress: { contains: f.q, mode: 'insensitive' } },
        { fromAddress: { contains: f.q, mode: 'insensitive' } },
        { user: { is: userSearch(f.q) } },
      ],
    })
  }
  return and.length ? { AND: and } : {}
}

function withdrawalWhere(f: TxFilters): Prisma.WithdrawalWhereInput {
  const and: Prisma.WithdrawalWhereInput[] = []
  if (f.chain) {
    const nets = CHAIN_TO_NETWORKS[f.chain] ?? [f.chain.toUpperCase()]
    and.push({ OR: nets.map((n) => ({ network: { equals: n, mode: 'insensitive' as const } })) })
  }
  if (f.asset) and.push({ coin: f.asset })
  const range = dateRange(f)
  if (range) and.push({ createdAt: range })
  if (f.source === 'auto') and.push({ tier: 1 })
  if (f.source === 'manual') and.push({ tier: { gt: 1 } })
  if (f.status === 'completed') {
    and.push({ OR: [{ status: { in: ['sent', 'completed'] } }, { status: 'auto_approved', txHash: { not: null } }] })
  } else if (f.status === 'pending') {
    and.push({
      OR: [
        { status: { in: ['email_pending', 'pending', 'first_approved', 'approved'] } },
        { status: 'auto_approved', txHash: null },
      ],
    })
  } else if (f.status === 'on_hold') {
    and.push({ status: 'on_hold' })
  } else if (f.status === 'failed') {
    and.push({ status: { in: ['rejected', 'cancelled'] } })
  }
  if (f.q) {
    and.push({
      OR: [
        { txHash: { contains: f.q, mode: 'insensitive' } },
        { toAddress: { contains: f.q, mode: 'insensitive' } },
        { orderRef: { contains: f.q, mode: 'insensitive' } },
        { user: { is: userSearch(f.q) } },
      ],
    })
  }
  return and.length ? { AND: and } : {}
}

const MAX_WINDOW = 2000

export async function listWalletTransactions(f: TxFilters, page: number, limit: number) {
  // Source 'auto' | 'manual' only describes withdrawals; 'onchain' only deposits.
  const includeDeposits = f.direction !== 'out' && (!f.source || f.source === 'onchain')
  const includeOut = f.direction !== 'in' && (!f.source || f.source === 'auto' || f.source === 'manual')
  const window = Math.min(page * limit, MAX_WINDOW)
  const userSelect = { select: { id: true, username: true, email: true } } as const

  const [deposits, depositTotal, withdrawals, withdrawalTotal] = await Promise.all([
    includeDeposits
      ? db.deposit.findMany({ where: depositWhere(f), orderBy: { detectedAt: 'desc' }, take: window, include: { user: userSelect } })
      : Promise.resolve([]),
    includeDeposits ? db.deposit.count({ where: depositWhere(f) }) : Promise.resolve(0),
    includeOut
      ? db.withdrawal.findMany({ where: withdrawalWhere(f), orderBy: { createdAt: 'desc' }, take: window, include: { user: userSelect } })
      : Promise.resolve([]),
    includeOut ? db.withdrawal.count({ where: withdrawalWhere(f) }) : Promise.resolve(0),
  ])

  const rows: TxRow[] = [
    ...deposits.map((d): TxRow => ({
      key: `d:${d.id}`, kind: 'deposit', direction: 'in', id: d.id, ref: null,
      chain: d.chain, network: null, asset: d.symbol, amount: d.amount.toString(), amountUsd: null,
      txHash: d.txHash, address: d.fromAddress, user: d.user, relatedOrder: null,
      status: d.status, statusGroup: depositStatusGroup(d.status), source: 'onchain',
      createdAt: d.detectedAt.toISOString(),
    })),
    ...withdrawals.map((w): TxRow => ({
      key: `w:${w.id}`, kind: 'withdrawal', direction: 'out', id: w.id, ref: w.orderRef,
      chain: chainForWithdrawalNetwork(w.network), network: w.network, asset: w.coin, amount: w.amount.toString(),
      amountUsd: w.amountUsd?.toString() ?? null,
      txHash: w.txHash, address: w.toAddress, user: w.user, relatedOrder: w.orderRef,
      status: w.status, statusGroup: withdrawalStatusGroup(w.status, w.txHash), source: w.tier <= 1 ? 'auto' : 'manual',
      createdAt: w.createdAt.toISOString(),
    })),
  ]

  const total = depositTotal + withdrawalTotal
  return { rows: mergePage(rows, page, limit), total, pages: Math.max(1, Math.ceil(total / limit)) }
}

export interface TxSummary {
  asset: string | null
  assets: string[]
  chains: string[]
  totalIn: number
  totalOut: number
  net: number
  countIn: number
  countOut: number
  pendingCount: number
  bucket: 'day' | 'month'
  series: Array<{ t: string; in: number; out: number }>
}

/** Summary + time series for ONE asset (mixed units would be meaningless). Completed movements only. */
export async function walletTransactionSummary(f: TxFilters): Promise<TxSummary> {
  const [depAssets, wdAssets, depChains, wdNetworks] = await Promise.all([
    db.deposit.findMany({ distinct: ['symbol'], select: { symbol: true } }),
    db.withdrawal.findMany({ distinct: ['coin'], select: { coin: true } }),
    db.deposit.findMany({ distinct: ['chain'], select: { chain: true } }),
    db.withdrawal.findMany({ distinct: ['network'], select: { network: true } }),
  ])
  const assets = [...new Set([...depAssets.map((a) => a.symbol), ...wdAssets.map((a) => a.coin)])].sort()
  const chains = [...new Set([...depChains.map((c) => c.chain), ...wdNetworks.map((n) => chainForWithdrawalNetwork(n.network))])].sort()
  const asset = f.asset ?? (assets.includes('USDT') ? 'USDT' : assets[0] ?? null)

  const spanDays = f.from && f.to ? (f.to.getTime() - f.from.getTime()) / 86_400_000 : Infinity
  const bucket: 'day' | 'month' = spanDays <= 92 ? 'day' : 'month'

  if (!asset) {
    return { asset, assets, chains, totalIn: 0, totalOut: 0, net: 0, countIn: 0, countOut: 0, pendingCount: 0, bucket, series: [] }
  }

  const depConds: Prisma.Sql[] = [Prisma.sql`"status" = 'credited'`, Prisma.sql`"symbol" = ${asset}`]
  const wdConds: Prisma.Sql[] = [WITHDRAWAL_SENT_SQL, Prisma.sql`"coin" = ${asset}`]
  if (f.chain) {
    depConds.push(Prisma.sql`"chain" = ${f.chain}`)
    const nets = (CHAIN_TO_NETWORKS[f.chain] ?? [f.chain.toUpperCase()]).map((n) => n.toUpperCase())
    wdConds.push(Prisma.sql`UPPER("network") IN (${Prisma.join(nets)})`)
  }
  if (f.from) { depConds.push(Prisma.sql`"detectedAt" >= ${f.from}`); wdConds.push(Prisma.sql`"createdAt" >= ${f.from}`) }
  if (f.to)   { depConds.push(Prisma.sql`"detectedAt" <= ${f.to}`);   wdConds.push(Prisma.sql`"createdAt" <= ${f.to}`) }
  // `bucket` is one of two literals decided above — never user input.
  const trunc = Prisma.raw(`'${bucket}'`)

  const [depRows, wdRows, pendingDeposits, pendingWithdrawals] = await Promise.all([
    db.$queryRaw<Array<{ t: Date; total: number; n: bigint }>>(Prisma.sql`
      SELECT date_trunc(${trunc}, "detectedAt") AS t, COALESCE(SUM("amount"),0)::float8 AS total, COUNT(*) AS n
      FROM "Deposit" WHERE ${Prisma.join(depConds, ' AND ')} GROUP BY 1 ORDER BY 1`),
    db.$queryRaw<Array<{ t: Date; total: number; n: bigint }>>(Prisma.sql`
      SELECT date_trunc(${trunc}, "createdAt") AS t, COALESCE(SUM("amount"),0)::float8 AS total, COUNT(*) AS n
      FROM "Withdrawal" WHERE ${Prisma.join(wdConds, ' AND ')} GROUP BY 1 ORDER BY 1`),
    db.deposit.count({ where: depositWhere({ ...f, asset, status: 'pending' }) }),
    db.withdrawal.count({ where: withdrawalWhere({ ...f, asset, status: 'pending' }) }),
  ])

  const byT = new Map<string, { t: string; in: number; out: number }>()
  const slot = (d: Date) => {
    const t = d.toISOString()
    if (!byT.has(t)) byT.set(t, { t, in: 0, out: 0 })
    return byT.get(t)!
  }
  let totalIn = 0, totalOut = 0, countIn = 0, countOut = 0
  for (const r of depRows) { slot(r.t).in = r.total; totalIn += r.total; countIn += Number(r.n) }
  for (const r of wdRows)  { slot(r.t).out = r.total; totalOut += r.total; countOut += Number(r.n) }

  return {
    asset, assets, chains, totalIn, totalOut, net: totalIn - totalOut, countIn, countOut,
    pendingCount: pendingDeposits + pendingWithdrawals, bucket,
    series: [...byT.values()].sort((a, b) => (a.t < b.t ? -1 : 1)),
  }
}
