# FRONTEND_STANDARDS.md — PakSwap Frontend Development Standards
## Tailwind CSS · Component Library · Hooks · Form Standards · Version 1.0 · 2026-05-12

> **Relationship to FULL_SPEC.md:** This is a satellite document. FULL_SPEC.md Section 21 (Design System) references this file for the complete component and styling standards. Overrides the inline styles mandate from earlier spec versions.
>
> **Core rule:** Use Tailwind CSS for all styling. Never use inline styles. Never use a separate CSS file unless absolutely unavoidable (e.g., third-party library overrides).

---

## Table of Contents

| Section | Topic |
|---------|-------|
| 1 | Tailwind Configuration |
| 2 | Design Tokens |
| 3 | Atomic Component Library |
| 4 | Page Layout Components |
| 5 | Custom Hooks |
| 6 | Form Standards |
| 7 | API Error Handling Pattern |
| 8 | Loading & Empty States |
| 9 | Responsive Design Rules |
| 10 | Dark Mode Strategy |
| 11 | Typography & Fonts |
| 12 | Animation Standards |
| 13 | Icon Strategy |
| 14 | Image & Asset Optimization |
| 15 | Accessibility Requirements |

---

## 1. Tailwind Configuration

```javascript
// tailwind.config.ts
import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Brand colors (from FULL_SPEC.md Section 21)
        primary: {
          DEFAULT: '#2563eb',  // blue-600
          hover: '#1d4ed8',    // blue-700
          light: '#eff6ff',    // blue-50
        },
        success: {
          DEFAULT: '#10b981',  // emerald-500
          hover: '#059669',    // emerald-600
          light: '#ecfdf5',    // emerald-50
        },
        warning: {
          DEFAULT: '#d97706',  // amber-600
          hover: '#b45309',    // amber-700
          light: '#fffbeb',    // amber-50
        },
        danger: {
          DEFAULT: '#ef4444',  // red-500
          hover: '#dc2626',    // red-600
          light: '#fef2f2',    // red-50
        },
        gold: {
          DEFAULT: '#f59e0b',  // amber-400
          light: '#fef3c7',    // amber-100
        },
        // Neutral
        surface: '#ffffff',
        'surface-alt': '#f8fafc',   // slate-50
        border: '#e2e8f0',          // slate-200
        'text-primary': '#0f172a',  // slate-900
        'text-secondary': '#64748b', // slate-500
        'text-muted': '#94a3b8',    // slate-400
      },
      fontFamily: {
        // System font stack — eliminates Google Fonts network request
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
      },
      fontSize: {
        // Minimum 16px for all inputs — prevents iOS Safari auto-zoom
        'input': ['16px', { lineHeight: '1.5' }],
      },
      screens: {
        xs: '375px',   // minimum supported width
        sm: '640px',
        md: '768px',
        lg: '1024px',
        xl: '1280px',
      },
      minHeight: {
        // Use dvh instead of vh — fixes iOS keyboard push
        screen: ['100vh', '100dvh'],
      },
      animation: {
        'fade-in': 'fadeIn 150ms ease-out',
        'slide-up': 'slideUp 200ms ease-out',
        'pulse-subtle': 'pulseSubtle 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp: { '0%': { transform: 'translateY(8px)', opacity: '0' }, '100%': { transform: 'translateY(0)', opacity: '1' } },
        pulseSubtle: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.7' } },
      },
    },
  },
  plugins: [],
}

export default config
```

---

## 2. Design Tokens

Use these Tailwind class groups consistently rather than arbitrary values:

### Spacing

| Use case | Tailwind class |
|----------|---------------|
| Card padding | `p-4` (mobile) → `p-6` (md+) |
| Section gap | `gap-4` or `space-y-4` |
| Button padding | `px-4 py-2` (md) / `px-6 py-3` (lg) |
| Input padding | `px-3 py-2.5` |
| Page horizontal margin | `px-4` (mobile) → `px-6` (sm+) |

### Border Radius

