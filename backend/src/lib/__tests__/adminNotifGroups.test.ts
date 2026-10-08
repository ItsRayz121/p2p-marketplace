import { describe, it, expect } from 'vitest'
import { classifyNotification, normalizePrefs, mutedInAppGroups, defaultPrefs } from '../adminNotifGroups'

describe('classifyNotification', () => {
  it('routes by topic before category', () => {
    expect(classifyNotification({ category: 'GAS', title: 'PKR Proof Submitted — PKR 134', href: '/admin/gas/orders/X' })).toBe('payment_review')
    expect(classifyNotification({ category: 'GAS', title: 'Gas Fee Delivery Failed After 3 Attempts' })).toBe('gas_orders')
    expect(classifyNotification({ category: 'TRADE', title: 'Trade Completed' })).toBe('usdt_trades')
    expect(classifyNotification({ category: 'CTM', title: 'New CTM Token Suggestion' })).toBe('ctm_trades')
    expect(classifyNotification({ category: 'DISPUTE', title: 'Dispute settled by the parties' })).toBe('disputes')
    expect(classifyNotification({ category: 'TRADE', title: 'Trade Dispute Opened' })).toBe('disputes')
    expect(classifyNotification({ category: 'SYSTEM', title: 'New support message', href: '/admin/support' })).toBe('support')
    expect(classifyNotification({ category: 'SYSTEM', title: 'New Affiliate Application', href: '/admin/gas/affiliates' })).toBe('affiliates')
    expect(classifyNotification({ category: 'SYSTEM', title: 'Share & Earn post to review', href: '/admin/gas/share-rewards' })).toBe('promotions')
    expect(classifyNotification({ category: 'SYSTEM', title: 'Background sweep failed: x' })).toBe('system')
    expect(classifyNotification({ category: 'WITHDRAWAL', title: 'Withdrawal Sent' })).toBe('payment_review')
  })
})

describe('preferences', () => {
  it('defaults keep every group on in-app and never mute mandatory groups', () => {
    const d = defaultPrefs()
    expect(Object.values(d).every((g) => g.inApp)).toBe(true)
    const p = normalizePrefs({ groups: { system: { inApp: false }, usdt_trades: { inApp: false, sound: true }, bogus: { inApp: false } } })
    expect(p.system.inApp).toBe(true)
    expect(p.usdt_trades).toMatchObject({ inApp: false, sound: true })
    expect(mutedInAppGroups(p)).toEqual(['usdt_trades'])
  })
  it('ignores garbage', () => {
    expect(normalizePrefs('x')).toEqual(defaultPrefs())
    expect(normalizePrefs({ groups: { gas_orders: { push: 'no' } } }).gas_orders.push).toBe(true)
  })
})
