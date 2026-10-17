/**
 * The import answers as one report: community-token trades and P2P USDT trades are added to the same
 * tracker, so the user sees a single preview and a single set of counts. Pure.
 */
interface PreviewItem { tradeRef: string; tokenName: string; type: 'BUY' | 'SELL'; quantity: string; consideration: string; quote: 'PKR' | 'USDT'; date: string }

export interface CtmLikeReport {
  dryRun: boolean
  created: number
  restored: number
  voided: number
  alreadyImported: number
  recordedManually: number
  attention: Array<{ reason: string; count: number }>
  hasImportedBefore: boolean
  preview: PreviewItem[]
  skippedForLimit: number
}

export interface UsdtLikeReport {
  created: number
  restored: number
  voided: number
  alreadyImported: number
  hasImportedBefore: boolean
  preview: PreviewItem[]
  skippedForLimit: number
}

export function mergeImportReports<C extends CtmLikeReport>(ctm: C, usdt: UsdtLikeReport): C {
  return {
    ...ctm,
    created: ctm.created + usdt.created,
    restored: ctm.restored + usdt.restored,
    voided: ctm.voided + usdt.voided,
    alreadyImported: ctm.alreadyImported + usdt.alreadyImported,
    hasImportedBefore: ctm.hasImportedBefore || usdt.hasImportedBefore,
    // Newest-first is not promised; keep the first few of each so neither kind crowds the other out of the prompt.
    preview: [...ctm.preview.slice(0, 12), ...usdt.preview.slice(0, 8)],
    skippedForLimit: ctm.skippedForLimit + usdt.skippedForLimit,
  }
}
