import { fetchPublicShare } from '@/lib/shareCardServer'
import { renderShareCard, shareCardSize } from '@/lib/shareCardImage'

export const runtime = 'edge'
export const alt = 'RupChain gas order'
export const size = shareCardSize
export const contentType = 'image/png'

export default async function Image({ params }: { params: Promise<{ orderRef: string }> }) {
  const { orderRef } = await params
  return renderShareCard(await fetchPublicShare(orderRef))
}
