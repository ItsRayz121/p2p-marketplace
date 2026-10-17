import { ImageResponse } from 'next/og'
import type { PublicShareData } from './shareCardServer'
import { normalizeChain, CHAIN_LOGO_LOCAL, CHAIN_LOGO_STATIC } from './logoRegistry'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rupchain.com'

/** 1200×675 is the size X shows best in a timeline; the same render is the preview, download and link card. */
export const shareCardSize = { width: 1200, height: 675 }

type ShareTemplate = 'snapshot' | 'experience' | 'minimal'
const TEMPLATES: ShareTemplate[] = ['snapshot', 'experience', 'minimal']
export const templateForVariant = (v: number): ShareTemplate => TEMPLATES[Math.abs(Math.trunc(v)) % TEMPLATES.length]!

const NAVY = '#020E18'
const CYAN = '#22D3EE'
const MINT = '#2DE0C0'

/** Brand colour per chain (drives the coin tint when there is no bespoke artwork). */
const CHAIN_COLOR: Record<string, string> = {
  BSC: '#F3BA2F', ETH: '#627EEA', TRON: '#EB0029', SOL: '#9945FF', MATIC: '#8247E5', ARB: '#28A0F0', BASE: '#0052FF',
  OP: '#FF0420', AVAX: '#E84142', TON: '#0098EA', SUI: '#4DA2FF', APTOS: '#12B5A6', APT: '#12B5A6', BTC: '#F7931A',
}

// ── Assets ────────────────────────────────────────────────────────────────────

let fontCache: { name: string; data: ArrayBuffer; weight: 500 | 700 | 800; style: 'normal' }[] | null = null

async function loadFont(weight: 500 | 700 | 800): Promise<ArrayBuffer | null> {
  try {
    const css = await (
      await fetch(`https://fonts.googleapis.com/css2?family=Inter:wght@${weight}`, {
        // An old Safari UA makes Google return a TTF, which is what the renderer needs.
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1' },
      })
    ).text()
    const url = css.match(/src: url\((.+?)\) format\('(?:opentype|truetype)'\)/)?.[1]
    if (!url) return null
    const res = await fetch(url)
    return res.ok ? await res.arrayBuffer() : null
  } catch {
    return null
  }
}

async function fonts() {
  if (fontCache) return fontCache
  const weights = [500, 700, 800] as const
  const loaded = await Promise.all(weights.map((w) => loadFont(w)))
  const out = weights.flatMap((w, i) => (loaded[i] ? [{ name: 'Inter', data: loaded[i]!, weight: w, style: 'normal' as const }] : []))
  // Only cache a complete set so a transient failure doesn't pin the plain fallback font.
  if (out.length === weights.length) fontCache = out
  return out
}

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

const assetCache = new Map<string, string | null>()

/** Fetch an image and inline it, so the renderer never depends on content-type sniffing. */
async function dataUri(url: string): Promise<string | null> {
  if (assetCache.has(url)) return assetCache.get(url)!
  let out: string | null = null
  try {
    const res = await fetch(url)
    if (res.ok) {
      const type = res.headers.get('content-type')?.split(';')[0] || (url.endsWith('.svg') ? 'image/svg+xml' : url.endsWith('.jpg') ? 'image/jpeg' : 'image/png')
      out = `data:${type};base64,${b64(await res.arrayBuffer())}`
    }
  } catch { /* fall through to null */ }
  assetCache.set(url, out)
  return out
}

const abs = (u: string) => (u.startsWith('/') ? `${BASE_URL}${u}` : u)

/** Chain logo: bundled official mark → admin upload → network CDN. First one that loads wins. */
async function chainLogo(chainKey: string, uploaded: string | null): Promise<string | null> {
  const key = normalizeChain(chainKey)
  for (const u of [CHAIN_LOGO_LOCAL[key], uploaded, CHAIN_LOGO_STATIC[key]]) {
    if (!u) continue
    const d = await dataUri(abs(u))
    if (d) return d
  }
  return null
}

// ── Colour helpers ────────────────────────────────────────────────────────────

