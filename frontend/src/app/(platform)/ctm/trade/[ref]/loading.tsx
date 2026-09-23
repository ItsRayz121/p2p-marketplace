import { Skeleton } from '@/components/ui/Skeleton'

export default function Loading() {
  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
      <Skeleton className="h-8 w-2/3" />
      <div className="flex flex-col gap-5 lg:flex-row">
        <Skeleton className="h-80 w-full rounded-xl lg:flex-1" />
        <Skeleton className="h-80 w-full rounded-xl lg:w-72" />
      </div>
    </div>
  )
}
