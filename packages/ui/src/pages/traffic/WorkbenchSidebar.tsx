import { useEffect, useMemo, useRef, useState } from 'react'
import type { CollectionItem, FlowSummary, WbNode } from '@proxy/shared'
import { call } from '../../api/client'
import { useWorkbenchStore, wbChildrenOf } from '../../stores/workbench'
import { useComposerStore } from '../../stores/composer'
import { useUiStore } from '../../stores/ui'
import { appGroupOf } from '../../stores/flows'

const SECTION_KEY = 'wb-sections'

function loadSectionState(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(SECTION_KEY) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

function deviceLabelOf(ip: string): string {
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return '本机'
  return ip
}

const DEVICE_NAMES_KEY = 'device-names.v1'

function loadDeviceNames(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DEVICE_NAMES_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

function saveDeviceNames(names: Record<string, string>): void {
  try {
    localStorage.setItem(DEVICE_NAMES_KEY, JSON.stringify(names))
  } catch {
    /* ignore */
  }
}

export function WorkbenchSidebar({
  flows,
  selectedApp,
  onSelectApp,
  filter,
  onApplyFilter
}: {
  flows: FlowSummary[]
  selectedApp: string | null
  onSelectApp: (app: string | null) => void
  filter: string
  onApplyFilter: (filter: string) => void
}): React.JSX.Element {
  const load = useWorkbenchStore((s) => s.load)
  const sections = useRef(loadSectionState())
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(sections.current)
  const [creating, setCreating] = useState<{ scope: 'favorite' | 'bookmark'; parentId: string | null } | null>(null)
  const [bookmarkDraft, setBookmarkDraft] = useState<{ name: string; filter: string } | null>(null)

  useEffect(() => {
    void load().catch(() => {})
  }, [load])

  const toggleSection = (id: string, forceOpen = false): void => {
    setCollapsed((prev) => {
      const next = forceOpen ? { ...prev, [id]: false } : { ...prev, [id]: !prev[id] }
      sections.current = next
      try {
        localStorage.setItem(SECTION_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  const item = (active: boolean): string =>
    `w-full flex items-center gap-1.5 pl-2 pr-2 py-1.5 text-left text-xs ${
      active ? 'bg-sky-600/15 text-sky-300' : 'text-zinc-400 hover:bg-zinc-800/50'
    }`

  return (
    <div className="w-56 shrink-0 border-r border-zinc-800 overflow-y-auto bg-zinc-900/30 flex flex-col">
      <Section
        title="我的收藏"
        icon={SECTION_ICONS.fav}
        collapsed={!!collapsed.fav}
        onToggle={() => toggleSection('fav')}
        extra={
          <button
            onClick={() => {
              setCreating({ scope: 'favorite', parentId: null })
              toggleSection('fav', true)
            }}
            title="新建收藏文件夹"
            className="text-zinc-600 hover:text-zinc-200 text-[13px] leading-none px-1"
          >
            ＋
          </button>
        }
      >
        {creating?.scope === 'favorite' && creating.parentId === null && (
          <NewFolderInput
            onCancel={() => setCreating(null)}
            onOk={async (name) => {
              await useWorkbenchStore.getState().createFolder('favorite', name, null)
              setCreating(null)
            }}
          />
        )}
        <FavoriteTree parentId={null} depth={0} />
        <AddToRootDropZone scope="favorite" />
      </Section>

      <Section
        title="我的书签"
        icon={SECTION_ICONS.bm}
        collapsed={!!collapsed.bm}
        onToggle={() => toggleSection('bm')}
        extra={
          <>
            <button
              onClick={() => {
                setBookmarkDraft({ name: '', filter })
                toggleSection('bm', true)
              }}
              title="把当前过滤条件存为书签"
              className="text-zinc-600 hover:text-amber-300 text-[12px] leading-none px-1"
            >
              ☆
            </button>
            <button
              onClick={() => {
                setCreating({ scope: 'bookmark', parentId: null })
                toggleSection('bm', true)
              }}
              title="新建书签文件夹"
              className="text-zinc-600 hover:text-zinc-200 text-[13px] leading-none px-1"
            >
              ＋
            </button>
          </>
        }
      >
        {bookmarkDraft && (
          <NewBookmarkInput
            initialFilter={filter}
            onCancel={() => setBookmarkDraft(null)}
            onOk={async (name, f) => {
              await useWorkbenchStore.getState().createBookmark(name, f, null)
              setBookmarkDraft(null)
            }}
          />
        )}
        {creating?.scope === 'bookmark' && creating.parentId === null && (
          <NewFolderInput
            onCancel={() => setCreating(null)}
            onOk={async (name) => {
              await useWorkbenchStore.getState().createFolder('bookmark', name, null)
              setCreating(null)
            }}
          />
        )}
        <BookmarkTree parentId={null} depth={0} onApplyFilter={onApplyFilter} />
        <AddToRootDropZone scope="bookmark" />
      </Section>

      <DeviceSection flows={flows} onApplyFilter={onApplyFilter} />
      <AppSection flows={flows} selectedApp={selectedApp} onSelectApp={onSelectApp} item={item} />
      <DomainSection flows={flows} onApplyFilter={onApplyFilter} />
    </div>
  )
}

// ------------------------------------------------------------------
// 通用分组外壳
// ------------------------------------------------------------------

const SECTION_ICONS: Record<string, string> = {
  fav: '★',
  bm: '🔖',
  device: '📱',
  app: '🖥',
  domain: '🌐'
}

function Section({
  title,
  icon,
  collapsed,
  onToggle,
  extra,
  children
}: {
  title: string
  icon: string
  collapsed: boolean
  onToggle: () => void
  extra?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="border-b border-zinc-800">
      <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 group bg-zinc-900/60 sticky top-0 z-10">
        <button onClick={onToggle} className="text-zinc-500 hover:text-zinc-200 text-[9px] w-3 shrink-0">
          {collapsed ? '▶' : '▼'}
        </button>
        <span className="text-[13px] leading-none shrink-0">{icon}</span>
        <span className="flex-1 text-[11px] font-semibold tracking-wide text-zinc-300 select-none uppercase">
          {title}
        </span>
        <span className="opacity-0 group-hover:opacity-100 transition-opacity flex gap-0.5">{extra}</span>
      </div>
      {!collapsed && <div className="pb-1">{children}</div>}
    </div>
  )
}

// ------------------------------------------------------------------
// 收藏树（文件夹 + Collection 条目）
// ------------------------------------------------------------------

function FavoriteTree({ parentId, depth }: { parentId: string | null; depth: number }): React.JSX.Element {
  const nodes = useWorkbenchStore((s) => s.nodes)
  const items = useWorkbenchStore((s) => s.items)
  const expanded = useWorkbenchStore((s) => s.expanded)
  const toggleExpand = useWorkbenchStore((s) => s.toggleExpand)
  const removeNode = useWorkbenchStore((s) => s.removeNode)
  const setItemFolder = useWorkbenchStore((s) => s.setItemFolder)
  const [creating, setCreating] = useState(false)
  const [dropOn, setDropOn] = useState(false)
  const loadFromCollection = useComposerStore((s) => s.loadFromCollection)
  const setPage = useUiStore((s) => s.setPage)

  const folders = useMemo(() => wbChildrenOf(nodes, 'favorite', parentId), [nodes, parentId])
  const childItems = useMemo(
    () => items.filter((it) => (it.folderId ?? null) === parentId),
    [items, parentId]
  )

  const openItem = (it: CollectionItem): void => {
    loadFromCollection(it)
    setPage('composer')
  }

  return (
    <div>
      {folders.map((node) => {
        const open = !!expanded[node.id]
        return (
          <div
            key={node.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-wb-node', node.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/x-wb-node') || e.dataTransfer.types.includes('application/x-wb-item')) {
                e.preventDefault()
                setDropOn(true)
              }
            }}
            onDragLeave={() => setDropOn(false)}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDropOn(false)
              const nodeId = e.dataTransfer.getData('application/x-wb-node')
              if (nodeId && nodeId !== node.id) {
                void useWorkbenchStore.getState().moveNode(nodeId, node.id)
                return
              }
              const itemId = e.dataTransfer.getData('application/x-wb-item')
              if (itemId) void setItemFolder(itemId, node.id)
            }}
            className={`group/folder ${dropOn ? 'bg-sky-600/20 rounded' : ''}`}
          >
            <div className="flex items-center gap-1 pr-2 py-1 text-xs hover:bg-zinc-800/50" style={{ paddingLeft: 6 + depth * 12 }}>
              <button
                onClick={() => toggleExpand(node.id)}
                className="text-zinc-600 hover:text-zinc-300 text-[9px] w-3 shrink-0"
              >
                {open ? '▼' : '▶'}
              </button>
              <span className="text-amber-500/80 text-[11px] shrink-0">📁</span>
              <NodeName node={node} />
              <span className="opacity-0 group-hover/folder:opacity-100 transition-opacity flex gap-0.5 shrink-0">
                <button
                  onClick={() => {
                    setCreating(false)
                    setCreating(true)
                  }}
                  title="新建子文件夹"
                  className="text-zinc-600 hover:text-zinc-200 text-[11px] px-0.5"
                >
                  ＋
                </button>
                <button
                  onClick={() => void removeNode(node.id)}
                  title="删除文件夹（条目移回根级）"
                  className="text-zinc-600 hover:text-red-400 text-[11px] px-0.5"
                >
                  ⨯
                </button>
              </span>
            </div>
            {open && (
              <div>
                {creating && (
                  <NewFolderInput
                    onCancel={() => setCreating(false)}
                    onOk={async (name) => {
                      await useWorkbenchStore.getState().createFolder('favorite', name, node.id)
                      setCreating(false)
                    }}
                  />
                )}
                <FavoriteTree parentId={node.id} depth={depth + 1} />
              </div>
            )}
          </div>
        )
      })}
      {childItems.map((it) => (
        <div
          key={it.id}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-wb-item', it.id)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onClick={() => openItem(it)}
          title={`${it.request.method} ${it.request.url}`}
          className="group/item flex items-center gap-1.5 pr-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800/50 cursor-pointer"
          style={{ paddingLeft: 12 + depth * 12 }}
        >
          <span className="font-mono text-[10px] text-sky-400 w-9 shrink-0">{it.request.method}</span>
          <span className="flex-1 truncate">{it.name}</span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              void call('collections.remove', { id: it.id }).then((r) => {
                useWorkbenchStore.setState({ items: r.items })
              })
            }}
            title="删除收藏"
            className="opacity-0 group-hover/item:opacity-100 text-zinc-600 hover:text-red-400 text-[11px] px-0.5 shrink-0"
          >
            ⨯
          </button>
        </div>
      ))}
      {folders.length === 0 && childItems.length === 0 && depth === 0 && (
        <div className="px-3 py-1.5 text-[11px] text-zinc-600">右键流量「加入 Collection」收藏请求</div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------
// 书签树
// ------------------------------------------------------------------

function BookmarkTree({
  parentId,
  depth,
  onApplyFilter
}: {
  parentId: string | null
  depth: number
  onApplyFilter: (filter: string) => void
}): React.JSX.Element {
  const nodes = useWorkbenchStore((s) => s.nodes)
  const expanded = useWorkbenchStore((s) => s.expanded)
  const toggleExpand = useWorkbenchStore((s) => s.toggleExpand)
  const removeNode = useWorkbenchStore((s) => s.removeNode)
  const moveNode = useWorkbenchStore((s) => s.moveNode)
  const [creating, setCreating] = useState(false)
  const [dropOn, setDropOn] = useState(false)
  const [bmCreating, setBmCreating] = useState(false)

  const children = useMemo(() => wbChildrenOf(nodes, 'bookmark', parentId), [nodes, parentId])

  return (
    <div>
      {children.map((node) => {
        if (node.kind === 'folder') {
          const open = !!expanded[node.id]
          return (
            <div
              key={node.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-wb-node', node.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('application/x-wb-node')) {
                  e.preventDefault()
                  setDropOn(true)
                }
              }}
              onDragLeave={() => setDropOn(false)}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setDropOn(false)
                const nodeId = e.dataTransfer.getData('application/x-wb-node')
                if (nodeId && nodeId !== node.id) void moveNode(nodeId, node.id)
              }}
              className={`group/folder ${dropOn ? 'bg-sky-600/20 rounded' : ''}`}
            >
              <div
                className="flex items-center gap-1 pr-2 py-1 text-xs hover:bg-zinc-800/50"
                style={{ paddingLeft: 6 + depth * 12 }}
              >
                <button
                  onClick={() => toggleExpand(node.id)}
                  className="text-zinc-600 hover:text-zinc-300 text-[9px] w-3 shrink-0"
                >
                  {open ? '▼' : '▶'}
                </button>
                <span className="text-amber-500/80 text-[11px] shrink-0">📁</span>
                <NodeName node={node} />
                <span className="opacity-0 group-hover/folder:opacity-100 transition-opacity flex gap-0.5 shrink-0">
                  <button
                    onClick={() => {
                      setBmCreating(false)
                      setBmCreating(true)
                    }}
                    title="新建书签"
                    className="text-zinc-600 hover:text-amber-300 text-[10px] px-0.5"
                  >
                    ☆
                  </button>
                  <button
                    onClick={() => setCreating(true)}
                    title="新建子文件夹"
                    className="text-zinc-600 hover:text-zinc-200 text-[11px] px-0.5"
                  >
                    ＋
                  </button>
                  <button
                    onClick={() => void removeNode(node.id)}
                    title="删除文件夹"
                    className="text-zinc-600 hover:text-red-400 text-[11px] px-0.5"
                  >
                    ⨯
                  </button>
                </span>
              </div>
              {open && (
                <div>
                  {bmCreating && (
                    <NewBookmarkInput
                      initialFilter=""
                      onCancel={() => setBmCreating(false)}
                      onOk={async (name, f) => {
                        await useWorkbenchStore.getState().createBookmark(name, f, node.id)
                        setBmCreating(false)
                      }}
                    />
                  )}
                  {creating && (
                    <NewFolderInput
                      onCancel={() => setCreating(false)}
                      onOk={async (name) => {
                        await useWorkbenchStore.getState().createFolder('bookmark', name, node.id)
                        setCreating(false)
                      }}
                    />
                  )}
                  <BookmarkTree parentId={node.id} depth={depth + 1} onApplyFilter={onApplyFilter} />
                </div>
              )}
            </div>
          )
        }
        return (
          <div
            key={node.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-wb-node', node.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onClick={() => onApplyFilter(node.filter ?? '')}
            title={`过滤条件：${node.filter ?? ''}`}
            className="group/bm flex items-center gap-1.5 pr-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800/50 cursor-pointer"
            style={{ paddingLeft: 12 + depth * 12 }}
          >
            <span className="text-amber-300 text-[10px] shrink-0">★</span>
            <NodeName node={node} />
            <button
              onClick={(e) => {
                e.stopPropagation()
                void removeNode(node.id)
              }}
              title="删除书签"
              className="opacity-0 group-hover/bm:opacity-100 text-zinc-600 hover:text-red-400 text-[11px] px-0.5 shrink-0"
            >
              ⨯
            </button>
          </div>
        )
      })}
      {children.length === 0 && depth === 0 && (
        <div className="px-3 py-1.5 text-[11px] text-zinc-600">☆ 把当前过滤条件存为书签</div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------
// 设备 / 应用 / 域名分组
// ------------------------------------------------------------------

function DeviceSection({
  flows,
  onApplyFilter
}: {
  flows: FlowSummary[]
  onApplyFilter: (filter: string) => void
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const [names, setNames] = useState<Record<string, string>>(loadDeviceNames)
  const [editingIp, setEditingIp] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const groups = useMemo(() => {
    const map = new Map<string, number>()
    for (const f of flows) {
      const ip = f.clientIp ?? '未知'
      map.set(ip, (map.get(ip) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  }, [flows])

  const rename = (ip: string): void => {
    const name = nameDraft.trim()
    const next = { ...names }
    if (name && name !== deviceLabelOf(ip)) next[ip] = name
    else delete next[ip]
    setNames(next)
    saveDeviceNames(next)
    setEditingIp(null)
  }

  return (
    <Section title="设备" icon={SECTION_ICONS.device} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)}>
      {groups.map(([ip, n]) =>
        editingIp === ip ? (
          <input
            key={ip}
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => rename(ip)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') rename(ip)
              else if (e.key === 'Escape') setEditingIp(null)
            }}
            placeholder={`命名 ${ip}`}
            className="w-[calc(100%-1rem)] mx-2 my-0.5 bg-zinc-800 border border-sky-700 rounded px-1 py-0.5 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
          />
        ) : (
          <button
            key={ip}
            onClick={() => onApplyFilter(`ip:"${ip}"`)}
            onDoubleClick={(e) => {
              e.stopPropagation()
              setNameDraft(names[ip] ?? '')
              setEditingIp(ip)
            }}
            title={`过滤来源 ${ip} · 双击命名设备`}
            className="w-full group/dev flex items-center gap-2 pl-3 pr-2 py-1.5 text-left text-xs text-zinc-400 hover:bg-zinc-800/50"
          >
            <span className="w-3.5 text-center text-[11px] leading-none text-violet-400/80 shrink-0" title="来源设备">🖥</span>
            <span className={`flex-1 truncate ${names[ip] ? '' : 'font-mono'}`}>
              {names[ip] ?? deviceLabelOf(ip)}
            </span>
            {names[ip] && (
              <span className="hidden group-hover/dev:inline text-[10px] text-zinc-600 font-mono truncate max-w-20" title={ip}>
                {ip}
              </span>
            )}
            <span className="text-zinc-600 tabular-nums">{n}</span>
          </button>
        )
      )}
      {groups.length === 0 && <div className="px-3 py-1.5 text-[11px] text-zinc-600">暂无流量</div>}
    </Section>
  )
}

function AppSection({
  flows,
  selectedApp,
  onSelectApp,
  item
}: {
  flows: FlowSummary[]
  selectedApp: string | null
  onSelectApp: (app: string | null) => void
  item: (active: boolean) => string
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const groups = useMemo(() => {
    const map = new Map<string, number>()
    for (const f of flows) {
      const key = appGroupOf(f)
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }, [flows])

  return (
    <Section title="应用程序" icon={SECTION_ICONS.app} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)}>
      <button onClick={() => onSelectApp(null)} className={item(selectedApp === null)} title="显示全部流量">
        <span className="w-3.5 text-center text-[11px] leading-none text-sky-400/90 shrink-0">◈</span>
        <span className="flex-1 truncate">全部流量</span>
        <span className="text-zinc-600 tabular-nums">{flows.length}</span>
      </button>
      {groups.map(([name, n]) => (
        <button
          key={name}
          onClick={() => onSelectApp(selectedApp === name ? null : name)}
          className={item(selectedApp === name)}
          title={name}
        >
          <span className="w-3.5 text-center text-[11px] leading-none text-emerald-500/90 shrink-0" title="应用">▣</span>
          <span className="flex-1 truncate">{name}</span>
          <span className="text-zinc-600 tabular-nums">{n}</span>
        </button>
      ))}
    </Section>
  )
}

function DomainSection({
  flows,
  onApplyFilter
}: {
  flows: FlowSummary[]
  onApplyFilter: (filter: string) => void
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(true)
  const groups = useMemo(() => {
    const map = new Map<string, number>()
    for (const f of flows) {
      if (!f.host) continue
      map.set(f.host, (map.get(f.host) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
  }, [flows])

  return (
    <Section title="域名" icon={SECTION_ICONS.domain} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)}>
      {groups.map(([host, n]) => (
        <button
          key={host}
          onClick={() => onApplyFilter(`host:${host}`)}
          title={`过滤 ${host}`}
          className="w-full flex items-center gap-2 pl-3 pr-2 py-1.5 text-left text-xs text-zinc-400 hover:bg-zinc-800/50"
        >
          <span className="w-3.5 text-center text-[11px] leading-none text-zinc-500 shrink-0" title="域名">🌐</span>
          <span className="flex-1 truncate font-mono">{host}</span>
          <span className="text-zinc-600 tabular-nums">{n}</span>
        </button>
      ))}
      {groups.length === 0 && <div className="px-3 py-1.5 text-[11px] text-zinc-600">暂无流量</div>}
    </Section>
  )
}

// ------------------------------------------------------------------
// 小组件
// ------------------------------------------------------------------

/** 节点名显示 + 双击重命名 */
function NodeName({ node }: { node: WbNode }): React.JSX.Element {
  const renameNode = useWorkbenchStore((s) => s.renameNode)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.name)
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const name = draft.trim()
            if (name && name !== node.name) void renameNode(node.id, name)
            setEditing(false)
          } else if (e.key === 'Escape') {
            setDraft(node.name)
            setEditing(false)
          }
        }}
        className="flex-1 min-w-0 bg-zinc-800 border border-sky-700 rounded px-1 text-[11px] text-zinc-200 focus:outline-none"
      />
    )
  }
  return (
    <span
      className="flex-1 truncate select-none"
      onDoubleClick={(e) => {
        e.stopPropagation()
        setDraft(node.name)
        setEditing(true)
      }}
      title="双击重命名"
    >
      {node.name}
    </span>
  )
}

function NewFolderInput({
  onOk,
  onCancel
}: {
  onOk: (name: string) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  return (
    <div className="flex items-center gap-1 px-2 py-1">
      <span className="text-[11px] shrink-0">📁</span>
      <input
        autoFocus
        value={name}
        placeholder="文件夹名称"
        onChange={(e) => setName(e.target.value)}
        onBlur={() => (name.trim() ? void onOk(name) : onCancel())}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) void onOk(name)
          else if (e.key === 'Escape') onCancel()
        }}
        className="flex-1 min-w-0 bg-zinc-800 border border-sky-700 rounded px-1 py-0.5 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
      />
    </div>
  )
}

