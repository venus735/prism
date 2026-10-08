import { useEffect, useRef, useState } from 'react'
import type { Flow, FlowSummary, Rule } from '@proxy/shared'
import { useFlowsStore, filteredFlows, HIGHLIGHT_COLORS } from '../../stores/flows'
import { useComposerStore } from '../../stores/composer'
import { useRulesStore } from '../../stores/rules'
import { call } from '../../api/client'
import { FlowTable } from './FlowTable'
import { FlowDetail } from './FlowDetail'
import { FlowTableHeader } from './FlowTableHeader'
import { WorkbenchSidebar } from './WorkbenchSidebar'
import { DiffModal, type DiffPayload } from '../../components/FlowDiff'

const FILTER_HELP = '过滤：纯文本 · host: · path: · method: · status:200|5xx · app: · label: · note: · trace: · body: · has:response · flag:'

const NET_SIM_RULE_ID = 'net-sim'
const NET_SIM_PRESETS = [
  { name: '弱网', kbps: 16, latencyMs: 800, lossPercent: 10 },
  { name: '2G', kbps: 30, latencyMs: 500, lossPercent: 1 },
  { name: '3G', kbps: 128, latencyMs: 200, lossPercent: 0 },
  { name: '4G', kbps: 1024, latencyMs: 60, lossPercent: 0 },
  { name: '断网', kbps: 1024, latencyMs: 0, lossPercent: 100 }
]

interface ContextMenuState {
  x: number
  y: number
  flow: FlowSummary
}

interface RepeatDialogState {
  flowId: string
  count: number
  intervalMs: number
}

interface CompareState {
  loading: boolean
  payloads: { request: DiffPayload | null; response: DiffPayload | null } | null
}

const DETAIL_MIN_WIDTH = 360
const DETAIL_STORAGE_KEY = 'traffic.detailWidth'

function defaultDetailWidth(): number {
  return Math.max(DETAIL_MIN_WIDTH, Math.round(window.innerWidth * 0.42))
}

function clampDetailWidth(w: number): number {
  return Math.min(Math.max(w, DETAIL_MIN_WIDTH), Math.max(DETAIL_MIN_WIDTH, window.innerWidth - 560))
}

/** 列表/详情之间的拖动分割条：拖动调宽 · 双击重置 */
function DetailSplitter({
  width,
  onResize,
  onReset
}: {
  width: number
  onResize: (w: number) => void
  onReset: () => void
}) {
  const start = useRef<{ x: number; w: number } | null>(null)
  return (
    <div
      className="w-1 shrink-0 cursor-col-resize bg-zinc-800 hover:bg-sky-600/70"
      title="拖动调整详情宽度 · 双击重置"
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        e.preventDefault()
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, w: width }
      }}
      onPointerMove={(e) => {
        if (start.current) onResize(clampDetailWidth(start.current.w - (e.clientX - start.current.x)))
      }}
      onPointerUp={(e) => {
        start.current = null
        ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      }}
    />
  )
}

function flowUrl(flow: FlowSummary): string {
  if (flow.url) return flow.url
  const scheme = flow.tls ? 'https' : 'http'
  return `${scheme}://${flow.host ?? ''}${flow.path ?? ''}`
}

