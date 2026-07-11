'use client'
import { useState, useCallback } from 'react'
import { apiRequest } from '@/lib/api'

type UploadType = 'kyc-front' | 'kyc-back' | 'kyc-selfie' | 'kyc-video' | 'payment-proof' | 'merchant-proof' | 'avatar' | 'chat-image' | 'blog-image' | 'giveaway-image'

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm']
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10 MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024 // 50 MB

/** Live upload progress in bytes. `pct` is 0–100 (0 until the first tick). */
export interface UploadProgress {
  loaded: number
  total: number
  pct: number
}

interface UseFileUploadReturn {
  upload: (file: File) => Promise<string>
  uploading: boolean
  error: string | null
  /** Non-null while an upload is in flight — drives the progress bar + MB readout. */
  progress: UploadProgress | null
}

// POST a multipart form to Cloudinary with real upload-progress events. `fetch`
// can't report progress, so we drop to XHR for the transfer itself.
function xhrUpload(
  url: string,
  form: FormData,
  onProgress: (p: UploadProgress) => void,
): Promise<{ ok: boolean; status: number; body: { secure_url?: string; error?: { message?: string } } }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress({ loaded: e.loaded, total: e.total, pct: Math.round((e.loaded / e.total) * 100) })
      }
    }
    xhr.onload = () => {
      let body: { secure_url?: string; error?: { message?: string } } = {}
      try { body = JSON.parse(xhr.responseText) } catch { /* ignore */ }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body })
    }
    xhr.onerror = () => reject(new Error('Network error during upload. Please try again.'))
    xhr.send(form)
  })
}

interface PresignResponse {
  url: string
  publicUrl: string
  fields: {
    api_key: string
    timestamp: number
    public_id: string
    folder: string
    signature: string
    // Present for KYC documents — uploads them as `authenticated` assets so
    // the bare URL is not publicly viewable (server signs delivery URLs).
    type?: string
  }
}

export function useFileUpload(type: UploadType): UseFileUploadReturn {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<UploadProgress | null>(null)

  const upload = useCallback(async (file: File): Promise<string> => {
    setError(null)

    const isVideo = type === 'kyc-video'
    const allowed = isVideo ? ALLOWED_VIDEO_TYPES : ALLOWED_IMAGE_TYPES
    const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES

    if (!allowed.includes(file.type)) {
      const msg = isVideo
        ? 'Only MP4, MOV, and WebM videos are allowed.'
        : 'Only JPEG, PNG, and WebP images are allowed.'
      setError(msg)
      throw new Error(msg)
    }

    if (file.size > maxBytes) {
      const msg = `File size must be ${isVideo ? '50' : '10'} MB or less.`
      setError(msg)
      throw new Error(msg)
    }

    setUploading(true)
    // Seed a 0% tick immediately so the bar shows the total size before the first
    // network progress event lands.
    setProgress({ loaded: 0, total: file.size, pct: 0 })
    try {
      const { url, publicUrl, fields } = await apiRequest<PresignResponse>('/upload/presign', {
        method: 'POST',
        body: JSON.stringify({ type, mimeType: file.type }),
      })

      // Cloudinary signed upload requires POST multipart/form-data with the
      // exact fields that were signed on the server.
      const form = new FormData()
      form.append('api_key', String(fields.api_key))
      form.append('timestamp', String(fields.timestamp))
      form.append('public_id', String(fields.public_id))
      form.append('folder', String(fields.folder))
      form.append('signature', String(fields.signature))
      if (fields.type) form.append('type', String(fields.type))
      form.append('file', file)

      const cloudRes = await xhrUpload(url, form, setProgress)
      const cloudData = cloudRes.body

      if (!cloudRes.ok || !cloudData.secure_url) {
        const msg = cloudData.error?.message ?? `Upload failed (HTTP ${cloudRes.status}). Please try again.`
        throw new Error(msg)
      }

      return cloudData.secure_url ?? publicUrl
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed.'
      setError(msg)
      throw err
    } finally {
      setUploading(false)
      setProgress(null)
    }
  }, [type])

  return { upload, uploading, error, progress }
}
