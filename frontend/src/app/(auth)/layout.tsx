export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-lg p-8">
        <div className="text-center mb-8">
          <h1 className="text-primary font-bold text-2xl tracking-tight">PakSwap</h1>
          <p className="text-text-muted text-sm mt-1">Pakistan&apos;s P2P Crypto Marketplace</p>
        </div>
        {children}
      </div>
    </div>
  )
}
