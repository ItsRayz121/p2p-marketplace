import { v2 as cloudinary } from 'cloudinary'
import { env } from './env'

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
})

export { cloudinary }

// Allowed upload folders — enforced in upload service
export const CLOUDINARY_FOLDERS = {
  KYC_FRONT: 'pakswap/kyc/front',
  KYC_BACK: 'pakswap/kyc/back',
  KYC_SELFIE: 'pakswap/kyc/selfie',
  PAYMENT_PROOF: 'pakswap/payment-proof',
  MERCHANT_PROOF: 'pakswap/merchant/proof',
} as const

// Max file sizes in bytes
export const UPLOAD_LIMITS = {
  KYC_IMAGE: 5 * 1024 * 1024,      // 5MB
  PAYMENT_PROOF: 10 * 1024 * 1024, // 10MB
} as const
