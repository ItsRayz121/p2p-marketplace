'use client'
import { useState, useCallback } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useAuth } from '@/hooks/useAuth'
import { usePolling } from '@/hooks/usePolling'
import { notificationsApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  Store,
  Coins,
  Fuel,
  Trophy,
  LayoutDashboard,
  Bell,
  ShieldCheck,
  ClipboardList,
  Wallet,
  Tag,
  Settings,
  Star,
  Gift,
  LogOut,
  ChevronDown,
  type LucideIcon,
} from 'lucide-react'

// ─── Nav items ────────────────────────────────────────────────────────────────

const NAV_ITEMS: { href: string; Icon: LucideIcon; label: string; shortLabel?: string }[] = [
  { href: '/marketplace', Icon: Store,           label: 'USDT Marketplace', shortLabel: 'Market'   },
  { href: '/ctm',         Icon: Coins,           label: 'Community Tokens', shortLabel: 'Tokens'   },
  { href: '/gas',         Icon: Fuel,            label: 'Crypto Gas Fees',  shortLabel: 'Gas'      },
  { href: '/leaderboard', Icon: Trophy,          label: 'Leaderboard'                              },
  { href: '/dashboard',   Icon: LayoutDashboard, label: 'Dashboard'                                },
]

const DROPDOWN_ITEMS: { href: string; Icon: LucideIcon; label: string }[] = [
  { href: '/dashboard', Icon: LayoutDashboard, label: 'Dashboard'        },
  { href: '/kyc',       Icon: ShieldCheck,     label: 'KYC Verification' },
  { href: '/orders',    Icon: ClipboardList,   label: 'My Trades'        },
  { href: '/wallet',    Icon: Wallet,          label: 'Wallet'           },
  { href: '/my-ads',    Icon: Tag,             label: 'My Ads'           },
  { href: '/settings',  Icon: Settings,        label: 'Settings'         },
  { href: '/leaderboard', Icon: Trophy,        label: 'Leaderboard'      },
  { href: '/referral',  Icon: Gift,            label: 'Referral'         },
]

// ─── Component ────────────────────────────────────────────────────────────────

export default function Navbar() {
  const { user, logout } = useAuth()
  const pathname = usePathname()
  const [unreadCount, setUnreadCount] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)

  const fetchUnread = useCallback(async () => {
    if (!user) return
    try {
      const res = await notificationsApi.getUnreadCount()
      setUnreadCount(res.count)
    } catch {
      // silently fail
    }
  }, [user])

  usePolling(fetchUnread, 60_000, !!user)

  const kycBadge =
    user?.kycStatus === 'approved' && user?.kycLevel === 'enhanced'
      ? { label: 'Level 2', cls: 'text-warning bg-warning/10' }
      : user?.kycStatus === 'approved' && user?.kycLevel === 'basic'
      ? { label: 'Level 1', cls: 'text-primary bg-primary/10' }
      : user?.kycStatus === 'pending'
      ? { label: 'Pending', cls: 'text-warning bg-warning/10' }
      : null

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href)

  return (
    <header className="sticky top-0 z-30 bg-surface border-b border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">

          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xl font-bold text-primary">PakSwap</span>
          </Link>

          {/* Center nav — md+ */}
          <nav className="hidden md:flex items-center gap-0.5">
            {NAV_ITEMS.map(({ href, Icon, label, shortLabel }) => {
              const active = isActive(href)
              return (
                <Link
                  key={href}
                  href={href}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-colors',
                    active
                      ? 'text-primary bg-primary/10'
                      : 'text-text-secondary hover:text-text-primary hover:bg-surface-alt',
                  )}
                >
                  <Icon size={15} aria-hidden className="flex-shrink-0" />
                  <span className="lg:hidden">{shortLabel ?? label}</span>
                  <span className="hidden lg:inline">{label}</span>
                </Link>
              )
            })}
          </nav>

          {/* Right actions */}
          <div className="flex items-center gap-2">
            {!user ? (
              <>
                <Link
                  href="/login"
                  className="hidden sm:inline-flex items-center px-3 py-1.5 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
                >
                  Login
                </Link>
                <Link
                  href="/register"
                  className="inline-flex items-center px-4 py-1.5 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors"
                >
                  Register
                </Link>
              </>
            ) : (
              <>
                {/* Notification bell */}
                <Link
                  href="/notifications"
                  className="relative p-2 text-text-secondary hover:text-text-primary hover:bg-surface-alt rounded-lg transition-colors"
                  aria-label="Notifications"
                >
                  <Bell size={18} aria-hidden />
                  {unreadCount > 0 && (
                    <span className="absolute top-1 right-1 min-w-[18px] h-[18px] bg-danger text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </Link>

                {/* Avatar dropdown */}
                <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
                  <DropdownMenu.Trigger asChild>
                    <button
                      className={cn(
                        'flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-lg border border-border hover:bg-surface-alt transition-colors',
                        menuOpen && 'bg-surface-alt',
                      )}
                    >
                      <div className="w-7 h-7 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center flex-shrink-0">
                        {(user.username || user.email).charAt(0).toUpperCase()}
                      </div>
                      <span className="hidden sm:block text-sm font-medium text-text-primary max-w-[100px] truncate">
                        {user.username || user.email}
                      </span>
                      <ChevronDown size={14} className="text-text-muted hidden sm:block" aria-hidden />
                    </button>
                  </DropdownMenu.Trigger>

                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="end"
                      sideOffset={8}
                      className="z-50 w-56 bg-surface rounded-xl border border-border shadow-card-lg py-1 animate-fade-in"
                    >
                      {/* User info header */}
                      <div className="px-3 py-2.5 border-b border-border">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-text-primary truncate">
                            {user.username || 'No username'}
                          </p>
                          {kycBadge && (
                            <span className={cn('shrink-0 inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none', kycBadge.cls)}>
                              <ShieldCheck size={9} aria-hidden />
                              {kycBadge.label}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-text-muted truncate mt-0.5">{user.email}</p>
                      </div>

                      {DROPDOWN_ITEMS.map(({ href, Icon, label }) => (
                        <DropdownMenu.Item key={href} asChild>
                          <Link href={href} className={dropdownItemCls}>
                            <Icon size={14} className="text-text-muted flex-shrink-0" aria-hidden />
                            {label}
                          </Link>
                        </DropdownMenu.Item>
                      ))}

                      <DropdownMenu.Separator className="my-1 h-px bg-border" />

                      <DropdownMenu.Item
                        onSelect={() => logout()}
                        className={cn(dropdownItemCls, 'text-danger focus:text-danger focus:bg-danger/10')}
                      >
                        <LogOut size={14} className="flex-shrink-0" aria-hidden />
                        Logout
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  )
}

const dropdownItemCls =
  'flex items-center gap-2.5 px-3 py-2 text-sm text-text-primary hover:bg-surface-alt rounded-lg mx-1 cursor-pointer outline-none focus:bg-surface-alt transition-colors'
