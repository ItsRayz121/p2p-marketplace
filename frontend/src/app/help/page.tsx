'use client'
import { useState } from 'react'
import Link from 'next/link'
import { SUPPORT_EMAIL, supportMailto } from '@/lib/contact'
import { openSupportChat } from '@/lib/supportChat'

const FAQS = [
  {
    category: 'Getting Started',
    items: [
      {
        q: 'How do I create an account?',
        a: 'Click "Create Account" on the homepage, fill in your name, email and password, then verify your email with the OTP we send you.',
      },
      {
        q: 'What is KYC and why do I need it?',
        a: 'KYC (Know Your Customer) is an identity verification process required by Pakistani financial regulations. You must complete at least Basic KYC (CNIC front & back + selfie) before you can trade. Basic KYC unlocks a PKR 50,000 daily limit; Enhanced KYC raises it to PKR 200,000.',
      },
      {
        q: 'Which payment methods are supported?',
        a: 'We support JazzCash, Easypaisa, bank transfer (all major Pakistani banks), SadaPay, and NayaPay.',
      },
    ],
  },
  {
    category: 'Trading',
    items: [
      {
        q: 'How does a P2P trade work?',
        a: "Browse the marketplace and pick an ad that suits your needs. Enter the amount, choose a payment method, and start the trade. You then send the payment via your chosen method and upload a screenshot as proof. The seller confirms receipt and releases the crypto to you. RupChain monitors the process and handles any disputes.",
      },
      {
        q: 'How long do I have to complete a trade?',
        a: 'The trade window is set by the seller and ranges from 15 minutes to 2 hours. You can see the countdown timer on the trade page. If the window expires, the trade is cancelled automatically.',
      },
      {
        q: 'What happens if there is a dispute?',
        a: 'Either party can open a dispute from the trade room. Our team reviews disputes within 24–72 hours. Please provide clear screenshots and evidence to support your case. Our decision is final.',
      },
      {
        q: 'Can I cancel a trade?',
        a: 'You can cancel a trade before payment proof is uploaded. Once proof is submitted the trade moves forward and cancellation requires a dispute.',
      },
    ],
  },
  {
    category: 'Wallet & Withdrawals',
    items: [
      {
        q: 'How do I deposit crypto?',
        a: 'Go to Wallet → select the coin and network → copy your unique deposit address. Send crypto to that address and it will be credited after the required network confirmations.',
      },
      {
        q: 'How long do withdrawals take?',
        a: 'Withdrawals are processed within a few minutes during business hours. Network congestion can add delays. You will receive an email confirmation once the transaction is broadcast.',
      },
      {
        q: 'Is there a withdrawal fee?',
        a: 'Network (gas) fees apply and vary by blockchain. We show the exact fee before you confirm. Our platform does not add a markup on withdrawals.',
      },
    ],
  },
  {
    category: 'Security',
    items: [
      {
        q: 'How do I enable Two-Factor Authentication (2FA)?',
        a: 'Go to Settings → Security → Enable 2FA. Scan the QR code with Google Authenticator, Authy, or any TOTP app, then enter the 6-digit code to confirm.',
      },
      {
        q: 'I forgot my password. What do I do?',
        a: 'Click "Forgot password?" on the login page. We will send a reset link to your registered email address. The link expires after 1 hour.',
      },
      {
        q: 'RupChain will never ask for my password?',
        a: 'Correct. Our support team will never ask for your password, 2FA code, or private keys via email, WhatsApp, or any other channel. If someone claims to be from RupChain and asks for these, it is a scam.',
      },
    ],
  },
  {
    category: 'Fees',
    items: [
      {
        q: 'What are the P2P trading fees?',
        a: 'P2P trading is currently free — 0% maker and 0% taker fees.',
      },
      {
        q: 'Where can I see all fees?',
        a: 'Our complete fee schedule is on the Fees page.',
      },
    ],
  },
]

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-4 h-4 text-text-muted transition-transform duration-200 flex-shrink-0 ${open ? 'rotate-180' : ''}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  )
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <button
        className="w-full flex items-center justify-between gap-3 px-4 py-3.5 text-left hover:bg-surface transition-colors"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="text-sm font-medium text-text-primary">{q}</span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div className="px-4 pb-4 text-sm text-text-muted leading-relaxed border-t border-border pt-3">
          {a}
        </div>
      )}
    </div>
  )
}

export default function HelpPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-10 pb-16">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-black text-text-primary">Help Centre</h1>
        <p className="text-text-muted mt-2 text-sm">Answers to the most common questions about RupChain</p>
      </div>

      {/* Contact bar */}
      <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 mb-8 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-text-primary">Still need help?</p>
          <p className="text-sm text-text-muted">Our support team is available via live chat or email.</p>
        </div>
        <div className="flex gap-3 flex-shrink-0">
          <button
            onClick={() => openSupportChat()}
            className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
          >
            Live Chat
          </button>
          <a
            href={supportMailto('RupChain Support')}
            className="px-4 py-2 text-sm font-medium border border-border text-text-primary rounded-lg hover:bg-surface transition-colors"
          >
            Email Us
          </a>
        </div>
      </div>

      {/* FAQ sections */}
      <div className="space-y-8">
        {FAQS.map((section) => (
          <div key={section.category}>
            <h2 className="text-base font-bold text-text-primary mb-3">{section.category}</h2>
            <div className="space-y-2">
              {section.items.map((item) => (
                <FaqItem key={item.q} q={item.q} a={item.a} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Footer links */}
      <div className="mt-10 pt-6 border-t border-border flex flex-wrap gap-4 text-sm text-text-muted">
        <Link href="/terms" className="hover:text-primary transition-colors">Terms of Service</Link>
        <Link href="/privacy" className="hover:text-primary transition-colors">Privacy Policy</Link>
        <Link href="/fees" className="hover:text-primary transition-colors">Fee Schedule</Link>
        <a href={supportMailto('RupChain Support')} className="hover:text-primary transition-colors">{SUPPORT_EMAIL}</a>
      </div>
    </div>
  )
}
