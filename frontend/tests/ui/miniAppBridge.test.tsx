import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

const replace = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }))
vi.mock('@/lib/telegram', () => ({
  loadTelegramSdk: () => Promise.resolve(null),
  getInitData: () => 'x',
  getStartParam: () => '',
  parseStartParamToPath: () => null,
}))

import MiniAppBridge from '@/app/mini-app/page'
import { useAuthStore } from '@/store/auth.store'

const user = (role: string) => ({ id: 'u1', email: 'a@b.c', fullName: 'T', username: 't', avatarUrl: null, kycStatus: 'none', kycLevel: 'none', role }) as never

function open(role: string, search = '') {
  window.history.pushState({}, '', `/mini-app${search}`)
  useAuthStore.setState({ user: user(role), isLoading: false })
  render(<MiniAppBridge />)
}

beforeEach(() => { replace.mockReset(); useAuthStore.setState({ user: null, isLoading: true }) })

describe('the Telegram Mini App bridge', () => {
  it('sends an admin who opens the app plainly to the admin panel, not the user dashboard', async () => {
    open('admin')
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin'))
  })
  it('sends other staff roles to the admin panel too, and ordinary users to the dashboard', async () => {
    open('kyc_reviewer')
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin'))
    replace.mockReset()
    useAuthStore.setState({ user: user('user') })
    render(<MiniAppBridge />)
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'))
  })
  it('lands an alert on exactly the page it is about', async () => {
    open('admin', `?path=${encodeURIComponent('/admin/gas/orders/GF-1')}`)
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin/gas/orders/GF-1'))
  })
  it('never follows an external or protocol-relative destination', async () => {
    open('admin', `?path=${encodeURIComponent('//evil.example')}`)
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin'))
  })
})
