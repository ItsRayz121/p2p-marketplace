import Link from 'next/link'
import { BadgeCheck, Headphones, Link2, Wallet } from 'lucide-react'
import { MarketingHeader } from '@/components/layout/MarketingHeader'
import Footer from '@/components/layout/Footer'
import { FaqAccordion } from '../FaqAccordion'
import { TerminalProvider } from './TerminalProvider'
import { TerminalTicker } from './TerminalTicker'
import { TerminalChartCard, TerminalPriceHeadline } from './TerminalHero'
import { OrderTicket } from './OrderTicket'
import { TerminalMarkets, TerminalOrderBook, TerminalTape } from './TerminalBoards'
import { fmtCompact } from './format'
import type { TerminalData } from './terminalData'

// Terminal homepage. Rendered by app/page.tsx when the `home_terminal_enabled`
// platform flag is ON (and always by /preview/home-terminal). Flip the flag
// off in Admin → Config → New & Beta Features to go back to the classic page.

const CHECKS = [
  { Icon: BadgeCheck, title: 'Identity', text: 'Every ad poster is identity-verified with a national ID or passport.' },
  { Icon: Link2, title: 'On-chain proof', text: 'Every crypto transfer is checked on the blockchain, in the open.' },
  { Icon: Wallet, title: 'Your wallet', text: 'No deposit needed. Your crypto stays yours until you start a trade.' },
  { Icon: Headphones, title: 'Dispute team', text: 'Real people review the evidence and resolve disputes, fast.' },
]

const COMPARE: [string, string][] = [
  ['Trust a stranger and hope', 'Every ad poster is identity-verified'],
  ['Send first, pray it arrives', 'Trade Protection backs every deal'],
  ['No proof of what happened', 'Transfers verified on-chain'],
  ['Hidden middleman markups', 'Live, transparent market rates'],
  ['Scammed? You are on your own', 'A real dispute team has your back'],
]

function SectionLabel({ children }: { children: string }) {
  return <p className="font-mono text-xs text-text-muted">{'// '}{children}</p>
}

