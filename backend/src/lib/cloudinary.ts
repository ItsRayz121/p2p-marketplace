import { v2 as cloudinary } from 'cloudinary'
import { env } from './env'

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME ?? '',
  api_key: env.CLOUDINARY_API_KEY ?? '',
  api_secret: env.CLOUDINARY_API_SECRET ?? '',
  secure: true,
})

export { cloudinary }

// Allowed upload folders — enforced in upload service
export const CLOUDINARY_FOLDERS = {
  KYC_FRONT: 'rupchain/kyc/front',
  KYC_BACK: 'rupchain/kyc/back',
  KYC_SELFIE: 'rupchain/kyc/selfie',
  KYC_VIDEO: 'rupchain/kyc/video',
  PAYMENT_PROOF: 'rupchain/payment-proof',
  MERCHANT_PROOF: 'rupchain/merchant/proof',
  CTM_PAYMENT_PROOF: 'rupchain/ctm/payment-proof',
  CTM_TOKEN_PROOF: 'rupchain/ctm/token-proof',
  CTM_TOKEN_LOGO: 'rupchain/ctm/token-logos',
  GAS_LOGO: 'rupchain/gas/logos',
  AVATAR: 'rupchain/avatars',
  CHAT_IMAGE: 'rupchain/trade/chat',
  APPEAL_EVIDENCE: 'rupchain/appeals/evidence',
  BLOG_IMAGE: 'rupchain/blog',
  GIVEAWAY_IMAGE: 'rupchain/giveaways',
} as const

// Max file sizes in bytes
export const UPLOAD_LIMITS = {
  KYC_IMAGE: 5 * 1024 * 1024,      // 5MB
  PAYMENT_PROOF: 10 * 1024 * 1024, // 10MB
} as const

/**
 * Convert a stored Cloudinary URL into a signed delivery URL when the asset
 * was uploaded with type=authenticated (KYC documents). Authenticated assets
 * 404 without a valid signature, so the bare stored URL is useless to anyone
 * who leaks it — only this server can mint a viewable link.
 *
 * Legacy assets (delivery type `upload`, publicly accessible) and non-Cloudinary
 * URLs are returned unchanged, so mixed old/new submissions keep working.
 */
export function signCloudinaryDeliveryUrl(storedUrl: string | null | undefined): string | null {
  if (!storedUrl) return null
  try {
    const u = new URL(storedUrl)
    if (!u.hostname.endsWith('res.cloudinary.com')) return storedUrl
    // Path shape: /<cloud_name>/<resource_type>/<delivery_type>/[v<version>/]<public_id…>[.<ext>]
    const parts = u.pathname.split('/').filter(Boolean)
    const [, resourceType, deliveryType, ...rest] = parts
    if (deliveryType !== 'authenticated' || rest.length === 0) return storedUrl
    // Cloudinary's upload-response secure_url includes a version segment —
    // strip it (cloudinary.url adds its own) along with the file extension.
    const segments = rest[0] && /^v\d+$/.test(rest[0]) ? rest.slice(1) : rest
    if (segments.length === 0) return storedUrl
    const last = segments[segments.length - 1]!
    const dotIdx = last.lastIndexOf('.')
    const format = dotIdx > 0 ? last.slice(dotIdx + 1) : undefined
    const publicId = [...segments.slice(0, -1), dotIdx > 0 ? last.slice(0, dotIdx) : last].join('/')
    return cloudinary.url(publicId, {
      resource_type: resourceType ?? 'image',
      type: 'authenticated',
      sign_url: true,
      secure: true,
      ...(format ? { format } : {}),
    })
  } catch {
    return storedUrl
  }
}

/**
 * Parse a stored Cloudinary URL into its retrieval parts (public_id, resource
 * type, format, delivery type). Returns null for non-Cloudinary URLs.
 */
function parseCloudinaryUrl(storedUrl: string): {
  resourceType: string
  deliveryType: string
  publicId: string
  format?: string
} | null {
  try {
    const u = new URL(storedUrl)
    if (!u.hostname.endsWith('res.cloudinary.com')) return null
    const parts = u.pathname.split('/').filter(Boolean)
    const [, resourceType, deliveryType, ...rest] = parts
    if (!resourceType || !deliveryType || rest.length === 0) return null
    const segments = rest[0] && /^v\d+$/.test(rest[0]) ? rest.slice(1) : rest
    if (segments.length === 0) return null
    const last = segments[segments.length - 1]!
    const dotIdx = last.lastIndexOf('.')
    const format = dotIdx > 0 ? last.slice(dotIdx + 1) : undefined
    const publicId = [...segments.slice(0, -1), dotIdx > 0 ? last.slice(0, dotIdx) : last].join('/')
    return { resourceType, deliveryType, publicId, ...(format ? { format } : {}) }
  } catch {
    return null
  }
}

/**
 * Retrieve the raw bytes of a stored Cloudinary asset server-side. For
 * authenticated (private) KYC assets it tries the signed delivery URL first,
 * then falls back to a signed private-download URL — so the admin reviewer's
 * browser never has to load a private Cloudinary URL directly (which CSP /
 * cross-site rules can block). Returns null if the asset can't be fetched.
 */
export async function fetchCloudinaryAsset(
  storedUrl: string | null | undefined,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!storedUrl) return null

  const attempt = async (url: string): Promise<{ buffer: Buffer; contentType: string } | null> => {
    try {
      const res = await fetch(url)
      if (!res.ok) return null
      const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
      const buffer = Buffer.from(await res.arrayBuffer())
      return { buffer, contentType }
    } catch {
      return null
    }
  }

  // 1) Signed delivery URL (works for both public `upload` and `authenticated`).
  const signed = signCloudinaryDeliveryUrl(storedUrl)
  if (signed) {
    const r = await attempt(signed)
    if (r) return r
  }

  // 2) Fallback: signed private-download URL for authenticated assets.
  const parsed = parseCloudinaryUrl(storedUrl)
  if (parsed && parsed.deliveryType === 'authenticated') {
    try {
      const downloadUrl = cloudinary.utils.private_download_url(
        parsed.publicId,
        parsed.format ?? '',
        { resource_type: parsed.resourceType, type: 'authenticated' },
      )
      const r = await attempt(downloadUrl)
      if (r) return r
    } catch {
      /* fall through */
    }
  }

  // 3) Last resort: the raw stored URL (works for legacy public `upload` assets).
  return attempt(storedUrl)
}
