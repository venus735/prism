export type ColumnKey =
  | 'seq'
  | 'method'
  | 'scheme'
  | 'host'
  | 'path'
  | 'app'
  | 'status'
  | 'size'
  | 'time'
  | 'flags'

export interface ColumnDef {
  key: ColumnKey
  label: string
  /** 固定像素宽度；'flex' 占满剩余空间（同时仅一列）；'auto' 按内容收缩 */
  width: number | 'flex' | 'auto'
  align: 'left' | 'right'
  defaultVisible: boolean
  /** 隐藏默认 flex 列时的降级顺序 */
  flexFallback?: ColumnKey[]
}

export const COLUMN_DEFS: ColumnDef[] = [
  { key: 'seq', label: '#', width: 40, align: 'right', defaultVisible: true },
  { key: 'method', label: 'Method', width: 56, align: 'left', defaultVisible: true },
  { key: 'scheme', label: 'Scheme', width: 56, align: 'left', defaultVisible: true },
  { key: 'host', label: 'Host', width: 204, align: 'left', defaultVisible: true, flexFallback: ['path'] },
  { key: 'path', label: 'Path', width: 'flex', align: 'left', defaultVisible: true },
  { key: 'app', label: 'App', width: 88, align: 'left', defaultVisible: true },
  { key: 'status', label: 'Status', width: 56, align: 'right', defaultVisible: true },
  { key: 'size', label: 'Size', width: 64, align: 'right', defaultVisible: true },
  { key: 'time', label: 'Time', width: 64, align: 'right', defaultVisible: true },
  { key: 'flags', label: 'Flags', width: 'auto', align: 'left', defaultVisible: true }
]

export const DEFAULT_HIDDEN: ColumnKey[] = []

export function effectiveWidth(def: ColumnDef, widths: Partial<Record<ColumnKey, number>>): number | 'flex' | 'auto' {
  if (def.width === 'flex' || def.width === 'auto') return def.width
  return widths[def.key] ?? def.width
}
