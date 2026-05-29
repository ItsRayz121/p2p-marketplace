'use client'
import { useState, useCallback } from 'react'
import { apiRequest } from '@/lib/api'

type UploadType = 'kyc-front' | 'kyc-back' | 'kyc-selfie' | 'payment-proof' | 'merchant-proof' | 'avatar'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
const MAX_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB

interface UseFileUploadReturn {
  upload: (file: File) => Promise<string>
  uploading: boolean
  error: string | null
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
  }
}

export function useFileUpload(type: UploadType): UseFileUploadReturn {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const upload = useCallback(async (file: File): Promise<string> => {
    setError(null)

    if (!ALLOWED_TYPES.includes(file.type as typeof ALLOWED_TYPES[number])) {
      const msg = 'Only JPEG, PNG, and WebP images are allowed.'
      setError(msg)
      throw new Error(msg)
    }

    if (file.size > MAX_SIZE_BYTES) {
      const msg = 'File size must be 10 MB or less.'
      setError(msg)
      throw new Error(msg)
    }

    setUploading(true)
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
      form.append('file', file)

      const cloudRes = await fetch(url, { method: 'POST', body: form })
      let cloudData: { secure_url?: string; error?: { message?: string } } = {}
      try { cloudData = await cloudRes.json() } catch { /* ignore */ }

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
    }
  }, [type])

  return { upload, uploading, error }
}
