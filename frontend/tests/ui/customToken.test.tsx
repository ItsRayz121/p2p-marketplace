import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { validateCustomAsset, parseSourceUrl, cleanText } from '@/lib/portfolio/customAsset'
import { monogramHue, monogramInitials } from '@/lib/portfolio/monogram'
import { CustomTokenForm, NAME_HELP, SOURCE_HELP } from '@/components/portfolio/CustomTokenForm'
import { PortfolioTab } from '@/components/portfolio/PortfolioTab'
import type { PortfolioAsset } from '@/lib/portfolio/types'

const ZWSP = String.fromCodePoint(0x200b) // zero-width space
const RLO = String.fromCodePoint(0x202e) // right-to-left override

describe('validateCustomAsset', () => {
  it('accepts a name only', () => {
    const r = validateCustomAsset({ name: '  Meta   Earth ' })
    expect(r).toEqual({ ok: true, value: { name: 'Meta Earth', symbol: null, sourceUrl: null, network: null, contractAddress: null } })
  })
  it('requires a name', () => {
    for (const name of ['', '   ', ZWSP + RLO]) {
      const r = validateCustomAsset({ name })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors.name).toBeTruthy()
    }
  })
  it('limits name length by characters, not UTF-16 units', () => {
    expect(validateCustomAsset({ name: '😀'.repeat(80) }).ok).toBe(true)
    expect(validateCustomAsset({ name: 'a'.repeat(81) }).ok).toBe(false)
  })
  it('strips invisible/bidi characters that could disguise names', () => {
    expect(cleanText('Al' + RLO + 'pha' + ZWSP)).toBe('Al pha')
    const r = validateCustomAsset({ name: 'A' + RLO + 'b' })
    expect(r.ok && r.value.name).toBe('A b')
  })
  it('symbol is optional and charset-limited', () => {
    expect(validateCustomAsset({ name: 'X', symbol: '' }).ok).toBe(true)
    expect(validateCustomAsset({ name: 'X', symbol: 'mEc' }).ok).toBe(true)
    expect(validateCustomAsset({ name: 'X', symbol: '<b>' }).ok).toBe(false)
    expect(validateCustomAsset({ name: 'X', symbol: 'A'.repeat(17) }).ok).toBe(false)
  })
  it('network is required when a contract is given', () => {
    const r = validateCustomAsset({ name: 'X', contractAddress: '0xabc' })
    expect(r.ok).toBe(false)
    expect(validateCustomAsset({ name: 'X', network: 'BEP20', contractAddress: '0xabc' }).ok).toBe(true)
    expect(validateCustomAsset({ name: 'X', network: 'BEP20' }).ok).toBe(true)
  })
})

describe('parseSourceUrl', () => {
  it.each(['https://example.com', 'http://example.com/path?q=1#x', 'HTTPS://Example.COM'])('accepts %s', (u) => {
    expect(parseSourceUrl(u).ok).toBe(true)
  })
  it.each([
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)',
    'file:///etc/passwd', 'ftp://example.com', 'blob:https://example.com/x', 'about:blank',
    'example.com', '//example.com', 'https://', 'https://user:pass@example.com', 'https://user@example.com',
    'java\nscript:alert(1)', 'java\tscript:alert(1)', 'https://exa mple.com', 'https://example.com/' + RLO + 'evil',
    'https://example.com/' + 'a'.repeat(2100),
  ])('rejects %j', (u) => {
    expect(parseSourceUrl(u).ok).toBe(false)
  })
  it('a link that is short as typed but too long once stored (non-ASCII is percent-encoded) is rejected', () => {
    const url = 'https://example.com/' + 'é'.repeat(700)
    expect(url.length).toBeLessThan(2048)
    const r = parseSourceUrl(url)
    expect(r.ok).toBe(false)
    expect(validateCustomAsset({ name: 'X', sourceUrl: url }).ok).toBe(false)
  })
  it('a long link that still fits when stored is accepted', () => {
    expect(parseSourceUrl('https://example.com/' + 'a'.repeat(1900)).ok).toBe(true)
  })
  it('blank URL never blocks creation', () => {
    expect(validateCustomAsset({ name: 'X', sourceUrl: '   ' }).ok).toBe(true)
    expect(validateCustomAsset({ name: 'X', sourceUrl: undefined }).ok).toBe(true)
  })
})

describe('monogram', () => {
  it('is deterministic and initial-based', () => {
    expect(monogramInitials('Meta Earth')).toBe('ME')
    expect(monogramInitials('Sidra')).toBe('SI')
    expect(monogramInitials('😀 Smile')).toBe('SM')
    expect(monogramInitials('***')).toBe('?')
    expect(monogramHue('Meta Earth')).toBe(monogramHue('Meta Earth'))
  })
})

