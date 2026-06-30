import { CreditCard, Coins, ShieldCheck, BadgeDollarSign, TrendingUp, Fuel, CheckCircle } from 'lucide-react'
import { supportMailto } from '@/lib/contact'
import { StaticPageNav } from '@/components/ui/StaticPageNav'
import { buildMeta } from '@/lib/metadata'

export const metadata = buildMeta(
  'About RupChain — Pakistan’s P2P Crypto Marketplace',
  'RupChain is Pakistan’s peer-to-peer crypto marketplace: protected USDT trades, local payments (JazzCash, Easypaisa, bank), community tokens, and a multi-chain gas station.',
  '/about',
)

const FEATURES = [
  { Icon: ShieldCheck,     title: 'Trade Protection',      desc: 'All trades are monitored by RupChain. Crypto is only released after the seller confirms payment receipt.' },
  { Icon: CreditCard,      title: 'Local Payments',        desc: 'Pay and receive with JazzCash, Easypaisa, and all major Pakistani banks.' },
  { Icon: Coins,           title: 'Community Tokens',      desc: 'Trade BKR, SIDRA, and other community tokens directly with verified counterparties.' },
  { Icon: ShieldCheck,     title: 'KYC Verified',          desc: 'Our KYC system ensures all traders are verified, creating a trusted community.' },
  { Icon: BadgeDollarSign, title: 'Zero P2P Trading Fees', desc: '0% maker and taker fees on all P2P trades.' },
  { Icon: Fuel,            title: 'Crypto Gas Fees',       desc: 'Top up gas fees on any chain instantly by paying with PKR through JazzCash or Easypaisa.' },
  { Icon: TrendingUp,      title: 'Real-time Prices',      desc: 'Live market rates ensure you always get a fair deal based on current market conditions.' },
]

export default function AboutPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-10 pb-16 space-y-10">
      <StaticPageNav />
      {/* Hero */}
      <div className="text-center space-y-3">
        <div className="w-16 h-16 rounded-2xl bg-primary text-white font-black text-2xl flex items-center justify-center mx-auto">P</div>
        <h1 className="text-3xl font-black text-text-primary">About RupChain</h1>
        <p className="text-text-muted text-base max-w-xl mx-auto">
          Pakistan's first secure peer-to-peer cryptocurrency exchange — built for Pakistanis, by Pakistanis.
        </p>
      </div>

      {/* Mission */}
      <section className="bg-surface shadow-card border border-border rounded-2xl p-6 space-y-3">
        <h2 className="text-xl font-bold text-text-primary">Our Mission</h2>
        <p className="text-text-muted leading-relaxed">
          RupChain exists to give every Pakistani access to the global crypto economy. We believe financial freedom shouldn't
          be limited by geography. By connecting buyers and sellers directly, we remove intermediaries, reduce costs, and
          put control back in your hands.
        </p>
      </section>

      {/* Why RupChain */}
      <section>
        <h2 className="text-xl font-bold text-text-primary mb-4">Why RupChain?</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {FEATURES.map(({ Icon, title, desc }) => (
            <div key={title} className="bg-surface shadow-card border border-border rounded-xl p-4 space-y-2">
              <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                <Icon size={18} className="text-primary" />
              </div>
              <h3 className="text-sm font-bold text-text-primary">{title}</h3>
              <p className="text-sm text-text-muted">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Security */}
      <section className="bg-surface shadow-card border border-border rounded-2xl p-6 space-y-4">
        <h2 className="text-xl font-bold text-text-primary">Security First</h2>
        <div className="space-y-3">
          {[
            { label: 'Trade Monitoring', desc: 'RupChain monitors every active trade and steps in to resolve disputes and protect all parties.' },
            { label: 'Two-Factor Authentication', desc: 'Protect your account with TOTP-based 2FA.' },
            { label: 'KYC Verification', desc: 'Identity verification prevents bad actors and protects all users.' },
            { label: 'Dispute Resolution', desc: 'Our team resolves disputes fairly with evidence-based reviews.' },
            { label: 'CNIC Data Encryption', desc: 'Sensitive identity documents are encrypted and stored securely.' },
          ].map((item) => (
            <div key={item.label} className="flex items-start gap-3">
              <div className="w-5 h-5 rounded-full bg-success/10 text-success flex items-center justify-center flex-shrink-0 mt-0.5">
                <CheckCircle size={12} className="text-success" />
              </div>
              <div>
                <p className="text-sm font-semibold text-text-primary">{item.label}</p>
                <p className="text-sm text-text-muted">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Contact */}
      <section className="bg-primary/5 border border-primary/20 rounded-2xl p-6 text-center space-y-3">
        <h2 className="text-xl font-bold text-text-primary">Get in Touch</h2>
        <p className="text-sm text-text-muted">Have questions or need support? We're here to help.</p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <a
            href={supportMailto('RupChain Support')}
            className="inline-flex items-center justify-center gap-2 bg-primary text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            Email Support
          </a>
          <span className="inline-flex items-center justify-center gap-2 bg-surface border border-border text-text-muted px-4 py-2.5 rounded-lg text-sm font-medium cursor-not-allowed">
            Telegram — Coming soon
          </span>
        </div>
        <p className="text-xs text-text-muted">More channels coming soon: WhatsApp · Telegram · Facebook · X · Instagram</p>
      </section>
    </div>
  )
}
