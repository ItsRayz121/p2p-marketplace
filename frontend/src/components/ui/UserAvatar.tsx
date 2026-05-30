import { cn } from '@/lib/utils'

const PALETTE = [
  'bg-blue-100 text-blue-700',
  'bg-emerald-100 text-emerald-700',
  'bg-violet-100 text-violet-700',
  'bg-amber-100 text-amber-700',
  'bg-pink-100 text-pink-700',
  'bg-cyan-100 text-cyan-700',
  'bg-red-100 text-red-700',
  'bg-indigo-100 text-indigo-700',
]

function colorFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (Math.imul(31, h) + name.charCodeAt(i)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length]
}

interface Props {
  name: string
  avatarUrl?: string | null
  size?: 'xs' | 'sm' | 'md' | 'lg'
  className?: string
}

const SIZE = {
  xs: 'w-5 h-5 text-[9px]',
  sm: 'w-7 h-7 text-[11px]',
  md: 'w-9 h-9 text-sm',
  lg: 'w-12 h-12 text-base',
}

export function UserAvatar({ name, avatarUrl, size = 'sm', className }: Props) {
  const initials = name
    .split(/[\s_]+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
    || name.slice(0, 2).toUpperCase()

  return avatarUrl ? (
    <img
      src={avatarUrl}
      alt={name}
      className={cn('rounded-full object-cover flex-shrink-0', SIZE[size], className)}
    />
  ) : (
    <div className={cn('rounded-full flex items-center justify-center font-bold flex-shrink-0 select-none', SIZE[size], colorFor(name), className)}>
      {initials}
    </div>
  )
}
