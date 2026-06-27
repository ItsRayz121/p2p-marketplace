'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useAuth } from '@/hooks/useAuth'
import {
  Home,
  ArrowLeftRight,
  Fuel,
  Wallet,
  ClipboardList,
  Coins,
} from 'lucide-react'

interface NavItem {
  href: string
  label: string
  icon: React.ReactNode
  primary?: boolean
}

const baseNavItems: NavItem[] = [
  {
    href: '/dashboard',
    label: 'Home',
    icon: <Home className="w-6 h-6" />,
  },
  {
    href: '/marketplace',
    label: 'Market',
    icon: <ArrowLeftRight className="w-6 h-6" />,
  },
  {
    href: '/gas',
    label: 'Gas',
    icon: <Fuel className="w-6 h-6" />,
    primary: true,
  },
  {
    href: '/wallet',
    label: 'Wallet',
    icon: <Wallet className="w-6 h-6" />,
  },
  {
    href: '/orders',
    label: 'Orders',
    icon: <ClipboardList className="w-6 h-6" />,
  },
]

const ctmNavItem: NavItem = {
  href: '/ctm',
  label: 'CTM',
  icon: <Coins className="w-6 h-6" />,
}

export default function BottomNav() {
  const pathname = usePathname()
  const { user } = useAuth()

  // Only show CTM to KYC-approved users — new users see a clean 5-item nav
  const kycApproved = user?.kycStatus === 'approved'
  const navItems = kycApproved
    ? [...baseNavItems.slice(0, 4), ctmNavItem, baseNavItems[4]]
    : baseNavItems

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/'
    return pathname.startsWith(href)
  }

  return (
    <nav className="fixed bottom-0 inset-x-0 z-30 lg:hidden bg-surface border-t border-border pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="flex items-center justify-around h-16">
        {navItems.map((item) => {
          const active = isActive(item.href)

          // Gas is the permanent prominent center FAB — always popped out.
          if (item.primary) {
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-label={item.label}
                className="relative flex flex-col items-center justify-center flex-1 h-full"
              >
                <span className="absolute -top-5 flex items-center justify-center w-12 h-12 bg-primary rounded-full text-white shadow-lg transition-transform duration-150 active:scale-95">
                  {item.icon}
                </span>
                <span className={cn('text-[10px] font-medium mt-8', active ? 'text-primary' : 'text-text-muted')}>
                  {item.label}
                </span>
              </Link>
            )
          }

          // Every other tab: when active, the icon lifts into a raised circular
          // badge (ring-surface punches it through the top edge) so the current
          // tab "pops" like the Gas FAB. Smoothly animated.
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              className={cn(
                'flex flex-col items-center justify-center flex-1 h-full gap-0.5',
                active ? 'text-primary' : 'text-text-muted hover:text-text-secondary',
              )}
            >
              <span
                className={cn(
                  'flex items-center justify-center w-11 h-11 rounded-full transition-all duration-200 ease-out',
                  active
                    ? '-translate-y-2.5 bg-primary/10 ring-4 ring-surface shadow-md'
                    : 'translate-y-0',
                )}
              >
                {item.icon}
              </span>
              <span
                className={cn(
                  'text-[10px] font-medium transition-transform duration-200',
                  active && '-translate-y-1.5',
                )}
              >
                {item.label}
              </span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
