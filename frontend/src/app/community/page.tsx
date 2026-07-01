import Link from 'next/link'
import { CommunityChannels } from '@/components/layout/CommunityChannels'
import { StaticPageNav } from '@/components/ui/StaticPageNav'
import { buildMeta } from '@/lib/metadata'
import { SUPPORT_EMAIL, supportMailto } from '@/lib/contact'

export const metadata = buildMeta(
  'RupChain Community — Telegram & WhatsApp',
  'Join the RupChain community: chat with traders on Telegram, follow official announcements, and get news on our WhatsApp channel.',
  '/community',
)

export default function CommunityPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-10 pb-16 space-y-8">
      <StaticPageNav />

      <div className="text-center space-y-3">
        <h1 className="text-3xl font-black text-text-primary">Join the community</h1>
        <p className="text-text-muted text-base max-w-xl mx-auto">
          Connect with fellow traders, stay on top of official updates, and get help fast.
          Pick the channel that suits you.
        </p>
      </div>

      <CommunityChannels />

      {/* Safety note — important for a crypto community */}
      <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
        <p className="text-sm font-semibold text-text-primary">Stay safe</p>
        <p className="text-sm text-text-muted mt-1 leading-relaxed">
          RupChain staff will <strong>never</strong> DM you first asking for your password, 2FA code,
          seed phrase, or payment. These are our only official channels — anyone else claiming to be
          RupChain is a scam.
        </p>
      </div>

      <div className="text-center text-sm text-text-muted">
        Prefer to reach us directly?{' '}
        <Link href="/help" className="text-primary hover:underline">Help Centre</Link>
        {' '}·{' '}
        <a href={supportMailto('RupChain Support')} className="text-primary hover:underline">{SUPPORT_EMAIL}</a>
      </div>
    </div>
  )
}
