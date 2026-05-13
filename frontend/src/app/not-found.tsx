import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 text-center px-4">
      <div className="text-6xl font-bold text-brand-500">404</div>
      <h1 className="text-2xl font-semibold text-text-primary">Page not found</h1>
      <p className="text-text-muted max-w-sm">
        The page you&apos;re looking for doesn&apos;t exist or has been moved.
      </p>
      <Link
        href="/"
        className="px-4 py-2 bg-brand-500 text-white rounded-lg font-medium hover:bg-brand-600 transition-colors"
      >
        Go home
      </Link>
    </div>
  )
}
