'use client'
import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

/**
 * First-touch referral capture.
 *
 * A shared trade link doubles as a referral link: it carries `?ref=<code>`.
 * When a brand-new visitor opens such a link we stash the code in localStorage
 * under the same `referralCode` key the /register flow already consumes, so
 * signup attributes them to the sharer.
 *
 * Rules (match "bind only brand-new signups"):
 *  - First-touch wins: never overwrite an already-captured code.
 *  - Skip when the visitor is already logged in (they won't hit /register, and
 *    existing accounts must not be re-attributed).
 */
export default function ReferralCapture() {
  const pathname = usePathname()

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const ref = new URLSearchParams(window.location.search).get('ref')
      if (!ref) return
      // Already logged in → do nothing (existing users just open the trade).
      const isAuthed = document.cookie.split('; ').some((c) => c.startsWith('rupchain_auth='))
      if (isAuthed) return
      // First-touch: don't clobber a previously captured referrer.
      if (localStorage.getItem('referralCode')) return
      // Basic sanity: referral codes are short alphanumerics.
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(ref)) return
      localStorage.setItem('referralCode', ref)
    } catch {
      /* ignore — capture is best-effort */
    }
  }, [pathname])

  return null
}
