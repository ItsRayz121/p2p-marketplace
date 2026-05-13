import { Spinner } from './Spinner'

interface LoadingStateProps {
  message?: string
}

export function LoadingState({ message = 'Loading...' }: LoadingStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full w-full gap-3 py-16 text-text-muted">
      <Spinner size="lg" />
      <p className="text-sm">{message}</p>
    </div>
  )
}
