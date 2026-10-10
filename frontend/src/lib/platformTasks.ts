import { apiRequest } from '@/lib/api'

export type VerifyMode = 'telegram_auto' | 'manual_proof' | 'self_claim'
export type RewardType = 'points' | 'usdt'
export type ClaimStatus = 'pending_review' | 'needs_changes' | 'awaiting_payout' | 'completed' | 'rejected'
export type TaskLifecycle = 'draft' | 'scheduled' | 'active' | 'paused' | 'ended' | 'archived'
export type Decision = 'approve' | 'request_changes' | 'reject'
export type PaymentState = 'credited' | 'awaiting_payment' | 'paid'
export const PAYOUT_NETWORKS = ['BEP20', 'ERC20', 'TRC20', 'APTOS'] as const
export const PLATFORMS = ['telegram', 'x', 'youtube', 'instagram', 'facebook', 'tiktok', 'discord', 'whatsapp', 'other'] as const
export type Platform = (typeof PLATFORMS)[number]

export interface ProofAttachment { url: string; name: string; size: number; mime: string }

export interface UserPlatformTask {
  id: string
  title: string
  description: string | null
  instructions?: string | null
  proofRequirements?: string | null
  proofFileRequired?: boolean
  platform?: Platform | null
  url: string | null
  logoUrl?: string | null
  verifyMode: VerifyMode
  rewardType: RewardType
  rewardPoints: number | null
  rewardUsdt: number | null
  payoutMode: 'auto' | 'manual'
  requireKyc: boolean
  endsAt: string | null
  spotsLeft: number | null
  claim: {
    status: ClaimStatus
    rejectionReason: string | null
    txHash: string | null
    createdAt: string
    completedAt: string | null
    revisionNo?: number
    /** Latest message from the reviewer to the member (never the internal note). */
    feedback?: string | null
    canResubmit?: boolean
  } | null
}

export interface UserTasksView {
  telegramLinked: boolean
  kycOk: boolean
  tasks: UserPlatformTask[]
}

export interface AdminPlatformTask {
  id: string
  title: string
  description: string | null
  instructions: string | null
  proofRequirements: string | null
  proofFileRequired: boolean
  platform: Platform | null
  url: string | null
  logoUrl?: string | null
  telegramChat: string | null
  verifyMode: VerifyMode
  rewardType: RewardType
  rewardPoints: number | null
  rewardUsdt: number | null
  payoutMode: 'auto' | 'manual'
  requireKyc: boolean
  startsAt: string | null
  endsAt: string | null
  maxClaims: number | null
  claimedCount: number
  budgetUsdt: number | null
  spentUsdt: number
  isActive: boolean
  isDraft: boolean
  archivedAt: string | null
  version: number
  lifecycle: TaskLifecycle
  createdAt: string
  counts: Partial<Record<ClaimStatus, number>>
}

export interface NewTaskInput {
  title: string
  description?: string | null
  instructions?: string | null
  proofRequirements?: string | null
  proofFileRequired?: boolean
  platform?: Platform | null
  url?: string | null
  logoUrl?: string | null
  telegramChat?: string | null
  verifyMode: VerifyMode
  rewardType: RewardType
  rewardPoints?: number | null
  rewardUsdt?: number | null
  payoutMode?: 'auto' | 'manual'
  requireKyc?: boolean
  startsAt?: string | null
  endsAt?: string | null
  maxClaims?: number | null
  budgetUsdt?: number | null
  isActive?: boolean
  isDraft?: boolean
}

export type TaskPatchInput = Partial<NewTaskInput> & { archived?: boolean }

export interface UserRef { id: string; email: string; username: string | null; fullName: string | null; telegramUsername: string | null; avatarUrl: string | null }

export interface Summary {
  period: { from: string; to: string }
  reviewTargetHours: number
  pendingReview: { count: number; overTarget: number }
  needsChanges: number
  activeTasks: number
  usdtAwaitingPayment: { amount: number; count: number }
  pointsCredited: { amount: number; count: number }
}

export interface InboxItem {
  id: string
  status: ClaimStatus
  user: UserRef
  task: { id: string; title: string; platform: Platform | null; verifyMode: VerifyMode; logoUrl: string | null }
  revisionNo: number
  isResubmission: boolean
  submittedAt: string
  waitingHours: number | null
  rewardType: RewardType
  rewardPoints: number | null
  rewardUsdt: number | null
  evidence: { files: number; links: number; hasNote: boolean }
}
export interface InboxPage { total: number; page: number; limit: number; items: InboxItem[] }

export interface RevisionView {
  number: number
  submittedAt: string
  proof: string | null
  links: Array<{ url: string; domain: string | null }>
  attachments: Array<{ name: string; size: number; mime: string; viewUrl: string | null }>
  decision: 'approved' | 'rejected' | 'needs_changes' | null
  feedback: string | null
  internalNote: string | null
  checks: Record<string, boolean> | null
  reviewedAt: string | null
  reviewer: string | null
}

