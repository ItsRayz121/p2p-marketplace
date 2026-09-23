import { Skeleton } from '@/components/ui/Skeleton'

export default function Loading() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-4 h-[calc(100dvh-4rem)] flex flex-col justify-end gap-3">
      <Skeleton className="h-10 w-2/3 rounded-2xl self-start" />
      <Skeleton className="h-10 w-1/2 rounded-2xl self-end" />
      <Skeleton className="h-16 w-3/4 rounded-2xl self-start" />
      <Skeleton className="h-10 w-1/3 rounded-2xl self-end" />
    </div>
  )
}