| Use case | Tailwind class |
|----------|---------------|
| Buttons | `rounded-lg` |
| Cards | `rounded-xl` |
| Inputs | `rounded-lg` |
| Badges/chips | `rounded-full` |
| Modals | `rounded-2xl` |

### Shadow

| Use case | Tailwind class |
|----------|---------------|
| Cards | `shadow-sm` |
| Modals | `shadow-xl` |
| Dropdowns | `shadow-lg` |

---

## 3. Atomic Component Library

All components live in `src/components/ui/`. Import from `@/components/ui`.

### Button

```tsx
// src/components/ui/Button.tsx
import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'link'
type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  fullWidth?: boolean
}

const variants: Record<ButtonVariant, string> = {
  primary:   'bg-primary text-white hover:bg-primary-hover active:scale-[0.98]',
  secondary: 'bg-white text-text-primary border border-border hover:bg-surface-alt',
  danger:    'bg-danger text-white hover:bg-danger-hover active:scale-[0.98]',
  ghost:     'text-text-secondary hover:bg-surface-alt hover:text-text-primary',
  link:      'text-primary hover:underline p-0',
}

const sizes: Record<ButtonSize, string> = {
  sm:  'px-3 py-1.5 text-sm rounded-md',
  md:  'px-4 py-2 text-sm rounded-lg',
  lg:  'px-6 py-3 text-base rounded-lg',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  disabled,
  children,
  className,
  ...props
}, ref) => (
  <button
    ref={ref}
    disabled={disabled || loading}
    className={cn(
      'inline-flex items-center justify-center gap-2 font-medium transition-all',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
      'disabled:pointer-events-none disabled:opacity-50',
      variants[variant],
      sizes[size],
      fullWidth && 'w-full',
      className,
    )}
    {...props}
  >
    {loading && <Spinner size="sm" />}
    {children}
  </button>
))
Button.displayName = 'Button'
```

### Input

```tsx
// src/components/ui/Input.tsx
interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
  leftIcon?: React.ReactNode
  rightElement?: React.ReactNode
}

export function Input({ label, error, hint, leftIcon, rightElement, className, ...props }: InputProps) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label className="text-sm font-medium text-text-primary">
          {label}
          {props.required && <span className="ml-1 text-danger">*</span>}
        </label>
      )}
      <div className="relative flex items-center">
        {leftIcon && (
          <div className="pointer-events-none absolute left-3 text-text-muted">
            {leftIcon}
          </div>
        )}
        <input
          className={cn(
            'w-full rounded-lg border border-border bg-white px-3 py-2.5',
            'text-[16px] text-text-primary placeholder:text-text-muted',  // 16px prevents iOS zoom
            'transition-colors',
            'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
            'disabled:cursor-not-allowed disabled:bg-surface-alt disabled:opacity-60',
            error && 'border-danger focus:border-danger focus:ring-danger',
            leftIcon && 'pl-10',
            rightElement && 'pr-10',
            className,
          )}
          {...props}
        />
        {rightElement && (
          <div className="absolute right-3">{rightElement}</div>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {hint && !error && <p className="text-xs text-text-muted">{hint}</p>}
    </div>
  )
}
```

### Modal

```tsx
// src/components/ui/Modal.tsx
// Uses @radix-ui/react-dialog for focus trap, escape key, aria-modal
import * as Dialog from '@radix-ui/react-dialog'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: React.ReactNode
  size?: 'sm' | 'md' | 'lg'
}

const modalSizes = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg' }

export function Modal({ open, onClose, title, description, children, size = 'md' }: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 animate-fade-in" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full -translate-x-1/2 -translate-y-1/2',
            'bg-white rounded-2xl shadow-xl p-6 animate-slide-up',
            'focus:outline-none',
            modalSizes[size],
            'mx-4', // horizontal margin on mobile
          )}
        >
          <div className="flex items-start justify-between mb-4">
            <div>
              <Dialog.Title className="text-lg font-semibold text-text-primary">{title}</Dialog.Title>
              {description && (
                <Dialog.Description className="mt-1 text-sm text-text-secondary">{description}</Dialog.Description>
              )}
            </div>
            <button onClick={onClose} className="ml-4 text-text-muted hover:text-text-primary transition-colors">
              <XIcon className="h-5 w-5" />
            </button>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
```

