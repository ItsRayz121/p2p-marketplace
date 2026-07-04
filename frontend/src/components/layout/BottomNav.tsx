'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
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

  // CTM is always visible for every user — no KYC gating and no dependence on
  // the async `user` load, which previously caused the tab to be missing on the
  // Telegram Mini App and to flicker in/out until a refresh on mobile.
  // Order groups the trading trio together: Home · Market · Gas · CTM · Wallet · Orders.
  // Gas is styled like every other tab (no longer a raised center FAB).
  const navItems = [...baseNavItems.slice(0, 3), ctmNavItem, ...baseNavItems.slice(3)]

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/'
    return pathname.startsWith(href)
  }

  return (
    <nav className="fixed bottom-0 inset-x-0 z-30 lg:hidden bg-surface border-t border-border pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="flex items-center justify-around h-16">
        {navItems.map((item) => {
          const active = isActive(item.href)

          // Every tab (Gas included): when active, the icon lifts into a raised circular
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
