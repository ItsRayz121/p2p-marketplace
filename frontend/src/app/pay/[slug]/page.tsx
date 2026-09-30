import type { Metadata } from 'next'
import PublicPaymentView from './PublicPaymentView'

// A payment link is for the people it was sent to — never indexed or previewed in search.
export const metadata: Metadata = {
  title: 'Payment details',
  robots: { index: false, follow: false, nocache: true },
}

export default async function PublicPaymentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return <PublicPaymentView slug={slug} />
}
