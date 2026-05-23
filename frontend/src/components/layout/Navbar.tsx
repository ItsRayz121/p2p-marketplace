'use client'
import { useState, useCallback } from 'react'
import Link from 'next/link'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useAuth } from '@/hooks/useAuth'
import { usePolling } from '@/hooks/usePolling'
import { notificationsApi } from '@/lib/api'
import { cn } from '@/lib/utils'

export default function Navbar() {
  const { user, logout } = useAuth()
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

  const isMerchant = user?.role === 'merchant'

  return (
    <header className="sticky top-0 z-30 bg-white border-b border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xl font-bold text-primary">PakSwap</span>
          </Link>

          {/* Center nav — desktop only */}
          <nav className="hidden lg:flex items-center gap-1">
            <NavLink href="/marketplace">USDT Marketplace</NavLink>
            <NavLink href="/ctm">Community Tokens</NavLink>
            <NavLink href="/gas">Crypto Gas Fees</NavLink>
            <NavLink href="/dashboard">Dashboard</NavLink>
          </nav>

          {/* Right actions */}
          <div className="flex items-center gap-2">
            {!user ? (
              <>
                <Link
                  href="/login"
                  className="hidden sm:inline-flex items-center px-3 py-1.5 text-sm font-medium text-text-primary hover:text-primary transition-colors"
                >
                  Login
                </Link>
                <Link
                  href="/register"
                  className="inline-flex items-center px-4 py-1.5 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
                >
                  Register
                </Link>
              </>
            ) : (
              <>
                {/* Notification bell */}
                <Link
                  href="/notifications"
                  className="relative p-2 text-text-secondary hover:text-text-primary hover:bg-surface rounded-lg transition-colors"
                  aria-label="Notifications"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                    />
                  </svg>
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
                        'flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-lg border border-border hover:bg-surface transition-colors',
                        menuOpen && 'bg-surface',
                      )}
                    >
                      <div className="w-7 h-7 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center flex-shrink-0">
                        {(user.username || user.email).charAt(0).toUpperCase()}
                      </div>
                      <span className="hidden sm:block text-sm font-medium text-text-primary max-w-[100px] truncate">
                        {user.username || user.email}
                      </span>
                      {isMerchant && (
                        <span className="hidden sm:inline-flex items-center text-[10px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded-full leading-none">
                          Merchant
                        </span>
                      )}
                      <svg className="w-4 h-4 text-text-muted hidden sm:block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                  </DropdownMenu.Trigger>

                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="end"
                      sideOffset={8}
                      className="z-50 w-56 bg-white rounded-xl border border-border shadow-lg py-1 animate-fade-in"
                    >
                      {/* User info */}
                      <div className="px-3 py-2 border-b border-border">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-text-primary truncate">
                            {user.username || 'No username'}
                          </p>
                          {isMerchant && (
                            <span className="shrink-0 text-[10px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded-full leading-none">
                              Merchant
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-text-muted truncate">{user.email}</p>
                      </div>

                      <DropdownMenu.Item asChild>
                        <Link href="/dashboard" className={dropdownItemCls}>Dashboard</Link>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item asChild>
                        <Link href="/kyc" className={dropdownItemCls}>KYC Verification</Link>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item asChild>
                        <Link href="/orders" className={dropdownItemCls}>My Trades</Link>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item asChild>
                        <Link href="/wallet" className={dropdownItemCls}>Wallet</Link>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item asChild>
                        <Link href="/my-ads" className={dropdownItemCls}>My Ads</Link>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item asChild>
                        <Link href="/settings" className={dropdownItemCls}>Settings</Link>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item asChild>
                        <Link href="/referral" className={dropdownItemCls}>Referral</Link>
                      </DropdownMenu.Item>

                      {/* Merchant mode switch */}
                      <DropdownMenu.Separator className="my-1 h-px bg-border" />
                      {isMerchant ? (
                        <DropdownMenu.Item asChild>
                          <Link
                            href="/merchant/dashboard"
                            className={cn(dropdownItemCls, 'gap-2 font-medium text-primary focus:text-primary focus:bg-primary/5')}
                          >
                            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
                            </svg>
                            Merchant Dashboard
                          </Link>
                        </DropdownMenu.Item>
                      ) : (
                        <DropdownMenu.Item asChild>
                          <Link
                            href="/merchant-apply"
                            className={cn(dropdownItemCls, 'gap-2 text-text-secondary focus:text-text-primary')}
                          >
                            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                            </svg>
                            Become a Merchant
                          </Link>
                        </DropdownMenu.Item>
                      )}

                      <DropdownMenu.Separator className="my-1 h-px bg-border" />

                      <DropdownMenu.Item
                        onSelect={() => logout()}
                        className={cn(dropdownItemCls, 'text-danger focus:text-danger focus:bg-danger/10')}
                      >
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
  'flex items-center px-3 py-2 text-sm text-text-primary hover:bg-surface rounded-lg mx-1 cursor-pointer outline-none focus:bg-surface transition-colors'

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-surface rounded-lg transition-colors"
    >
      {children}
    </Link>
  )
}