describe('CustomTokenForm', () => {
  it('shows the required help texts and marks only the name as required', () => {
    render(<CustomTokenForm onSubmit={() => {}} onCancel={() => {}} />)
    expect(screen.getByText(NAME_HELP)).toBeInTheDocument()
    expect(screen.getByText(SOURCE_HELP)).toBeInTheDocument()
    expect(screen.getByLabelText('Token name')).toBeRequired()
    expect(screen.getByLabelText(/Symbol/)).not.toBeRequired()
    expect(screen.getByLabelText(/Official website/)).not.toBeRequired()
    expect(NAME_HELP).toBe('Copy the exact token name from its official website or another trusted source.')
    expect(SOURCE_HELP).toBe('Helps identify similarly named tokens. Leave blank when unsure. A link does not verify the token.')
  })
  it('creates with name only', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<CustomTokenForm onSubmit={onSubmit} onCancel={() => {}} />)
    await user.type(screen.getByLabelText('Token name'), 'Meta Earth')
    await user.click(screen.getByRole('button', { name: 'Add token' }))
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Meta Earth', symbol: null, sourceUrl: null, network: null, contractAddress: null })
  })
  it('blocks an empty name, focuses it, and does not submit', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<CustomTokenForm onSubmit={onSubmit} onCancel={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Add token' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(await screen.findByText('Enter the token name.')).toBeInTheDocument()
    await vi.waitFor(() => expect(screen.getByLabelText('Token name')).toHaveFocus())
    expect(screen.getByLabelText('Token name')).toHaveAttribute('aria-invalid', 'true')
  })
  it('rejects a javascript: link but keeps the help text', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<CustomTokenForm onSubmit={onSubmit} onCancel={() => {}} />)
    await user.type(screen.getByLabelText('Token name'), 'X')
    await user.type(screen.getByLabelText(/Official website/), 'javascript:alert(1)')
    await user.click(screen.getByRole('button', { name: 'Add token' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('Only http:// or https:// links are allowed.')).toBeInTheDocument()
    expect(screen.getByText(SOURCE_HELP)).toBeInTheDocument()
  })
  it('network/contract details are disclosed progressively', async () => {
    const user = userEvent.setup()
    render(<CustomTokenForm onSubmit={() => {}} onCancel={() => {}} />)
    expect(screen.queryByLabelText(/Contract address/)).toBeNull()
    await user.click(screen.getByRole('button', { name: /network and contract/i }))
    expect(screen.getByLabelText(/Contract address/)).toBeInTheDocument()
  })
  it('shows a server error without losing input', async () => {
    const user = userEvent.setup()
    render(<CustomTokenForm onSubmit={() => { throw new Error('Server said no') }} onCancel={() => {}} />)
    await user.type(screen.getByLabelText('Token name'), 'Keep me')
    await user.click(screen.getByRole('button', { name: 'Add token' }))
    expect(await screen.findByText('Server said no')).toBeInTheDocument()
    expect(screen.getByLabelText('Token name')).toHaveValue('Keep me')
  })
})

describe('safe rendering and no remote requests', () => {
  afterEach(() => vi.restoreAllMocks())

  const hostile: PortfolioAsset[] = [
    { id: 'h1', name: '<img src=x onerror=alert(1)>', symbol: '"><script>', sourceUrl: 'https://evil.example/logo.png' },
    { id: 'h2', name: '=HYPERLINK("http://evil")', sourceUrl: 'javascript:alert(1)' },
  ]

  it('renders hostile names as text and never creates elements from them', async () => {
    const user = userEvent.setup()
    const { container } = render(<PortfolioTab assets={hostile} />)
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(container.querySelector('img, script, iframe, object, embed, svg image')).toBeNull()
    await user.click(screen.getByText('<img src=x onerror=alert(1)>'))
    expect(container.querySelector('img, script')).toBeNull()
  })
  it('only http/https source links render, with safe rel, and as hostname text', async () => {
    const user = userEvent.setup()
    const { container } = render(<PortfolioTab assets={hostile} />)
    await user.click(screen.getByText('<img src=x onerror=alert(1)>'))
    const link = screen.getByRole('link', { name: 'evil.example' })
    expect(link).toHaveAttribute('href', 'https://evil.example/logo.png')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'))
    expect(screen.getByText('A link does not verify the token.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /back to portfolio/i }))
    await user.click(screen.getByText('=HYPERLINK("http://evil")'))
    expect(container.querySelector('a[href^="javascript"]')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })
  it('creating, viewing and editing a token makes zero network requests and loads no images', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, 'open')
    const beacon = vi.fn()
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })

    const assets: PortfolioAsset[] = []
    const onAdd = vi.fn(async (v) => { assets.push({ id: 'n1', ...v }) })
    const { container, rerender } = render(<PortfolioTab assets={assets} onAddAsset={onAdd} onEditAsset={async () => {}} />)
    await user.click(screen.getByRole('button', { name: 'Add custom token' }))
    await user.type(screen.getByLabelText('Token name'), 'Meta Earth')
    await user.type(screen.getByLabelText(/Official website/), 'https://metaearth.example')
    await user.click(screen.getByRole('button', { name: 'Add token' }))
    rerender(<PortfolioTab assets={[...assets]} onAddAsset={onAdd} onEditAsset={async () => {}} />)
    await user.click(await screen.findByText('Meta Earth'))
    expect(within(container).getAllByTestId('token-monogram').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Edit details' }))

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(xhrOpen).not.toHaveBeenCalled()
    expect(beacon).not.toHaveBeenCalled()
    expect(container.querySelector('img, link[rel~="icon"], iframe')).toBeNull()
    vi.unstubAllGlobals()
  })
})
