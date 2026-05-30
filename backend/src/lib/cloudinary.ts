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
  PAYMENT_PROOF: 'rupchain/payment-proof',
  MERCHANT_PROOF: 'rupchain/merchant/proof',
  CTM_PAYMENT_PROOF: 'rupchain/ctm/payment-proof',
  CTM_TOKEN_PROOF: 'rupchain/ctm/token-proof',
  CTM_TOKEN_LOGO: 'rupchain/ctm/token-logos',
  GAS_LOGO: 'rupchain/gas/logos',
  AVATAR: 'rupchain/avatars',
} as const

// Max file sizes in bytes
export const UPLOAD_LIMITS = {
  KYC_IMAGE: 5 * 1024 * 1024,      // 5MB
  PAYMENT_PROOF: 10 * 1024 * 1024, // 10MB
} as const
