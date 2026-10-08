import { create } from 'zustand'
import type { CollectionItem, WbNode, WbScope } from '@proxy/shared'
import { call } from '../api/client'

const EXPANDED_KEY = 'wb-expanded'

function loadExpanded(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

function saveExpanded(v: Record<string, boolean>): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(v))
  } catch {
    /* ignore */
  }
}

interface WorkbenchState {
  nodes: WbNode[]
  items: CollectionItem[]
  loaded: boolean
  expanded: Record<string, boolean>
  load: () => Promise<void>
  toggleExpand: (id: string) => void
  createFolder: (scope: WbScope, name: string, parentId?: string | null) => Promise<void>
  createBookmark: (name: string, filter: string, parentId?: string | null) => Promise<void>
  renameNode: (id: string, name: string) => Promise<void>
  removeNode: (id: string) => Promise<void>
  moveNode: (id: string, parentId: string | null) => Promise<void>
  setItemFolder: (itemId: string, folderId: string | null) => Promise<void>
}

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  nodes: [],
  items: [],
  loaded: false,
  expanded: loadExpanded(),
  load: async () => {
    const [n, c] = await Promise.all([call('workbench.nodes'), call('collections.list')])
    set({ nodes: n.nodes, items: c.items, loaded: true })
  },
  toggleExpand: (id) =>
    set((s) => {
      const expanded = { ...s.expanded, [id]: !s.expanded[id] }
      saveExpanded(expanded)
      return { expanded }
    }),
  createFolder: async (scope, name, parentId = null) => {
    const r = await call('workbench.createFolder', { scope, name, parentId })
    set((s) => ({ nodes: r.nodes, expanded: parentId ? { ...s.expanded, [parentId]: true } : s.expanded }))
  },
  createBookmark: async (name, filter, parentId = null) => {
    const r = await call('workbench.createBookmark', { name, filter, parentId })
    set((s) => ({ nodes: r.nodes, expanded: parentId ? { ...s.expanded, [parentId]: true } : s.expanded }))
  },
  renameNode: async (id, name) => {
    const r = await call('workbench.renameNode', { id, name })
    set({ nodes: r.nodes })
  },
  removeNode: async (id) => {
    const [n, c] = await Promise.all([
      call('workbench.removeNode', { id }),
      call('collections.list')
    ])
    set({ nodes: n.nodes, items: c.items })
  },
  moveNode: async (id, parentId) => {
    const r = await call('workbench.moveNode', { id, parentId })
    set((s) => ({ nodes: r.nodes, expanded: parentId ? { ...s.expanded, [parentId]: true } : s.expanded }))
  },
  setItemFolder: async (itemId, folderId) => {
    const r = await call('collections.setFolder', { id: itemId, folderId })
    set({ items: r.items })
  }
}))

/** 节点树形组装；孤儿节点（parent 已被删）只在根级兜底显示 */
export function wbChildrenOf(nodes: WbNode[], scope: WbScope, parentId: string | null): WbNode[] {
  if (parentId === null) {
    const ids = new Set(nodes.map((n) => n.id))
    return nodes.filter(
      (n) => n.scope === scope && (n.parentId === null || !ids.has(n.parentId))
    )
  }
  return nodes.filter((n) => n.scope === scope && n.parentId === parentId)
}
