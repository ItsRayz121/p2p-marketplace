import { Skeleton } from '@/components/ui/Skeleton'

export default function Loading() {
  return (
    <div className="max-w-xl mx-auto px-4 py-6 space-y-5">
      <Skeleton className="h-7 w-1/2" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  )
}
