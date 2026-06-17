'use client'
// Per-user dismissible banner for admin broadcast announcements (the "web"
// channel). Fetches the active, not-yet-dismissed banners for the signed-in
// user and renders them stacked below the navbar. Dismissal is persisted
// server-side so it stays gone across devices.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { announcementApi, type AnnouncementBanner as Banner } from '@/lib/api'

function isInternal(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//')
}

export function AnnouncementBanner() {
  const [banners, setBanners] = useState<Banner[]>([])

  useEffect(() => {
    let active = true
    announcementApi
      .getActiveBanners()
      .then((res) => { if (active) setBanners(res.banners) })
      .catch(() => { /* silent — banner is non-critical */ })
    return () => { active = false }
  }, [])

  const dismiss = (id: string) => {
    setBanners((prev) => prev.filter((b) => b.id !== id))
    void announcementApi.dismissBanner(id).catch(() => { /* already hidden locally */ })
  }

  if (banners.length === 0) return null

  return (
    <>
      {banners.map((b) => (
        <div
          key={b.id}
          className="border-b border-primary/20 bg-primary/10 px-4 py-2.5 flex items-center justify-between gap-4 text-sm text-primary"
        >
          <div className="flex-1 min-w-0">
            <span className="font-semibold">📢 {b.title}</span>
            <span className="text-text-secondary"> — {b.body}</span>
            {b.linkUrl && (
              isInternal(b.linkUrl) ? (
                <Link href={b.linkUrl} className="ml-2 font-semibold underline underline-offset-2 hover:opacity-80">
                  Open
                </Link>
              ) : (
                <a href={b.linkUrl} target="_blank" rel="noopener noreferrer" className="ml-2 font-semibold underline underline-offset-2 hover:opacity-80">
                  Open
                </a>
              )
            )}
          </div>
          <button
            onClick={() => dismiss(b.id)}
            aria-label="Dismiss announcement"
            className="flex-shrink-0 p-1 rounded hover:opacity-70 transition-opacity"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </>
  )
}
