import { resend, EMAIL_FROM, isEmailConfigured } from '../lib/resend'
import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { env } from '../lib/env'

// ─── HTML Shell ───────────────────────────────────────────────────────────────

function htmlShell(content: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #0f172a;">
  <div style="text-align: center; margin-bottom: 32px;">
    <h1 style="color: #2563eb; font-size: 28px; margin: 0;">PakSwap</h1>
    <p style="color: #64748b; margin: 4px 0 0;">Pakistan P2P Crypto Exchange</p>
  </div>
  ${content}
  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
  <p style="color: #94a3b8; font-size: 12px; text-align: center;">© 2026 PakSwap. Pakistan P2P Crypto Exchange</p>
</body>
</html>`
}

// ─── Log Helper ───────────────────────────────────────────────────────────────

async function logEmail(
  template: string,
  toEmail: string,
  status: 'sent' | 'failed',
  userId?: string,
): Promise<void> {
  try {
    await db.emailLog.create({
      data: { template, toEmail, status, userId: userId ?? null },
    })
  } catch (err) {
    logger.error({ err, template, toEmail }, 'Failed to log email')
  }
}

// ─── Send Helper ──────────────────────────────────────────────────────────────

async function send(
  to: string,
  subject: string,
  html: string,
  template: string,
  userId?: string,
): Promise<void> {
  if (!isEmailConfigured() || !EMAIL_FROM) {
    logger.warn(
      { template, to },
      'Skipping email send — EMAIL_FROM or RESEND_API_KEY is missing/invalid. ' +
        'Configure them in Railway and ensure the sender domain is verified in Resend.',
    )
    await logEmail(template, to, 'failed', userId)
    return
  }
  try {
    await resend.emails.send({ from: EMAIL_FROM, to, subject, html })
    await logEmail(template, to, 'sent', userId)
  } catch (err) {
    logger.error({ err, template, to, from: EMAIL_FROM }, 'Email send failed')
    await logEmail(template, to, 'failed', userId)
    // Never throw — email failure must not crash the app
  }
}

// ─── Public Functions ─────────────────────────────────────────────────────────

export async function sendOtpEmail(
  toEmail: string,
  code: string,
  type: 'verify' | 'reset',
): Promise<void> {
  const isVerify = type === 'verify'
  const subject = isVerify ? 'Verify your PakSwap email' : 'Reset your PakSwap password'
  const heading = isVerify ? 'Email Verification' : 'Password Reset'
  const instruction = isVerify
    ? 'Enter this code to verify your email address.'
    : 'Enter this code to reset your password.'

  const html = htmlShell(`
    <h2 style="margin: 0 0 8px;">${heading}</h2>
    <p style="color: #475569; margin: 0 0 4px;">${instruction}</p>
    <div style="font-size: 36px; font-family: monospace; letter-spacing: 8px; text-align: center; padding: 16px; background: #f8fafc; border-radius: 8px; margin: 24px 0;">${code}</div>
    <p style="color: #64748b; font-size: 14px; text-align: center;">Expires in 10 minutes. Do not share this code with anyone.</p>
  `)

  await send(toEmail, subject, html, `otp_${type}`)
}

export async function sendTradeEmail(
  type: 'started' | 'payment_uploaded' | 'completed' | 'cancelled',
  trade: {
    orderRef: string
    coin: string
    amount: string
    pkrValue: string
    counterpartyUsername: string
  },
  recipientEmail: string,
): Promise<void> {
  const labels: Record<typeof type, { subject: string; heading: string; body: string }> = {
    started: {
      subject: `Trade ${trade.orderRef} started`,
      heading: 'Trade Started',
      body: `Your trade <strong>${trade.orderRef}</strong> has been started with <strong>${trade.counterpartyUsername}</strong>.`,
    },
    payment_uploaded: {
      subject: `Payment uploaded for trade ${trade.orderRef}`,
      heading: 'Payment Uploaded',
      body: `Payment proof has been uploaded for trade <strong>${trade.orderRef}</strong>. Please review and confirm.`,
    },
    completed: {
      subject: `Trade ${trade.orderRef} completed`,
      heading: 'Trade Completed',
      body: `Trade <strong>${trade.orderRef}</strong> has been completed successfully.`,
    },
    cancelled: {
      subject: `Trade ${trade.orderRef} cancelled`,
      heading: 'Trade Cancelled',
      body: `Trade <strong>${trade.orderRef}</strong> has been cancelled.`,
    },
  }

  const { subject, heading, body } = labels[type]

  const html = htmlShell(`
    <h2 style="margin: 0 0 16px;">${heading}</h2>
    <p style="color: #475569;">${body}</p>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
      <tr><td style="padding: 8px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Order Ref</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">${trade.orderRef}</td></tr>
      <tr><td style="padding: 8px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Coin</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${trade.coin}</td></tr>
      <tr><td style="padding: 8px; color: #64748b; border-bottom: 1px solid #e2e8f0;">Amount</td><td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${trade.amount} ${trade.coin}</td></tr>
      <tr><td style="padding: 8px; color: #64748b;">PKR Value</td><td style="padding: 8px;">PKR ${trade.pkrValue}</td></tr>
    </table>
  `)

  await send(recipientEmail, subject, html, `trade_${type}`)
}

export async function sendKycEmail(
  type: 'submitted' | 'approved' | 'rejected' | 'merchant_approved' | 'merchant_rejected',
  email: string,
  data?: { reason?: string; dailyLimit?: number; level?: string },
): Promise<void> {
  const configs: Record<typeof type, { subject: string; heading: string; body: string }> = {
    submitted: {
      subject: 'KYC submission received',
      heading: 'KYC Submission Received',
      body: 'Your KYC documents have been received and are under review. We will notify you once the review is complete.',
    },
    approved: {
      subject: 'KYC approved — account verified',
      heading: 'KYC Approved',
      body: `Your identity has been verified${data?.level ? ` at <strong>${data.level}</strong> level` : ''}. You can now trade on PakSwap${data?.dailyLimit ? ` with a daily limit of PKR ${data.dailyLimit.toLocaleString()}` : ''}.`,
    },
    rejected: {
      subject: 'KYC submission rejected',
      heading: 'KYC Rejected',
      body: `Your KYC submission was rejected.${data?.reason ? ` Reason: <em>${data.reason}</em>` : ''} Please resubmit with correct documents.`,
    },
    merchant_approved: {
      subject: 'Merchant application approved',
      heading: 'Merchant Account Approved',
      body: 'Congratulations! Your merchant application has been approved. You can now post ads and trade as a merchant.',
    },
    merchant_rejected: {
      subject: 'Merchant application rejected',
      heading: 'Merchant Application Rejected',
      body: `Your merchant application was rejected.${data?.reason ? ` Reason: <em>${data.reason}</em>` : ''}`,
    },
  }

  const { subject, heading, body } = configs[type]
  const html = htmlShell(`<h2 style="margin: 0 0 16px;">${heading}</h2><p style="color: #475569;">${body}</p>`)
  await send(email, subject, html, `kyc_${type}`)
}

export async function sendWithdrawalEmail(
  type: 'requested' | 'approved' | 'rejected',
  email: string,
  data: { amount: string; coin: string; txHash?: string; reason?: string },
): Promise<void> {
  const configs: Record<typeof type, { subject: string; heading: string; body: string }> = {
    requested: {
      subject: `Withdrawal request received — ${data.amount} ${data.coin}`,
      heading: 'Withdrawal Requested',
      body: `Your withdrawal of <strong>${data.amount} ${data.coin}</strong> has been submitted and is pending approval.`,
    },
    approved: {
      subject: `Withdrawal sent — ${data.amount} ${data.coin}`,
      heading: 'Withdrawal Approved & Sent',
      body: `Your withdrawal of <strong>${data.amount} ${data.coin}</strong> has been approved and sent.${data.txHash ? ` Transaction hash: <code>${data.txHash}</code>` : ''}`,
    },
    rejected: {
      subject: `Withdrawal rejected — ${data.amount} ${data.coin}`,
      heading: 'Withdrawal Rejected',
      body: `Your withdrawal of <strong>${data.amount} ${data.coin}</strong> was rejected.${data.reason ? ` Reason: <em>${data.reason}</em>` : ''}`,
    },
  }

  const { subject, heading, body } = configs[type]
  const html = htmlShell(`<h2 style="margin: 0 0 16px;">${heading}</h2><p style="color: #475569;">${body}</p>`)
  await send(email, subject, html, `withdrawal_${type}`)
}

export async function sendReferralRewardEmail(email: string, amount: string): Promise<void> {
  const html = htmlShell(`
    <h2 style="margin: 0 0 16px;">Referral Reward Earned!</h2>
    <p style="color: #475569;">You earned a referral reward of <strong>PKR ${amount}</strong> for inviting a new user to PakSwap.</p>
    <p style="color: #64748b; font-size: 14px;">Keep sharing your referral code to earn more rewards.</p>
  `)
  await send(email, `You earned a PKR ${amount} referral reward`, html, 'referral_reward')
}

export async function sendBadgeEmail(
  email: string,
  badge: string,
  direction: 'upgraded' | 'downgraded',
): Promise<void> {
  const isUpgrade = direction === 'upgraded'
  const html = htmlShell(`
    <h2 style="margin: 0 0 16px;">Trader Badge ${isUpgrade ? 'Upgraded' : 'Changed'}</h2>
    <p style="color: #475569;">Your trader badge has been ${direction} to <strong>${badge}</strong>.</p>
    <p style="color: #64748b; font-size: 14px;">${isUpgrade ? 'Keep trading to maintain and improve your badge!' : 'Complete more trades to improve your badge.'}</p>
  `)
  await send(
    email,
    `Your trader badge is now ${badge}`,
    html,
    `badge_${direction}`,
  )
}

export async function sendAdminAlertEmail(subject: string, body: string): Promise<void> {
  if (!env.ADMIN_ALERT_EMAIL) {
    logger.warn({ subject }, 'ADMIN_ALERT_EMAIL is not set — admin alert email skipped')
    return
  }
  const html = htmlShell(`
    <h2 style="margin: 0 0 16px; color: #dc2626;">Admin Alert</h2>
    <pre style="background: #f8fafc; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 13px;">${body}</pre>
  `)
  await send(env.ADMIN_ALERT_EMAIL, `[PakSwap Alert] ${subject}`, html, 'admin_alert')
}
