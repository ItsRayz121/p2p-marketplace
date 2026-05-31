import { create } from 'zustand'

export type ToastVariant = 'default' | 'success' | 'error' | 'warning'

export interface ToastItem {
  id: string
  title: string
  description?: string
  variant: ToastVariant
  duration: number
}

interface ToastStore {
  toasts: ToastItem[]
  add: (t: Omit<ToastItem, 'id'>) => void
  remove: (id: string) => void
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  add: (t) =>
    set((s) => ({
      toasts: [
        ...s.toasts,
        { ...t, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` },
      ],
    })),
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

function add(title: string, variant: ToastVariant, description?: string, duration = 4000) {
  useToastStore.getState().add({ title, description, variant, duration })
}

export const toast = {
  success: (title: string, description?: string) => add(title, 'success', description),
  error: (title: string, description?: string) => add(title, 'error', description, 5000),
  warning: (title: string, description?: string) => add(title, 'warning', description),
  info: (title: string, description?: string) => add(title, 'default', description),
}
