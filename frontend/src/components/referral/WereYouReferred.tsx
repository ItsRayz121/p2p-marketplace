'use client'
import { useState, useEffect, useCallback } from 'react'
import { gasApi } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'

// Compact "enter who referred you" card for Settings. Renders nothing until we know
// the referral program is live and the user isn't already bound (first-touch, once).
export function WereYouReferred() {
  const [code, setCode] = useState('')
  const [applying, setApplying] = useState(false)
  const [show, setShow] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const s = await gasApi.getReferralSummary()
      setShow(s.enabled && !s.boundToReferrer)
    } catch { setShow(false) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const handleApply = async () => {
    if (!code.trim()) return
    setApplying(true)
    try {
      const r = await gasApi.applyReferral(code.trim())
      if (r.bound) { toast.success('Referral code applied'); setCode(''); await refresh() }
      else toast.error('Code could not be applied (already linked, or invalid)')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to apply code') }
    finally { setApplying(false) }
  }

  if (!show) return null

  return (
    <div className="bg-surface shadow-card border border-border rounded-xl p-5 space-y-3">
      <h3 className="text-sm font-bold text-text-primary">Were you referred?</h3>
      <p className="text-xs text-text-muted">Enter the code of whoever invited you. This can only be set once.</p>
      <div className="flex gap-2">
        <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="REFERRAL CODE" className="uppercase" />
        <Button variant="secondary" onClick={handleApply} disabled={applying || !code.trim()}>
          {applying ? <Spinner size="sm" /> : 'Apply'}
        </Button>
      </div>
    </div>
  )
}
