export default function PrivacyPage() {
  const lastUpdated = '1 January 2025'

  return (
    <div className="max-w-3xl mx-auto px-4 py-10 pb-16">
      <div className="mb-8">
        <h1 className="text-3xl font-black text-text-primary">Privacy Policy</h1>
        <p className="text-sm text-text-muted mt-1">Last updated: {lastUpdated}</p>
      </div>

      <div className="space-y-8">
        <p className="text-text-muted text-sm leading-relaxed">
          RupChain (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;) is committed to protecting your privacy. This Privacy Policy explains what
          data we collect, how we use it, and your rights regarding your personal information.
        </p>

        {[
          {
            title: '1. Data We Collect',
            items: [
              { label: 'Account Information', desc: 'Email address, full name, username, and password (hashed).' },
              { label: 'Identity Documents', desc: 'CNIC front/back images and selfie photos submitted for KYC verification.' },
              { label: 'Transaction Data', desc: 'Trade history, wallet transactions, payment references, and order history.' },
              { label: 'Payment Information', desc: 'JazzCash/Easypaisa numbers, bank account details you add to your profile.' },
              { label: 'Device & Usage Data', desc: 'IP addresses, browser/device info, session timestamps, and activity logs.' },
              { label: 'Communication Data', desc: 'Messages sent in trade chat, support tickets, and dispute evidence.' },
            ],
          },
          {
            title: '2. How We Use Your Data',
            items: [
              { label: 'Identity Verification', desc: 'KYC documents are used solely to verify your identity and comply with anti-money laundering regulations.' },
              { label: 'Service Delivery', desc: 'To facilitate trades, process payments, and operate platform wallet services.' },
              { label: 'Security', desc: 'To detect and prevent fraud, money laundering, and unauthorized access.' },
              { label: 'Communication', desc: 'To send transaction notifications, security alerts, and platform updates.' },
              { label: 'Compliance', desc: 'To comply with applicable Pakistani laws and regulatory requirements.' },
              { label: 'Platform Improvement', desc: 'Anonymized usage data helps us improve performance and user experience.' },
            ],
          },
          {
            title: '3. CNIC & Identity Document Handling',
            items: [
              { label: 'Storage', desc: 'CNIC images are stored encrypted using AES-256 encryption on secure cloud infrastructure.' },
              { label: 'Access', desc: 'Only authorized KYC review staff can access identity documents.' },
              { label: 'Retention', desc: 'Documents are retained for 5 years after account closure as required by Pakistani financial regulations.' },
              { label: 'No Sharing', desc: 'We do not sell or share your CNIC data with third parties, except as required by law or court order.' },
              { label: 'Security', desc: 'Documents are transmitted over TLS and stored with access controls and audit logging.' },
            ],
          },
          {
            title: '4. Data Sharing',
            items: [
              { label: 'No Selling', desc: 'We never sell your personal data to third parties.' },
              { label: 'Service Providers', desc: 'We share minimal data with trusted providers (cloud hosting, email delivery) under strict data processing agreements.' },
              { label: 'Legal Requirements', desc: 'We may disclose data to law enforcement or government authorities when legally required.' },
              { label: 'Business Transfer', desc: 'In the event of a merger or acquisition, users will be notified before any data transfer.' },
            ],
          },
          {
            title: '5. Cookies & Tracking',
            items: [
              { label: 'Session Cookies', desc: 'Used to maintain your login session. Required for the platform to function.' },
              { label: 'Security Tokens', desc: 'CSRF tokens are used to protect against cross-site request forgery attacks.' },
              { label: 'No Ad Tracking', desc: 'We do not use third-party advertising trackers or analytics that identify you individually.' },
            ],
          },
          {
            title: '6. Your Rights',
            items: [
              { label: 'Access', desc: 'You can request a copy of all personal data we hold about you by emailing privacy@RupChain.pk.' },
              { label: 'Correction', desc: 'You can update your profile information at any time from Settings.' },
              { label: 'Deletion', desc: 'You may request account deletion by contacting support@RupChain.pk. Some data may be retained as required by law.' },
              { label: 'Portability', desc: 'You may request your trade history and transaction data in machine-readable format.' },
              { label: 'Withdrawal of Consent', desc: 'You may withdraw consent for optional data processing at any time, though this may limit platform functionality.' },
            ],
          },
          {
            title: '7. Data Security',
            items: [
              { label: 'Encryption', desc: 'All data is transmitted via TLS 1.3 and sensitive data at rest is encrypted.' },
              { label: 'Access Controls', desc: 'Staff access to user data is role-based, logged, and audited.' },
              { label: 'Incident Response', desc: 'We have a data breach response plan. Affected users will be notified within 72 hours of discovery.' },
            ],
          },
          {
            title: '8. Data Retention',
            items: [
              { label: 'Active Accounts', desc: 'Data is retained for the duration of your account.' },
              { label: 'Closed Accounts', desc: 'Transaction records and KYC documents are retained for 5 years per regulatory requirements.' },
              { label: 'Anonymization', desc: 'After the retention period, identifying information is anonymized rather than deleted.' },
            ],
          },
        ].map((section) => (
          <section key={section.title} className="space-y-3">
            <h2 className="text-base font-bold text-text-primary border-b border-border pb-2">{section.title}</h2>
            <div className="space-y-3">
              {section.items.map((item) => (
                <div key={item.label} className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0 mt-2" />
                  <div>
                    <span className="text-sm font-semibold text-text-primary">{item.label}: </span>
                    <span className="text-sm text-text-muted">{item.desc}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}

        <div className="bg-surface border border-border rounded-xl p-5 text-sm text-text-muted space-y-1">
          <p className="font-semibold text-text-primary">Privacy Inquiries</p>
          <p>Email: <a href="mailto:privacy@RupChain.pk" className="text-primary underline">privacy@RupChain.pk</a></p>
          <p>We aim to respond to all privacy requests within 30 days.</p>
        </div>
      </div>
    </div>
  )
}
