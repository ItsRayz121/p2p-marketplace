'use client'
import { useState, useCallback } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useAuth } from '@/hooks/useAuth'
import { usePolling } from '@/hooks/usePolling'
import { notificationsApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import Image from 'next/image'
import {
  BuildingStorefrontIcon,
  CircleStackIcon,
  FireIcon,
  TrophyIcon,
  Squares2X2Icon,
  BellIcon,
  ShieldCheckIcon,
  ClipboardDocumentListIcon,
  WalletIcon,
  TagIcon,
  Cog6ToothIcon,
  GiftIcon,
  ArrowRightStartOnRectangleIcon,
  ChevronDownIcon,
} from '@heroicons/react/24/solid'

// ─── Nav items ────────────────────────────────────────────────────────────────

const NAV_ITEMS: { href: string; Icon: React.ElementType; label: string; shortLabel?: string }[] = [
  { href: '/marketplace', Icon: BuildingStorefrontIcon, label: 'USDT Marketplace', shortLabel: 'Market' },
  { href: '/ctm',         Icon: CircleStackIcon,        label: 'Community Tokens', shortLabel: 'Tokens' },
  { href: '/gas',         Icon: FireIcon,               label: 'Crypto Gas Fees',  shortLabel: 'Gas'    },
  { href: '/leaderboard', Icon: TrophyIcon,             label: 'Leaderboard'                            },
  { href: '/dashboard',   Icon: Squares2X2Icon,         label: 'Dashboard'                              },
]

const DROPDOWN_ITEMS: { href: string; Icon: React.ElementType; label: string; iconCls: string; bgCls: string }[] = [
  { href: '/dashboard',   Icon: Squares2X2Icon,               label: 'Dashboard',        iconCls: 'text-blue-500',    bgCls: 'bg-blue-500/10'   },
  { href: '/kyc',         Icon: ShieldCheckIcon,               label: 'KYC Verification', iconCls: 'text-amber-500',   bgCls: 'bg-amber-500/10'  },
  { href: '/orders',      Icon: ClipboardDocumentListIcon,     label: 'My Trades',        iconCls: 'text-emerald-500', bgCls: 'bg-emerald-500/10'},
  { href: '/wallet',      Icon: WalletIcon,                    label: 'Wallet',           iconCls: 'text-violet-500',  bgCls: 'bg-violet-500/10' },
  { href: '/my-ads',      Icon: TagIcon,                       label: 'My Ads',           iconCls: 'text-cyan-500',    bgCls: 'bg-cyan-500/10'   },
  { href: '/settings',    Icon: Cog6ToothIcon,                 label: 'Settings',         iconCls: 'text-slate-500',   bgCls: 'bg-slate-400/10'  },
  { href: '/leaderboard', Icon: TrophyIcon,                    label: 'Leaderboard',      iconCls: 'text-yellow-500',  bgCls: 'bg-yellow-500/10' },
  { href: '/referral',    Icon: GiftIcon,                      label: 'Referral',         iconCls: 'text-pink-500',    bgCls: 'bg-pink-500/10'   },
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
            <Image
              src="/brand/logo-icon.png"
              alt="RupChain"
              width={32}
              height={32}
              className="w-8 h-8 object-contain flex-shrink-0"
              priority
            />
            <span className="hidden sm:block font-bold text-lg text-text-primary tracking-tight leading-none">
              RupChain
            </span>
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
                  <Icon className="w-4 h-4 flex-shrink-0" aria-hidden />
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
                  <BellIcon className="w-5 h-5" aria-hidden />
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
                      {user.avatarUrl ? (
                        <img src={user.avatarUrl} alt="Avatar" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                      ) : (
                        <div className="w-7 h-7 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center flex-shrink-0">
                          {(user.fullName || user.username || user.email).charAt(0).toUpperCase()}
                        </div>
                      )}
                      <span className="hidden sm:block text-sm font-medium text-text-primary max-w-[120px] truncate">
                        {user.fullName || user.username || user.email}
                      </span>
                      <ChevronDownIcon className="w-3.5 h-3.5 text-text-muted hidden sm:block" aria-hidden />
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
                            {user.fullName || user.username || 'No username'}
                          </p>
                          {kycBadge && (
                            <span className={cn('shrink-0 inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none', kycBadge.cls)}>
                              <ShieldCheckIcon className="w-2.5 h-2.5" aria-hidden />
                              {kycBadge.label}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-text-muted truncate mt-0.5">{user.email}</p>
                      </div>

                      {DROPDOWN_ITEMS.map(({ href, Icon, label, iconCls, bgCls }) => (
                        <DropdownMenu.Item key={href} asChild>
                          <Link href={href} className={dropdownItemCls}>
                            <span className={cn('flex items-center justify-center w-6 h-6 rounded-md flex-shrink-0', bgCls)}>
                              <Icon className={cn('w-3.5 h-3.5', iconCls)} aria-hidden />
                            </span>
                            {label}
                          </Link>
                        </DropdownMenu.Item>
                      ))}

                      <DropdownMenu.Separator className="my-1 h-px bg-border" />

                      <DropdownMenu.Item
                        onSelect={() => logout()}
                        className={cn(dropdownItemCls, 'text-danger focus:text-danger focus:bg-danger/10')}
                      >
                        <span className="flex items-center justify-center w-6 h-6 rounded-md flex-shrink-0 bg-red-500/10">
                          <ArrowRightStartOnRectangleIcon className="w-3.5 h-3.5 text-red-500" aria-hidden />
                        </span>
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
