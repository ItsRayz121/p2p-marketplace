import { fetchPublicShare } from '@/lib/shareCardServer'
import { renderShareCard } from '@/lib/shareCardImage'

export const runtime = 'edge'

/**
 * The one share graphic: shown in the card preview, downloaded, shared as a file and unfurled by X.
 * `?v=` picks the template; the order facts come from the delivered order, never from the URL.
 */
export async function GET(req: Request, { params }: { params: Promise<{ orderRef: string }> }) {
  const { orderRef } = await params
  const v = Number(new URL(req.url).searchParams.get('v') ?? '0')
  const res = await renderShareCard(await fetchPublicShare(orderRef.slice(0, 40)), Number.isFinite(v) ? v : 0)
  res.headers.set('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600')
  return res
}
