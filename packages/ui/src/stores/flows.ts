import { create } from 'zustand'
import type { FlowSummary } from '@proxy/shared'
import { parseFilter, matchSummary } from '@proxy/shared'
import { call, subscribe } from '../api/client'

const MAX_LIVE = 5000

/** 右键高亮可选颜色（hex，行背景以透明度渲染在暗色底上） */
export const HIGHLIGHT_COLORS = ['#fde047', '#86efac', '#7dd3fc', '#fca5a5', '#c4b5fd']

interface FlowsState {
  flows: FlowSummary[]
  selectedId: string | null
  selectedIds: string[]
  anchorId: string | null
  filter: string
  selectedApp: string | null
  highlights: Record<string, string>
  recording: boolean
  turbo: boolean
  traceOn: boolean
  followTail: boolean
  setFilter: (filter: string) => void
  select: (id: string | null) => void
  setSelection: (ids: string[], activeId: string | null, anchorId?: string | null) => void
  setSelectedApp: (app: string | null) => void
  setHighlight: (id: string, color: string | null) => void
  setMeta: (id: string, label?: string | null, note?: string | null) => Promise<void>
  moveSelection: (delta: number) => void
  toggleRecording: () => void
  toggleTurbo: () => void
  toggleTrace: () => void
  toggleFollowTail: () => void
  clear: () => void
  loadHistory: () => Promise<void>
}

/** 侧栏分组 key：本机进程名，远程客户端用 IP，兜底「未知」 */
export function appGroupOf(flow: FlowSummary): string {
  return flow.clientApp ?? flow.clientIp ?? '未知'
}

export const useFlowsStore = create<FlowsState>((set, get) => ({
  flows: [],
  selectedId: null,
  selectedIds: [],
  anchorId: null,
  filter: '',
  selectedApp: null,
  highlights: {},
  recording: true,
  turbo: false,
  traceOn: false,
  followTail: true,
  setFilter: (filter) => set({ filter }),
  select: (id) => set({ selectedId: id, selectedIds: id ? [id] : [], anchorId: id }),
  setSelection: (ids, activeId, anchorId) =>
    set((s) => ({
      selectedIds: ids,
      selectedId: activeId,
      anchorId: anchorId !== undefined ? anchorId : s.anchorId
    })),
  setSelectedApp: (app) => set({ selectedApp: app }),
  setHighlight: (id, color) =>
    set((s) => {
      const highlights = { ...s.highlights }
      if (color) highlights[id] = color
      else delete highlights[id]
      return { highlights }
    }),
  setMeta: async (id, label, note) => {
    await call('flows.setMeta', { id, label, note })
    set((s) => ({
      flows: s.flows.map((f) =>
        f.id === id
          ? {
              ...f,
              label: label === undefined ? f.label : label || undefined,
              note: note === undefined ? f.note : note || undefined
            }
          : f
      )
    }))
  },
  moveSelection: (delta) => {
    const { flows, filter, selectedApp, selectedId } = get()
    const visible = filteredFlows(flows, filter, selectedApp)
    if (visible.length === 0) return
    const idx = visible.findIndex((f) => f.id === selectedId)
    const next =
      idx === -1
        ? delta > 0
          ? 0
          : visible.length - 1
        : Math.min(visible.length - 1, Math.max(0, idx + delta))
    const target = visible[next]
    if (target.id !== selectedId) get().select(target.id)
  },
  toggleRecording: () => {
    const recording = !get().recording
    set({ recording })
    // 引擎级无痕：paused 时 flow/WS/gRPC 均不落库、不推送 UI
    void call('app.settings.get')
      .then((s) => call('app.settings.set', { capture: { ...s.capture, paused: !recording } }))
      .catch(() => {})
  },
  toggleTurbo: () => {
    const turbo = !get().turbo
    set({ turbo })
    void call('app.settings.get')
      .then((s) => call('app.settings.set', { capture: { ...s.capture, turbo } }))
      .catch(() => {})
  },
  toggleTrace: () => {
    const traceOn = !get().traceOn
    set({ traceOn })
    void call('app.settings.get')
      .then((s) => call('app.settings.set', { trace: { ...s.trace, enabled: traceOn } }))
      .catch(() => {})
  },
  toggleFollowTail: () => set((s) => ({ followTail: !s.followTail })),
  clear: async () => {
    await call('flows.clear')
    set({ flows: [], selectedId: null, selectedIds: [], anchorId: null, selectedApp: null, highlights: {} })
  },
  loadHistory: async () => {
    const { flows } = await call('flows.list', { limit: 1000 })
    set({ flows })
  }
}))

let started = false

export function startFlowStream(): void {
  if (started) return
  started = true
  void call('app.settings.get')
    .then((s) =>
      useFlowsStore.setState({
        recording: !s.capture.paused,
        turbo: s.capture.turbo,
        traceOn: s.trace?.enabled ?? false
      })
    )
    .catch(() => {})
  void useFlowsStore.getState().loadHistory()
  subscribe<FlowSummary[]>('flow', (batch) => {
    const state = useFlowsStore.getState()
    if (!state.recording) return
    const incoming = batch.map(toSummaryUpdate)
    let flows = state.flows
    const byId = new Map(flows.map((f) => [f.id, f]))
    for (const update of incoming) {
      const existing = byId.get(update.id)
      if (existing) {
        byId.set(update.id, { ...existing, ...update })
      } else {
        flows = [update, ...flows]
        byId.set(update.id, update)
      }
    }
    if (flows.length > MAX_LIVE) {
      flows = flows.slice(0, MAX_LIVE)
    }
    useFlowsStore.setState({ flows: [...byId.values()].sort((a, b) => b.seq - a.seq).slice(0, MAX_LIVE) })
  })
}

function toSummaryUpdate(f: FlowSummary): FlowSummary {
  return f
}

export function filteredFlows(flows: FlowSummary[], filter: string, selectedApp?: string | null): FlowSummary[] {
  let out = flows
  if (selectedApp) out = out.filter((f) => appGroupOf(f) === selectedApp)
  if (!filter.trim()) return out
  const nodes = parseFilter(filter)
  return out.filter((f) => matchSummary(f, nodes))
}