### Badge

```tsx
// src/components/ui/Badge.tsx
type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'gold' | 'outline'

const badgeVariants: Record<BadgeVariant, string> = {
  default:  'bg-slate-100 text-slate-700',
  success:  'bg-success-light text-success',
  warning:  'bg-warning-light text-warning',
  danger:   'bg-danger-light text-danger',
  gold:     'bg-gold-light text-amber-700',
  outline:  'border border-border text-text-secondary bg-transparent',
}

export function Badge({ variant = 'default', children, className }: {
  variant?: BadgeVariant; children: React.ReactNode; className?: string
}) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium', badgeVariants[variant], className)}>
      {children}
    </span>
  )
}
```

### Card

```tsx
// src/components/ui/Card.tsx
export function Card({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-xl border border-border bg-white shadow-sm', className)}
      {...props}
    >
      {children}
    </div>
  )
}

export function CardHeader({ children, className }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 py-4 border-b border-border md:px-6', className)}>{children}</div>
}

export function CardBody({ children, className }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 py-4 md:px-6', className)}>{children}</div>
}
```

### Spinner

```tsx
// src/components/ui/Spinner.tsx
export function Spinner({ size = 'md', className }: { size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const sizes = { sm: 'h-4 w-4', md: 'h-6 w-6', lg: 'h-8 w-8' }
  return (
    <svg
      className={cn('animate-spin text-current', sizes[size], className)}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-label="Loading"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}
```

### ConfirmModal

```tsx
// src/components/ui/ConfirmModal.tsx
interface ConfirmModalProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void | Promise<void>
  title: string
  message: string
  confirmLabel?: string
  confirmVariant?: 'primary' | 'danger'
  loading?: boolean
}

export function ConfirmModal({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', confirmVariant = 'primary', loading }: ConfirmModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <p className="text-sm text-text-secondary mb-6">{message}</p>
      <div className="flex gap-3 justify-end">
        <Button variant="secondary" onClick={onClose} disabled={loading}>Cancel</Button>
        <Button variant={confirmVariant} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
      </div>
    </Modal>
  )
}
```

### CopyButton

```tsx
// src/components/ui/CopyButton.tsx
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { copied, copy } = useCopyToClipboard()
  return (
    <button
      onClick={() => copy(text)}
      className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary-hover transition-colors"
    >
      {copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
      {copied ? 'Copied!' : (label ?? 'Copy')}
    </button>
  )
}
```

### CountdownTimer

```tsx
// src/components/ui/CountdownTimer.tsx
// Always compute from server timestamp, never client Date.now() at mount
export function CountdownTimer({ expiresAt, onExpired }: { expiresAt: string; onExpired?: () => void }) {
  const secondsLeft = useCountdown(expiresAt, onExpired)
  const minutes = Math.floor(secondsLeft / 60)
  const seconds = secondsLeft % 60

  if (secondsLeft <= 0) return <span className="text-danger font-medium">Expired</span>

  return (
    <span className={cn('font-mono font-medium tabular-nums', secondsLeft < 60 && 'text-danger animate-pulse-subtle')}>
      {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
    </span>
  )
}
```

### StalenessBadge

```tsx
// src/components/ui/StalenessBadge.tsx
export function StalenessBadge({ updatedAt }: { updatedAt: string }) {
  const ageMinutes = Math.floor((Date.now() - new Date(updatedAt).getTime()) / 60000)

  if (ageMinutes < 6) return null  // Fresh — don't show anything

  return (
    <Badge variant={ageMinutes > 60 ? 'danger' : 'warning'}>
      Rate {ageMinutes}m old
    </Badge>
  )
}
```

---

## 4. Page Layout Components

