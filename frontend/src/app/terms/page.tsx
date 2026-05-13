export default function TermsPage() {
  const lastUpdated = '1 January 2025'

  return (
    <div className="max-w-3xl mx-auto px-4 py-10 pb-16">
      <div className="mb-8">
        <h1 className="text-3xl font-black text-text-primary">Terms of Service</h1>
        <p className="text-sm text-text-muted mt-1">Last updated: {lastUpdated}</p>
      </div>

      <div className="prose prose-sm max-w-none space-y-8">
        <p className="text-text-muted leading-relaxed">
          Please read these Terms of Service (&quot;Terms&quot;) carefully before using PakSwap. By accessing or using our platform,
          you agree to be bound by these Terms. If you do not agree, do not use the platform.
        </p>

        {[
          {
            title: '1. Eligibility',
            content: [
              'You must be at least 18 years of age to use PakSwap.',
              'You must be a resident of Pakistan or otherwise legally permitted to access cryptocurrency services.',
              'You must complete our KYC (Know Your Customer) verification before conducting trades.',
              'You may not use PakSwap if you are subject to any sanctions, are a Politically Exposed Person (PEP) without disclosure, or have been previously banned from our platform.',
              'By registering, you confirm that all information you provide is accurate, current, and complete.',
            ],
          },
          {
            title: '2. Prohibited Activities',
            content: [
              'Money laundering, terrorist financing, or any activity that violates applicable laws.',
              'Using the platform for transactions related to illegal goods or services.',
              'Creating multiple accounts, using fake identities, or impersonating others.',
              'Manipulating prices, front-running, or engaging in market manipulation.',
              'Attempting to hack, disrupt, or reverse-engineer the platform.',
              'Using automated bots or scripts without prior written permission.',
              'Engaging in wash trading or artificial volume generation.',
            ],
          },
          {
            title: '3. Escrow & Trade Execution',
            content: [
              'When a trade is initiated, the seller\'s cryptocurrency is locked in our escrow system.',
              'Cryptocurrency is only released after the buyer confirms payment and the seller verifies receipt.',
              'Trades must be completed within the agreed trade window (15 minutes to 2 hours).',
              'Incomplete trades will be automatically cancelled and escrowed funds returned.',
              'PakSwap is not responsible for errors in payment details provided by users.',
            ],
          },
          {
            title: '4. Dispute Resolution',
            content: [
              'Either party may raise a dispute during an active trade if the counterparty is unresponsive or acting in bad faith.',
              'Disputes are reviewed by our team within 24–72 hours.',
              'Users must provide evidence (screenshots, transaction records) to support their claim.',
              'Our team\'s decision is final and binding.',
              'Abuse of the dispute system may result in account suspension.',
            ],
          },
          {
            title: '5. Fees & Payments',
            content: [
              'P2P trading fees are currently 0% for both makers and takers.',
              'Instant Buy and other premium services carry fees as listed on our Fees page.',
              'Network withdrawal fees apply and are subject to blockchain conditions.',
              'We reserve the right to modify our fee structure with 7 days\' notice.',
            ],
          },
          {
            title: '6. Account Security',
            content: [
              'You are solely responsible for maintaining the security of your account credentials.',
              'You must notify us immediately at security@pakswap.pk of any unauthorized access.',
              'We recommend enabling Two-Factor Authentication (2FA).',
              'PakSwap will never ask for your password via email, WhatsApp, or any other channel.',
            ],
          },
          {
            title: '7. Limitations of Liability',
            content: [
              'PakSwap provides the platform "as is" without warranties of any kind.',
              'We are not liable for losses arising from price volatility of cryptocurrencies.',
              'We are not liable for user errors, including incorrect wallet addresses.',
              'Our liability is limited to the amount of fees paid in the 30 days preceding the claim.',
              'We are not liable for losses due to events beyond our control (force majeure).',
            ],
          },
          {
            title: '8. Account Termination',
            content: [
              'We reserve the right to suspend or terminate accounts that violate these Terms.',
              'Suspected fraudulent activity will result in immediate account suspension.',
              'Users may request account deletion by contacting support@pakswap.pk.',
              'Upon termination, any funds in your wallet will be returned after identity verification.',
            ],
          },
          {
            title: '9. Governing Law',
            content: [
              'These Terms are governed by the laws of the Islamic Republic of Pakistan.',
              'Any disputes shall be subject to the exclusive jurisdiction of courts in Lahore, Pakistan.',
              'These Terms constitute the entire agreement between you and PakSwap.',
            ],
          },
          {
            title: '10. Changes to Terms',
            content: [
              'We may update these Terms at any time with reasonable notice.',
              'Continued use of the platform after changes constitutes acceptance of the updated Terms.',
              'Material changes will be notified via email and in-app notification.',
            ],
          },
        ].map((section) => (
          <section key={section.title} className="space-y-3">
            <h2 className="text-base font-bold text-text-primary border-b border-border pb-2">{section.title}</h2>
            <ul className="space-y-2">
              {section.content.map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-text-muted leading-relaxed">
                  <span className="text-text-muted mt-0.5 flex-shrink-0">•</span>
                  {item}
                </li>
              ))}
            </ul>
          </section>
        ))}

        <div className="bg-surface border border-border rounded-xl p-5 text-sm text-text-muted">
          <p className="font-semibold text-text-primary mb-1">Contact Us</p>
          <p>For questions about these Terms, contact us at <a href="mailto:legal@pakswap.pk" className="text-primary underline">legal@pakswap.pk</a></p>
        </div>
      </div>
    </div>
  )
}
