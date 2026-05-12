import { checkApiHealth } from '@/lib/api'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const health = await checkApiHealth()

  const dbOk = health?.services?.db.status === 'ok'
  const redisOk = health?.services?.redis.status === 'ok'
  const apiOk = health?.status === 'ok'

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8 bg-surface-alt">
      <div className="w-full max-w-lg space-y-8">

        {/* Logo / Brand */}
        <div className="text-center">
          <h1 className="text-3xl font-bold text-text-primary">PakSwap</h1>
          <p className="mt-2 text-text-secondary">Pakistan P2P Crypto Exchange</p>
        </div>

        {/* API Connection Status */}
        <div className="rounded-xl border border-border bg-white shadow-sm p-6 space-y-4">
          <h2 className="text-base font-semibold text-text-primary">System Status</h2>

          <div className="space-y-3">
            <StatusRow
              label="API Server"
              ok={apiOk}
              detail={health ? (health.responseMs != null ? `${health.responseMs}ms` : 'OK') : 'Unreachable'}
            />
            <StatusRow
              label="Database"
              ok={dbOk}
              detail={health?.services?.db.latencyMs != null ? `${health.services.db.latencyMs}ms` : '—'}
            />
            <StatusRow
              label="Redis"
              ok={redisOk}
              detail={health?.services?.redis.latencyMs != null ? `${health.services.redis.latencyMs}ms` : '—'}
            />
          </div>

          {health && (health.version ?? health.timestamp) && (
            <p className="text-xs text-text-muted pt-2 border-t border-border">
              {health.version && <>Backend v{health.version} · </>}
              {health.uptimeSeconds != null && <>Uptime {Math.floor(health.uptimeSeconds / 60)}m · </>}
              {health.timestamp && new Date(health.timestamp).toLocaleTimeString()}
            </p>
          )}

          {!health && (
            <p className="text-xs text-danger pt-2 border-t border-border">
              Cannot reach backend. Is it running on{' '}
              <code className="font-mono">{process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}</code>?
            </p>
          )}
        </div>

        {/* Setup checklist */}
        <div className="rounded-xl border border-border bg-white shadow-sm p-6 space-y-3">
          <h2 className="text-base font-semibold text-text-primary">Setup Progress</h2>
          <ul className="space-y-2 text-sm">
            <ChecklistItem done label="Monorepo structure" />
            <ChecklistItem done label="Next.js 14 + TypeScript + Tailwind" />
            <ChecklistItem done label="Fastify backend + Prisma + Redis + BullMQ" />
            <ChecklistItem done label="Prisma schema — all 31 models" />
            <ChecklistItem done={apiOk} label="Backend API reachable" />
            <ChecklistItem done={dbOk} label="Database connected" />
            <ChecklistItem done={redisOk} label="Redis connected" />
            <ChecklistItem done={false} label="Run: prisma migrate dev --name init" />
            <ChecklistItem done={false} label="Auth system (next step)" />
          </ul>
        </div>

        <p className="text-center text-xs text-text-muted">
          Structure ready · No features built yet · See docs/ for specifications
        </p>
      </div>
    </main>
  )
}

function StatusRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${ok ? 'bg-success' : 'bg-danger'}`} />
        <span className="text-sm text-text-primary">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-muted">{detail}</span>
        <span className={`text-xs font-medium ${ok ? 'text-success' : 'text-danger'}`}>
          {ok ? 'OK' : 'ERROR'}
        </span>
      </div>
    </div>
  )
}

function ChecklistItem({ done, label }: { done: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className={`text-sm ${done ? 'text-success' : 'text-text-muted'}`}>
        {done ? '✓' : '○'}
      </span>
      <span className={`text-sm ${done ? 'text-text-primary' : 'text-text-muted'}`}>{label}</span>
    </li>
  )
}
