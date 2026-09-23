import { Skeleton } from '@/components/ui/Skeleton'

export default function Loading() {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-5">
      <Skeleton className="h-8 w-2/3" />
      <div className="flex flex-col gap-5 lg:flex-row">
        <Skeleton className="h-96 w-full rounded-xl lg:flex-1" />
        <Skeleton className="h-96 w-full rounded-xl lg:w-72" />
      </div>
    </div>
  )
}
