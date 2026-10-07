import { apiRequest } from '@/lib/api'

export type VerifyMode = 'telegram_auto' | 'manual_proof' | 'self_claim'
export type RewardType = 'points' | 'usdt'
export type ClaimStatus = 'pending_review' | 'awaiting_payout' | 'completed' | 'rejected'
export const PAYOUT_NETWORKS = ['BEP20', 'ERC20', 'TRC20', 'APTOS'] as const

export interface UserPlatformTask {
  id: string
  title: string
  description: string | null
  url: string | null
  verifyMode: VerifyMode
  rewardType: RewardType
  rewardPoints: number | null
  rewardUsdt: number | null
  payoutMode: 'auto' | 'manual'
  requireKyc: boolean
  endsAt: string | null
  spotsLeft: number | null
  claim: { status: ClaimStatus; rejectionReason: string | null; txHash: string | null; createdAt: string; completedAt: string | null } | null
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
  url: string | null
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
  createdAt: string
  counts: Partial<Record<ClaimStatus, number>>
}

export interface AdminSubmission {
  id: string
  taskId: string
  taskTitle: string
  status: ClaimStatus
  proof: string | null
  rewardType: RewardType
  rewardPoints: number | null
  rewardUsdt: number | null
  payoutMode: string | null
  payoutNetwork: string | null
  payoutAddress: string | null
  txHash: string | null
  rejectionReason: string | null
  createdAt: string
  completedAt: string | null
  user: { id: string; email: string; username: string | null; fullName: string | null; telegramUsername: string | null }
}

export interface NewTaskInput {
  title: string
  description?: string | null
  url?: string | null
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
}

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })

export const platformTaskApi = {
  list: () => apiRequest<UserTasksView>('/platform-tasks'),
  claim: (id: string, body: { proof?: string; payoutNetwork?: string; payoutAddress?: string }) =>
    apiRequest<{ status: ClaimStatus }>(`/platform-tasks/${id}/claim`, json(body)),
}

export const adminPlatformTaskApi = {
  list: () => apiRequest<AdminPlatformTask[]>('/admin/platform-tasks'),
  create: (body: NewTaskInput) => apiRequest<{ id: string }>('/admin/platform-tasks', json(body)),
  update: (id: string, body: Partial<NewTaskInput>) =>
    apiRequest<unknown>(`/admin/platform-tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  submissions: (status?: string) =>
    apiRequest<AdminSubmission[]>(`/admin/platform-tasks/submissions${status ? `?status=${status}` : ''}`),
  approve: (id: string) => apiRequest<unknown>(`/admin/platform-tasks/submissions/${id}/approve`, { method: 'POST' }),
  reject: (id: string, reason: string) => apiRequest<unknown>(`/admin/platform-tasks/submissions/${id}/reject`, json({ reason })),
  pay: (id: string, txHash: string) => apiRequest<unknown>(`/admin/platform-tasks/submissions/${id}/pay`, json({ txHash })),
}