export function TerminalHome({ data, faqs }: { data: TerminalData; faqs: { question: string; answer: string }[] }) {
  const s = data.stats
  const stats = s ? [
    ['USERS', s.totalUsers.toLocaleString('en-US')],
    ['TRADES', s.totalTrades.toLocaleString('en-US')],
    ['VOLUME', `PKR ${fmtCompact(parseFloat(s.totalVolume))}`],
    ['VERIFIED', s.verifiedTraders.toLocaleString('en-US')],
    ['TODAY', s.todayTrades.toLocaleString('en-US')],
  ] : []
  const showStats = !!s && (s.totalUsers > 0 || s.totalTrades > 0)

  return (
    <div className="min-h-screen bg-canvas">
      <MarketingHeader />
      <TerminalProvider initial={data}>
        <TerminalTicker />

        {/* ── Hero: live price + chart, order ticket ── */}
        <section className="border-b border-border">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 lg:py-12 grid lg:grid-cols-[1.4fr_1fr] gap-x-12 gap-y-8">
            <div className="min-w-0 order-1 lg:order-none lg:col-start-1 lg:row-start-1">
              <TerminalPriceHeadline />
            </div>
            <div className="min-w-0 order-3 lg:order-none lg:col-start-1 lg:row-start-2">
              <TerminalChartCard />
              <h1 className="mt-8 text-2xl sm:text-3xl font-bold tracking-tight text-text-primary max-w-xl">
                The P2P crypto desk for USDT, community tokens and gas.
              </h1>
              <p className="mt-2 text-text-secondary max-w-xl">
                Buy and sell with identity-verified traders, backed by on-chain proof and a real dispute team.
                Pay with local methods like JazzCash, Easypaisa or bank transfer, or with USDT.
              </p>
              <div className="mt-5 flex flex-col sm:flex-row gap-3">
                <Link href="/register" className="inline-flex items-center justify-center px-6 py-3 rounded-lg bg-primary text-white font-bold hover:bg-primary-hover transition-colors">
                  Create free account
                </Link>
                <Link href="/marketplace" className="inline-flex items-center justify-center px-6 py-3 rounded-lg border border-border bg-surface text-text-primary font-semibold hover:bg-surface-alt transition-colors">
                  Browse marketplace
                </Link>
              </div>
              {showStats && (
                <div className="mt-6 grid grid-cols-2 sm:grid-cols-5 border border-border rounded-xl overflow-hidden bg-surface">
                  {stats.map(([label, value], i) => (
                    <div key={label} className={`px-4 py-3 ${i ? 'border-t sm:border-t-0 sm:border-l border-border' : ''}`}>
                      <p className="font-mono text-[10px] text-text-muted">{label}</p>
                      <p className="font-mono text-lg font-semibold tabular-nums text-text-primary">{value}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="order-2 lg:order-none lg:col-start-2 lg:row-start-1 lg:row-span-2">
              <div className="lg:sticky lg:top-20"><OrderTicket /></div>
            </div>
          </div>
        </section>

        {/* ── Order book ── */}
        <section className="border-b border-border">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
            <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
              <div>
                <SectionLabel>ORDER BOOK</SectionLabel>
                <h2 className="mt-1 text-2xl font-bold text-text-primary">Top USDT offers</h2>
              </div>
              <Link href="/marketplace" className="font-mono text-xs font-semibold text-primary hover:underline">VIEW FULL MARKET →</Link>
            </div>
            <TerminalOrderBook />
          </div>
        </section>

        {/* ── Markets + tape ── */}
        <section className="border-b border-border bg-surface-alt/40">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 grid lg:grid-cols-[1fr_340px] gap-6">
            <div className="min-w-0">
              <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
                <div>
                  <SectionLabel>MARKETS</SectionLabel>
                  <h2 className="mt-1 text-2xl font-bold text-text-primary">All markets <span className="text-sm font-normal text-text-muted">· tap a market to chart it</span></h2>
                </div>
                <Link href="/markets" className="font-mono text-xs font-semibold text-primary hover:underline">ALL MARKETS →</Link>
              </div>
              <TerminalMarkets />
            </div>
            <div className="min-w-0">
              <SectionLabel>TAPE</SectionLabel>
              <h2 className="mt-1 mb-6 text-2xl font-bold text-text-primary">Recent trades</h2>
              <div className="rounded-xl border border-border bg-surface px-4 py-2"><TerminalTape /></div>
            </div>
          </div>
        </section>
      </TerminalProvider>

      {/* ── What is RupChain + protection ── */}
      <section className="border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 grid lg:grid-cols-2 gap-10">
          <div>
            <SectionLabel>WHAT IS RUPCHAIN</SectionLabel>
            <h2 className="mt-1 text-3xl font-bold tracking-tight text-text-primary">Four checks behind every trade</h2>
            <p className="mt-3 text-text-secondary [text-wrap:pretty]">
              RupChain is a peer-to-peer crypto marketplace. Buy and sell USDT and community tokens, and top up blockchain
              gas fees on any chain. Sign up free with email, Google or Telegram and trade directly with other users.
            </p>
            <div className="mt-6">
              {CHECKS.map(({ Icon, title, text }, i) => (
                <div key={title} className="grid grid-cols-[3rem_1fr] gap-4 py-5 border-t border-border">
                  <p className="font-mono text-2xl font-semibold text-text-muted">0{i + 1}</p>
                  <div>
                    <p className="font-semibold text-text-primary flex items-center gap-2"><Icon className="w-4 h-4 text-primary" aria-hidden />{title}</p>
                    <p className="mt-1 text-sm text-text-secondary">{text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <SectionLabel>WHY IT MATTERS</SectionLabel>
            <h2 className="mt-1 text-3xl font-bold tracking-tight text-text-primary">Group chat vs. RupChain</h2>
            <div className="mt-8 rounded-xl border border-border overflow-hidden text-sm bg-surface">
              <div className="grid grid-cols-2 font-mono text-[10px] uppercase border-b border-border">
                <p className="px-4 py-2 text-danger">Group chat deal</p>
                <p className="px-4 py-2 text-success border-l border-border">RupChain</p>
              </div>
              {COMPARE.map(([bad, good]) => (
                <div key={bad} className="grid grid-cols-2 border-b border-border last:border-0">
                  <p className="px-4 py-3 text-text-muted flex gap-2"><span className="text-danger font-mono" aria-hidden>✕</span>{bad}</p>
                  <p className="px-4 py-3 border-l border-border flex gap-2 bg-success/[0.05] text-text-primary"><span className="text-success font-mono" aria-hidden>✓</span>{good}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <FaqAccordion items={faqs} />

      {/* ── Closing CTA ── */}
      <section className="border-t border-border bg-surface-alt/40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div>
            <SectionLabel>READY</SectionLabel>
            <h2 className="mt-1 text-3xl font-bold text-text-primary">Open your first protected trade.</h2>
            <p className="mt-1 text-text-secondary">Free to join. No deposit. Sign up with email, Google or Telegram.</p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <Link href="/register" className="inline-flex items-center justify-center px-6 py-3 rounded-lg bg-success text-white font-bold hover:bg-success-hover transition-colors">Create account</Link>
            <Link href="/marketplace" className="inline-flex items-center justify-center px-6 py-3 rounded-lg border border-border bg-surface text-text-primary font-semibold hover:bg-surface-alt transition-colors">View market</Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  )
}
