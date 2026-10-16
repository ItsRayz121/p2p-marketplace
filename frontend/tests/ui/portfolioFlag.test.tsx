import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { walletTabsFor, WALLET_TABS, type WalletTab } from '@/lib/walletTab'
import { WalletTabs } from '@/components/wallet/WalletTabs'

const src = (p: string) => readFileSync(path.resolve(__dirname, '../../src', p), 'utf8')

describe('which tabs the page shows (kill switch)', () => {
  it('feature ON: Payment methods + Portfolio for EVERYONE, funds or not', () => {
    for (const showBalanceTab of [true, false]) {
      const r = walletTabsFor({ portfolioOn: true, showBalanceTab })
      expect(r.secondTabVisible).toBe(true)
      expect(r.tabs.map((t) => t.label)).toEqual(['Payment methods', 'Portfolio'])
    }
  })
  it('feature OFF, has funds or is a maker: the page is exactly as before ("Balance & deposits")', () => {
    const r = walletTabsFor({ portfolioOn: false, showBalanceTab: true })
    expect(r.secondTabVisible).toBe(true)
    expect(r.tabs.map((t) => t.label)).toEqual(['Payment methods', 'Balance & deposits'])
  })
  it('feature OFF, no funds: no tab bar at all, exactly as before', () => {
    const r = walletTabsFor({ portfolioOn: false, showBalanceTab: false })
    expect(r.secondTabVisible).toBe(false)
    expect(r.tabs.map((t) => t.label)).toEqual(['Payment methods'])
  })
  it('nobody with funds ever loses access to their wallet, in any state of the flag', () => {
    for (const portfolioOn of [true, false]) {
      expect(walletTabsFor({ portfolioOn, showBalanceTab: true }).secondTabVisible).toBe(true)
    }
  })
  it('the second tab keeps the same id (so old links, #balance and #portfolio, still land on it)', () => {
    for (const portfolioOn of [true, false]) {
      expect(walletTabsFor({ portfolioOn, showBalanceTab: true }).tabs[1]!.id).toBe('portfolio')
    }
  })
  it('the default tab list is unchanged', () => {
    expect(WALLET_TABS.map((t) => t.label)).toEqual(['Payment methods', 'Portfolio'])
  })
})

describe('WalletTabs with a relabelled tab', () => {
  function Harness({ label }: { label: string }) {
    const [tab, setTab] = useState<WalletTab>('methods')
    return <WalletTabs tab={tab} onChange={setTab} tabs={[WALLET_TABS[0]!, { id: 'portfolio', label }]} />
  }
  it('shows the given label and keeps keyboard navigation working', async () => {
    const user = userEvent.setup()
    render(<Harness label="Balance & deposits" />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Payment methods', 'Balance & deposits'])
    screen.getByRole('tab', { name: 'Payment methods' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Balance & deposits' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'Balance & deposits' })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('the page (source checks)', () => {
  const page = src('app/(platform)/wallet/page.tsx')
  it('asks the server whether the feature is on, and assumes ON until told otherwise', () => {
    expect(page).toContain('portfolioApi.status()')
    expect(page).toMatch(/useState\(true\)/)
    expect(page).toMatch(/portfolioApi\.status\(\)\.then\(\(s\) => setPortfolioOn\(s\.enabled\)\)\.catch\(\(\) => \{\}\)/)
  })
  it('uses the shared tab rule and hides the tab bar when only one tab exists', () => {
    expect(page).toContain('walletTabsFor({ portfolioOn, showBalanceTab })')
    expect(page).toMatch(/tabs\.length > 1 && <WalletTabs/)
  })
  it('renders the SAME wallet section whether the feature is on (inside Portfolio) or off (on its own)', () => {
    expect(page).toMatch(/portfolioOn \? <PortfolioPanel userId=\{user\?\.id\} walletSection=\{walletSectionEl\} \/> : walletSectionEl/)
    expect(page.match(/walletSectionEl/g)!.length).toBeGreaterThanOrEqual(3)
  })
  it('the Portfolio code is loaded only when its tab is opened', () => {
    expect(page).toMatch(/const PortfolioPanel = dynamic\(\(\) => import\('@\/components\/portfolio\/PortfolioPanel'\)/)
    expect(page).not.toMatch(/^import \{ PortfolioPanel \}/m)
  })
  it('keeps Deposit, Withdraw and the payment-method sections intact', () => {
    expect(page).toContain('setDepositCoin(b.coin)')
    expect(page).toContain('setWithdrawWallet({ coin: b.coin, network: b.network })')
    expect(page).toContain('<PaymentMethodsSection />')
    expect(page).toContain('id="payment-methods"')
  })
})
