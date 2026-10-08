import { useEffect, useRef, useState } from 'react'
import { COLUMN_DEFS, effectiveWidth } from './columns'
import { useColumnsStore } from '../../stores/columns'
import { useCellStyle } from './FlowRow'

export function FlowTableHeader() {
  const { columns, styleFor, flexKey } = useCellStyle()
  const widths = useColumnsStore((s) => s.widths)
  const setWidth = useColumnsStore((s) => s.setWidth)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  return (
    <div
      className="relative flex items-center gap-2 px-2 py-1 border-b border-zinc-800 text-[11px] text-zinc-500 font-mono shrink-0 bg-zinc-900/50 select-none overflow-hidden"
      onContextMenu={(e) => {
        e.preventDefault()
        const x = Math.min(e.clientX, window.innerWidth - 180)
        const y = Math.min(e.clientY, window.innerHeight - 280)
        setMenu({ x, y })
      }}
      title="右键自定义列 · 拖动列边缘调宽"
    >
      {columns.map((def) => {
        const w = effectiveWidth(def, widths)
        const resizable = typeof w === 'number' && def.key !== flexKey
        return (
          <div key={def.key} className="relative shrink-0" style={styleFor(def)}>
            <span className={`block truncate ${def.align === 'right' ? 'text-right' : ''}`}>{def.label}</span>
            {resizable && (
              <ResizeHandle
                width={w as number}
                onResize={(nw) => setWidth(def.key, nw)}
              />
            )}
          </div>
        )
      })}

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 py-1 rounded-md border border-zinc-700 bg-zinc-900 shadow-xl text-sm min-w-40"
          style={{ left: menu.x, top: menu.y }}
        >
          <div className="px-3 py-1 text-[10px] text-zinc-600">显示列</div>
          {COLUMN_DEFS.map((def) => (
            <MenuCheckbox key={def.key} columnKey={def.key} label={def.label} />
          ))}
          <div className="mt-1 border-t border-zinc-800">
            <button
              onClick={() => {
                useColumnsStore.getState().resetColumns()
                setMenu(null)
              }}
              className="w-full px-3 py-1.5 text-left text-zinc-400 hover:bg-sky-700/30 hover:text-zinc-100"
            >
              重置列
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function MenuCheckbox({ columnKey, label }: { columnKey: (typeof COLUMN_DEFS)[number]['key']; label: string }): React.JSX.Element {
  const hidden = useColumnsStore((s) => s.hidden)
  const toggleColumn = useColumnsStore((s) => s.toggleColumn)
  const visible = !hidden.includes(columnKey)
  return (
    <button
      onClick={() => toggleColumn(columnKey)}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-zinc-300 hover:bg-sky-700/30 hover:text-zinc-100"
    >
      <span
        className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center text-[9px] ${
          visible ? 'bg-sky-600 border-sky-600 text-white' : 'border-zinc-600'
        }`}
      >
        {visible ? '✓' : ''}
      </span>
      {label}
    </button>
  )
}

function ResizeHandle({ width, onResize }: { width: number; onResize: (width: number) => void }): React.JSX.Element {
  const start = useRef<{ x: number; w: number } | null>(null)
  return (
    <div
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-sky-600/70"
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, w: width }
      }}
      onPointerMove={(e) => {
        if (start.current) onResize(start.current.w + (e.clientX - start.current.x))
      }}
      onPointerUp={(e) => {
        start.current = null
        ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      }}
    />
  )
}
