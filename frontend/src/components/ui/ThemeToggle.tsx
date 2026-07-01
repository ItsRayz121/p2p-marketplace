'use client'
import { useEffect, useState } from 'react'
import { toggleTheme, getEffectiveTheme, type Theme } from '@/lib/theme'
import { Sun, Moon } from 'lucide-react'
import { cn } from '@/lib/utils'

export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>('light')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    setTheme(getEffectiveTheme())

    // Keep in sync if OS preference changes while the tab is open
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => setTheme(getEffectiveTheme())
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  if (!mounted) {
    // Render a placeholder with the same dimensions to prevent layout shift
    return <span className="w-9 h-9 inline-block" />
  }

  const handleToggle = () => {
    const next = toggleTheme()
    setTheme(next)
  }

  return (
    <button
      onClick={handleToggle}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className={cn('p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-alt transition-colors', className)}
    >
      {theme === 'dark' ? (
        <Sun className="w-5 h-5" aria-hidden />
      ) : (
        <Moon className="w-5 h-5" aria-hidden />
      )}
    </button>
  )
}
