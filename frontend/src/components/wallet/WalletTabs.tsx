'use client'

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { hashForWalletTab, parseWalletTab, type WalletTab } from '@/lib/walletTab'

export const WALLET_TABS: ReadonlyArray<{ id: WalletTab; label: string }> = [
  { id: 'methods', label: 'Payment methods' },
  { id: 'portfolio', label: 'Portfolio' },
]

/** Tab state kept in sync with the URL hash (no navigation, so scroll and history stay put). */
export function useWalletTab(): [WalletTab, (t: WalletTab) => void] {
  // Default on first render so server and client markup match; the URL is read after mount.
  const [tab, setTabState] = useState<WalletTab>('methods')

  useEffect(() => {
    const sync = () => setTabState(parseWalletTab(window.location.hash, window.location.search))
    sync()
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  const setTab = useCallback((next: WalletTab) => {
    setTabState(next)
    const { pathname, search } = window.location
    window.history.replaceState(window.history.state, '', pathname + search + hashForWalletTab(next))
  }, [])

  return [tab, setTab]
}

export const tabId = (t: WalletTab) => `wallet-tab-${t}`
export const panelId = (t: WalletTab) => `wallet-panel-${t}`

export function WalletTabs({ tab, onChange }: { tab: WalletTab; onChange: (t: WalletTab) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1
    if (e.key === 'ArrowRight') next = (index + 1) % WALLET_TABS.length
    else if (e.key === 'ArrowLeft') next = (index - 1 + WALLET_TABS.length) % WALLET_TABS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = WALLET_TABS.length - 1
    if (next < 0) return
    e.preventDefault()
    const target = WALLET_TABS[next].id
    onChange(target)
    refs.current[target]?.focus()
  }

  return (
    <div role="tablist" aria-label="Wallet sections" className="flex gap-1 border-b border-border -mb-4 overflow-x-auto">
      {WALLET_TABS.map(({ id, label }, i) => {
        const selected = tab === id
        return (
          <button
            key={id}
            ref={(el) => { refs.current[id] = el }}
            id={tabId(id)}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={panelId(id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px whitespace-nowrap transition-colors ${selected ? 'border-primary text-primary' : 'border-transparent text-text-muted hover:text-text-primary'}`}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
