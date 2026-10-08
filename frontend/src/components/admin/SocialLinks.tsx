'use client'
import { useState, type ReactNode } from 'react'
import { BadgeCheck, Facebook, Globe, Instagram, Youtube } from 'lucide-react'
import { cn } from '@/lib/utils'

type IconProps = { className?: string }
const svg = (d: string) => function Icon({ className }: IconProps) {
  return <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden><path d={d} /></svg>
}
const XIcon = svg('M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z')
const TelegramIcon = svg('M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z')
const TikTokIcon = svg('M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z')

interface Platform { label: string; icon: (p: IconProps) => ReactNode; color: string; base?: string }
const PLATFORMS: Record<string, Platform> = {
  twitter: { label: 'X (Twitter)', icon: XIcon, color: 'text-text-primary', base: 'https://x.com/' },
  instagram: { label: 'Instagram', icon: (p) => <Instagram {...p} />, color: 'text-[#E1306C]', base: 'https://instagram.com/' },
  youtube: { label: 'YouTube', icon: (p) => <Youtube {...p} />, color: 'text-[#FF0000]', base: 'https://youtube.com/@' },
  telegram: { label: 'Telegram', icon: TelegramIcon, color: 'text-[#229ED9]', base: 'https://t.me/' },
  tiktok: { label: 'TikTok', icon: TikTokIcon, color: 'text-text-primary', base: 'https://tiktok.com/@' },
  facebook: { label: 'Facebook', icon: (p) => <Facebook {...p} />, color: 'text-[#1877F2]', base: 'https://facebook.com/' },
}
const ALIASES: Record<string, string> = { x: 'twitter', 'x.com': 'twitter', 'twitter.com': 'twitter', 't.me': 'telegram', 'instagram.com': 'instagram', 'youtube.com': 'youtube', 'youtu.be': 'youtube', 'tiktok.com': 'tiktok', 'facebook.com': 'facebook', 'fb.com': 'facebook' }

function resolve(platform: string, value: string) {
  const v = value.trim()
  const key = platform.toLowerCase()
  const p = PLATFORMS[ALIASES[key] ?? key]
  const href = /^https?:\/\//i.test(v) ? v : p?.base ? p.base + v.replace(/^@/, '') : null
  return { p, href, v }
}

/** Platform icon as a clickable round button opening the profile in a new tab. */
export function SocialIconLink({ platform, value, verified }: { platform: string; value: string; verified?: boolean }) {
  const { p, href, v } = resolve(platform, value)
  const Icon = p?.icon ?? ((x: IconProps) => <Globe {...x} />)
  const title = `${p?.label ?? platform}: ${v}${verified ? ' (verified)' : ''}`
  const cls = cn('relative inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface-alt transition-colors', href && 'hover:border-primary/50 hover:bg-surface', p?.color ?? 'text-text-secondary')
  const inner = (
    <>
      <Icon className="h-4 w-4" />
      {verified && <BadgeCheck className="absolute -right-1 -top-1 h-3.5 w-3.5 rounded-full bg-surface text-success" aria-label="Verified" />}
    </>
  )
  return href
    ? <a href={href} target="_blank" rel="noopener noreferrer" title={title} aria-label={title} className={cls}>{inner}</a>
    : <span title={title} aria-label={title} className={cls}>{inner}</span>
}

export function SocialIconRow({ socials, verified, max }: { socials: Record<string, string> | null | undefined; verified?: Record<string, unknown>; max?: number }) {
  const entries = Object.entries(socials ?? {}).slice(0, max)
  if (!entries.length) return <span className="text-xs text-text-muted">No socials</span>
  return <div className="flex flex-wrap gap-1.5">{entries.map(([k, v]) => <SocialIconLink key={k} platform={k} value={v} verified={!!verified?.[k]} />)}</div>
}

/** One row per submitted profile with its own Verify / Unverify action. */
export function SocialVerifyList({ socials, verified, canVerify, onVerify }: {
  socials: Record<string, string> | null | undefined
  verified?: Record<string, { at: string; by: string }>
  canVerify: boolean
  onVerify: (platform: string, next: boolean) => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const entries = Object.entries(socials ?? {})
  if (!entries.length) return null
  const done = entries.filter(([k]) => verified?.[k]).length
  return (
    <div className="mt-2 rounded-lg border border-border bg-surface-alt/40">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
        <span>Social profiles</span>
        <span className={done === entries.length ? 'text-success' : ''}>{done} / {entries.length} verified</span>
      </div>
      <ul className="divide-y divide-border">
        {entries.map(([k, v]) => {
          const ok = !!verified?.[k]
          const { p, href } = resolve(k, v)
          return (
            <li key={k} className="flex items-center gap-3 px-3 py-2">
              <SocialIconLink platform={k} value={v} verified={ok} />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-text-primary">{p?.label ?? k}</p>
                {href
                  ? <a href={href} target="_blank" rel="noopener noreferrer" className="block truncate text-xs text-primary hover:underline">{v}</a>
                  : <p className="truncate text-xs text-text-secondary">{v}</p>}
              </div>
              {ok
                ? <span className="inline-flex items-center gap-1 text-xs font-medium text-success"><BadgeCheck className="h-3.5 w-3.5" /> Verified</span>
                : <span className="text-xs text-text-muted">Not verified</span>}
              {canVerify && (
                <button
                  type="button"
                  disabled={busy === k}
                  onClick={async () => { setBusy(k); try { await onVerify(k, !ok) } finally { setBusy(null) } }}
                  className="rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface-alt disabled:opacity-50"
                >
                  {ok ? 'Unverify' : 'Verify'}
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
