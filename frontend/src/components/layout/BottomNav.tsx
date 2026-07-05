'use client'
import { useCallback, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useAuth } from '@/hooks/useAuth'
import { usePolling } from '@/hooks/usePolling'
import { messagingApi, type InboxSummary } from '@/lib/messaging'
import {
  Home,
  ArrowLeftRight,
  Fuel,
  ClipboardList,
  Coins,
  MessageSquare,
} from 'lucide-react'

interface NavItem {
  href: string
  label: string
  icon: React.ReactNode
  badge?: number
}

// Fixed leading tabs. Wallet is intentionally NOT here — it lives on the Home
// tab (Quick Actions) and in the avatar dropdown, so the bottom bar stays lean.
// "USDT" replaces the old "Market" label; the trading trio (USDT · Gas · CTM)
// groups together after Home.
const leadingNavItems: NavItem[] = [
  {
    href: '/dashboard',
    label: 'Home',
    icon: <Home className="w-6 h-6" />,
  },
  {
    href: '/marketplace',
    label: 'USDT',
    icon: <ArrowLeftRight className="w-6 h-6" />,
  },
  {
    href: '/gas',
    label: 'Gas',
    icon: <Fuel className="w-6 h-6" />,
  },
  {
    href: '/ctm',
    label: 'CTM',
    icon: <Coins className="w-6 h-6" />,
  },
]

// Fallback last tab when messaging is disabled.
const ordersNavItem: NavItem = {
  href: '/orders',
  label: 'Orders',
  icon: <ClipboardList className="w-6 h-6" />,
}

export default function BottomNav() {
  const pathname = usePathname()
  const { user } = useAuth()
  const [msgSummary, setMsgSummary] = useState<InboxSummary | null>(null)

  // Messaging inbox summary drives whether the last tab is "Messages" (feature
  // ON) or falls back to "Orders" (feature OFF) — plus its unread/active badge.
  const fetchMsgSummary = useCallback(async () => {
    if (!user) return
    try {
      setMsgSummary(await messagingApi.getSummary())
    } catch {
      // silently fail — fall back to Orders
    }
  }, [user])

  usePolling(fetchMsgSummary, 60_000, !!user)

  // Last tab: Messages when the messaging feature is enabled, else Orders. This
  // realises "replace Orders with Messaging" without leaving a dead tab while
  // `messaging_inbox_enabled` is still OFF in production.
  const lastNavItem: NavItem = msgSummary?.enabled
    ? {
        href: '/messages',
        label: 'Messages',
        icon: <MessageSquare className="w-6 h-6" />,
        badge: msgSummary.activeTrades || msgSummary.unreadThreads || 0,
      }
    : ordersNavItem

  const navItems: NavItem[] = [...leadingNavItems, lastNavItem]

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/'
    return pathname.startsWith(href)
  }

  return (
    <nav className="fixed bottom-0 inset-x-0 z-30 lg:hidden bg-surface border-t border-border pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="flex items-center justify-around h-16">
        {navItems.map((item) => {
          const active = isActive(item.href)

          // Every tab: when active, the icon lifts into a raised circular badge
          // (ring-surface punches it through the top edge) so the current tab
          // "pops". Smoothly animated.
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              className={cn(
                'relative flex flex-col items-center justify-center flex-1 h-full gap-0.5',
                active ? 'text-primary' : 'text-text-muted hover:text-text-secondary',
              )}
            >
              <span
                className={cn(
                  'relative flex items-center justify-center w-11 h-11 rounded-full transition-all duration-200 ease-out',
                  active
                    ? '-translate-y-2.5 bg-primary/10 ring-4 ring-surface shadow-md'
                    : 'translate-y-0',
                )}
              >
                {item.icon}
                {!!item.badge && item.badge > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-danger text-white text-[9px] font-bold flex items-center justify-center">
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                )}
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
