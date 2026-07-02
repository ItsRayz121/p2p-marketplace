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
