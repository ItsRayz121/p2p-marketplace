'use client'
import { useState } from 'react'
import { StalenessBadge } from '@/components/ui/StalenessBadge'

interface Props {
  initialRate: number | null
  initialUpdatedAt: string | null
}

export function RateCalculator({ initialRate, initialUpdatedAt }: Props) {
  const [pkrInput, setPkrInput] = useState('')
  const [usdtInput, setUsdtInput] = useState('')

  const handlePkrChange = (val: string) => {
    setPkrInput(val)
    if (initialRate && val) setUsdtInput((parseFloat(val) / initialRate).toFixed(6))
    else setUsdtInput('')
  }

  const handleUsdtChange = (val: string) => {
    setUsdtInput(val)
    if (initialRate && val) setPkrInput((parseFloat(val) * initialRate).toFixed(2))
    else setPkrInput('')
  }

  if (!initialRate) {
    return (
      <div className="bg-white/5 backdrop-blur-sm rounded-xl border border-white/10 p-6 shadow-card-lg">
        <p className="text-sm text-red-400">Rate unavailable. Check back soon.</p>
      </div>
    )
  }

  return (
    <div className="bg-white/5 backdrop-blur-sm rounded-xl border border-white/10 p-6 shadow-card-lg">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-white">USDT / PKR Calculator</h2>
        {initialUpdatedAt && <StalenessBadge updatedAt={initialUpdatedAt} />}
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">PKR Amount</label>
          <div className="relative">
            <input
              type="number"
              value={pkrInput}
              onChange={(e) => handlePkrChange(e.target.value)}
              placeholder="Enter PKR"
              className="w-full px-4 py-3 border border-white/10 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 bg-white/10 text-white placeholder:text-slate-500"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-slate-400">PKR</span>
          </div>
        </div>
        <div className="flex items-center justify-center">
          <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
          </svg>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">USDT Amount</label>
          <div className="relative">
            <input
              type="number"
              value={usdtInput}
              onChange={(e) => handleUsdtChange(e.target.value)}
              placeholder="Enter USDT"
              className="w-full px-4 py-3 border border-white/10 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 bg-white/10 text-white placeholder:text-slate-500"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-slate-400">USDT</span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
        <p className="text-xs text-slate-400 text-center">
          1 USDT = <span className="text-white font-semibold">PKR {initialRate.toLocaleString()}</span>
        </p>
      </div>
    </div>
  )
}
