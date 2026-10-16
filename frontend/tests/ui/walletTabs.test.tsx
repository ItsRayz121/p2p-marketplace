import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { parseWalletTab, hashForWalletTab, type WalletTab } from '@/lib/walletTab'
import { WalletTabs, useWalletTab, WALLET_TABS } from '@/components/wallet/WalletTabs'
import { PortfolioTab } from '@/components/portfolio/PortfolioTab'

const src = (p: string) => readFileSync(path.resolve(__dirname, '../../src', p), 'utf8')

describe('deep-link compatibility', () => {
  it('keeps existing #payment-methods and other legacy hashes on Payment methods', () => {
    expect(parseWalletTab('#payment-methods')).toBe('methods')
    expect(parseWalletTab('#saved-addresses')).toBe('methods')
    expect(parseWalletTab('')).toBe('methods')
  })
  it('opens Portfolio for #portfolio, legacy #balance and ?tab=', () => {
    expect(parseWalletTab('#portfolio')).toBe('portfolio')
    expect(parseWalletTab('#balance')).toBe('portfolio')
    expect(parseWalletTab('', '?tab=portfolio')).toBe('portfolio')
    expect(parseWalletTab('', '?tab=balance')).toBe('portfolio')
    expect(parseWalletTab('#payment-methods', '?tab=portfolio')).toBe('methods')
  })
  it('writes a clean URL for the default tab', () => {
    expect(hashForWalletTab('methods')).toBe('')
    expect(hashForWalletTab('portfolio')).toBe('#portfolio')
  })
})

function Harness() {
  const [tab, setTab] = useWalletTab()
  return <WalletTabs tab={tab} onChange={setTab} />
}

describe('WalletTabs', () => {
  it('has exactly two local tabs in order: Payment methods, Portfolio', () => {
    render(<Harness />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Payment methods', 'Portfolio'])
    expect(WALLET_TABS).toHaveLength(2)
    expect(screen.queryByText(/balance & deposits/i)).toBeNull()
  })
  it('defaults to Payment methods and uses roving tabindex', () => {
    render(<Harness />)
    expect(screen.getByRole('tab', { name: 'Payment methods' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Payment methods' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('tab', { name: 'Portfolio' })).toHaveAttribute('tabindex', '-1')
  })
  it('arrow keys, Home and End move selection and focus', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    screen.getByRole('tab', { name: 'Payment methods' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Portfolio' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Portfolio' })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Payment methods' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'Portfolio' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: 'Payment methods' })).toHaveFocus()
  })
  it('syncs the hash when switching and reads it on mount', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/wallet#portfolio')
    render(<Harness />)
    expect(await screen.findByRole('tab', { name: 'Portfolio', selected: true })).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Payment methods' }))
    expect(window.location.hash).toBe('')
    await user.click(screen.getByRole('tab', { name: 'Portfolio' }))
    expect(window.location.hash).toBe('#portfolio')
  })
  it('opens Portfolio for the legacy #balance link', async () => {
    window.history.replaceState(null, '', '/wallet#balance')
    render(<Harness />)
    expect(await screen.findByRole('tab', { name: 'Portfolio', selected: true })).toBeInTheDocument()
  })
})

describe('PortfolioTab', () => {
  const wallet = <section><h2>RupChain wallet</h2><button>Deposit</button><button>Withdraw</button></section>

  it('renders the existing wallet section untouched next to an empty tracked portfolio', () => {
    render(<PortfolioTab walletSection={wallet} />)
    expect(screen.getByRole('heading', { name: 'Tracked portfolio' })).toBeInTheDocument()
    expect(screen.getByText(/never added together/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deposit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument()
  })
  it('token detail has Back to portfolio, which returns focus to the row', async () => {
    const user = userEvent.setup()
    render(<PortfolioTab assets={[{ id: 'a1', name: 'Alpha' }]} />)
    const row = screen.getByRole('button', { name: 'Alpha' })
    await user.click(row)
    const back = screen.getByRole('button', { name: /back to portfolio/i })
    expect(back).toHaveFocus()
    expect(screen.getByRole('heading', { name: 'Alpha' })).toBeInTheDocument()
    await user.click(back)
    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveFocus()
  })
})

describe('page structure (source checks)', () => {
  const page = src('app/(platform)/wallet/page.tsx')
  it('wallet page uses the tab components and no longer has the old tab label', () => {
    expect(page).toContain('<WalletTabs')
    expect(page).not.toContain('Balance & deposits')
    expect(page).toContain("panelId('portfolio')")
  })
  it('keeps the Deposit/Withdraw controls and payment-methods anchors', () => {
    expect(page).toContain('setDepositCoin(b.coin)')
    expect(page).toContain('setWithdrawWallet({ coin: b.coin, network: b.network })')
    expect(page).toContain('id="payment-methods"')
    expect(page).toContain('<PaymentMethodsSection />')
  })
  it('does not add Portfolio to global navigation', () => {
    expect(src('components/layout/Navbar.tsx')).not.toMatch(/portfolio/i)
    expect(src('app/(platform)/dashboard/page.tsx')).not.toMatch(/portfolio/i)
  })
})

// compile-time guard that WalletTab stays a two-value union (no third local tab)
const _exhaustive: Record<WalletTab, true> = { methods: true, portfolio: true }
void _exhaustive
