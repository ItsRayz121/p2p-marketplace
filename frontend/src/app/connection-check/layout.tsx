import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Connection check',
  robots: { index: false, follow: false },
}

export default function ConnectionCheckLayout({ children }: { children: React.ReactNode }) {
  return children
}
