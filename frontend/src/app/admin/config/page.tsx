'use client'
import { useState, useCallback, useEffect } from 'react'
import { adminApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { useRouter } from 'next/navigation'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'

type ConfigMap = Record<string, unknown>

interface GroupedConfig {
  prefix: string
  label: string
  items: Array<{ key: string; value: string }>
}

const GROUP_PREFIXES: Array<{ prefix: string; label: string }> = [
  { prefix: 'fee_', label: 'Fees' },
  { prefix: 'rate_', label: 'Rates' },
  { prefix: 'deposit_address_', label: 'Deposit Addresses' },
  { prefix: 'kyc_', label: 'KYC Settings' },
  { prefix: 'site_', label: 'Site Settings' },
  { prefix: 'referral_', label: 'Referral Settings' },
  { prefix: 'merchant_', label: 'Merchant Settings' },
]

function groupConfig(config: ConfigMap): GroupedConfig[] {
  const grouped: GroupedConfig[] = GROUP_PREFIXES.map(({ prefix, label }) => ({
    prefix,
    label,
    items: [],
  }))
  const other: GroupedConfig = { prefix: '', label: 'Other', items: [] }

  Object.entries(config).forEach(([key, value]) => {
    const match = grouped.find((g) => key.startsWith(g.prefix))
    const entry = { key, value: String(value) }
    if (match) {
      match.items.push(entry)
    } else {
      other.items.push(entry)
    }
  })

  const result = grouped.filter((g) => g.items.length > 0)
  if (other.items.length > 0) result.push(other)
  return result
}

export default function ConfigPage() {
  const { user } = useAuthStore()
  const router = useRouter()
  const [config, setConfig] = useState<ConfigMap | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editKey, setEditKey] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null)

  useEffect(() => {
    if (user && user.role !== 'super_admin') {
      router.replace('/admin')
    }
  }, [user, router])

  const fetchConfig = useCallback(async () => {
    try {
      const data = await adminApi.getConfig() as ConfigMap
      setConfig(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchConfig()
  }, [fetchConfig])

  function startEdit(key: string, currentValue: string) {
    setEditKey(key)
    setEditValue(currentValue)
    setSaveError(null)
    setSaveSuccess(null)
  }

  async function saveEdit(key: string) {
    setSaving(true)
    setSaveError(null)
    setSaveSuccess(null)
    try {
      await adminApi.updateConfig({ key, value: editValue })
      setConfig((prev) => prev ? { ...prev, [key]: editValue } : prev)
      setSaveSuccess(`"${key}" updated successfully.`)
      setEditKey(null)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save config')
    } finally {
      setSaving(false)
    }
  }

  if (user?.role !== 'super_admin') return null
  if (loading) return <LoadingState message="Loading configuration..." />
  if (error && !config) return <ErrorState title={error} onRetry={fetchConfig} />
  if (!config || Object.keys(config).length === 0) return <EmptyState title="No configuration found" description="The platform configuration is empty." />

  const groups = groupConfig(config)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Platform Configuration</h1>
        <p className="text-text-muted text-sm mt-0.5">Super admin only â€” edit platform settings</p>
      </div>

      {saveSuccess && (
        <div className="px-4 py-3 bg-success/10 border border-success/20 rounded-xl text-success text-sm">
          {saveSuccess}
        </div>
      )}

      {groups.map((group) => (
        <div key={group.prefix || 'other'} className="bg-white rounded-xl border border-border overflow-hidden">
          <div className="px-5 py-3 bg-surface border-b border-border">
            <h2 className="text-sm font-semibold text-text-primary">{group.label}</h2>
          </div>
          <div className="divide-y divide-border">
            {group.items.map(({ key, value }) => (
              <div key={key} className="flex items-center gap-4 px-5 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-text-primary truncate">{key}</p>
                </div>

                {editKey === key ? (
                  <div className="flex items-center gap-2 flex-1 max-w-sm">
                    <input
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      className="flex-1 px-3 py-1.5 border border-border rounded-lg text-sm text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveEdit(key)
                        if (e.key === 'Escape') setEditKey(null)
                      }}
                    />
                    <Button size="sm" loading={saving} onClick={() => saveEdit(key)}>Save</Button>
                    <Button size="sm" variant="secondary" onClick={() => setEditKey(null)} disabled={saving}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 flex-1 max-w-sm justify-end">
                    <span className="text-sm text-text-secondary font-mono truncate max-w-xs">{value}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => startEdit(key, value)}
                    >
                      Edit
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {saveError && editKey && group.items.some((i) => i.key === editKey) && (
            <div className="px-5 py-2 text-danger text-sm bg-danger/5 border-t border-danger/10">
              {saveError}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