```tsx
// src/components/layout/PageContainer.tsx
export function PageContainer({ children, maxWidth = 'lg' }: { children: React.ReactNode; maxWidth?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const widths = { sm: 'max-w-sm', md: 'max-w-2xl', lg: 'max-w-4xl', xl: 'max-w-6xl' }
  return (
    <main className={cn('mx-auto w-full px-4 py-6 sm:px-6', widths[maxWidth])}>
      {children}
    </main>
  )
}
```

---

## 5. Custom Hooks

### usePolling

```typescript
// src/hooks/usePolling.ts
export function usePolling(
  fn: () => Promise<void>,
  intervalMs: number,
  enabled: boolean = true,
) {
  useEffect(() => {
    if (!enabled) return
    if (!navigator.onLine) return  // Don't start polling if offline

    fn() // Run immediately on mount

    const id = setInterval(fn, intervalMs)

    const handleOffline = () => clearInterval(id)
    const handleOnline = () => { fn(); setInterval(fn, intervalMs) }

    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)

    return () => {
      clearInterval(id)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
    }
  }, [enabled, intervalMs]) // fn excluded intentionally — use useCallback at call site
}
```

### useCountdown

```typescript
// src/hooks/useCountdown.ts
export function useCountdown(expiresAt: string, onExpired?: () => void): number {
  const getSecondsLeft = () => Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000))

  const [secondsLeft, setSecondsLeft] = useState(getSecondsLeft)

  useEffect(() => {
    if (secondsLeft <= 0) {
      onExpired?.()
      return
    }

    const id = setInterval(() => {
      const remaining = getSecondsLeft()
      setSecondsLeft(remaining)
      if (remaining <= 0) {
        clearInterval(id)
        onExpired?.()
      }
    }, 1000)

    return () => clearInterval(id)
  }, [expiresAt])

  return secondsLeft
}
```

### useCopyToClipboard

```typescript
// src/hooks/useCopyToClipboard.ts
export function useCopyToClipboard(resetAfterMs = 2000) {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), resetAfterMs)
  }, [resetAfterMs])

  return { copied, copy }
}
```

### useFileUpload

```typescript
// src/hooks/useFileUpload.ts
export function useFileUpload() {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const upload = useCallback(async (file: File, type: 'kyc' | 'payment_proof'): Promise<string> => {
    setUploading(true)
    setError(null)

    try {
      // 1. Compress image client-side (from FULL_SPEC.md Section 27.14)
      const compressed = await compressImage(file, { maxWidthOrHeight: 1920, maxSizeMB: 1 })

      // 2. Get presigned URL from backend
      const { url, key } = await api.post('/api/upload/presign', { type, mimeType: compressed.type })

      // 3. Upload directly to S3
      await fetch(url, { method: 'PUT', body: compressed, headers: { 'Content-Type': compressed.type } })

      return key
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed'
      setError(message)
      throw err
    } finally {
      setUploading(false)
    }
  }, [])

  return { upload, uploading, error }
}
```

### useAuth

```typescript
// src/hooks/useAuth.ts
// Wraps Zustand auth store — always import from here, never from store directly
export function useAuth() {
  const { user, accessToken, isLoading, login, logout, refreshToken } = useAuthStore()
  return { user, isAuthenticated: !!accessToken, isLoading, login, logout, refreshToken }
}
```

### useOfflineDetection

```typescript
// src/hooks/useOfflineDetection.ts
export function useOfflineDetection() {
  const [isOnline, setIsOnline] = useState(navigator.onLine)

  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return isOnline
}
```

---

## 6. Form Standards

### Form Library

Use **React Hook Form** + **Zod resolver**. Share Zod schemas between frontend and backend (put in `src/lib/validators/`).

```typescript
// src/lib/validators/trade.validators.ts (shared between FE and BE)
import { z } from 'zod'

export const createTradeSchema = z.object({
  adId: z.string().cuid(),
  amount: z.number().positive().min(100, 'Minimum trade amount is PKR 100'),
  paymentMethod: z.enum(['jazzcash', 'easypaisa', 'bank_transfer']),
})
```

```tsx
// In a form component:
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'

const form = useForm({
  resolver: zodResolver(createTradeSchema),
  defaultValues: { amount: 0, paymentMethod: 'jazzcash' },
})
```

