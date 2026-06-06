'use client'
import { useState, useCallback, useEffect } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { fmtDate, fmtDateTime, fmtNumber } from '@/lib/fmt'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Badge } from '@/components/ui/Badge'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { BadgeChip } from '@/components/ui/TraderLevelCard'
import {
  ArrowLeft, Shield, Star, TrendingUp, Users, AlertTriangle, Wallet,
  Scale, ClipboardList, CreditCard,
} from 'lucide-react'

/* eslint-disable @typescript-eslint/no-explicit-any */

type Tab = 'overview' | 'trades' | 'wallet' | 'disputes' | 'referrals' | 'payment' | 'audit'

function statusTone(status: string): string {
  const s = status.toLowerCase()
  if (['completed', 'crypto_released', 'delivered', 'credited', 'resolved', 'dispute_resolved'].includes(s)) return 'success'
  if (['cancelled', 'expired', 'rejected', 'failed', 'refunded'].includes(s)) return 'danger'
  if (['disputed', 'open', 'pending'].includes(s)) return 'warning'
  return 'default'
}

function StatCard({ icon: Icon, label, value, sub }: { icon: any; label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-surface shadow-card rounded-xl border border-border p-4">
      <div className="flex items-center gap-2 text-text-muted">
        <Icon size={14} />
        <p className="text-xs">{label}</p>
      </div>
      <p className="text-xl font-bold text-text-primary mt-1">{value}</p>
      {sub && <p className="text-xs text-text-muted mt-0.5">{sub}</p>}
    </div>
  )
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <h2 className="font-semibold text-text-primary">{title}</h2>
        {count !== undefined && <span className="text-xs text-text-muted">{count.toLocaleString()}</span>}
      </div>
      {children}
    </div>
  )
}

function Empty({ msg }: { msg: string }) {
  return <div className="px-5 py-8 text-center text-sm text-text-muted">{msg}</div>
}

function StatusChips({ rows }: { rows: Array<{ status: string; _count: { status: number } }> }) {
  if (!rows?.length) return <span className="text-xs text-text-muted">No records</span>
  return (
    <div className="flex flex-wrap gap-1.5">
      {rows.map((r) => (
        <Badge key={r.status} variant={statusTone(r.status) as any} size="sm">
          {r.status.replace(/_/g, ' ')}: {r._count.status}
        </Badge>
      ))}
    </div>
  )
}

