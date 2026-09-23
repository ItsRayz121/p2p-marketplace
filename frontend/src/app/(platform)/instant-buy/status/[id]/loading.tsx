import { Skeleton } from '@/components/ui/Skeleton'

export default function Loading() {
  return (
    <div className="max-w-xl mx-auto px-4 py-8 space-y-6">
      <Skeleton className="h-7 w-32" />
      <Skeleton className="h-11 w-full rounded-lg" />
    </div>
  )
}
