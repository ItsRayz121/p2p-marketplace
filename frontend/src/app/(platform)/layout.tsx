'use client'
import { useState, useCallback, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import Navbar from '@/components/layout/Navbar'
import Footer from '@/components/layout/Footer'
import BottomNav from '@/components/layout/BottomNav'
import { usePolling } from '@/hooks/usePolling'
import { marketplaceApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { prefetchCommonScreens } from '@/lib/prefetch'
import { PushOptInBanner } from '@/components/ui/PushOptInBanner'
import { InstallAppBanner } from '@/components/ui/InstallAppBanner'
import { AnnouncementBanner } from '@/components/ui/AnnouncementBanner'
import { StartupLoader } from '@/components/ui/StartupLoader'

interface SiteConfig {
  site_notice?: string
  site_notice_type?: 'info' | 'warning' | 'danger'
}

function hashStr(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return String(h)
}

const noticeColors: Record<string, string> = {
  info: 'bg-primary/10 text-primary border-primary/20',
  warning: 'bg-warning/10 text-warning border-warning/20',
  danger: 'bg-danger/10 text-danger border-danger/20',
}

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const { isLoading: authLoading, user, accessToken } = useAuthStore()
  const [config, setConfig] = useState<SiteConfig>({})
  const [dismissed, setDismissed] = useState(false)
  const pathname = usePathname()
  // On mobile the marketing footer only belongs on the Home tab (where the page
  // is meant to scroll to the very bottom). On every other app surface — USDT
  // marketplace, CTM, Messages, trade rooms, etc. — the content is the end of
  // the page, so the footer is hidden on small screens and kept on desktop only.
  const isHomeTab = pathname === '/dashboard' || pathname === '/'

  const fetchConfig = useCallback(async () => {
    try {
      const data = await marketplaceApi.getConfig()
      setConfig(data as SiteConfig)
    } catch {
      // silently fail
    }
  }, [])

  usePolling(fetchConfig, 5 * 60_000, true)

  const notice = config.site_notice
  const noticeType = config.site_notice_type ?? 'info'
  const noticeHash = notice ? hashStr(notice) : ''

  // Two-tier dismissal: danger notices re-appear next session (urgent), info /
  // warning notices stay dismissed for 7 days via localStorage so daily users
  // don't see the same banner every tab open.
  useEffect(() => {
    if (!noticeHash) return
    const sessKey = `notice_dismissed_${noticeHash}`
    if (sessionStorage.getItem(sessKey) === '1') { setDismissed(true); return }
    if (noticeType !== 'danger') {
      try {
        const raw = localStorage.getItem(sessKey)
        if (raw) {
          const expiresAt = Number(raw)
          if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
            setDismissed(true)
            return
          }
          localStorage.removeItem(sessKey)
        }
      } catch { /* ignore quota errors */ }
    }
    setDismissed(false)
  }, [noticeHash, noticeType])

  const handleDismiss = () => {
    if (noticeHash) {
      const key = `notice_dismissed_${noticeHash}`
      sessionStorage.setItem(key, '1')
      if (noticeType !== 'danger') {
        try {
          const sevenDays = Date.now() + 7 * 24 * 3600_000
          localStorage.setItem(key, String(sevenDays))
        } catch { /* ignore */ }
      }
    }
    setDismissed(true)
  }

  // Once we hold a live session, quietly warm the screens people open next.
  useEffect(() => {
    if (user && accessToken) prefetchCommonScreens(user.id)
  }, [user, accessToken])

  const showNotice = notice && !dismissed

  return (
    <div className="flex flex-col min-h-screen">
      <Navbar />

      {showNotice && (
        <div className={`border-b px-4 py-2 flex items-center justify-between gap-4 text-sm ${noticeColors[noticeType] ?? noticeColors.info}`}>
          <p className="flex-1 text-center">{notice}</p>
          <button
            onClick={handleDismiss}
            aria-label="Dismiss notice"
            className="flex-shrink-0 p-1 rounded hover:opacity-70 transition-opacity"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {user?.tradingHold && (
        <div className="border-b border-danger/20 bg-danger/10 text-danger px-4 py-2 text-sm text-center">
          <strong>Trading hold:</strong> you cannot post ads or start trades right now.
          {user.tradingHoldReason ? ` Reason: ${user.tradingHoldReason}.` : ''} Answer your open dispute in Messages or contact support to have it lifted.
        </div>
      )}

      {user && <AnnouncementBanner />}

      {/* Hold page content until auth hydration finishes to avoid unauthenticated
          API calls racing with the refresh cycle in Providers.tsx */}
      {/* pb reserves space for the mobile BottomNav (FAB clears 64-80px) plus
          the device safe-area inset (home indicator / gesture bar), so content
          is never hidden behind the nav on notched phones or in Telegram.
          individual pages no longer need to add it themselves. */}
      <main className="flex-1 overflow-x-clip pb-[calc(6rem+env(safe-area-inset-bottom))] lg:pb-0">
        {authLoading ? <StartupLoader /> : children}
      </main>

      <div className={isHomeTab ? '' : 'hidden lg:block'}>
        <Footer />
      </div>
      <BottomNav />
      {user && <PushOptInBanner />}
      <InstallAppBanner />
    </div>
  )
}
