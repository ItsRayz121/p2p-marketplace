import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'

const signedIn = { id: 'u1', email: 'a@b.c', fullName: 'Test User', username: 'tester', avatarUrl: null, kycStatus: 'none', kycLevel: 'none', role: 'user' }
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: signedIn, logout: vi.fn() }) }))
vi.mock('@/hooks/usePolling', () => ({ usePolling: () => {} }))
vi.mock('next/navigation', () => ({ usePathname: () => '/wallet' }))
vi.mock('@/lib/api', () => ({ notificationsApi: { getUnreadCount: vi.fn().mockResolvedValue({ count: 0 }) }, airdropApi: { getStatus: vi.fn().mockResolvedValue({ enabled: false }) } }))
vi.mock('@/lib/messaging', () => ({ messagingApi: { getSummary: vi.fn().mockResolvedValue({ unread: 0 }) } }))
vi.mock('@/lib/swrCache', () => ({ dedupe: (_k: string, _t: number, f: () => unknown) => f(), userKey: (id: string, k: string) => `${id}:${k}` }))

vi.mock('@/components/ui/ThemeToggle', () => ({ ThemeToggle: () => null }))

import Navbar from '@/components/layout/Navbar'

describe('Navbar first render matches the server', () => {
  it('a browser that has a cached signed-in user still renders the signed-out header on the first pass (what the server sends)', () => {
    const html = renderToString(<Navbar />)
    expect(html).toContain('href="/login"')
    expect(html).not.toContain('aria-label="Notifications"')
  })

  it('then shows the signed-in header (bell and account menu) once mounted', async () => {
    render(<Navbar />)
    expect(await screen.findByLabelText('Notifications')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Login' })).toBeNull()
  })
})
