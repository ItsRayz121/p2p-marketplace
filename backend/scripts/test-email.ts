/**
 * One-shot Resend sender smoke test.
 *
 * Usage (on Railway shell or locally with env loaded):
 *   npx tsx scripts/test-email.ts recipient@example.com
 *
 * It validates EMAIL_FROM, prints the resolved sender, then attempts a single
 * send and prints Resend's response. Exits non-zero on any failure so it's
 * usable in CI / health checks.
 */
import { resend, EMAIL_FROM, isEmailConfigured } from '../src/lib/resend'
import { env } from '../src/lib/env'

async function main() {
  const to = process.argv[2]
  if (!to) {
    console.error('Usage: npx tsx scripts/test-email.ts <recipient@example.com>')
    process.exit(2)
  }

  console.log('— Resend config check —')
  console.log('RESEND_API_KEY set:', Boolean(env.RESEND_API_KEY))
  console.log('EMAIL_FROM raw:    ', env.EMAIL_FROM ?? '(unset)')
  console.log('EMAIL_FROM parsed: ', EMAIL_FROM ?? '(invalid)')

  if (!isEmailConfigured()) {
    console.error(
      'Email not configured. Fix EMAIL_FROM and/or RESEND_API_KEY in Railway, then redeploy.',
    )
    process.exit(1)
  }

  console.log(`Sending test email to ${to} …`)
  const result = await resend.emails.send({
    from: EMAIL_FROM!,
    to,
    subject: '[PakSwap] Resend sender smoke test',
    html: `<p>This is a one-shot smoke test from <code>scripts/test-email.ts</code>.</p>
           <p>Sender: <code>${EMAIL_FROM}</code></p>
           <p>If you see this, Resend accepted the message.</p>`,
  })

  if ((result as { error?: unknown }).error) {
    console.error('Resend returned an error:', (result as { error: unknown }).error)
    process.exit(1)
  }
  console.log('Sent. Resend response:', JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error('Test send threw:', err)
  process.exit(1)
})
