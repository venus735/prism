import type { FlowSummary } from '@proxy/shared'
import type { CSSProperties } from 'react'
import { COLUMN_DEFS, effectiveWidth, type ColumnDef, type ColumnKey } from './columns'
import { useColumnsStore } from '../../stores/columns'
import { useFlowsStore } from '../../stores/flows'

const LABEL_PALETTE = ['#fbbf24', '#34d399', '#60a5fa', '#f87171', '#c084fc', '#f472b6']

export function labelColor(label: string): string {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0
  return LABEL_PALETTE[h % LABEL_PALETTE.length]
}

function statusColor(status: number | undefined, state: string): string {
  if (state === 'error') return 'text-red-500'
  if (state === 'aborted') return 'text-zinc-500'
  if (status === undefined) return 'text-zinc-500'
  if (status >= 500) return 'text-red-400'
  if (status >= 400) return 'text-amber-400'
  if (status >= 300) return 'text-sky-400'
  return 'text-emerald-400'
}

function methodColor(method: string | undefined): string {
  switch (method) {
    case 'GET':
      return 'text-emerald-400'
    case 'POST':
      return 'text-amber-400'
    case 'PUT':
      return 'text-sky-400'
    case 'DELETE':
      return 'text-red-400'
    case 'OPTIONS':
    case 'HEAD':
      return 'text-violet-400'
    default:
      return 'text-zinc-400'
  }
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} K`
  return `${(bytes / 1024 / 1024).toFixed(1)} M`
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '-'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

export function useCellStyle(): {
  columns: ColumnDef[]
  styleFor: (def: ColumnDef) => CSSProperties
  flexKey: ColumnKey | null
} {
  const hidden = useColumnsStore((s) => s.hidden)
  const widths = useColumnsStore((s) => s.widths)
  const columns = COLUMN_DEFS.filter((d) => !hidden.includes(d.key))
  const flexKey = resolveFlexKey(columns)
  const styleFor = (def: ColumnDef): CSSProperties => {
    const w = effectiveWidth(def, widths)
    if (def.key === flexKey) return { flex: '1 1 0%', minWidth: 0 }
    if (w === 'auto') return {}
    return { width: w, flex: '0 0 auto' }
  }
  return { columns, styleFor, flexKey }
}

function resolveFlexKey(columns: ColumnDef[]): ColumnKey | null {
  const visible = new Set(columns.map((c) => c.key))
  if (visible.has('path')) return 'path'
  if (visible.has('host')) return 'host'
  return null
}

export function FlowRow({
  flow,
  selected,
  onSelect,
  onContextMenu
}: {
  flow: FlowSummary
  selected: boolean
  onSelect: (e: React.MouseEvent) => void
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  const { columns, styleFor, flexKey } = useCellStyle()
  const highlight = useFlowsStore((s) => s.highlights[flow.id])
  return (
    <div
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={flow.note}
      className={`flex h-full items-center gap-2 px-2 border-b border-zinc-800/60 cursor-default whitespace-nowrap select-none ${
        selected && !highlight ? 'bg-sky-600/15' : highlight ? '' : 'hover:bg-zinc-800/50'
      }`}
      style={highlight ? { backgroundColor: `${highlight}${selected ? 'd9' : 'b3'}` } : undefined}
    >
      {columns.map((def) => (
        <Cell key={def.key} flow={flow} def={def} style={styleFor(def)} isFlex={def.key === flexKey} />
      ))}
    </div>
  )
}

function Cell({
  flow,
  def,
  style,
  isFlex
}: {
  flow: FlowSummary
  def: ColumnDef
  style: CSSProperties
  isFlex: boolean
}): React.JSX.Element {
  const truncatable = isFlex || def.key === 'host' || def.key === 'app'
  const cls = `shrink-0 ${truncatable ? 'truncate' : ''} ${def.align === 'right' ? 'text-right' : ''}`
  switch (def.key) {
    case 'seq':
      return (
        <span style={style} className={`${cls} text-zinc-600`}>
          {flow.seq}
        </span>
      )
    case 'method':
      return (
        <span style={style} className={`${cls} ${methodColor(flow.method)}`}>
          {flow.method ?? '—'}
        </span>
      )
    case 'scheme':
      return (
        <span style={style} className={`${cls} text-zinc-500`}>
          {flow.tls ? (flow.mitm ? 'TLS' : '🔐→') : 'HTTP'}
        </span>
      )
    case 'host':
      return (
        <span style={style} className={`${cls} text-zinc-300`} title={flow.host}>
          {flow.host ?? '—'}
        </span>
      )
    case 'path':
      return (
        <span style={style} className={`${cls} text-zinc-400`} title={flow.path}>
          {flow.path ?? ''}
        </span>
      )
    case 'app':
      return (
        <span style={style} className={`${cls} text-zinc-500`} title={flow.clientApp ?? flow.clientIp}>
          {flow.clientApp ?? flow.clientIp ?? ''}
        </span>
      )
    case 'status':
      return (
        <span style={style} className={`${cls} ${statusColor(flow.status, flow.state)}`}>
          {flow.status ?? (flow.state === 'error' ? 'ERR' : '···')}
        </span>
      )
    case 'size':
      return (
        <span style={style} className={`${cls} text-zinc-500`} title={`${flow.totalSize} B（含请求/响应头与体）`}>
          {formatSize(flow.totalSize)}
        </span>
      )
    case 'time':
      return (
        <span style={style} className={`${cls} text-zinc-500`}>
          {formatDuration(flow.durationMs)}
        </span>
      )
    case 'flags':
      return flow.label || flow.flags.length > 0 ? (
        <span style={style} className={`${cls} flex items-center gap-1 text-[11px] text-violet-400`}>
          {flow.label && (
            <span
              className="px-1 rounded text-[10px] text-zinc-900 font-semibold"
              style={{ backgroundColor: labelColor(flow.label) }}
            >
              {flow.label}
            </span>
          )}
          {flow.flags.length > 0 && <span className="truncate">{flow.flags.join(',')}</span>}
        </span>
      ) : (
        <span style={style} />
      )
  }
}
