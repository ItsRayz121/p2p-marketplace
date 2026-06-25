'use client'
import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { LoadingState } from '@/components/ui/LoadingState'

// Gas referrals have been merged into the single Referral hub (/referral), so this page is
// now a thin redirect that forwards any inbound ?ref= code so old shared links keep binding.
function GasReferralRedirect() {
  const router = useRouter()
  const params = useSearchParams()

  useEffect(() => {
    const ref = params.get('ref')
    router.replace(ref ? `/referral?ref=${encodeURIComponent(ref)}` : '/referral')
  }, [router, params])

  return <div className="max-w-xl mx-auto px-4 py-10"><LoadingState message="Taking you to your referral hub…" /></div>
}

export default function GasReferralPage() {
  return (
    <Suspense fallback={<div className="max-w-xl mx-auto px-4 py-10"><LoadingState message="Loading…" /></div>}>
      <GasReferralRedirect />
    </Suspense>
  )
}
