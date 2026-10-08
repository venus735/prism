import { useMemo } from 'react'
import type { FlowSummary } from '@proxy/shared'
import { useFlowsStore, appGroupOf } from '../../stores/flows'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

const STATUS_COLORS: Record<string, string> = {
  '2xx': '#34d399',
  '3xx': '#60a5fa',
  '4xx': '#fbbf24',
  '5xx': '#f87171',
  tunnel: '#a1a1aa',
  pending: '#52525b',
  error: '#ef4444'
}

const CARD = 'rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3'
const CARD_TITLE = 'text-[11px] text-zinc-500 mb-1'
const CARD_VALUE = 'text-xl font-semibold text-zinc-100 tabular-nums'

export default function StatsPage() {
  const flows = useFlowsStore((s) => s.flows)

  const stats = useMemo(() => {
    const byStatus = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, tunnel: 0, pending: 0, error: 0 }
    const byMethod = new Map<string, number>()
    const byHost = new Map<string, { total: number; error: number }>()
    const byApp = new Map<string, number>()
    let totalReqBytes = 0
    let totalRespBytes = 0
    let tlsCount = 0
    let errCount = 0
    let pendingCount = 0
    let durations = 0
    let durationCount = 0
    let oldest = Number.MAX_SAFE_INTEGER
    let newest = 0

    for (const f of flows) {
      oldest = Math.min(oldest, f.createdAt)
      newest = Math.max(newest, f.createdAt)
      totalReqBytes += f.reqSize ?? 0
      totalRespBytes += f.respSize ?? 0
      if (f.tls) tlsCount++
      if (f.state === 'error' || f.error) errCount++
      if (f.state === 'pending') pendingCount++
      if (typeof f.durationMs === 'number' && f.durationMs > 0) {
        durations += f.durationMs
        durationCount++
      }
      const m = f.method ?? '—'
      byMethod.set(m, (byMethod.get(m) ?? 0) + 1)
      const hostKey = f.host ?? '（隧道）'
      const h = byHost.get(hostKey) ?? { total: 0, error: 0 }
      h.total++
      if (f.state === 'error' || f.error || (f.status ?? 0) >= 500) h.error++
      byHost.set(hostKey, h)
      const appKey = appGroupOf(f)
      byApp.set(appKey, (byApp.get(appKey) ?? 0) + 1)

      if (f.kind !== 'http') {
        byStatus.tunnel++
      } else if (f.state === 'error' || f.error) {
        byStatus.error++
      } else if (f.state === 'pending' || f.status === undefined) {
        byStatus.pending++
      } else if (f.status < 300) {
        byStatus['2xx']++
      } else if (f.status < 400) {
        byStatus['3xx']++
      } else if (f.status < 500) {
        byStatus['4xx']++
      } else {
        byStatus['5xx']++
      }
    }

    // 按时间分桶（最多 60 桶，覆盖全部数据跨度）
    const buckets: number[] = []
    const bucketLabels: string[] = []
    if (flows.length > 0 && newest > oldest) {
      const n = Math.min(60, flows.length)
      const width = (newest - oldest) / n
      for (let i = 0; i < n; i++) {
        buckets.push(0)
        bucketLabels.push(fmtTime(oldest + width * (i + 0.5)))
      }
      for (const f of flows) {
        const idx = Math.min(buckets.length - 1, Math.floor((f.createdAt - oldest) / width))
        buckets[idx]++
      }
    }

    return {
      total: flows.length,
      errCount,
      pendingCount,
      avgDuration: durationCount ? durations / durationCount : 0,
      totalBytes: totalReqBytes + totalRespBytes,
      tlsRatio: flows.length ? tlsCount / flows.length : 0,
      byStatus,
      byMethod: [...byMethod.entries()].sort((a, b) => b[1] - a[1]),
      byHost: [...byHost.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 12),
      byApp: [...byApp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
      buckets,
      bucketLabels,
      oldest,
      newest
    }
  }, [flows])

  const statusTotal = Object.values(stats.byStatus).reduce((a, b) => a + b, 0)

  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      <div className="flex items-baseline gap-3">
        <h2 className="text-sm font-medium text-zinc-300">流量统计</h2>
        <span className="text-[11px] text-zinc-600">基于当前会话最近 {stats.total} 条（上限 1000 + 实时）</span>
      </div>

      <div className="grid grid-cols-6 gap-3">
        <div className={CARD}>
          <div className={CARD_TITLE}>总请求</div>
          <div className={CARD_VALUE}>{stats.total}</div>
        </div>
        <div className={CARD}>
          <div className={CARD_TITLE}>进行中</div>
          <div className={`${CARD_VALUE} ${stats.pendingCount > 0 ? 'text-sky-400' : ''}`}>{stats.pendingCount}</div>
        </div>
        <div className={CARD}>
          <div className={CARD_TITLE}>失败</div>
          <div className={`${CARD_VALUE} ${stats.errCount > 0 ? 'text-red-400' : ''}`}>{stats.errCount}</div>
        </div>
        <div className={CARD}>
          <div className={CARD_TITLE}>平均耗时</div>
          <div className={CARD_VALUE}>{stats.avgDuration ? `${Math.round(stats.avgDuration)} ms` : '—'}</div>
        </div>
        <div className={CARD}>
          <div className={CARD_TITLE}>总流量</div>
          <div className={CARD_VALUE}>{fmtBytes(stats.totalBytes)}</div>
        </div>
        <div className={CARD}>
          <div className={CARD_TITLE}>HTTPS 占比</div>
          <div className={CARD_VALUE}>{stats.total ? `${Math.round(stats.tlsRatio * 100)}%` : '—'}</div>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
        <div className="text-[11px] text-zinc-500 mb-2">
          请求量时间线{stats.buckets.length > 0 && `（${fmtTime(stats.oldest)} → ${fmtTime(stats.newest)}）`}
        </div>
        {stats.buckets.length === 0 ? (
          <div className="h-20 flex items-center justify-center text-xs text-zinc-600">暂无数据</div>
        ) : (
          <svg viewBox={`0 0 ${stats.buckets.length * 10} 80`} className="w-full h-20" preserveAspectRatio="none">
            {(() => {
              const max = Math.max(...stats.buckets, 1)
              return stats.buckets.map((v, i) => {
                const h = (v / max) * 74
                return (
                  <g key={i}>
                    <rect x={i * 10 + 1} y={80 - h} width={8} height={h} rx={1} fill={v > 0 ? '#38bdf8' : '#27272a'} />
                    {v === 0 && <rect x={i * 10 + 1} y={78} width={8} height={2} fill="#27272a" />}
                  </g>
                )
              })
            })()}
          </svg>
        )}
        <div className="flex justify-between text-[10px] text-zinc-600 mt-1">
          <span>{stats.bucketLabels[0]}</span>
          <span>{stats.bucketLabels[stats.bucketLabels.length - 1]}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
          <div className="text-[11px] text-zinc-500 mb-2">状态码分布</div>
          <div className="flex h-3 rounded overflow-hidden mb-3 bg-zinc-800">
            {statusTotal > 0 &&
              Object.entries(stats.byStatus)
                .filter(([, v]) => v > 0)
                .map(([k, v]) => (
                  <div
                    key={k}
                    style={{ width: `${(v / statusTotal) * 100}%`, backgroundColor: STATUS_COLORS[k] }}
                    title={`${k}: ${v}`}
                  />
                ))}
          </div>
          <div className="grid grid-cols-4 gap-y-1.5">
            {Object.entries(stats.byStatus).map(([k, v]) => (
              <div key={k} className="flex items-center gap-1.5 text-xs">
                <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: STATUS_COLORS[k] }} />
                <span className="text-zinc-400">{k}</span>
                <span className="text-zinc-600 tabular-nums">{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
          <div className="text-[11px] text-zinc-500 mb-2">Method 分布</div>
          <div className="flex flex-wrap gap-2">
            {stats.byMethod.map(([m, n]) => (
              <span
                key={m}
                className="px-2 py-0.5 rounded bg-zinc-800 text-xs text-zinc-300 tabular-nums"
              >
                <span className="font-mono text-sky-400">{m}</span> {n}
              </span>
            ))}
            {stats.byMethod.length === 0 && <span className="text-xs text-zinc-600">暂无数据</span>}
          </div>
          <div className="text-[11px] text-zinc-500 mt-4 mb-2">Top 应用</div>
          <div className="flex flex-wrap gap-2">
            {stats.byApp.map(([a, n]) => (
              <span key={a} className="px-2 py-0.5 rounded bg-zinc-800 text-xs text-zinc-300 tabular-nums">
                <span className="text-emerald-400">{a}</span> {n}
              </span>
            ))}
            {stats.byApp.length === 0 && <span className="text-xs text-zinc-600">暂无数据</span>}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
        <div className="text-[11px] text-zinc-500 mb-2">Top 域名</div>
        {stats.byHost.length === 0 ? (
          <div className="text-xs text-zinc-600 py-3">暂无数据</div>
        ) : (
          <div className="space-y-1">
            {(() => {
              const max = stats.byHost[0][1].total
              return stats.byHost.map(([host, { total, error }]) => (
                <div key={host} className="flex items-center gap-2 text-xs">
                  <span className="w-56 shrink-0 truncate font-mono text-zinc-300" title={host}>
                    {host}
                  </span>
                  <div className="flex-1 h-3.5 rounded bg-zinc-800 overflow-hidden">
                    <div
                      className="h-full rounded bg-sky-600/60"
                      style={{ width: `${(total / max) * 100}%` }}
                    />
                  </div>
                  <span className="w-10 text-right tabular-nums text-zinc-300">{total}</span>
                  {error > 0 && (
                    <span className="w-16 text-right tabular-nums text-red-400" title="失败 / 5xx">
                      {error} 异常
                    </span>
                  )}
                  {error === 0 && <span className="w-16" />}
                </div>
              ))
            })()}
          </div>
        )}
      </div>
    </div>
  )
}
