'use client'

import { useCallback, useEffect, useState } from 'react'
import { ApiError, portfolioAdminApi, type ListingInterestReport } from '@/lib/api'

const TREND_LABEL = { rising: 'Rising', steady: 'Steady', falling: 'Falling' } as const

/**
 * Listing research: anonymous, aggregate interest only. There is deliberately no account list, no
 * holdings, no amounts and no notes here, and nothing below the minimum group size is shown.
 */
export default function AdminPortfolioInterestPage() {
  const [report, setReport] = useState<ListingInterestReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setReport(await portfolioAdminApi.interest())
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'Could not load listing interest.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-text-primary">Listing interest</h1>
        <p className="text-sm text-text-muted mt-1">
          Tokens that people tracking a portfolio have asked RupChain to list. Anonymous totals only.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-surface p-4 text-xs text-text-muted space-y-1">
        <p>Only tokens suggested by at least {report?.threshold ?? 20} people are shown. Counts are rounded down to a multiple of 5 and refresh about once an hour.</p>
        <p>This is self-reported interest from people who agreed to share it. It is not market volume, and it does not approve a listing: a listing still needs the normal operational and risk review.</p>
        <p>Each time this page is opened it is recorded in the audit log.</p>
      </div>

      {loading ? (
        <p role="status" className="text-sm text-text-muted">Loading…</p>
      ) : error ? (
        <p role="alert" className="text-sm text-danger">
          {error} <button type="button" onClick={() => void load()} className="font-medium text-primary hover:underline">Try again</button>
        </p>
      ) : report ? (
        <>
          <p className="text-xs text-text-muted">As of {new Date(report.asOf).toLocaleString()}</p>
          {report.groups.length === 0 ? (
            <p className="rounded-xl border border-border bg-surface p-4 text-sm text-text-muted">
              No token has reached the minimum number of suggestions yet.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border bg-surface">
              <table className="w-full text-sm">
                <caption className="sr-only">Tokens people have asked RupChain to list</caption>
                <thead>
                  <tr className="text-left text-xs text-text-muted border-b border-border">
                    <th scope="col" className="px-3 py-2 font-medium">Network</th>
                    <th scope="col" className="px-3 py-2 font-medium">Contract</th>
                    <th scope="col" className="px-3 py-2 font-medium">Commonly called</th>
                    <th scope="col" className="px-3 py-2 font-medium text-right">People (at least)</th>
                    <th scope="col" className="px-3 py-2 font-medium">Last 30 days</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {report.groups.map((g) => (
                    <tr key={`${g.network}:${g.contract}`}>
                      <td className="px-3 py-2 break-words">{g.network}</td>
                      <td className="px-3 py-2 font-mono text-xs break-all">{g.contract}</td>
                      <td className="px-3 py-2 break-words">{g.commonName ?? 'Varies'}</td>
                      <td className="px-3 py-2 text-right">{g.approxAccounts}</td>
                      <td className="px-3 py-2">{TREND_LABEL[g.trend]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {report.suppressedGroups > 0 && (
            <p className="text-xs text-text-muted">
              {report.suppressedGroups} more {report.suppressedGroups === 1 ? 'token has' : 'tokens have'} some interest but {report.suppressedGroups === 1 ? 'is' : 'are'} below the minimum and not shown.
            </p>
          )}
        </>
      ) : null}
    </div>
  )
}
