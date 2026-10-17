import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({
  getKycQueue: vi.fn(), getKycSubmission: vi.fn(), reviewKycItem: vi.fn(), requestKycChanges: vi.fn(), approveKycPart: vi.fn(), approveKyc: vi.fn(), rejectKyc: vi.fn(),
  resubmit: vi.fn(),
}))
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  adminApi: api,
  kycApi: { resubmit: api.resubmit },
}))
vi.mock('@/hooks/usePolling', () => ({ usePolling: (fn: () => void) => { void fn() } }))
vi.mock('@/hooks/useFileUpload', () => ({ useFileUpload: () => ({ upload: vi.fn(), uploading: false, error: null, progress: null }) }))
vi.mock('@/components/admin/KycDocImage', () => ({ KycDocImage: ({ label }: { label: string }) => <div>{label} image</div> }))

import KycQueuePage from '@/app/admin/kyc/page'
import { KycItemControls } from '@/components/admin/KycItemControls'
import { KycChangesCard } from '@/components/kyc/KycChangesCard'

const item = (name: string, part: 'basic' | 'enhanced', status = 'pending', reason: string | null = null) => ({ item: name, part, status, reason })
const submission = (o: Record<string, unknown> = {}) => ({
  id: 's1', userId: 'u1', user: { email: 'a@b.c', username: 'ali' }, tier: 'enhanced', status: 'pending', basicState: 'pending', enhancedState: 'pending',
  idType: 'national_id', frontUrl: 'f', backUrl: 'b', selfieUrl: 's', legalName: 'Ali Khan', cnicNumberHash: 'hhhh1862', whatsappNumber: '+923071439415',
  communityLinks: [{ url: 'https://chat.whatsapp.com/x' }], referenceUrl: null, socialLinks: [{ platform: 'Facebook', url: 'https://facebook.com/x' }], createdAt: '2026-10-15T10:00:00Z',
  items: [item('id_front', 'basic'), item('id_back', 'basic'), item('selfie', 'basic'), item('legal_name', 'basic'), item('social', 'basic'), item('whatsapp', 'enhanced'), item('community', 'enhanced')],
  ...o,
})

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset())
  api.getKycQueue.mockResolvedValue({ submissions: [submission()], pagination: { total: 1, page: 1, limit: 20, pages: 1 } })
  api.getKycSubmission.mockResolvedValue(submission())
})

async function openReview() {
  const user = userEvent.setup()
  render(<KycQueuePage />)
  await user.click(await screen.findByRole('button', { name: 'Review' }))
  await screen.findByText('KYC Review')
  return user
}