export interface SubmissionDetail {
  id: string
  status: ClaimStatus
  revisionNo: number
  createdAt: string
  updatedAt: string
  waitingHours: number | null
  user: UserRef
  terms: { title: string; instructions: string | null; proofRequirements: string | null; proofFileRequired: boolean; version: number; taskHasChangedSince: boolean }
  task: { id: string; title: string; platform: Platform | null; url: string | null; verifyMode: VerifyMode; logoUrl: string | null; telegramChat: string | null }
  reward: { type: RewardType; points: number | null; usdt: number | null; payoutMode: string | null; payoutNetwork: string | null; payoutAddress: string | null; txHash: string | null }
  verification: { method: VerifyMode; automatic: boolean; note: string }
  revisions: RevisionView[]
  otherSubmissions: Array<{ id: string; status: ClaimStatus; createdAt: string; taskTitle: string }>
}

export interface RewardRow {
  id: string
  user: UserRef
  taskTitle: string
  rewardType: RewardType
  amount: number | null
  approvedAt: string
  state: PaymentState
  payoutMode: string | null
  payoutNetwork: string | null
  payoutAddress: string | null
  txHash: string | null
  paidAt: string | null
}
export interface RewardsPage {
  total: number; page: number; limit: number
  totals: { pointsCredited: number; usdtAwaitingPayment: number; usdtSettled: number }
  items: RewardRow[]
}

export interface Analytics {
  period: { from: string; to: string }
  totals: { submitted: number; approved: number; rejected: number; needsChanges: number; approvalRate: number | null }
  medianReviewHours: number | null
  reviewedCount: number
  daily: Array<{ day: string; submitted: number; approved: number; rejected: number; needs_changes: number }>
  perTask: Array<{ id: string; title: string; platform: Platform | null; verifyMode: VerifyMode; rewardType: RewardType; claims: number; approved: number; rejected: number; pending: number; approvalRate: number | null }>
  byPlatform: Array<{ platform: string; claims: number }>
  rewards: { pointsCredited: number; usdtApprovedAwaitingPayment: number; usdtSettled: number }
}

export interface ActivityPage {
  total: number; page: number; limit: number
  items: Array<{ id: string; action: string; actor: string; targetType: string | null; targetId: string | null; metadata: Record<string, unknown>; createdAt: string }>
}

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })
const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export interface EvidenceInput { proof?: string; links?: string[]; attachments?: ProofAttachment[] }

export const platformTaskApi = {
  list: () => apiRequest<UserTasksView>('/platform-tasks'),
  claim: (id: string, body: EvidenceInput & { payoutNetwork?: string; payoutAddress?: string }) =>
    apiRequest<{ status: ClaimStatus }>(`/platform-tasks/${id}/claim`, json(body)),
  resubmit: (id: string, body: EvidenceInput) =>
    apiRequest<{ status: ClaimStatus; revisionNo: number }>(`/platform-tasks/${id}/resubmit`, json(body)),
}

export const adminPlatformTaskApi = {
  list: () => apiRequest<AdminPlatformTask[]>('/admin/platform-tasks'),
  create: (body: NewTaskInput) => apiRequest<{ id: string }>('/admin/platform-tasks', json(body)),
  update: (id: string, body: TaskPatchInput) =>
    apiRequest<unknown>(`/admin/platform-tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  summary: (p: { from?: string; to?: string }) => apiRequest<Summary>(`/admin/platform-tasks/summary${qs(p)}`),
  inbox: (p: { status?: string; taskId?: string; platform?: string; rewardType?: string; from?: string; to?: string; q?: string; sort?: string; page?: number; limit?: number }) =>
    apiRequest<InboxPage>(`/admin/platform-tasks/inbox${qs(p)}`),
  detail: (id: string) => apiRequest<SubmissionDetail>(`/admin/platform-tasks/submissions/${id}`),
  decide: (id: string, body: { decision: Decision; revisionNo: number; feedback?: string | null; internalNote?: string | null; checks?: Record<string, boolean> | null }) =>
    apiRequest<{ status: ClaimStatus }>(`/admin/platform-tasks/submissions/${id}/decision`, json(body)),
  pay: (id: string, txHash: string) => apiRequest<unknown>(`/admin/platform-tasks/submissions/${id}/pay`, json({ txHash })),
  cancelPayout: (id: string, reason: string) => apiRequest<unknown>(`/admin/platform-tasks/submissions/${id}/cancel-payout`, json({ reason })),
  rewards: (p: { state?: string; type?: string; q?: string; page?: number }) => apiRequest<RewardsPage>(`/admin/platform-tasks/rewards${qs(p)}`),
  analytics: (p: { from?: string; to?: string }) => apiRequest<Analytics>(`/admin/platform-tasks/analytics${qs(p)}`),
  activity: (page = 1) => apiRequest<ActivityPage>(`/admin/platform-tasks/activity${qs({ page })}`),
}
