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
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              className={cn(
                'flex flex-col items-center justify-center flex-1 h-full gap-0.5 transition-colors',
                item.primary
                  ? 'relative'
                  : active
                  ? 'text-primary border-t-2 border-primary -mt-px'
                  : 'text-text-muted hover:text-text-secondary border-t-2 border-transparent -mt-px',
              )}
            >
              {item.primary ? (
                <span className="absolute -top-5 flex items-center justify-center w-12 h-12 bg-primary rounded-full text-white shadow-lg">
                  {item.icon}
                </span>
              ) : (
                item.icon
              )}
              <span className={cn('text-[10px] font-medium', item.primary && 'mt-8')}>
                {item.label}
              </span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
