import { COMMUNITY_CHANNELS, type CommunityBrand } from '@/lib/contact'

// Brand marks (official simple-icons paths). Kept inline so the component stays
// self-contained and works in both light and dark themes via currentColor.
function BrandIcon({ brand, className }: { brand: CommunityBrand; className?: string }) {
  if (brand === 'whatsapp') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885M20.52 3.449C18.24 1.245 15.24 0 12.045 0 5.463 0 .104 5.334.101 11.892c0 2.096.549 4.14 1.595 5.945L0 24l6.335-1.652a12.062 12.062 0 005.71 1.447h.006c6.585 0 11.946-5.335 11.949-11.896 0-3.176-1.24-6.165-3.495-8.411" />
      </svg>
    )
  }
  // telegram
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  )
}

const brandTint: Record<CommunityBrand, string> = {
  telegram: 'text-[#229ED9] bg-[#229ED9]/10',
  whatsapp: 'text-[#25D366] bg-[#25D366]/10',
}

/**
 * Labeled community-channel cards. Each card explains what the channel is for
 * so users know community vs announcements vs broadcast. Reads from
 * COMMUNITY_CHANNELS (single source of truth in lib/contact).
 */
export function CommunityChannels({ className }: { className?: string }) {
  return (
    <div className={className}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {COMMUNITY_CHANNELS.map((c) => (
          <a
            key={c.id}
            href={c.href}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 hover:border-primary/40 hover:shadow-card transition-all"
          >
            <div className="flex items-center gap-3">
              <span className={`flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0 ${brandTint[c.brand]}`}>
                <BrandIcon brand={c.brand} className="w-5 h-5" />
              </span>
              <span className="text-sm font-semibold text-text-primary">{c.label}</span>
            </div>
            <p className="text-xs text-text-muted leading-relaxed flex-1">{c.purpose}</p>
            <span className="text-xs font-semibold text-primary group-hover:underline">
              {c.cta} →
            </span>
          </a>
        ))}
      </div>
    </div>
  )
}

/** Compact icon-only row for tight spaces (e.g. the footer). */
export function CommunityIconLinks({ className }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className ?? ''}`}>
      {COMMUNITY_CHANNELS.map((c) => (
        <a
          key={c.id}
          href={c.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={c.label}
          title={c.label}
          className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors ${brandTint[c.brand]} hover:opacity-80`}
        >
          <BrandIcon brand={c.brand} className="w-4 h-4" />
        </a>
      ))}
    </div>
  )
}
