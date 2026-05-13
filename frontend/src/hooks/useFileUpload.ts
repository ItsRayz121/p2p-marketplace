'use client'
import { useState, useCallback } from 'react'
import { apiRequest } from '@/lib/api'

type UploadType = 'kyc-front' | 'kyc-back' | 'kyc-selfie' | 'payment-proof' | 'merchant-proof'

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
      const { url, publicUrl } = await apiRequest<PresignResponse>('/upload/presign', {
        method: 'POST',
        body: JSON.stringify({ type, mimeType: file.type }),
      })

      const putRes = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      })

      if (!putRes.ok) {
        throw new Error('Failed to upload file. Please try again.')
      }

      return publicUrl
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
