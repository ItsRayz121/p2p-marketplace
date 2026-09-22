import MarketsChrome from './_components/MarketsChrome'

// No `metadata` export here — the list page and each [slug] detail page ship
// their own generateMetadata (unique per token), which takes precedence.
export default function MarketsLayout({ children }: { children: React.ReactNode }) {
  return <MarketsChrome>{children}</MarketsChrome>
}