### Error Display Pattern

- Field-level errors: shown below each input (handled by `<Input error={...} />`)
- Form-level errors (e.g., server errors): shown in a `<ErrorAlert />` above the submit button
- Never use browser `alert()` for form errors

```tsx
{form.formState.errors.root && (
  <div className="rounded-lg bg-danger-light border border-danger/20 p-3 text-sm text-danger">
    {form.formState.errors.root.message}
  </div>
)}
```

### Input Validation Rules (all fields)

```typescript
// Max lengths must match backend validators exactly:
const FIELD_MAX_LENGTHS = {
  username: 20,
  fullName: 100,
  adTerms: 2000,
  tradeMessage: 500,
  disputeDescription: 5000,
  kycRejectionReason: 500,
  businessDescription: 1000,
  adminNote: 2000,
  withdrawalAdminNote: 500,
}
```

---

## 7. API Error Handling Pattern

```typescript
// src/lib/api.ts
export async function apiRequest<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': getCsrfToken(),
      ...options?.headers,
    },
  })

  if (res.status === 401) {
    // Try to refresh token
    const refreshed = await refreshAccessToken()
    if (refreshed) return apiRequest(url, options) // Retry once
    // Token refresh failed — redirect to login
    window.location.href = '/auth/login'
    throw new Error('SESSION_EXPIRED')
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After')
    throw new ApiError('RATE_LIMITED', `Too many requests. Try again in ${retryAfter}s.`, 429)
  }

  if (res.status >= 500) {
    const requestId = res.headers.get('X-Request-Id') ?? 'unknown'
    throw new ApiError('SERVER_ERROR', `Something went wrong (ref: ${requestId})`, res.status)
  }

  const data = await res.json()
  if (!data.success) throw new ApiError(data.error, data.message, res.status)

  return data.data
}
```

---

## 8. Loading & Empty States

Use consistent states across all pages. Never show a blank white screen.

```tsx
// src/components/ui/LoadingState.tsx
export function LoadingState({ message = 'Loading...' }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3">
      <Spinner size="lg" className="text-primary" />
      <p className="text-sm text-text-muted">{message}</p>
    </div>
  )
}

// src/components/ui/EmptyState.tsx
export function EmptyState({ icon, title, description, action }: {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
      {icon && <div className="text-text-muted mb-2">{icon}</div>}
      <p className="font-medium text-text-primary">{title}</p>
      {description && <p className="text-sm text-text-muted max-w-xs">{description}</p>}
      {action && <Button variant="secondary" size="sm" onClick={action.onClick} className="mt-2">{action.label}</Button>}
    </div>
  )
}

// src/components/ui/ErrorState.tsx
export function ErrorState({ title = 'Something went wrong', onRetry }: { title?: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
      <div className="rounded-full bg-danger-light p-3">
        <AlertIcon className="h-6 w-6 text-danger" />
      </div>
      <p className="font-medium text-text-primary">{title}</p>
      {onRetry && <Button variant="secondary" size="sm" onClick={onRetry}>Try Again</Button>}
    </div>
  )
}
```

---

## 9. Responsive Design Rules

- **Mobile-first:** Write mobile styles first, add `md:` and `lg:` variants for larger screens
- **Minimum width:** 375px (iPhone SE). Nothing should break below 375px.
- **Tap targets:** Minimum 44×44px for all interactive elements (`min-h-[44px] min-w-[44px]`)
- **No horizontal scroll:** All pages must fit within 375px without horizontal overflow
- **Bottom navigation:** Main navigation is a bottom bar on mobile; sidebar on `lg+`

```tsx
// Correct mobile-first example:
<div className="flex flex-col gap-4 md:flex-row md:gap-6">
  <div className="w-full md:w-64">Sidebar</div>
  <div className="flex-1">Content</div>
</div>
```

---

## 10. Dark Mode Strategy

**Decision: Dark mode is Phase 3. Do not implement in Phase 1 or Phase 2.**

Reason: Adds ~20% frontend complexity to every component. Not worth it until core product is validated. When implemented, use Tailwind's `dark:` variant with `prefers-color-scheme` media query.

