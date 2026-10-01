import { describe, it, expect } from 'vitest'
import { generatePaymentSlug, isValidPaymentSlug, isValidPaymentUsername, toPublicPaymentAddress, toPublicPaymentMethod } from '../paymentShare'

describe('paymentShare', () => {
  it('generates unguessable, valid, unique slugs', () => {
    const a = generatePaymentSlug()
    const b = generatePaymentSlug()
    expect(a).not.toBe(b)
    expect(isValidPaymentSlug(a)).toBe(true)
    expect(a.length).toBe(16)
  })

  it('rejects malformed slugs', () => {
    for (const bad of ['', 'short', 'has space in it!!!', '../../etc/passwd', 'a'.repeat(41), 42, null, undefined]) {
      expect(isValidPaymentSlug(bad)).toBe(false)
    }
  })

  it('bank method exposes only institution, holder and numbers', () => {
    const dto = toPublicPaymentMethod({
      type: 'bank_transfer', accountName: ' Ali Khan ', mobileNumber: '0300', bankName: 'UBL — United Bank Limited',
      ibanNumber: 'PK44UNIL0109000275878182', accountNumber: '12345',
      // extra DB columns must never leak
      ...({ id: 'x', userId: 'u', hidden: false } as object),
    } as never)
    expect(dto).toEqual({
      type: 'bank_transfer', label: 'UBL — United Bank Limited', bankName: 'UBL — United Bank Limited', accountName: 'Ali Khan',
      numbers: [{ label: 'IBAN', value: 'PK44UNIL0109000275878182' }, { label: 'Account number', value: '12345' }],
    })
    expect(Object.keys(dto).sort()).toEqual(['accountName', 'bankName', 'label', 'numbers', 'type'])
  })

  it('wallet method exposes the mobile/account number only', () => {
    const dto = toPublicPaymentMethod({ type: 'nayapay', accountName: 'Ali', mobileNumber: '03167815843', bankName: null, ibanNumber: null, accountNumber: null })
    expect(dto.label).toBe('NayaPay')
    expect(dto.numbers).toEqual([{ label: 'Account number', value: '03167815843' }])
  })

  it('validates usernames used as vanity links', () => {
    for (const ok of ['fazal', 'Fazal_Elahi', 'a.b-c']) expect(isValidPaymentUsername(ok)).toBe(true)
    for (const bad of ['', 'ab', 'has space', '../x', 'a'.repeat(33), 5, null]) expect(isValidPaymentUsername(bad)).toBe(false)
  })

  it('address exposes only coin, network, address and label', () => {
    const dto = toPublicPaymentAddress({ coin: 'USDT', network: 'BEP20', address: '0xabc\n', label: 'Main', ...({ id: 'x', userId: 'u' } as object) } as never)
    expect(dto).toEqual({ coin: 'USDT', network: 'BEP20', address: '0xabc', label: 'Main' })
  })

  it('strips control characters', () => {
    const dto = toPublicPaymentMethod({ type: 'easypaisa', accountName: 'Ali\u0000\n', mobileNumber: '0309\r8336810', bankName: null, ibanNumber: null, accountNumber: null })
    expect(dto.accountName).toBe('Ali')
    expect(dto.numbers[0]!.value).toBe('03098336810')
  })
})
