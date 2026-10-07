// Server-side fetch of the non-identifying facts behind a public share page / preview image.
// Plain fetch (no client-only imports), same reasoning as marketsFetch.ts.

export interface PublicShareData {
  amount: string
  symbol: string
  chainName: string
  paidWith: 'PKR' | 'USDT'
  refCode: string | null
  discountPct: number
}

function normaliseOrigin(raw: string): string {
  let v = raw.trim().replace(/\/$/, '')
  if (v && !/^https?:\/\//i.test(v)) v = `https://${v}`
  return v
}

const API = normaliseOrigin(process.env.BACKEND_ORIGIN_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001')

export async function fetchPublicShare(orderRef: string): Promise<PublicShareData | null> {
  try {
    const res = await fetch(`${API}/api/v1/gas-fee/share/public/${encodeURIComponent(orderRef)}`, { next: { revalidate: 300 } })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: PublicShareData }
    return body.data ?? null
  } catch {
    return null
  }
}
