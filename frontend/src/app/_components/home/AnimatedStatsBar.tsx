'use client'
import { useState, useEffect } from 'react'

interface MarketStats {
  totalUsers: number
  totalTrades: number
  totalVolume: string
  verifiedTraders: number
}

function AnimatedNumber({ value, prefix = '', suffix = '' }: { value: number; prefix?: string; suffix?: string }) {
  const [display, setDisplay] = useState(value)

  useEffect(() => {
    if (value === 0) return
    const duration = 1200
    const steps = 40
    const increment = value / steps
    let current = 0
    const timer = setInterval(() => {
      current = Math.min(current + increment, value)
      setDisplay(Math.floor(current))
      if (current >= value) clearInterval(timer)
    }, duration / steps)
    return () => clearInterval(timer)
  }, [value])

  return (
    <span>
      {prefix}{display.toLocaleString()}{suffix}
    </span>
  )
}

export function AnimatedStatsBar({ stats }: { stats: MarketStats }) {
  return (
    <section className="bg-slate-800 border-b border-slate-700 py-5">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
          <div>
            <p className="text-xl font-bold text-white">
              <AnimatedNumber value={stats.totalUsers} />
            </p>
            <p className="text-xs text-slate-400 mt-0.5 uppercase tracking-wide font-medium">Users</p>
          </div>
          <div>
            <p className="text-xl font-bold text-white">
              <AnimatedNumber value={stats.totalTrades} />
            </p>
            <p className="text-xs text-slate-400 mt-0.5 uppercase tracking-wide font-medium">Trades Completed</p>
          </div>
          <div>
            <p className="text-xl font-bold text-white">
              <AnimatedNumber value={parseFloat(stats.totalVolume) || 0} prefix="$" />
            </p>
            <p className="text-xs text-slate-400 mt-0.5 uppercase tracking-wide font-medium">Volume (USD)</p>
          </div>
          <div>
            <p className="text-xl font-bold text-white">
              <AnimatedNumber value={stats.verifiedTraders} />
            </p>
            <p className="text-xs text-slate-400 mt-0.5 uppercase tracking-wide font-medium">Verified Traders</p>
          </div>
        </div>
      </div>
    </section>
  )
}
