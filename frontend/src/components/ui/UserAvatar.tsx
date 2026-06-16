import { cn } from '@/lib/utils'

const PALETTE = [
  'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-pink-500/15 text-pink-700 dark:text-pink-300',
  'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
  'bg-red-500/15 text-red-700 dark:text-red-300',
  'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
]

function colorFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (Math.imul(31, h) + name.charCodeAt(i)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length]
}

interface Props {
  name: string
  avatarUrl?: string | null
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}

const SIZE = {
  xs:  'w-5 h-5 text-[9px]',
  sm:  'w-7 h-7 text-[11px]',
  md:  'w-9 h-9 text-sm',
  lg:  'w-12 h-12 text-base',
  xl:  'w-16 h-16 text-xl',
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
