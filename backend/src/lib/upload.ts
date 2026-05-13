import { AppError } from './errors'

export function assertCloudinaryUrl(url: string, field: string): void {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    throw new AppError('INVALID_URL', `${field} is not a valid URL`, 400)
  }
  if (!hostname.endsWith('res.cloudinary.com')) {
    throw new AppError('INVALID_URL', `${field} must be a Cloudinary URL`, 400)
  }
}
