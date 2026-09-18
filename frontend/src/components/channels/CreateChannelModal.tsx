'use client'
import { useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { channelsApi } from '@/lib/channels'
import { toast } from '@/lib/toast'

export function CreateChannelModal({ isOpen, onClose, onCreated }: { isOpen: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'private'>('public')
  const [busy, setBusy] = useState(false)

  const reset = () => { setName(''); setDescription(''); setVisibility('public') }

  async function submit() {
    if (name.trim().length < 3 || busy) return
    setBusy(true)
    try {
      const { id } = await channelsApi.create({ name: name.trim(), description: description.trim() || undefined, visibility })
      reset()
      onCreated(id)
    } catch (e) {
      toast.error('Could not create channel', e instanceof Error ? e.message : 'Please try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={() => { onClose(); reset() }} title="Create a channel">
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">
          A channel is a broadcast — only you can post; everyone who joins just reads.
        </p>
        <div>
          <label className="block text-xs font-medium text-text-muted mb-1">Channel name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="e.g. Rate Alerts by Ali"
            className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-muted mb-1">Description (optional)</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={300}
            placeholder="What will you post here?"
            className="w-full px-3 py-2 text-sm border border-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-muted mb-1">Visibility</label>
          <div className="flex gap-2">
            {(['public', 'private'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setVisibility(v)}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  visibility === v ? 'border-primary bg-primary/10 text-primary' : 'border-border text-text-muted hover:text-text-primary'
                }`}
              >
                {v === 'public' ? 'Public — listed in Discover' : 'Private — invite link only'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-3 pt-1">
          <button onClick={onClose} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium text-text-primary hover:bg-surface-alt">Cancel</button>
          <button
            onClick={() => void submit()}
            disabled={name.trim().length < 3 || busy}
            className="flex-1 bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create channel'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
