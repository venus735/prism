import { useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { FlowSummary } from '@proxy/shared'
import { useFlowsStore, filteredFlows } from '../../stores/flows'
import { FlowRow } from './FlowRow'

const ROW_HEIGHT = 28

export function FlowTable({
  onRowContextMenu
}: {
  onRowContextMenu?: (flow: FlowSummary, e: React.MouseEvent) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const flows = useFlowsStore((s) => s.flows)
  const filter = useFlowsStore((s) => s.filter)
  const selectedApp = useFlowsStore((s) => s.selectedApp)
  const selectedId = useFlowsStore((s) => s.selectedId)
  const selectedIds = useFlowsStore((s) => s.selectedIds)

  const visible = useMemo(() => filteredFlows(flows, filter, selectedApp), [flows, filter, selectedApp])

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20
  })

  useEffect(() => {
    if (!selectedId) return
    const idx = visible.findIndex((f) => f.id === selectedId)
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'auto' })
  }, [selectedId, visible, virtualizer])

  /** 普通点击单选 · Cmd/Ctrl 点加选/减选 · Shift 点从锚点连选 */
  const handleSelect = (flow: FlowSummary, e: React.MouseEvent): void => {
    const state = useFlowsStore.getState()
    if (e.shiftKey) {
      const anchorIdx = visible.findIndex((f) => f.id === state.anchorId)
      const idx = visible.findIndex((f) => f.id === flow.id)
      if (anchorIdx >= 0 && idx >= 0 && anchorIdx !== idx) {
        const [a, b] = anchorIdx < idx ? [anchorIdx, idx] : [idx, anchorIdx]
        state.setSelection(visible.slice(a, b + 1).map((f) => f.id), flow.id)
        return
      }
    }
    if (e.metaKey || e.ctrlKey) {
      const ids = state.selectedIds.includes(flow.id)
        ? state.selectedIds.filter((x) => x !== flow.id)
        : [...state.selectedIds, flow.id]
      const active = ids.includes(flow.id) ? flow.id : ids[ids.length - 1] ?? null
      state.setSelection(ids, active, flow.id)
      return
    }
    state.select(flow.id)
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden text-[13px] font-mono">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => (
          <FlowRowWrapper
            key={visible[row.index].id}
            flow={visible[row.index]}
            selected={selectedIds.includes(visible[row.index].id)}
            onSelect={handleSelect}
            onContextMenu={onRowContextMenu}
            translateY={row.start}
          />
        ))}
      </div>
    </div>
  )
}

function FlowRowWrapper({
  flow,
  selected,
  onSelect,
  onContextMenu,
  translateY
}: {
  flow: FlowSummary
  selected: boolean
  onSelect: (flow: FlowSummary, e: React.MouseEvent) => void
  onContextMenu?: (flow: FlowSummary, e: React.MouseEvent) => void
  translateY: number
}) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: ROW_HEIGHT,
        transform: `translateY(${translateY}px)`
      }}
    >
      <FlowRow
        flow={flow}
        selected={selected}
        onSelect={(e) => onSelect(flow, e)}
        onContextMenu={onContextMenu ? (e) => onContextMenu(flow, e) : undefined}
      />
    </div>
  )
}
