import { describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EventForm } from '@/components/portfolio/EventForm'
import type { PortfolioEventInput, PortfolioEventType } from '@/lib/portfolio/types'
// The SERVER's real validation (strict: unknown or malformed fields are rejected).
import { eventSchema } from '../../../backend/src/lib/portfolio/eventInput'

/** Fill the real form, capture exactly what it sends, and check the real server schema accepts it. */
async function submitted(type: PortfolioEventType, fill: (u: ReturnType<typeof userEvent.setup>) => Promise<void>) {
  cleanup() // a test may submit more than one form
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  render(<EventForm assetName="X" defaultType={type} onSubmit={onSubmit} onCancel={() => {}} />)
  await fill(user)
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(onSubmit).toHaveBeenCalledTimes(1)
  return onSubmit.mock.calls[0]![0] as PortfolioEventInput
}

describe('what the entry form sends is accepted by the server\'s own validation', () => {
  it('a buy with a fee', async () => {
    const input = await submitted('BUY', async (u) => {
      await u.type(screen.getByLabelText('Quantity'), '12.5')
      await u.type(screen.getByLabelText('Amount paid (PKR)'), '25000.75')
      await u.click(screen.getByRole('button', { name: /More options/ }))
      await u.type(screen.getByLabelText(/Fee/), '10')
      await u.type(screen.getByLabelText('Note, optional'), 'bought on a dip')
    })
    const r = eventSchema.safeParse(input)
    expect(r.success, JSON.stringify(r.success ? '' : r.error.issues)).toBe(true)
  })
  it('a sell in USDT sends no rate', async () => {
    const input = await submitted('SELL', async (u) => {
      await u.click(screen.getByRole('radio', { name: 'USDT' }))
      await u.type(screen.getByLabelText('Quantity'), '3')
      await u.type(screen.getByLabelText('Amount received (USDT)'), '36.5')
    })
    expect(input).toMatchObject({ type: 'SELL', quote: 'USDT' })
    expect(input).not.toHaveProperty('fxRate')
    const r = eventSchema.safeParse(input)
    expect(r.success, JSON.stringify(r.success ? '' : r.error.issues)).toBe(true)
  })
  it('an opening holding with unknown cost', async () => {
    const input = await submitted('OPENING', async (u) => { await u.type(screen.getByLabelText('Quantity'), '10') })
    const r = eventSchema.safeParse(input)
    expect(r.success, JSON.stringify(r.success ? '' : r.error.issues)).toBe(true)
  })
  it('an opening holding with a known cost, and with a confirmed zero cost', async () => {
    const known = await submitted('OPENING', async (u) => {
      await u.type(screen.getByLabelText('Quantity'), '10')
      await u.type(screen.getByLabelText(/Total cost/), '555.5')
    })
    expect(eventSchema.safeParse(known).success).toBe(true)
    const zero = await submitted('OPENING', async (u) => {
      await u.type(screen.getByLabelText('Quantity'), '4')
      await u.click(screen.getByLabelText(/cost me nothing/))
    })
    expect(zero).toMatchObject({ basis: '0', zeroCost: true })
    expect(eventSchema.safeParse(zero).success).toBe(true)
  })
  it('the request id the form generates is one the server accepts', async () => {
    const input = await submitted('BUY', async (u) => {
      await u.type(screen.getByLabelText('Quantity'), '1')
      await u.type(screen.getByLabelText('Amount paid (PKR)'), '1')
    })
    expect(input.clientRequestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(eventSchema.safeParse(input).success).toBe(true)
  })
})