function mix(hex: string, other: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const a = p(hex), b = p(other)
  return `#${a.map((v, i) => Math.round(v + (b[i]! - v) * t).toString(16).padStart(2, '0')).join('')}`
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function Coin({ color, logo, symbol }: { color: string; logo: string | null; symbol: string }) {
  const light = mix(color, '#ffffff', 0.45)
  const dark = mix(color, '#000000', 0.45)
  return (
    <div style={{ position: 'absolute', left: 640, top: 0, width: 560, height: 675, display: 'flex' }}>
      <div style={{ position: 'absolute', left: 70, top: 100, width: 420, height: 420, borderRadius: 210, border: `2px solid rgba(34,211,238,0.28)`, display: 'flex' }} />
      <div style={{ position: 'absolute', left: 110, top: 140, width: 340, height: 340, borderRadius: 170, border: `3px solid rgba(34,211,238,0.5)`, display: 'flex' }} />
      <div style={{ position: 'absolute', left: 40, top: 470, width: 480, height: 90, borderRadius: 240, display: 'flex', background: 'radial-gradient(ellipse at 50% 40%, rgba(34,211,238,0.35) 0%, rgba(2,14,24,0) 70%)' }} />
      <div
        style={{
          position: 'absolute', left: 130, top: 120, width: 300, height: 300, borderRadius: 150, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `radial-gradient(circle at 32% 28%, ${light} 0%, ${color} 50%, ${dark} 100%)`,
          boxShadow: `0 0 90px ${color}88, inset 0 0 0 12px ${dark}`,
        }}
      >
        <div style={{ position: 'absolute', left: 26, top: 26, width: 248, height: 248, borderRadius: 124, border: '4px solid rgba(255,255,255,0.35)', display: 'flex' }} />
        <div style={{ width: 150, height: 150, borderRadius: 75, background: 'rgba(255,255,255,0.94)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} width={104} height={104} alt="" style={{ objectFit: 'contain' }} />
          ) : (
            <span style={{ fontSize: 44, fontWeight: 800, color: dark }}>{symbol.slice(0, 4)}</span>
          )}
        </div>
      </div>
    </div>
  )
}

const CheckIcon = ({ size = 56 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 56 56">
    <circle cx="28" cy="28" r="25" fill="none" stroke={MINT} strokeWidth="3.5" />
    <path d="M17 29.5 L25 37 L40 20" fill="none" stroke={MINT} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const LinkIcon = () => (
  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke={CYAN} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
    <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
  </svg>
)

function ChainBadge({ logo, symbol, color, size }: { logo: string | null; symbol: string; color: string; size: number }) {
  if (logo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logo} width={size} height={size} alt="" style={{ objectFit: 'contain' }} />
  }
  return (
    <div style={{ width: size, height: size, borderRadius: size / 2, background: color, color: '#fff', fontSize: size * 0.36, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {symbol.slice(0, 3)}
    </div>
  )
}

// ── Card ──────────────────────────────────────────────────────────────────────

/**
 * The branded graphic for a delivered gas order. Everything that varies (amount, coin, chain, payment
 * currency, logo, colours) comes from the order; the layout and artwork are fixed so every card keeps
 * the approved RupChain look. Only a delivered order ever produces a "complete" card.
 */
export async function renderShareCard(data: PublicShareData | null, variant = 0): Promise<ImageResponse> {
  const template = templateForVariant(variant)
  const key = data ? normalizeChain(data.chainKey) : 'BSC'
  const color = CHAIN_COLOR[key] ?? '#22D3EE'
  const [fontList, brand, logo, hero] = await Promise.all([
    fonts(),
    dataUri(`${BASE_URL}/brand/icon-512.png`),
    data ? chainLogo(data.chainKey, data.chainLogoUrl) : Promise.resolve(null),
    // The approved BNB artwork is reused as-is for BNB; other chains get the generated coin.
    key === 'BSC' ? dataUri(`${BASE_URL}/brand/share/hero-bsc.png`) : Promise.resolve(null),
  ])

  const symbol = data?.symbol ?? 'Gas'
  const title = (() => {
    if (!data) return { a: 'Crypto gas,', b: 'made simple.' }
    if (template === 'experience') return { a: `Needed a little ${symbol}`, b: 'for gas.' }
    if (template === 'minimal') return { a: 'Gas sorted.', b: 'Back on-chain.' }
    return { a: `${symbol} gas,`, b: 'topped up.' }
  })()
  // Fit the longest line into the text column; long symbols or chain names shrink instead of wrapping.
  const size = Math.min(template === 'experience' ? 72 : 96, Math.floor(600 / (Math.max(title.a.length, title.b.length) * 0.55)))

  return new ImageResponse(
    (
      <div style={{ width: 1200, height: 675, display: 'flex', position: 'relative', backgroundColor: NAVY, backgroundImage: 'radial-gradient(circle at 80% 38%, rgba(14,116,144,0.55) 0%, rgba(2,14,24,0) 55%)', fontFamily: 'Inter, sans-serif', color: '#fff' }}>
        {hero ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={hero} width={568} height={675} alt="" style={{ position: 'absolute', left: 632, top: 0, width: 568, height: 675 }} />
            <div style={{ position: 'absolute', left: 632, top: 0, width: 150, height: 675, display: 'flex', background: `linear-gradient(90deg, ${NAVY} 0%, rgba(2,14,24,0) 100%)` }} />
          </>
        ) : (
          <Coin color={color} logo={logo} symbol={symbol} />
        )}

        {/* Brand */}
        <div style={{ position: 'absolute', left: 62, top: 44, display: 'flex', alignItems: 'center', gap: 20 }}>
          {brand ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand} width={78} height={78} alt="" style={{ borderRadius: 18 }} />
          ) : null}
          <div style={{ display: 'flex', fontSize: 46, fontWeight: 700 }}>
            <span>Rup</span>
            <span style={{ color: CYAN }}>Chain</span>
          </div>
        </div>

        {/* Headline */}
        <div style={{ position: 'absolute', left: 62, top: template === 'experience' ? 150 : 140, width: 600, display: 'flex', flexDirection: 'column', fontSize: size, fontWeight: 800, lineHeight: 1.06, letterSpacing: -2, whiteSpace: 'nowrap' }}>
          <span>{title.a}</span>
          <span style={{ color: MINT }}>{title.b}</span>
        </div>

        {/* Facts */}
        {data && template === 'snapshot' && (
          <div style={{ position: 'absolute', left: 60, top: 392, width: 640, height: 112, borderRadius: 22, border: '1.5px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', padding: '0 26px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 1 }}>
              <ChainBadge logo={logo} symbol={symbol} color={color} size={62} />
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 34, fontWeight: 800 }}>{data.amount} {symbol}</span>
                <span style={{ fontSize: 22, fontWeight: 500, color: 'rgba(255,255,255,0.72)' }}>{data.chainName}</span>
              </div>
            </div>
            <div style={{ width: 1.5, height: 64, background: 'rgba(255,255,255,0.16)', display: 'flex' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, paddingLeft: 24 }}>
              <CheckIcon size={52} />
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 24, fontWeight: 700 }}>Paid with {data.paidWith}</span>
                <span style={{ fontSize: 22, fontWeight: 500, color: 'rgba(255,255,255,0.72)' }}>Delivered to wallet</span>
              </div>
            </div>
          </div>
        )}
        {data && template === 'experience' && (
          <div style={{ position: 'absolute', left: 62, top: 340, width: 600, display: 'flex', flexDirection: 'column', gap: 22 }}>
            <span style={{ fontSize: 34, fontWeight: 500, color: 'rgba(255,255,255,0.85)' }}>Topped up through RupChain.</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, height: 64 }}>
              <ChainBadge logo={logo} symbol={symbol} color={color} size={52} />
              <span style={{ fontSize: 30, fontWeight: 800 }}>{data.amount} {symbol}</span>
              {data.chainName.toLowerCase() !== symbol.toLowerCase() && <span style={{ fontSize: 24, fontWeight: 500, color: 'rgba(255,255,255,0.72)' }}>on {data.chainName}</span>}
            </div>
            <span style={{ fontSize: 24, fontWeight: 500, color: 'rgba(255,255,255,0.72)' }}>Paid with {data.paidWith}. Delivered to wallet.</span>
          </div>
        )}
        {data && template === 'minimal' && (
          <div style={{ position: 'absolute', left: 62, top: 360, display: 'flex', alignItems: 'center', gap: 14 }}>
            <ChainBadge logo={logo} symbol={symbol} color={color} size={44} />
            <span style={{ fontSize: 28, fontWeight: 500, color: 'rgba(255,255,255,0.8)' }}>{data.chainName} · Powered by RupChain</span>
          </div>
        )}
        {!data && (
          <span style={{ position: 'absolute', left: 62, top: 380, fontSize: 30, fontWeight: 500, color: 'rgba(255,255,255,0.8)' }}>Pay in PKR or USDT, from an exchange or a wallet.</span>
        )}

        {/* Footer */}
        <div style={{ position: 'absolute', left: 62, bottom: 44, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <LinkIcon />
            <span style={{ fontSize: 32, fontWeight: 700, color: CYAN }}>rupchain.com/gas</span>
          </div>
          <span style={{ fontSize: 22, fontWeight: 500, color: 'rgba(255,255,255,0.6)' }}>Crypto gas fees, made simple.</span>
        </div>
      </div>
    ),
    { ...shareCardSize, ...(fontList.length ? { fonts: fontList } : {}) },
  )
}