describe('item controls', () => {
  it('approves in one click, and needs a reason to send back or reject', async () => {
    const onDecide = vi.fn()
    const user = userEvent.setup()
    render(<KycItemControls label="selfie" status="pending" locked={false} onDecide={onDecide} />)
    await user.click(screen.getByRole('button', { name: 'Approve selfie' }))
    expect(onDecide).toHaveBeenCalledWith('approved')
    await user.click(screen.getByRole('button', { name: 'Request resubmission of selfie' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await user.type(screen.getByLabelText('Reason for selfie'), 'Too blurry{Enter}')
    expect(onDecide).toHaveBeenLastCalledWith('resubmit', 'Too blurry')
  })
  it('shows the decision and its reason, and offers no actions once the part is decided', () => {
    render(<KycItemControls label="selfie" status="resubmit" reason="Too blurry" locked onDecide={vi.fn()} />)
    expect(screen.getByText('Sent back')).toBeInTheDocument()
    expect(screen.getByText('Too blurry')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /selfie/ })).toBeNull()
  })
})

describe('the admin review modal', () => {
  it('shows each part separately with small actions on every document and answer', async () => {
    await openReview()
    expect(api.getKycSubmission).toHaveBeenCalledWith('s1')
    expect((await screen.findAllByText(/Basic: Pending/)).length).toBeGreaterThan(0)
    for (const l of ['ID front', 'ID back', 'selfie', 'name', 'WhatsApp number', 'community link', 'social profiles']) {
      expect(screen.getByRole('button', { name: `Approve ${l}` })).toBeInTheDocument()
    }
  })

  it('an item decision is saved at once and the refreshed state is shown', async () => {
    api.reviewKycItem.mockResolvedValue({ items: [] })
    const user = await openReview()
    api.getKycSubmission.mockResolvedValue(submission({ items: [item('id_front', 'basic'), item('id_back', 'basic'), item('selfie', 'basic'), item('legal_name', 'basic'), item('social', 'basic'), item('whatsapp', 'enhanced'), item('community', 'enhanced', 'resubmit', 'dead link')] }))
    await user.click(await screen.findByRole('button', { name: 'Request resubmission of community link' }))
    await user.type(screen.getByLabelText('Reason for community link'), 'dead link{Enter}')
    await waitFor(() => expect(api.reviewKycItem).toHaveBeenCalledWith('s1', 'community', { status: 'resubmit', reason: 'dead link' }))
    expect(await screen.findByText('dead link')).toBeInTheDocument()
  })

  it('Basic can be approved while an Enhanced item is sent back; Enhanced stays locked behind Basic', async () => {
    api.approveKycPart.mockResolvedValue({ status: 'pending' })
    api.getKycSubmission.mockResolvedValue(submission({ items: [item('id_front', 'basic'), item('id_back', 'basic'), item('selfie', 'basic'), item('legal_name', 'basic'), item('social', 'basic'), item('whatsapp', 'enhanced'), item('community', 'enhanced', 'resubmit', 'dead link')] }))
    const user = await openReview()
    expect(await screen.findByRole('button', { name: 'Send change request' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve Enhanced' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve Basic + Enhanced' })).toBeNull() // a flagged item blocks the combined approval
    const approve = screen.getByRole('button', { name: 'Approve Basic' })
    expect(approve).toBeEnabled()
    await user.click(approve)
    const dialog = await screen.findByRole('dialog', { name: /Approve Basic KYC/ }).catch(() => null)
    const confirm = dialog ? within(dialog).getByRole('button', { name: 'Approve' }) : (await screen.findAllByRole('button', { name: 'Approve' }))[0]!
    await user.click(confirm)
    await waitFor(() => expect(api.approveKycPart).toHaveBeenCalledWith('s1', 'basic'))
    expect(api.approveKyc).not.toHaveBeenCalled()
  })

  it('a flagged identity item blocks Basic', async () => {
    api.getKycSubmission.mockResolvedValue(submission({ items: [item('id_front', 'basic'), item('id_back', 'basic'), item('selfie', 'basic', 'rejected', 'Not you'), item('whatsapp', 'enhanced'), item('community', 'enhanced')] }))
    await openReview()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve Basic' })).toBeDisabled())
  })

  it('once Basic is approved, Enhanced can be approved on its own', async () => {
    api.getKycSubmission.mockResolvedValue(submission({ basicState: 'approved', items: [item('id_front', 'basic', 'approved'), item('whatsapp', 'enhanced'), item('community', 'enhanced')] }))
    await openReview()
    expect(await screen.findByRole('button', { name: 'Approve Enhanced' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Approve Basic' })).toBeNull()
    // approved identity items are locked
    expect(screen.queryByRole('button', { name: 'Approve ID front' })).toBeNull()
  })

  it('sending the change request goes through a confirmation', async () => {
    api.requestKycChanges.mockResolvedValue({ items: [] })
    api.getKycSubmission.mockResolvedValue(submission({ items: [item('id_front', 'basic'), item('selfie', 'basic'), item('whatsapp', 'enhanced'), item('community', 'enhanced', 'resubmit', 'dead')] }))
    const user = await openReview()
    await user.click(await screen.findByRole('button', { name: 'Send change request' }))
    expect(api.requestKycChanges).not.toHaveBeenCalled()
    const buttons = await screen.findAllByRole('button', { name: 'Send request' })
    await user.click(buttons[0]!)
    await waitFor(() => expect(api.requestKycChanges).toHaveBeenCalledWith('s1'))
  })

  it('shows the server refusal instead of failing silently', async () => {
    api.reviewKycItem.mockRejectedValue(new Error('Basic is already decided.'))
    const user = await openReview()
    await user.click(await screen.findByRole('button', { name: 'Approve selfie' }))
    expect(await screen.findByText('Basic is already decided.')).toBeInTheDocument()
  })
})

describe('what the applicant sees', () => {
  const review = (items: unknown[], o: Record<string, unknown> = {}) => ({ basicState: 'approved', enhancedState: 'changes_requested', items, ...o })
  const row = (item: string, label: string, status: string, reason: string | null = null) => ({ item, label, part: item === 'whatsapp' || item === 'community' ? 'enhanced' : 'basic', status, reason })

  it('lists only the items that were sent back, with the reason', () => {
    render(<KycChangesCard submissionId="s1" onSent={() => {}} review={review([row('selfie', 'Selfie', 'approved'), row('community', 'Community link', 'resubmit', 'Dead link')]) as never} />)
    expect(screen.getByText('Community link')).toBeInTheDocument()
    expect(screen.getByText('Dead link')).toBeInTheDocument()
    expect(screen.queryByText('Selfie')).toBeNull()
    expect(screen.getByText(/Basic KYC: Verified · Enhanced KYC: Changes required/)).toBeInTheDocument()
  })

  it('sends back only what was changed, without touching the identity documents', async () => {
    api.resubmit.mockResolvedValue({})
    const onSent = vi.fn()
    const user = userEvent.setup()
    render(<KycChangesCard submissionId="s1" onSent={onSent} review={review([row('community', 'Community link', 'resubmit', 'Dead link')]) as never} />)
    await user.type(screen.getByLabelText('Community link'), 'https://t.me/mygroup123')
    await user.click(screen.getByRole('button', { name: 'Send changes' }))
    await waitFor(() => expect(api.resubmit).toHaveBeenCalledWith('s1', { communityLinks: [{ url: 'https://t.me/mygroup123' }] }))
    expect(onSent).toHaveBeenCalled()
    expect(await screen.findByText(/Sent\. We will review it soon/)).toBeInTheDocument()
  })

  it('asks for at least one item and shows the server message when it is refused', async () => {
    api.resubmit.mockRejectedValue(new Error('The trusted reference must be a link starting with https://'))
    const user = userEvent.setup()
    render(<KycChangesCard submissionId="s1" onSent={() => {}} review={review([row('reference', 'Trusted reference', 'rejected', 'Not valid')]) as never} />)
    await user.click(screen.getByRole('button', { name: 'Send changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Add at least one')
    await user.type(screen.getByLabelText('Trusted reference'), 'ftp://x')
    await user.click(screen.getByRole('button', { name: 'Send changes' }))
    expect(await screen.findByText(/must be a link starting with https/)).toBeInTheDocument()
  })

  it('shows nothing when nothing was sent back', () => {
    const { container } = render(<KycChangesCard submissionId="s1" onSent={() => {}} review={review([row('selfie', 'Selfie', 'approved')]) as never} />)
    expect(container).toBeEmptyDOMElement()
  })
})
