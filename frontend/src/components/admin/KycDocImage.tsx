'use client'
import { useState, useEffect } from 'react'
import { adminApi } from '@/lib/api'

// Loads a KYC document (CNIC/selfie/video) by streaming its bytes through our
// own API origin as an object URL. KYC docs are authenticated Cloudinary assets
// that a direct <img src> can fail to load (CSP / cross-site); the proxy makes
// them render reliably. Falls back to a clear "couldn't load" state on error.
export function KycDocImage({
  submissionId, kind, label, isVideo,
}: {
  submissionId: string
  kind: 'front' | 'back' | 'selfie' | 'video'
  label: string
  isVideo?: boolean
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    setStatus('loading')
    setUrl(null)
    adminApi
      .getKycDocUrl(submissionId, kind)
      .then((u) => {
        if (cancelled) { URL.revokeObjectURL(u); return }
        objectUrl = u
        setUrl(u)
        setStatus('ready')
      })
      .catch(() => { if (!cancelled) setStatus('error') })
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [submissionId, kind])

  return (
    <div className="space-y-1">
      <p className="text-xs text-text-muted">{label}</p>
      {status === 'loading' && (
        <div className="rounded-lg w-full aspect-video border border-border bg-surface flex items-center justify-center text-xs text-text-muted animate-pulse">
          Loading…
        </div>
      )}
      {status === 'error' && (
        <div className="rounded-lg w-full aspect-video border border-danger/30 bg-danger/5 flex items-center justify-center text-xs text-danger text-center px-2">
          Couldn&apos;t load document
        </div>
      )}
      {status === 'ready' && url && (
        isVideo ? (
          <video src={url} controls className="rounded-lg w-full aspect-video object-contain border border-border bg-surface" />
        ) : (
          <a href={url} target="_blank" rel="noopener noreferrer">
            <img src={url} alt={label} className="rounded-lg w-full aspect-video object-contain border border-border hover:opacity-80 transition-opacity bg-surface" />
          </a>
        )
      )}
    </div>
  )
}
