import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Allowed CDN hostnames for user-uploaded images.
// Any URL not matching these is rejected before rendering to prevent
// open-redirect and foreign-image injection attacks.
const TRUSTED_IMAGE_HOSTS = [
  'res.cloudinary.com',
  'amazonaws.com',
  'cloudfront.net',
]

/**
 * Voice notes are stored as Cloudinary audio, which lives under the `video`
 * resource type (images are under /image/). The recorded length rides in the URL
 * fragment (`#d=<seconds>`), which Cloudinary ignores, so no schema change is needed.
 */
export function isVoiceNoteUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.hostname === 'res.cloudinary.com' && u.pathname.includes('/video/upload/')
  } catch {
    return false
  }
}

export function voiceNoteDuration(url: string): number | null {
  const m = /^#?d=(\d+)$/.exec(url.split('#')[1] ?? '')
  return m ? Number(m[1]) : null
}

export function isTrustedImageUrl(url: string | null | undefined): boolean {
  if (!url) return false
  // Allow local blob URLs created by URL.createObjectURL (KYC preview, etc.)
  if (url.startsWith('blob:')) return true
  // Allow data URIs (e.g. 2FA QR codes generated server-side)
  if (url.startsWith('data:')) return true
  try {
    const { hostname } = new URL(url)
    return TRUSTED_IMAGE_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`))
  } catch {
    return false
  }
}
