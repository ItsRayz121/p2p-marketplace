export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'rupchain-theme'

export function getStoredTheme(): Theme | null {
  if (typeof window === 'undefined') return null
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'dark' || v === 'light' ? v : null
}

export function getSystemTheme(): Theme {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function getEffectiveTheme(): Theme {
  return getStoredTheme() ?? getSystemTheme()
}

export function applyTheme(theme: Theme) {
  const html = document.documentElement
  if (theme === 'dark') {
    html.classList.add('dark')
  } else {
    html.classList.remove('dark')
  }
}

export function setTheme(theme: Theme) {
  localStorage.setItem(STORAGE_KEY, theme)
  applyTheme(theme)
}

export function toggleTheme(): Theme {
  const next = getEffectiveTheme() === 'dark' ? 'light' : 'dark'
  setTheme(next)
  return next
}

// Inline script text — injected into <head> before any React hydration to
// prevent flash of wrong theme. Reads localStorage; falls back to OS setting.
export const THEME_SCRIPT = `(function(){
  try {
    var s = localStorage.getItem('rupchain-theme');
    var t = s === 'dark' || s === 'light' ? s
          : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    if (t === 'dark') document.documentElement.classList.add('dark');
  } catch(e) {}
})();`
