import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { COLUMN_DEFS, DEFAULT_HIDDEN, type ColumnKey } from '../pages/traffic/columns'

export const MIN_COLUMN_WIDTH = 28

interface ColumnsState {
  hidden: ColumnKey[]
  widths: Partial<Record<ColumnKey, number>>
  toggleColumn: (key: ColumnKey) => void
  setWidth: (key: ColumnKey, width: number) => void
  resetColumns: () => void
}

export const useColumnsStore = create<ColumnsState>()(
  persist(
    (set) => ({
      hidden: DEFAULT_HIDDEN,
      widths: {},
      toggleColumn: (key) =>
        set((s) => ({
          hidden: s.hidden.includes(key) ? s.hidden.filter((k) => k !== key) : [...s.hidden, key]
        })),
      setWidth: (key, width) =>
        set((s) => ({ widths: { ...s.widths, [key]: Math.max(MIN_COLUMN_WIDTH, Math.round(width)) } })),
      resetColumns: () => set({ hidden: DEFAULT_HIDDEN, widths: {} })
    }),
    { name: 'proxy-flow-columns', version: 1 }
  )
)

export function visibleColumns(): (typeof COLUMN_DEFS)[number][] {
  const { hidden } = useColumnsStore.getState()
  return COLUMN_DEFS.filter((d) => !hidden.includes(d.key))
}
