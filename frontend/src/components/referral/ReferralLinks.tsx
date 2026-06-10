'use client'
import { Send, Globe } from 'lucide-react'
import { CopyButton } from '@/components/ui/CopyButton'
import { buildReferralLinks } from '@/lib/telegram'

// Shows BOTH referral links side-by-side so users share whichever fits their
// audience. The Telegram link is primary (one-tap auto-auth); the web link is
// the fallback for social / non-Telegram. Both carry the SAME code.
export function ReferralLinks({ code }: { code: string }) {
  const { telegram, web } = buildReferralLinks(code)

  return (
    <div className="space-y-3">
      {telegram && (
        <LinkCard
          icon={<Send size={18} className="text-[#229ED9]" aria-hidden />}
          iconWrap="bg-[#229ED9]/10"
          title="Telegram link"
          hint="Best for Telegram — one tap, auto sign-in"
          url={telegram}
          primary
        />
      )}
      <LinkCard
        icon={<Globe size={18} className="text-primary" aria-hidden />}
        iconWrap="bg-primary/10"
        title="Website link"
        hint="Best for web & social sharing"
        url={web}
      />
    </div>
  )
}

function LinkCard({
  icon,
  iconWrap,
  title,
  hint,
  url,
  primary = false,
}: {
  icon: React.ReactNode
  iconWrap: string
  title: string
  hint: string
  url: string
  primary?: boolean
}) {
  return (
    <div
      className={[
        'flex items-center gap-3 rounded-2xl border bg-surface p-3',
        primary ? 'border-[#229ED9]/40' : 'border-border',
      ].join(' ')}
    >
      <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${iconWrap}`}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-text-primary">{title}</p>
          {primary && (
            <span className="rounded-full bg-[#229ED9]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#229ED9]">
              Primary
            </span>
          )}
        </div>
        <p className="truncate text-xs text-text-muted" title={url}>
          {url}
        </p>
        <p className="mt-0.5 text-[11px] text-text-muted">{hint}</p>
      </div>
      {/* ≥44px touch target via min sizing on the copy control wrapper */}
      <div className="flex min-h-[44px] min-w-[44px] items-center justify-center">
        <CopyButton text={url} />
      </div>
    </div>
  )
}