export default function AdminUserProfilePage() {
  const params = useParams()
  const id = params?.id as string
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')

  const fetchProfile = useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminApi.getUserProfile(id)
      setData(res)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load user profile')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { if (id) fetchProfile() }, [id, fetchProfile])

  if (loading) return <LoadingState message="Loading user profile..." />
  if (error || !data) return <ErrorState title={error ?? 'User not found'} onRetry={fetchProfile} />

  const p = data.profile
  const tabs: Array<{ key: Tab; label: string; icon: any }> = [
    { key: 'overview', label: 'Overview', icon: Shield },
    { key: 'trades', label: 'Trades', icon: TrendingUp },
    { key: 'wallet', label: 'Wallet', icon: Wallet },
    { key: 'disputes', label: 'Disputes & Ratings', icon: Scale },
    { key: 'referrals', label: 'Referrals', icon: Users },
    { key: 'payment', label: 'Payment & Addresses', icon: CreditCard },
    { key: 'audit', label: 'Audit', icon: ClipboardList },
  ]

  return (
    <div className="space-y-5">
      <Link href="/admin/users" className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-primary">
        <ArrowLeft size={15} /> Back to Users
      </Link>

      {/* ── Identity header ── */}
      <div className="bg-surface shadow-card rounded-xl border border-border p-5">
        <div className="flex flex-wrap items-start gap-4">
          <UserAvatar name={p.username} avatarUrl={p.avatarUrl} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-text-primary">{p.username}</h1>
              {p.isOnline ? (
                <span className="inline-flex items-center gap-1 text-xs text-success">
                  <span className="w-2 h-2 rounded-full bg-success" /> Online
                </span>
              ) : (
                <span className="text-xs text-text-muted">Last seen {p.lastSeenAt ? fmtDateTime(p.lastSeenAt) : 'never'}</span>
              )}
            </div>
            <p className="text-sm text-text-secondary">{p.email}</p>
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <Badge variant="default" size="sm">Role: {p.role}</Badge>
              <Badge variant={p.kycStatus === 'verified' ? 'success' : 'warning'} size="sm">KYC: {p.kycStatus} ({p.kycLevel})</Badge>
              {p.isMerchant && <Badge variant="info" size="sm">Merchant{p.merchantName ? `: ${p.merchantName}` : ''}</Badge>}
              {p.isCtmMerchant && <Badge variant="info" size="sm">CTM Merchant</Badge>}
              {p.badge && <BadgeChip badge={p.badge} badgeLabel={p.badgeLabel} />}
              {p.isBanned && <Badge variant="danger" size="sm">Banned</Badge>}
              {p.isSuspended && <Badge variant="danger" size="sm">Suspended</Badge>}
            </div>
          </div>
          <div className="text-right text-xs text-text-muted space-y-0.5">
            <p>Joined {fmtDate(p.createdAt)}</p>
            <p>Reg IP: <span className="font-mono">{p.registrationIp ?? 'Not captured'}</span></p>
            <p className="font-mono">Ref: {p.referralCode}</p>
          </div>
        </div>
        {(p.isBanned || p.isSuspended) && p.suspendReason && (
          <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
            Reason: {p.suspendReason}
          </div>
        )}
        <p className="mt-3 text-xs text-text-muted">
          This is a read-only intelligence view. Use the{' '}
          <Link href="/admin/users" className="text-primary hover:underline">Users</Link> page for admin actions (ban / suspend / badge).
        </p>
      </div>

      {/* ── Stat cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard icon={Shield} label="Trust Score" value={p.trustScore ?? '—'} />
        <StatCard icon={TrendingUp} label="Completion Rate" value={p.completionRate != null ? `${Math.round(p.completionRate * 100)}%` : '—'} sub={`${p.completedTrades}/${p.totalTrades} trades`} />
        <StatCard icon={Star} label="Avg Rating" value={p.avgRating ?? '—'} sub={`${p.ratingCount} ratings`} />
        <StatCard icon={Users} label="Referrals" value={data.summary.referralCount} />
        <StatCard icon={AlertTriangle} label="Fraud Flags" value={data.fraudFlags?.length ?? 0} />
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key ? 'border-primary text-primary' : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
          >
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {/* ── Overview ── */}
      {tab === 'overview' && (
        <div className="grid md:grid-cols-3 gap-4">
          <Section title="P2P Trades"><div className="p-5"><StatusChips rows={data.summary.p2pStatus} /></div></Section>
          <Section title="CTM Trades (Buy)"><div className="p-5"><StatusChips rows={data.summary.ctmBuyStatus} /></div></Section>
          <Section title="CTM Trades (Sell)"><div className="p-5"><StatusChips rows={data.summary.ctmSellStatus} /></div></Section>
          <Section title="Gas Orders"><div className="p-5"><StatusChips rows={data.summary.gasStatus} /></div></Section>
          <Section title="Admin Notes" count={data.adminNotes?.length}>
            {data.adminNotes?.length ? (
              <ul className="divide-y divide-border">
                {data.adminNotes.map((n: any) => (
                  <li key={n.id} className="px-5 py-3 text-sm">
                    <p className="text-text-secondary">{n.note}</p>
                    <p className="text-xs text-text-muted mt-1">{fmtDateTime(n.createdAt)}</p>
                  </li>
                ))}
              </ul>
            ) : <Empty msg="No admin notes recorded for this user." />}
          </Section>
          <Section title="Fraud Flags" count={data.fraudFlags?.length}>
            {data.fraudFlags?.length ? (
              <ul className="divide-y divide-border">
                {data.fraudFlags.map((f: any) => (
                  <li key={f.id} className="px-5 py-3 text-sm flex items-center justify-between gap-2">
                    <span className="text-text-secondary">{f.type ?? f.reason ?? 'Flag'}</span>
                    <Badge variant={statusTone(f.status ?? '') as any} size="sm">{f.status}</Badge>
                  </li>
                ))}
              </ul>
            ) : <Empty msg="No fraud flags. Flags appear here when risk checks trip." />}
          </Section>
        </div>
      )}

      {/* ── Trades ── */}
      {tab === 'trades' && (
        <div className="space-y-4">
          <Section title="P2P Trades" count={data.p2pTrades?.length}>
            {data.p2pTrades?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border text-text-muted">
                    <tr><th className="text-left px-4 py-2 font-medium">Ref</th><th className="text-left px-4 py-2 font-medium">Coin</th><th className="text-left px-4 py-2 font-medium">Amount</th><th className="text-left px-4 py-2 font-medium">PKR</th><th className="text-left px-4 py-2 font-medium">Status</th><th className="text-left px-4 py-2 font-medium">Date</th></tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.p2pTrades.map((t: any) => (
                      <tr key={t.id} className="hover:bg-surface-alt/50">
                        <td className="px-4 py-2"><Link href={`/admin/trades/${t.id}`} className="text-primary hover:underline font-mono text-xs">{t.orderRef ?? t.id.slice(0, 8)}</Link></td>
                        <td className="px-4 py-2 text-text-secondary">{t.coin}</td>
                        <td className="px-4 py-2 text-text-primary">{fmtNumber(t.amount)}</td>
                        <td className="px-4 py-2 text-text-secondary">{t.fiatAmount ? fmtNumber(t.fiatAmount) : '—'}</td>
                        <td className="px-4 py-2"><Badge variant={statusTone(t.status) as any} size="sm">{t.status.replace(/_/g, ' ')}</Badge></td>
                        <td className="px-4 py-2 text-text-muted text-xs whitespace-nowrap">{fmtDate(t.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty msg="No P2P trades. USDT marketplace trades will appear here." />}
          </Section>

          <Section title="CTM Trades" count={data.ctmTrades?.length}>
            {data.ctmTrades?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border text-text-muted">
                    <tr><th className="text-left px-4 py-2 font-medium">Ref</th><th className="text-left px-4 py-2 font-medium">Token</th><th className="text-left px-4 py-2 font-medium">Amount</th><th className="text-left px-4 py-2 font-medium">PKR</th><th className="text-left px-4 py-2 font-medium">Status</th><th className="text-left px-4 py-2 font-medium">Date</th></tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.ctmTrades.map((t: any) => (
                      <tr key={t.id} className="hover:bg-surface-alt/50">
                        <td className="px-4 py-2 font-mono text-xs text-text-secondary">{t.tradeRef.slice(0, 10)}</td>
                        <td className="px-4 py-2 text-text-secondary">{t.token?.symbol ?? '—'}</td>
                        <td className="px-4 py-2 text-text-primary">{fmtNumber(t.tokenAmount)}</td>
                        <td className="px-4 py-2 text-text-secondary">{fmtNumber(t.fiatAmount)}</td>
                        <td className="px-4 py-2"><Badge variant={statusTone(t.status) as any} size="sm">{t.status.replace(/_/g, ' ')}</Badge></td>
                        <td className="px-4 py-2 text-text-muted text-xs whitespace-nowrap">{fmtDate(t.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty msg="No CTM trades. Community token trades will appear here." />}
          </Section>

          <Section title="Gas Orders" count={data.gasOrders?.length}>
            {data.gasOrders?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border text-text-muted">
                    <tr><th className="text-left px-4 py-2 font-medium">Ref</th><th className="text-left px-4 py-2 font-medium">Chain</th><th className="text-left px-4 py-2 font-medium">USD</th><th className="text-left px-4 py-2 font-medium">Status</th><th className="text-left px-4 py-2 font-medium">Date</th></tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.gasOrders.map((o: any) => (
                      <tr key={o.id} className="hover:bg-surface-alt/50">
                        <td className="px-4 py-2 font-mono text-xs text-text-secondary">{o.orderRef}</td>
                        <td className="px-4 py-2 text-text-secondary">{o.chain}</td>
                        <td className="px-4 py-2 text-text-primary">${fmtNumber(o.gasAmountUSD)}</td>
                        <td className="px-4 py-2"><Badge variant={statusTone(o.status) as any} size="sm">{o.status.replace(/_/g, ' ')}</Badge></td>
                        <td className="px-4 py-2 text-text-muted text-xs whitespace-nowrap">{fmtDate(o.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty msg="No gas orders. Crypto gas fee orders will appear here." />}
          </Section>
        </div>
      )}

      {/* ── Wallet ── */}
      {tab === 'wallet' && (
        <div className="space-y-4">
          <Section title="Withdrawals" count={data.withdrawals?.length}>
            {data.withdrawals?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border text-text-muted">
                    <tr><th className="text-left px-4 py-2 font-medium">Ref</th><th className="text-left px-4 py-2 font-medium">Coin</th><th className="text-left px-4 py-2 font-medium">Amount</th><th className="text-left px-4 py-2 font-medium">To</th><th className="text-left px-4 py-2 font-medium">Status</th><th className="text-left px-4 py-2 font-medium">Date</th></tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.withdrawals.map((w: any) => (
                      <tr key={w.id} className="hover:bg-surface-alt/50">
                        <td className="px-4 py-2 font-mono text-xs text-text-secondary">{w.orderRef}</td>
                        <td className="px-4 py-2 text-text-secondary">{w.coin} ({w.network})</td>
                        <td className="px-4 py-2 text-text-primary">{fmtNumber(w.amount)}</td>
                        <td className="px-4 py-2 font-mono text-xs text-text-muted">{w.toAddress?.slice(0, 6)}…{w.toAddress?.slice(-4)}</td>
                        <td className="px-4 py-2"><Badge variant={statusTone(w.status) as any} size="sm">{w.status.replace(/_/g, ' ')}</Badge></td>
                        <td className="px-4 py-2 text-text-muted text-xs whitespace-nowrap">{fmtDate(w.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty msg="No withdrawals on record." />}
          </Section>

          <Section title="Deposits" count={data.deposits?.length}>
            {data.deposits?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border text-text-muted">
                    <tr><th className="text-left px-4 py-2 font-medium">Tx</th><th className="text-left px-4 py-2 font-medium">Chain</th><th className="text-left px-4 py-2 font-medium">Asset</th><th className="text-left px-4 py-2 font-medium">Amount</th><th className="text-left px-4 py-2 font-medium">Status</th><th className="text-left px-4 py-2 font-medium">Date</th></tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.deposits.map((d: any) => (
                      <tr key={d.id} className="hover:bg-surface-alt/50">
                        <td className="px-4 py-2 font-mono text-xs text-text-muted">{d.txHash?.slice(0, 8)}…</td>
                        <td className="px-4 py-2 text-text-secondary">{d.chain}</td>
                        <td className="px-4 py-2 text-text-secondary">{d.symbol}</td>
                        <td className="px-4 py-2 text-text-primary">{fmtNumber(d.amount)}</td>
                        <td className="px-4 py-2"><Badge variant={statusTone(d.status) as any} size="sm">{d.status}</Badge></td>
                        <td className="px-4 py-2 text-text-muted text-xs whitespace-nowrap">{fmtDate(d.detectedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty msg="No on-chain deposits detected." />}
          </Section>
        </div>
      )}

      {/* ── Disputes & Ratings ── */}
      {tab === 'disputes' && (
        <div className="space-y-4">
          <Section title="Disputes (P2P + CTM)" count={(data.disputes?.p2p?.length ?? 0) + (data.disputes?.ctm?.length ?? 0)}>
            {(data.disputes?.p2p?.length || data.disputes?.ctm?.length) ? (
              <ul className="divide-y divide-border">
                {data.disputes.p2p.map((d: any) => (
                  <li key={d.id} className="px-5 py-3 text-sm flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-mono text-xs text-text-muted mr-2">P2P {d.trade?.orderRef}</span>
                      <span className="text-text-secondary">{d.reason}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {d.winner && <span className="text-xs text-text-muted">winner: {d.winner}</span>}
                      <Badge variant={statusTone(d.status) as any} size="sm">{d.status}</Badge>
                    </div>
                  </li>
                ))}
                {data.disputes.ctm.map((d: any) => (
                  <li key={d.id} className="px-5 py-3 text-sm flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-mono text-xs text-text-muted mr-2">CTM {d.trade?.tradeRef?.slice(0, 10)}</span>
                      <span className="text-text-secondary">{d.reason}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {d.winner && <span className="text-xs text-text-muted">winner: {d.winner}</span>}
                      <Badge variant={statusTone(d.status) as any} size="sm">{d.status}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            ) : <Empty msg="No disputes involving this user." />}
          </Section>

          <Section title="Ratings Received" count={(data.ratings?.p2p?.length ?? 0) + (data.ratings?.ctm?.length ?? 0)}>
            {(data.ratings?.p2p?.length || data.ratings?.ctm?.length) ? (
              <ul className="divide-y divide-border">
                {[...data.ratings.p2p, ...data.ratings.ctm].map((r: any) => (
                  <li key={r.id} className="px-5 py-3 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-gold">{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</span>
                      <span className="text-xs text-text-muted">{fmtDate(r.createdAt)}</span>
                    </div>
                    {r.comment && <p className="text-text-secondary mt-1">{r.comment}</p>}
                  </li>
                ))}
              </ul>
            ) : <Empty msg="No ratings received yet." />}
          </Section>
        </div>
      )}

      {/* ── Referrals ── */}
      {tab === 'referrals' && (
        <div className="space-y-4">
          <Section title="Referred By">
            {data.referredBy ? (
              <div className="px-5 py-3 text-sm">
                <Link href={`/admin/users/${data.referredBy.id}`} className="text-primary hover:underline font-medium">{data.referredBy.username}</Link>
                <span className="text-text-muted ml-2">{data.referredBy.email}</span>
              </div>
            ) : <Empty msg="This user was not referred by anyone." />}
          </Section>
          <Section title="Invited Users" count={data.summary.referralCount}>
            {data.referrals?.length ? (
              <ul className="divide-y divide-border">
                {data.referrals.map((r: any) => (
                  <li key={r.id} className="px-5 py-3 text-sm flex items-center justify-between gap-2">
                    <Link href={`/admin/users/${r.id}`} className="text-primary hover:underline font-medium">{r.username}</Link>
                    <div className="flex items-center gap-2">
                      <Badge variant={r.kycStatus === 'verified' ? 'success' : 'default'} size="sm">{r.kycStatus}</Badge>
                      <span className="text-xs text-text-muted">{fmtDate(r.createdAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : <Empty msg="This user has not invited anyone yet." />}
          </Section>
        </div>
      )}

      {/* ── Payment & Addresses ── */}
      {tab === 'payment' && (
        <div className="space-y-4">
          <Section title="Saved Payment Methods" count={data.paymentMethods?.length}>
            {data.paymentMethods?.length ? (
              <ul className="divide-y divide-border">
                {data.paymentMethods.map((m: any) => (
                  <li key={m.id} className="px-5 py-3 text-sm flex items-center justify-between gap-2">
                    <div>
                      <p className="text-text-primary font-medium">{m.displayName} <span className="text-xs text-text-muted">({m.type})</span></p>
                      <p className="text-xs text-text-muted">{m.accountName} · {m.mobileNumber ?? m.accountNumber ?? m.ibanNumber ?? '—'}</p>
                    </div>
                    {!m.isActive && <Badge variant="default" size="sm">Inactive</Badge>}
                  </li>
                ))}
              </ul>
            ) : <Empty msg="No saved payment methods." />}
          </Section>
          <Section title="Saved Delivery Addresses" count={data.savedAddresses?.length}>
            {data.savedAddresses?.length ? (
              <ul className="divide-y divide-border">
                {data.savedAddresses.map((a: any) => (
                  <li key={a.id} className="px-5 py-3 text-sm">
                    <p className="text-text-primary font-medium">{a.label} <span className="text-xs text-text-muted">({a.coin} · {a.network})</span></p>
                    <p className="text-xs font-mono text-text-muted break-all">{a.address}</p>
                  </li>
                ))}
              </ul>
            ) : <Empty msg="No saved delivery addresses." />}
          </Section>
        </div>
      )}

      {/* ── Audit ── */}
      {tab === 'audit' && (
        <div className="space-y-4">
          <Section title="Actions Targeting This User" count={data.auditTargetingUser?.length}>
            {data.auditTargetingUser?.length ? (
              <ul className="divide-y divide-border">
                {data.auditTargetingUser.map((a: any) => (
                  <li key={a.id} className="px-5 py-3 text-sm flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-text-secondary">{a.action}</span>
                    <span className="text-xs text-text-muted">{a.ipAddress ?? 'Not captured'} · {fmtDateTime(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : <Empty msg="No admin actions have targeted this user." />}
          </Section>
          <Section title="Actions By This User" count={data.auditByUser?.length}>
            {data.auditByUser?.length ? (
              <ul className="divide-y divide-border">
                {data.auditByUser.map((a: any) => (
                  <li key={a.id} className="px-5 py-3 text-sm flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-text-secondary">{a.action}{a.targetType ? ` → ${a.targetType}` : ''}</span>
                    <span className="text-xs text-text-muted">{a.ipAddress ?? 'Not captured'} · {fmtDateTime(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : <Empty msg="No audit actions recorded for this user (only admins generate audit entries)." />}
          </Section>
        </div>
      )}
    </div>
  )
}
