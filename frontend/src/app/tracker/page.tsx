import type { Metadata } from 'next'
import { GuestTracker } from '@/components/portfolio/GuestTracker'

export const metadata: Metadata = {
  title: 'Local portfolio tracker',
  description: 'Track your crypto investments privately in this browser, without an account.',
  // A private working tool, not a landing page.
  robots: { index: false, follow: false },
}

export default function TrackerPage() {
  return (
    <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <GuestTracker />
    </main>
  )
}
