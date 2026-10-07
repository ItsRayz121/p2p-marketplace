'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ExternalLink, MousePointerClick, UserPlus, ShoppingCart, Wallet, Trophy, Send, Globe, Share2, Search, Radio } from 'lucide-react'
import { affiliateDashboardApi, type AffiliateDashboardData } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { buildReferralLinks } from '@/lib/telegram'
import { CopyButton } from '@/components/ui/CopyButton'
import { LoadingState } from '@/components/ui/LoadingState'

const usd = (n: number) => `$${n.toFixed(2)}`

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'never'
  const mins = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString()
}

function StatTile({ icon, label, value, sub, accent = false }: { icon: React.ReactNode; label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${accent ? 'border-primary/40 bg-primary/5' : 'border-border bg-surface'}`}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-text-muted">{icon}{label}</div>
      <p className="mt-1 text-xl font-black tabular-nums text-text-primary">{value}</p>
      {sub && <p className="text-[11px] text-text-muted">{sub}</p>}
    </div>
  )
}

function TierCard({ d }: { d: AffiliateDashboardData }) {
  const { tier, next, ordersToNext, progressPct, tiers, orders } = d.tier
  const standard = !d.isAffiliate
  const pct = standard ? d.earnings.referralPct ?? 5 : tier.pct
  return (
    <div className="rounded-2xl border border-border bg-gradient-to-br from-primary/10 to-fuchsia-500/5 p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-text-muted">Your commission</p>
          <p className="text-4xl font-black text-text-primary tabular-nums">{pct}%</p>
          <p className="text-xs text-text-muted mt-0.5">
            {standard ? 'of the platform fee on every gas order your referrals make' : `${tier.name} tier · of the platform fee on every gas order your referrals make`}
          </p>
        </div>
        <Trophy className="h-8 w-8 text-amber-500 flex-shrink-0" aria-hidden />
      </div>

      {standard ? (
        <div className="rounded-lg border border-border bg-surface p-3 text-xs text-text-secondary">
          Approved affiliates start at <strong>{tiers[0]?.pct}%</strong> and can climb to <strong>{tiers[tiers.length - 1]?.pct}%</strong> as their referrals place more orders.
          {d.affiliateStatus === 'pending'
            ? ' Your application is being reviewed.'
            : d.affiliateStatus === 'rejected' ? ' Your last application was not approved. You can apply again below.' : ' Apply below to become an affiliate.'}
        </div>
      ) : (
        <>
          {next ? (
            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="font-semibold text-text-primary">Next: {next.name} · {next.pct}%</span>
                <span className="text-text-muted tabular-nums">{orders} / {next.minOrders} orders</span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface-alt">
                <div className="h-full rounded-full bg-gradient-to-r from-primary to-fuchsia-500 transition-[width] duration-700" style={{ width: `${Math.max(progressPct, 3)}%` }} />
              </div>
              <p className="mt-1 text-[11px] text-text-muted">{ordersToNext} more delivered order{ordersToNext === 1 ? '' : 's'} from your referrals to unlock {next.pct}%.</p>
            </div>
          ) : (
            <p className="text-xs font-semibold text-success">You are at the top tier. Thank you for growing RupChain!</p>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {tiers.map((t) => {
              const reached = orders >= t.minOrders
              const current = t.key === tier.key
              return (
                <div key={t.key} className={`rounded-lg border px-2.5 py-2 text-center ${current ? 'border-primary bg-primary/10' : reached ? 'border-success/40 bg-success/5' : 'border-border bg-surface opacity-70'}`}>
                  <p className="text-[11px] font-semibold text-text-primary">{t.name}</p>
                  <p className="text-base font-black tabular-nums text-text-primary">{t.pct}%</p>
                  <p className="text-[10px] text-text-muted">{t.minOrders === 0 ? 'start' : `${t.minOrders}+ orders`}</p>
                </div>
              )
            })}
          </div>
          <p className="text-[11px] text-text-muted">
            Every delivered gas order from someone you referred counts toward your tier. Orders are lifetime, so you never drop a tier. Commission is paid from our margin only.
          </p>
        </>
      )}
    </div>
  )
}

function LinkRow({ link }: { link: AffiliateDashboardData['links'][number] }) {
  const { telegram, web } = buildReferralLinks(link.code)
  const text = encodeURIComponent('Need gas for your crypto wallet? I use RupChain. Pay in PKR or USDT and get it in minutes.')
  const share = [
    { label: 'WhatsApp', href: `https://wa.me/?text=${text}%20${encodeURIComponent(web)}` },
    { label: 'Telegram', href: `https://t.me/share/url?url=${encodeURIComponent(web)}&text=${text}` },
    { label: 'X', href: `https://twitter.com/intent/tweet?text=${text}&url=${encodeURIComponent(web)}` },
  ]
  return (
    <div className="rounded-xl border border-border bg-surface p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-text-primary">
          {link.label ?? (link.isPrimary ? 'Main link' : link.code)}
          <span className="ml-2 font-mono text-xs text-text-muted">{link.code}</span>
          {!link.isActive && <span className="ml-2 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-bold text-warning">Paused</span>}
        </p>
        <p className="text-[11px] text-text-muted">Last click: {timeAgo(link.lastClickAt)}</p>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2 rounded-lg bg-surface-alt px-2.5 py-1.5">
          <Globe className="h-3.5 w-3.5 flex-shrink-0 text-primary" aria-hidden />
          <a href={web} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-xs text-primary hover:underline">{web}</a>
          <a href={web} target="_blank" rel="noopener noreferrer" aria-label="Open link" className="flex-shrink-0 text-text-muted hover:text-primary"><ExternalLink className="h-3.5 w-3.5" /></a>
          <CopyButton text={web} />
        </div>
        {telegram && (
          <div className="flex items-center gap-2 rounded-lg bg-surface-alt px-2.5 py-1.5">
            <Send className="h-3.5 w-3.5 flex-shrink-0 text-[#229ED9]" aria-hidden />
            <a href={telegram} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-xs text-[#229ED9] hover:underline">{telegram}</a>
            <a href={telegram} target="_blank" rel="noopener noreferrer" aria-label="Open Telegram link" className="flex-shrink-0 text-text-muted hover:text-primary"><ExternalLink className="h-3.5 w-3.5" /></a>
            <CopyButton text={telegram} />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Share2 className="h-3.5 w-3.5 text-text-muted" aria-hidden />
        {share.map((s) => (
          <a key={s.label} href={s.href} target="_blank" rel="noopener noreferrer" className="rounded-full border border-border px-2.5 py-1 text-[11px] font-semibold text-text-secondary hover:border-primary hover:text-primary">{s.label}</a>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-2 text-center">
        {[
          ['Clicks', link.clicks.toLocaleString()],
          ['Sign-ups', String(link.signups)],
          ['Orders', String(link.orders)],
          ['Earned', usd(link.earnedUsdt)],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg bg-surface-alt py-1.5">
            <p className="text-[10px] text-text-muted">{k}</p>
            <p className="text-sm font-bold tabular-nums text-text-primary">{v}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * A card whose body is hidden until the header is tapped, and hides again on a
 * second tap — the same pattern as "Referral rewards" lower on this page. Long
 * lists (200 referrals, the earnings feed) start collapsed so the page stays short.
 */
function CollapsibleCard({ title, count, defaultOpen = false, children }: { title: string; count?: number; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-3.5 text-left transition-colors hover:bg-surface-alt"
      >
        <h2 className="text-sm font-semibold text-text-primary">
          {title}
          {count !== undefined && <span className="ml-1 text-text-muted">({count})</span>}
        </h2>
        <ChevronDown size={18} className={`flex-shrink-0 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="space-y-3 border-t border-border p-4">{children}</div>}
    </section>
  )
}

function ReferralsPanel({ rows }: { rows: AffiliateDashboardData['referrals'] }) {
  const [q, setQ] = useState('')
  const [all, setAll] = useState(false)
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    return t ? rows.filter((r) => r.username.toLowerCase().includes(t)) : rows
  }, [rows, q])
  const shown = all ? filtered : filtered.slice(0, 10)

  return (
    <CollapsibleCard title="Your referrals" count={rows.length}>
      {rows.length > 5 && (
        <div className="flex justify-end">
          <label className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-alt px-2 py-1">
            <Search className="h-3.5 w-3.5 text-text-muted" aria-hidden />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search username" className="w-28 bg-transparent text-xs text-text-primary outline-none sm:w-40" />
          </label>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-text-muted">No referrals yet. Share a link above and they will appear here the moment they sign up.</p>
      ) : (
        <div className="divide-y divide-border">
          {shown.map((r) => (
            <div key={r.referredId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text-primary">{r.username}</p>
                <p className="text-[11px] text-text-muted">
                  Joined {timeAgo(r.joinedAt)} · via {r.linkLabel ?? r.linkCode}
                </p>
              </div>
              <div className="flex items-center gap-4 text-right">
                <div>
                  <p className="text-sm font-bold tabular-nums text-text-primary">{r.orders}</p>
                  <p className="text-[10px] text-text-muted">orders</p>
                </div>
                <div>
                  <p className="text-sm font-bold tabular-nums text-success">{usd(r.earnedUsdt)}</p>
                  <p className="text-[10px] text-text-muted">{r.lastOrderAt ? `last ${timeAgo(r.lastOrderAt)}` : 'no orders yet'}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {filtered.length > 10 && (
        <button onClick={() => setAll((v) => !v)} className="w-full rounded-lg bg-surface-alt py-2 text-xs font-semibold text-text-secondary hover:text-text-primary">
          {all ? 'Show fewer' : `Show all ${filtered.length}`}
        </button>
      )}
    </CollapsibleCard>
  )
}

/**
 * The affiliate's single dashboard: tier + progress, live totals, every link with working
 * (clickable) URLs and its own stats, every referred user with their orders and commission,
 * and a live earnings feed. Refreshes itself every 15 seconds.
 */
export function AffiliateDashboard() {
  const [data, setData] = useState<AffiliateDashboardData | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    try { setData(await affiliateDashboardApi.get()); setError(false) } catch { setError(true) }
  }, [])
  usePolling(load, 15_000, true)

  if (!data) return error ? <p className="py-6 text-center text-sm text-text-muted">Could not load your dashboard. Retrying…</p> : <LoadingState message="Loading your dashboard..." />

  const t = data.totals
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-text-primary">Affiliate dashboard</h2>
        <span className="flex items-center gap-1 text-[11px] text-text-muted"><Radio className="h-3 w-3 text-success" aria-hidden /> Live · updated {timeAgo(data.generatedAt)}</span>
      </div>

      <TierCard d={data} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile icon={<MousePointerClick className="h-3.5 w-3.5" />} label="Link clicks" value={t.clicks.toLocaleString()} />
        <StatTile icon={<UserPlus className="h-3.5 w-3.5" />} label="Sign-ups" value={String(t.signups)} sub={`${t.activeReferrals} ordered · ${t.conversionPct}%`} />
        <StatTile icon={<ShoppingCart className="h-3.5 w-3.5" />} label="Referred orders" value={String(t.orders)} />
        <StatTile icon={<Wallet className="h-3.5 w-3.5" />} label="Total earned" value={usd(data.earnings.totalAccruedUsdt)} sub={t.level2Earned > 0 ? `incl. ${usd(t.level2Earned)} level 2` : undefined} accent />
        <StatTile icon={<Wallet className="h-3.5 w-3.5" />} label="Available" value={usd(data.earnings.withdrawableUsdt)} sub={data.earnings.availableUsdt > data.earnings.withdrawableUsdt ? `${usd(data.earnings.availableUsdt - data.earnings.withdrawableUsdt)} on hold` : undefined} />
        <StatTile icon={<Wallet className="h-3.5 w-3.5" />} label="Withdrawn" value={usd(data.earnings.withdrawnUsdt)} />
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-text-primary">Your links</h2>
        {data.links.map((l) => <LinkRow key={l.id} link={l} />)}
      </div>

      <ReferralsPanel rows={data.referrals} />

      <CollapsibleCard title="Recent earnings" count={data.feed.length}>
        {data.feed.length === 0 ? (
          <p className="py-4 text-center text-sm text-text-muted">Your commissions will show up here as soon as a referral&apos;s order is delivered.</p>
        ) : (
          <div className="divide-y divide-border">
            {data.feed.map((f) => (
              <div key={f.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-text-primary">
                    {f.level === 2 ? 'Level 2 · ' : ''}{f.username ?? 'A referral'} placed an order
                  </p>
                  <p className="text-[11px] text-text-muted">{timeAgo(f.at)} · {f.pct}% commission{f.status === 'withdrawn' ? ' · withdrawn' : ''}</p>
                </div>
                <span className="text-sm font-bold tabular-nums text-success">+{usd(f.amountUsdt)}</span>
              </div>
            ))}
          </div>
        )}
      </CollapsibleCard>

      <p className="text-[11px] text-text-muted">
        Need help or want to be reviewed for a higher tier? <Link href="/messages/support" className="font-semibold text-primary underline">Contact support</Link>.
      </p>
    </div>
  )
}
