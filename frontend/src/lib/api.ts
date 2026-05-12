// In dev, Next.js rewrites /api/* → backend, so we use '' (same-origin).
// In production, we call the Railway backend URL directly.
const API_BASE =
  process.env.NODE_ENV === 'development'
    ? ''
    : (process.env.NEXT_PUBLIC_API_URL ?? '')

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// In-memory CSRF token cache — one fetch per page load is enough (token TTL = 24h)
let _csrfToken: string | null = null

async function getCsrfToken(): Promise<string> {
  if (_csrfToken) return _csrfToken
  const res = await fetch(`${API_BASE}/api/v1/auth/csrf`, { credentials: 'include' })
  const data = (await res.json()) as { token: string }
  _csrfToken = data.token
  return _csrfToken
}

/** Call this to clear the cached CSRF token (e.g. after a 403 INVALID_CSRF_TOKEN response) */
export function invalidateCsrfToken(): void {
  _csrfToken = null
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const method = (options?.method ?? 'GET').toUpperCase()
  const url = `${API_BASE}${path}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  }

  if (UNSAFE_METHODS.has(method)) {
    headers['X-CSRF-Token'] = await getCsrfToken()
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15_000)

  try {
    const res = await fetch(url, {
      ...options,
      method,
      headers,
      credentials: 'include',
      signal: controller.signal,
    })

    const data = await res.json()

    if (!res.ok) {
      // Stale CSRF token — clear cache and let caller retry once
      if (res.status === 403 && (data as { error?: string }).error === 'INVALID_CSRF_TOKEN') {
        invalidateCsrfToken()
      }
      throw new ApiError(
        (data as { error?: string }).error ?? 'UNKNOWN_ERROR',
        (data as { message?: string }).message ?? 'An error occurred',
        res.status,
        (data as { requestId?: string }).requestId,
      )
    }

    return data as T
  } finally {
    clearTimeout(timeoutId)
  }
}

export const api = {
  get: <T>(path: string, options?: RequestInit) =>
    request<T>(path, { method: 'GET', ...options }),

  post: <T>(path: string, body?: unknown, options?: RequestInit) =>
    request<T>(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...options,
    }),

  patch: <T>(path: string, body?: unknown, options?: RequestInit) =>
    request<T>(path, {
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...options,
    }),

  delete: <T>(path: string, options?: RequestInit) =>
    request<T>(path, { method: 'DELETE', ...options }),
}

export type HealthCheckResponse = {
  status: 'ok' | 'degraded'
  // Fields below are only present in development — stripped in production
  timestamp?: string
  uptimeSeconds?: number
  responseMs?: number
  version?: string
  services?: {
    db: { status: 'ok' | 'error'; latencyMs: number }
    redis: { status: 'ok' | 'error'; latencyMs: number }
  }
}

export async function checkApiHealth(): Promise<HealthCheckResponse | null> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5_000)
    try {
      return await api.get<HealthCheckResponse>('/health', { signal: controller.signal })
    } finally {
      clearTimeout(timeoutId)
    }
  } catch {
    return null
  }
}