For now, use only light mode styles. Do not add `dark:` classes prematurely.

---

## 11. Typography & Fonts

Use system font stack only (defined in Tailwind config). Never add Google Fonts or custom font files in Phase 1-2.

```
Benefit: Eliminates 100-200KB network request on first load.
Benefit: Native look on each device (familiar to users).
Benefit: No FOUT (Flash of Unstyled Text).
```

### Type Scale

| Use case | Tailwind classes |
|----------|-----------------|
| Page heading (H1) | `text-2xl font-bold text-text-primary` |
| Section heading (H2) | `text-xl font-semibold text-text-primary` |
| Card title (H3) | `text-base font-semibold text-text-primary` |
| Body text | `text-sm text-text-primary` |
| Secondary text | `text-sm text-text-secondary` |
| Captions / labels | `text-xs text-text-muted` |
| Large numbers (amounts) | `text-2xl font-bold tabular-nums` |

---

## 12. Animation Standards

Use animations sparingly. Animations must not impede usability.

| Situation | Animation | Duration |
|-----------|-----------|---------|
| Modal open | `animate-slide-up` | 200ms |
| Toast/notification appear | `animate-fade-in` | 150ms |
| Page transitions | None (too slow for PWA) | — |
| Loading pulse | `animate-pulse-subtle` | 2s loop |
| Skeleton loaders | `animate-pulse` (Tailwind built-in) | — |
| Button click feedback | `active:scale-[0.98]` | CSS transition |

Never use animations that loop indefinitely on non-loading states (distracting). Never use animations longer than 300ms for interactive elements.

---

## 13. Icon Strategy

Use **Lucide React** (`lucide-react` package). Consistent sizing via props.

```tsx
import { Copy, Check, AlertCircle, ChevronRight, X } from 'lucide-react'

// Standard sizes:
<Copy className="h-4 w-4" />   // inline with text
<AlertCircle className="h-5 w-5" /> // standalone icon
<ChevronRight className="h-6 w-6" /> // large action icon
```

Never use emoji as icons in UI (inconsistent rendering across devices). Never mix icon libraries.

---

## 14. Image & Asset Optimization

- Use Next.js `<Image>` component for all images (automatic WebP conversion, lazy loading, size optimization)
- Logo: SVG format only (never PNG)
- User avatars: Use initials-based fallback if no photo, not a default avatar PNG
- KYC screenshots: Never displayed in browser after upload (security — only admin can view via signed URL)
- Never import images from `public/` with `<img>` — always use `next/image`

```tsx
import Image from 'next/image'

// Correct:
<Image src="/logo.svg" alt="PakSwap" width={120} height={40} priority />

// Correct for user content (dynamic):
<Image src={signedS3Url} alt="Payment proof" fill className="object-contain" />
```

---

## 15. Accessibility Requirements

Minimum accessibility requirements for launch:

- All form inputs have associated `<label>` (handled by `<Input label={...} />`)
- All modals have `aria-modal`, `role="dialog"`, and focus trap (handled by Radix UI)
- All icon-only buttons have `aria-label`
- Color is not the only way to convey status (badges have text labels, not just color)
- Touch targets are minimum 44×44px
- Keyboard navigation works for all interactive elements (Tab, Enter, Escape for modals)

```tsx
// Correct — icon-only button:
<button aria-label="Close modal" onClick={onClose}>
  <X className="h-5 w-5" />
</button>

// Correct — status not by color alone:
<Badge variant="success">✓ Verified</Badge>  // has text label
<Badge variant="danger">✗ Rejected</Badge>   // has text label
```

---

## cn() Utility

```typescript
// src/lib/utils.ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

Required packages:
```bash
npm install clsx tailwind-merge @radix-ui/react-dialog lucide-react
npm install -D tailwindcss @tailwindcss/forms
```

---

*Document version: 1.0*
*Created: 2026-05-12*
*Related: FULL_SPEC.md Section 21 (Design System), FULL_SPEC.md Section 22 (Developer Rules)*
