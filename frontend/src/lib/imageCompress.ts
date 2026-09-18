// Client-side downscale/re-encode before upload — keeps broadcast images small
// (fewer bytes stored, fewer bytes served on every fan-out view) without
// needing any server-side processing. Falls back to the original file if the
// browser can't do canvas encoding, so a picked image always makes it to send.
export async function compressImage(file: File, opts: { maxDimension?: number; quality?: number } = {}): Promise<File> {
  const { maxDimension = 1600, quality = 0.82 } = opts
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file

  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close?.()

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
    if (!blob || blob.size >= file.size) return file // re-encoding didn't help — keep the original

    const newName = file.name.replace(/\.\w+$/, '') + '.jpg'
    return new File([blob], newName, { type: 'image/jpeg' })
  } catch {
    return file
  }
}
