// Client for community / influencer task-gated giveaways (off-platform reward).
import { apiRequest } from '@/lib/api'

export interface PromoTask {
  id: string
  label: string
  url?: string
  required: boolean
}

export interface PromoWinner {
  username: string | null
  address: string // already masked server-side
}

export interface PromoGiveawayPublic {
  code: string
  title: string
  description: string | null
  thumbnailUrl: string | null
  resultsSheetUrl: string | null
  tasks: PromoTask[]
  addressLabel: string | null
  rewardAll: boolean
  winnerCount: number
  requireKyc: boolean
  entryDeadline: string | null
  status: string
  open: boolean
  entryCount: number
  alreadyEntered: boolean
  myStatus: string | null
  myNote: string | null
  winners: PromoWinner[]
  createdByName: string | null
}

export interface PromoGiveaway {
  id: string
  code: string
  title: string
  description: string | null
  thumbnailUrl: string | null
  resultsSheetUrl: string | null
  tasks: PromoTask[]
  addressLabel: string | null
  winnerCount: number
  rewardAll: boolean
  requireKyc: boolean
  entryDeadline: string | null
  status: string
  isActive: boolean
  entryCount: number
  createdAt: string
  // present on the admin oversight list
  createdByName?: string | null
  createdByRole?: string
  createdById?: string
}

export interface PromoEntry {
  id: string
  username: string | null
  email: string | null
  receivingAddress: string
  status: string
  note?: string | null
  createdAt: string
}

export type PromoEntryStatus = 'entered' | 'pending' | 'sent' | 'rejected'

export const PROMO_ENTRY_STATUSES: { value: PromoEntryStatus; label: string }[] = [
  { value: 'entered', label: 'Entered' },
  { value: 'pending', label: 'Pending' },
  { value: 'sent', label: 'Reward sent' },
  { value: 'rejected', label: 'Rejected' },
]

export interface CreatePromoPayload {
  title: string
  description?: string
  thumbnailUrl?: string
  tasks: PromoTask[]
  addressLabel?: string
  winnerCount: number
  rewardAll: boolean
  requireKyc: boolean
  entryDeadline?: string
  code?: string
}

export const promoGiveawayApi = {
  create: (p: CreatePromoPayload) =>
    apiRequest<PromoGiveaway>('/promo-giveaways', { method: 'POST', body: JSON.stringify(p) }),
  listMine: () => apiRequest<PromoGiveaway[]>('/promo-giveaways/mine'),
  entries: (id: string) => apiRequest<PromoEntry[]>(`/promo-giveaways/${id}/entries`),
  close: (id: string) => apiRequest<unknown>(`/promo-giveaways/${id}/close`, { method: 'POST' }),
  setResults: (id: string, resultsSheetUrl: string | null) =>
    apiRequest<unknown>(`/promo-giveaways/${id}/results`, { method: 'PATCH', body: JSON.stringify({ resultsSheetUrl }) }),
  updateEntry: (id: string, entryId: string, body: { status: PromoEntryStatus; note?: string }) =>
    apiRequest<unknown>(`/promo-giveaways/${id}/entries/${entryId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  publicInfo: (code: string) => apiRequest<PromoGiveawayPublic>(`/promo-giveaways/public/${code}`),
  enter: (code: string, body: { receivingAddress: string; email?: string; ackTasks: string[] }) =>
    apiRequest<{ entered: boolean }>(`/promo-giveaways/public/${code}/enter`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // admin oversight
  adminList: () => apiRequest<PromoGiveaway[]>('/admin/promo-giveaways'),
  adminSetActive: (id: string, isActive: boolean) =>
    apiRequest<unknown>(`/admin/promo-giveaways/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive }) }),
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function entriesToCsv(entries: PromoEntry[]): string {
  const rows = [['Username', 'Email', 'Address', 'Status', 'Entered At'].join(',')]
  for (const e of entries) {
    rows.push(
      [csvCell(e.username), csvCell(e.email), csvCell(e.receivingAddress), csvCell(e.status), csvCell(new Date(e.createdAt).toISOString())].join(','),
    )
  }
  return rows.join('\n')
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
