'use client'
import { useState, useCallback, useEffect } from 'react'
import Navbar from '@/components/layout/Navbar'
import Footer from '@/components/layout/Footer'
import BottomNav from '@/components/layout/BottomNav'
import { usePolling } from '@/hooks/usePolling'
import { marketplaceApi } from '@/lib/api'
import { Web3Provider } from '@/lib/web3/Web3Provider'
import { useAuthStore } from '@/store/auth.store'

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
  const { isLoading: authLoading } = useAuthStore()
  const [config, setConfig] = useState<SiteConfig>({})
  const [dismissed, setDismissed] = useState(false)

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

  useEffect(() => {
    if (noticeHash) {
      const key = `notice_dismissed_${noticeHash}`
      setDismissed(sessionStorage.getItem(key) === '1')
    }
  }, [noticeHash])

  const handleDismiss = () => {
    if (noticeHash) {
      sessionStorage.setItem(`notice_dismissed_${noticeHash}`, '1')
    }
    setDismissed(true)
  }

  const showNotice = notice && !dismissed

  return (
    <Web3Provider>
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

        {/* Hold page content until auth hydration finishes to avoid unauthenticated
            API calls racing with the refresh cycle in Providers.tsx */}
        <main className="flex-1">
          {authLoading ? (
            <div className="flex items-center justify-center min-h-[60vh]">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : children}
        </main>

        <Footer />
        <BottomNav />
      </div>
    </Web3Provider>
  )
}