function NewBookmarkInput({
  initialFilter,
  onOk,
  onCancel
}: {
  initialFilter: string
  onOk: (name: string, filter: string) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [filter, setFilter] = useState(initialFilter)
  const submit = (): void => {
    if (name.trim() && filter.trim()) void onOk(name, filter)
  }
  return (
    <div className="mx-2 my-1 p-2 rounded border border-zinc-700 bg-zinc-900 space-y-1.5">
      <input
        autoFocus
        value={name}
        placeholder="书签名称"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          else if (e.key === 'Escape') onCancel()
        }}
        className="w-full bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-sky-700"
      />
      <input
        value={filter}
        placeholder="过滤条件（host: / path: / app: …）"
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          else if (e.key === 'Escape') onCancel()
        }}
        className="w-full bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-sky-700 font-mono"
      />
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="text-[10px] text-zinc-500 hover:text-zinc-300 px-1">
          取消
        </button>
        <button
          onClick={submit}
          className="text-[10px] text-sky-400 hover:text-sky-300 px-1"
        >
          保存
        </button>
      </div>
    </div>
  )
}

/** 树底部的空白区：拖拽到此 = 移到根级 */
function AddToRootDropZone({ scope }: { scope: 'favorite' | 'bookmark' }): React.JSX.Element {
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-wb-node') || e.dataTransfer.types.includes('application/x-wb-item')) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const nodeId = e.dataTransfer.getData('application/x-wb-node')
        if (nodeId) {
          void useWorkbenchStore.getState().moveNode(nodeId, null)
          return
        }
        const itemId = e.dataTransfer.getData('application/x-wb-item')
        if (itemId && scope === 'favorite') void useWorkbenchStore.getState().setItemFolder(itemId, null)
      }}
      className={`h-5 mx-1 rounded ${over ? 'bg-sky-600/20 border border-dashed border-sky-700' : ''}`}
      title="拖到此处移到根级"
    />
  )
}