/** 一键网络模拟：管理固定 id 的系统 throttle 规则（host 可填，默认全量） */
function NetSimButton({ showToast }: { showToast: (msg: string) => void }) {
  const rules = useRulesStore((s) => s.rules)
  const loadRules = useRulesStore((s) => s.load)
  const setRules = useRulesStore((s) => s.setRules)
  const [open, setOpen] = useState(false)
  const [host, setHost] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)
  const simRule = rules.find((r) => r.id === NET_SIM_RULE_ID) ?? null
  const activePreset = simRule?.enabled
    ? NET_SIM_PRESETS.find(
        (p) =>
          simRule.action.type === 'throttle' &&
          simRule.action.kbps === p.kbps &&
          (simRule.action.latencyMs ?? 0) === p.latencyMs &&
          (simRule.action.lossPercent ?? 0) === p.lossPercent
      ) ?? { name: '自定义' }
    : null

  useEffect(() => {
    if (!rules.length) void loadRules().catch(() => {})
  }, [rules.length, loadRules])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const apply = async (preset: (typeof NET_SIM_PRESETS)[number] | null): Promise<void> => {
    const current = useRulesStore.getState().rules
    const others = current.filter((r) => r.id !== NET_SIM_RULE_ID)
    if (!preset) {
      if (simRule) await setRules(others)
      showToast('已关闭网络模拟')
    } else {
      const rule: Rule = {
        id: NET_SIM_RULE_ID,
        name: `网络模拟 · ${preset.name}`,
        enabled: true,
        match: { host: host.trim() || '*', path: '', method: '' },
        action: { type: 'throttle', kbps: preset.kbps, latencyMs: preset.latencyMs, lossPercent: preset.lossPercent }
      }
      await setRules([rule, ...others])
      showToast(`网络模拟已开启：${preset.name}${host.trim() ? `（${host.trim()}）` : '（全部流量）'}`)
    }
    setOpen(false)
  }

  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`px-2 py-1 rounded text-xs ${
          activePreset ? 'bg-amber-600/20 text-amber-400' : 'text-zinc-400 hover:text-sky-400 hover:bg-zinc-800'
        }`}
        title="一键弱网模拟：为全部或指定 host 套用带宽/延迟/丢包预设"
      >
        ⏱ 网络模拟{activePreset ? ` · ${activePreset.name}` : ''}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 rounded border border-zinc-800 bg-zinc-900 shadow-lg py-1.5 w-52">
          <div className="px-2 pb-1.5 flex items-center gap-1.5">
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="host（空 = 全部）"
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-sky-700"
            />
          </div>
          {NET_SIM_PRESETS.map((p) => (
            <button
              key={p.name}
              onClick={() => void apply(p)}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-800 ${
                activePreset?.name === p.name ? 'text-amber-400' : 'text-zinc-300'
              }`}
            >
              {p.name}
              <span className="ml-2 text-[10px] text-zinc-500">
                {p.kbps}kbps · {p.latencyMs}ms{p.lossPercent ? ` · 丢包 ${p.lossPercent}%` : ''}
              </span>
            </button>
          ))}
          <div className="border-t border-zinc-800 mt-1 pt-1">
            <button
              onClick={() => void apply(null)}
              disabled={!simRule}
              className="w-full text-left px-3 py-1.5 text-xs text-zinc-400 hover:text-red-400 disabled:opacity-30 hover:bg-zinc-800"
            >
              关闭模拟
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function TrafficPage() {
  const filter = useFlowsStore((s) => s.filter)
  const setFilter = useFlowsStore((s) => s.setFilter)
  const recording = useFlowsStore((s) => s.recording)
  const toggleRecording = useFlowsStore((s) => s.toggleRecording)
  const turbo = useFlowsStore((s) => s.turbo)
  const toggleTurbo = useFlowsStore((s) => s.toggleTurbo)
  const traceOn = useFlowsStore((s) => s.traceOn)
  const toggleTrace = useFlowsStore((s) => s.toggleTrace)
  const clear = useFlowsStore((s) => s.clear)
  const flows = useFlowsStore((s) => s.flows)
  const selectedId = useFlowsStore((s) => s.selectedId)
  const selectedApp = useFlowsStore((s) => s.selectedApp)
  const setSelectedApp = useFlowsStore((s) => s.setSelectedApp)
  const select = useFlowsStore((s) => s.select)
  const setHighlight = useFlowsStore((s) => s.setHighlight)
  const setMeta = useFlowsStore((s) => s.setMeta)
  const highlights = useFlowsStore((s) => s.highlights)
  const selectedIds = useFlowsStore((s) => s.selectedIds)
  const [harState, setHarState] = useState<'idle' | 'exporting' | 'saved' | 'failed'>('idle')
  const [importing, setImporting] = useState(false)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [repeat, setRepeat] = useState<RepeatDialogState | null>(null)
  const [repeating, setRepeating] = useState(false)
  const [compare, setCompare] = useState<CompareState | null>(null)
  const [labelDraft, setLabelDraft] = useState('')
  const [noteDraft, setNoteDraft] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [detailWidth, setDetailWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(DETAIL_STORAGE_KEY))
    return Number.isFinite(saved) && saved > 0 ? clampDetailWidth(saved) : defaultDetailWidth()
  })
  const filterRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const resizeDetail = (w: number): void => {
    setDetailWidth(w)
    localStorage.setItem(DETAIL_STORAGE_KEY, String(Math.round(w)))
  }

  const count = filteredFlows(flows, filter, selectedApp).length

  const showToast = (msg: string): void => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 1600)
  }

  const copyText = async (text: string, label: string): Promise<void> => {
    try {
      await call('app.clipboard.writeText', { text })
      showToast(`${label} 已复制`)
    } catch {
      showToast('复制失败')
    }
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        filterRef.current?.focus()
        filterRef.current?.select()
        return
      }
      if (e.key === 'Escape') {
        if (menu) setMenu(null)
        else if (useFlowsStore.getState().selectedId) useFlowsStore.getState().select(null)
        return
      }
      const t = e.target as HTMLElement | null
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        useFlowsStore.getState().moveSelection(1)
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        useFlowsStore.getState().moveSelection(-1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', () => setMenu(null), { once: true })
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const openMenu = (flow: FlowSummary, e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    // 右键已选中的行 → 保留多选；否则仅选中该行
    if (!useFlowsStore.getState().selectedIds.includes(flow.id)) select(flow.id)
    setLabelDraft(flow.label ?? '')
    setNoteDraft(flow.note ?? '')
    const x = Math.min(e.clientX, window.innerWidth - 200)
    const y = Math.min(e.clientY, window.innerHeight - 300)
    setMenu({ x, y, flow })
  }

  const applyMeta = async (flowId: string): Promise<void> => {
    await setMeta(flowId, labelDraft.trim() || null, noteDraft.trim() || null)
    setMenu(null)
  }

  const runRepeat = async (r: RepeatDialogState): Promise<void> => {
    setRepeating(true)
    try {
      const res = await call('flows.repeat', { id: r.flowId, count: r.count, intervalMs: r.intervalMs })
      showToast(`已重放 ${res.flowIds.length} 次`)
    } catch {
      showToast('重放失败')
    } finally {
      setRepeating(false)
      setRepeat(null)
    }
  }

  const openCompare = async (ids: [string, string]): Promise<void> => {
    setCompare({ loading: true, payloads: null })
    try {
      const [fa, fb] = await Promise.all(ids.map((id) => call('flows.get', { id })))
      const flowA = fa.flow
      const flowB = fb.flow
      if (!flowA?.request || !flowB?.request) {
        showToast('无法对比（缺少请求数据）')
        setCompare(null)
        return
      }
      const bodies = await Promise.all(
        (['req', 'resp'] as const).flatMap((part) =>
          ids.map((id) => call('flows.getBody', { id, part }).then((r) => r.body))
        )
      )
      const [reqBodyA, reqBodyB, respBodyA, respBodyB] = bodies
      const titleOf = (f: Flow): string =>
        `#${f.seq} ${f.request?.method ?? ''} ${f.request?.url ?? f.host ?? ''}`
      const durationOf = (f: Flow): string =>
        f.timing.firstByte && f.timing.end ? `${f.timing.end - f.timing.start} ms` : '—'
      const request: DiffPayload = {
        lines: [
          { label: 'Method', l: flowA.request.method, r: flowB.request.method },
          { label: 'URL', l: flowA.request.url, r: flowB.request.url }
        ],
        lHeaders: flowA.request.headers,
        rHeaders: flowB.request.headers,
        lBody: reqBodyA?.text ?? '',
        rBody: reqBodyB?.text ?? '',
        lTitle: titleOf(flowA),
        rTitle: titleOf(flowB)
      }
      const response: DiffPayload | null =
        flowA.response && flowB.response
          ? {
              lines: [
                {
                  label: 'Status',
                  l: `${flowA.response.status} ${flowA.response.statusText}`.trim(),
                  r: `${flowB.response.status} ${flowB.response.statusText}`.trim()
                },
                { label: '耗时', l: durationOf(flowA), r: durationOf(flowB) }
              ],
              lHeaders: flowA.response.headers,
              rHeaders: flowB.response.headers,
              lBody: respBodyA?.text ?? '',
              rBody: respBodyB?.text ?? '',
              lTitle: `#${flowA.seq} 响应`,
              rTitle: `#${flowB.seq} 响应`
            }
          : null
      setCompare({ loading: false, payloads: { request, response } })
    } catch {
      showToast('对比失败')
      setCompare(null)
    }
  }

  const copyCurl = async (flowIds: string[]): Promise<void> => {
    try {
      const parts: string[] = []
      for (const id of flowIds) {
        const { code } = await call('flows.codegen', { id, lang: 'curl' })
        parts.push(code)
      }
      await copyText(parts.join('\n\n'), 'cURL')
    } catch {
      showToast('生成 cURL 失败')
    }
  }

  const addToCollection = async (flowIds: string[]): Promise<void> => {
    try {
      const byId = new Map(flows.map((f) => [f.id, f]))
      let n = 0
      for (const id of flowIds) {
        const flow = byId.get(id)
        if (!flow) continue
        const name = `${flow.method ?? ''} ${flow.host ?? ''}${flow.path ?? ''}`.trim().slice(0, 80)
        await call('collections.addFromFlow', { flowId: flow.id, name })
        n++
      }
      showToast(n > 1 ? `已加入 Collection（${n} 条）` : '已加入 Collection')
    } catch {
      showToast('加入失败')
    }
  }

  const importHar = async () => {
    setImporting(true)
    try {
      const r = await call('flows.importHar')
      if (!r.canceled) {
        if (r.error) showToast(`导入失败：${r.error}`)
        else {
          const skipped = r.skipped ? `，跳过 ${r.skipped} 条` : ''
          showToast(`已导入 ${r.imported ?? 0} 条${skipped}`)
          // 暂停录制时 flow 事件被忽略，兜底刷新一次列表
          void useFlowsStore.getState().loadHistory()
        }
      }
    } catch {
      showToast('导入失败')
    } finally {
      setImporting(false)
    }
  }

  const exportHar = async () => {
    setHarState('exporting')
    try {
      const r = await call('flows.exportHar', { filter: filter.trim() || undefined })
      setHarState(r.saved ? 'saved' : 'idle')
      if (r.saved) {
        setTimeout(() => setHarState('idle'), 2000)
      }
    } catch {
      setHarState('failed')
      setTimeout(() => setHarState('idle'), 2000)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 shrink-0">
        <button
          onClick={toggleRecording}
          className={`w-3 h-3 rounded-full shrink-0 ${recording ? 'bg-red-500 animate-pulse' : 'bg-zinc-600'}`}
          title={recording ? '录制中，点击暂停（无痕：不记录流量）' : '无痕模式：已暂停记录，点击恢复'}
        />
        <button
          onClick={toggleTurbo}
          className={`text-[13px] leading-none shrink-0 ${turbo ? 'text-amber-400' : 'text-zinc-600 hover:text-zinc-300'}`}
          title={
            turbo
              ? '极速模式已开启：流量仅在内存中展示，不写磁盘（重启后清空）。点击关闭'
              : '开启极速模式：不写磁盘、仅内存实时展示（重启后清空），适合大流量压测'
          }
        >
          ⚡
        </button>
        <button
          onClick={toggleTrace}
          className={`text-[13px] leading-none shrink-0 ${traceOn ? 'text-sky-400' : 'text-zinc-600 hover:text-zinc-300'}`}
          title={
            traceOn
              ? '请求跟踪已开启：为上游请求注入 X-Trace-Id（右键流量可按 trace: 过滤）。点击关闭'
              : '开启请求跟踪：为每个上游请求注入 X-Trace-Id 追踪头，可按 trace: 前缀过滤'
          }
        >
          ⌖
        </button>
        <input
          ref={filterRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={FILTER_HELP}
          className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-sky-700"
        />
        <span className="text-xs text-zinc-500 shrink-0" title="快捷键：⌘F 过滤 · ↑/↓ 或 j/k 导航 · Esc 取消选择">
          {count} 条
        </span>
        <NetSimButton showToast={showToast} />
        <button
          onClick={() => void importHar()}
          disabled={importing}
          className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-sky-400 hover:bg-zinc-800 shrink-0 disabled:opacity-50"
          title="从 HAR 1.2 文件导入流量记录（可用 flag:imported 过滤）"
        >
          {importing ? '导入中…' : '导入 HAR'}
        </button>
        <button
          onClick={() => void exportHar()}
          disabled={harState === 'exporting'}
          className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-sky-400 hover:bg-zinc-800 shrink-0 disabled:opacity-50"
          title="将当前过滤结果导出为 HAR 1.2 文件"
        >
          {harState === 'exporting' ? '导出中…' : harState === 'saved' ? '已导出 ✓' : harState === 'failed' ? '导出失败' : '导出 HAR'}
        </button>
        <button
          onClick={() => clear()}
          className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-red-400 hover:bg-zinc-800 shrink-0"
        >
          清空
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <WorkbenchSidebar
          flows={flows}
          selectedApp={selectedApp}
          onSelectApp={(app) => setSelectedApp(app)}
          filter={filter}
          onApplyFilter={(f) => setFilter(f)}
        />
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden border-r border-zinc-800">
          <FlowTableHeader />
          <FlowTable onRowContextMenu={openMenu} />
        </div>
        {selectedId && (
          <>
            <DetailSplitter
              width={detailWidth}
              onResize={resizeDetail}
              onReset={() => {
                localStorage.removeItem(DETAIL_STORAGE_KEY)
                setDetailWidth(defaultDetailWidth())
              }}
            />
            <div style={{ width: detailWidth }} className="flex flex-col overflow-hidden">
              <FlowDetail flowId={selectedId} />
            </div>
          </>
        )}
      </div>

      {menu && (() => {
        // 多选时右键作用于全部选中行；否则仅当前行
        const targets = selectedIds.includes(menu.flow.id) ? selectedIds : [menu.flow.id]
        const n = targets.length
        const byId = new Map(flows.map((f) => [f.id, f]))
        return (
        <div
          ref={menuRef}
          className="fixed z-50 py-1 rounded-md border border-zinc-700 bg-zinc-900 shadow-xl text-sm min-w-40"
          style={{ left: menu.x, top: menu.y }}
        >
          <MenuItem
            label={n > 1 ? `复制 URL（${n} 条）` : '复制 URL'}
            onClick={() => {
              setMenu(null)
              const urls = targets.map((id) => flowUrl(byId.get(id) ?? menu.flow))
              void copyText(urls.join('\n'), 'URL')
            }}
          />
          <MenuItem
            label={n > 1 ? `复制 cURL（${n} 条）` : '复制 cURL'}
            onClick={() => {
              const ids = [...targets]
              setMenu(null)
              void copyCurl(ids)
            }}
          />
          {n === 1 && (
            <MenuItem
              label="在 Composer 中打开"
              onClick={() => {
                const flow = menu.flow
                setMenu(null)
                void useComposerStore.getState().loadFromFlow(flow.id)
              }}
            />
          )}
          {n === 1 && menu.flow.kind === 'http' && (
            <MenuItem
              label="重放…"
              onClick={() => {
                setRepeat({ flowId: menu.flow.id, count: 1, intervalMs: 0 })
                setMenu(null)
              }}
            />
          )}
          {n === 1 && menu.flow.traceId && (
            <MenuItem
              label={`按 Trace ID 过滤（${menu.flow.traceId.slice(0, 8)}…）`}
              onClick={() => {
                setMenu(null)
                setFilter(`trace:"${menu.flow.traceId}"`)
                filterRef.current?.focus()
              }}
            />
          )}
          {(() => {
            const httpTargets = targets
              .map((id) => byId.get(id))
              .filter((f): f is FlowSummary => !!f && f.kind === 'http')
            if (httpTargets.length !== 2) return null
            const [x, y] = httpTargets
            return (
              <MenuItem
                label={`对比（#${x.seq} vs #${y.seq}）`}
                onClick={() => {
                  setMenu(null)
                  void openCompare([x.id, y.id])
                }}
              />
            )
          })()}
          <MenuItem
            label={n > 1 ? `加入 Collection（${n} 条）` : '加入 Collection'}
            onClick={() => {
              const ids = [...targets]
              setMenu(null)
              void addToCollection(ids)
            }}
          />
          <div className="mt-1 border-t border-zinc-800 px-3 py-1.5">
            <div className="text-[10px] text-zinc-600 mb-1">{n > 1 ? `高亮（${n} 条）` : '高亮'}</div>
            <div className="flex items-center gap-2">
              {HIGHLIGHT_COLORS.map((c) => {
                const active = targets.length > 0 && targets.every((id) => highlights[id] === c)
                return (
                  <button
                    key={c}
                    onClick={() => {
                      const color = active ? null : c
                      for (const id of targets) setHighlight(id, color)
                      setMenu(null)
                    }}
                    className="w-4 h-4 rounded-full border hover:scale-110 transition-transform"
                    style={{
                      backgroundColor: c,
                      borderColor: active ? '#e4e4e7' : 'transparent',
                      boxShadow: active ? `0 0 0 1px ${c}` : undefined
                    }}
                    title={active ? '取消高亮' : '高亮'}
                  />
                )
              })}
              {targets.some((id) => highlights[id]) && (
                <button
                  onClick={() => {
                    for (const id of targets) setHighlight(id, null)
                    setMenu(null)
                  }}
                  className="text-[10px] text-zinc-500 hover:text-zinc-300"
                >
                  取消
                </button>
              )}
            </div>
          </div>
          {n === 1 && (
            <div className="mt-1 border-t border-zinc-800 px-3 py-1.5">
              <div className="text-[10px] text-zinc-600 mb-1">标签 / 备注</div>
              <input
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void applyMeta(menu.flow.id)
                }}
                placeholder="标签（可用 label: 过滤）"
                className="w-44 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-sky-700"
              />
              <input
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void applyMeta(menu.flow.id)
                }}
                placeholder="备注（悬停行可查看）"
                className="mt-1 w-44 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-sky-700"
              />
              <button
                onClick={() => void applyMeta(menu.flow.id)}
                className="mt-1.5 px-2 py-0.5 rounded text-[10px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700"
              >
                保存
              </button>
            </div>
          )}
        </div>
        )
      })()}

      {repeat && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => {
            if (!repeating) setRepeat(null)
          }}
        >
          <div
            className="w-72 rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm text-zinc-200 font-medium mb-3">批量重放</div>
            <label className="block text-xs text-zinc-500 mb-1">次数（1-100）</label>
            <input
              type="number"
              min={1}
              max={100}
              value={repeat.count}
              onChange={(e) =>
                setRepeat({ ...repeat, count: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })
              }
              className="w-full mb-3 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-sky-700"
            />
            <label className="block text-xs text-zinc-500 mb-1">间隔（毫秒）</label>
            <input
              type="number"
              min={0}
              step={100}
              value={repeat.intervalMs}
              onChange={(e) => setRepeat({ ...repeat, intervalMs: Math.max(0, Number(e.target.value) || 0) })}
              className="w-full mb-4 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-sky-700"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRepeat(null)}
                disabled={repeating}
                className="px-3 py-1 rounded text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={() => void runRepeat(repeat)}
                disabled={repeating}
                className="px-3 py-1 rounded text-xs text-zinc-100 bg-sky-600 hover:bg-sky-500 disabled:opacity-50"
              >
                {repeating ? '重放中…' : `重放 ${repeat.count} 次`}
              </button>
            </div>
          </div>
        </div>
      )}

      {compare?.loading && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={() => setCompare(null)}>
          <div className="text-sm text-zinc-400">加载对比数据…</div>
        </div>
      )}
      {compare?.payloads && (
        <DiffModal
          title="流量对比"
          tabs={[
            { id: 'request', label: '请求', payload: compare.payloads.request },
            { id: 'response', label: '响应', payload: compare.payloads.response }
          ]}
          onClose={() => setCompare(null)}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 px-3 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-200 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between gap-6 px-3 py-1.5 text-left text-zinc-300 hover:bg-sky-700/30 hover:text-zinc-100"
    >
      <span>{label}</span>
    </button>
  )
}
