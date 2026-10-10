/** Responsive attrs for Cloudinary-hosted images (auto format/quality, width ladder); other hosts pass through untouched. */
const CLOUDINARY_UPLOAD = /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(?![^/]*\b[fqw]_)(.+)$/

export function responsiveCover(url: string): { src: string; srcSet?: string; sizes?: string } {
  const m = CLOUDINARY_UPLOAD.exec(url)
  if (!m) return { src: url }
  const at = (w: number) => `${m[1]}f_auto,q_auto,w_${w}/${m[2]} ${w}w`
  return {
    src: `${m[1]}f_auto,q_auto,w_1200/${m[2]}`,
    srcSet: [480, 800, 1200].map(at).join(', '),
    sizes: '(min-width: 768px) 768px, 100vw',
  }
}
