import { useEffect, useMemo, useState } from 'react'
import type { CollectionItem } from '@proxy/shared'
import { call } from '../../api/client'
import { base64ToUtf8, collectionToSpec, useComposerStore } from '../../stores/composer'
import { DiffModal, type DiffPayload } from '../../components/FlowDiff'

export default function CollectionsPage() {
  const [items, setItems] = useState<CollectionItem[] | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [diff, setDiff] = useState<[CollectionItem, CollectionItem] | null>(null)
  const [msg, setMsg] = useState('')
  const [importing, setImporting] = useState(false)
  const loadFromCollection = useComposerStore((s) => s.loadFromCollection)

  const refresh = () => {
    call('collections.list')
      .then((r) => setItems(r.items))
      .catch(() => setItems([]))
  }

  useEffect(refresh, [])

  const importFrom = async (
    channel: 'collections.importPostman' | 'collections.importOpenApi' | 'collections.importHoppscotch'
  ) => {
    setImporting(true)
    try {
      const r = await call(channel)
      if (!r.canceled) {
        if (r.error) setMsg(`导入失败：${r.error}`)
        else setMsg(`已导入 ${r.imported ?? 0} 个请求 / ${r.folders ?? 0} 个文件夹`)
        setTimeout(() => setMsg(''), 3000)
        refresh()
      }
    } catch {
      setMsg('导入失败')
      setTimeout(() => setMsg(''), 2500)
    } finally {
      setImporting(false)
    }
  }

  const toggle = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= 2 ? [prev[1], id] : [...prev, id]
    )
  }

  const remove = async (id: string) => {
    const r = await call('collections.remove', { id })
    setItems(r.items)
    setSelected((prev) => prev.filter((x) => x !== id))
  }

  const resend = async (item: CollectionItem) => {
    const r = await call('composer.send', { spec: collectionToSpec(item) })
    setMsg(`已重发，flow ${r.flowId.slice(0, 8)}…（在流量列表查看）`)
    setTimeout(() => setMsg(''), 2500)
  }

  const diffPair = useMemo(() => {
    if (selected.length !== 2 || !items) return null
    const a = items.find((i) => i.id === selected[0])
    const b = items.find((i) => i.id === selected[1])
    return a && b ? ([a, b] as const) : null
  }, [selected, items])

  if (!items) {
    return <div className="h-full flex items-center justify-center text-zinc-600">加载中…</div>
  }

  const groups = new Map<string, CollectionItem[]>()
  for (const it of items) {
    const g = it.group || ''
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(it)
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-base font-medium text-zinc-200">收藏夹</h1>
        <span className="text-xs text-zinc-500">{items.length} 条 · 勾选两条可对比</span>
        <span className="flex-1" />
        <button
          onClick={() => void importFrom('collections.importPostman')}
          disabled={importing}
          className="px-3 py-1 rounded text-sm text-zinc-400 hover:text-sky-400 hover:bg-zinc-800 disabled:opacity-50"
          title="导入 Postman Collection v2.0/v2.1（文件夹映射为收藏文件夹树）"
        >
          {importing ? '导入中…' : '导入 Postman…'}
        </button>
        <button
          onClick={() => void importFrom('collections.importOpenApi')}
          disabled={importing}
          className="px-3 py-1 rounded text-sm text-zinc-400 hover:text-sky-400 hover:bg-zinc-800 disabled:opacity-50"
          title="导入 OpenAPI 3.0 / Swagger 2.0（ApiFox、ApiPost 等导出的 JSON；tags 映射为文件夹）"
        >
          导入 OpenAPI…
        </button>
        <button
          onClick={() => void importFrom('collections.importHoppscotch')}
          disabled={importing}
          className="px-3 py-1 rounded text-sm text-zinc-400 hover:text-sky-400 hover:bg-zinc-800 disabled:opacity-50"
          title="导入 Hoppscotch collection 导出 JSON（folders 映射为收藏文件夹树）"
        >
          导入 Hoppscotch…
        </button>
        {diffPair && (
          <button
            onClick={() => setDiff([diffPair[0], diffPair[1]])}
            className="px-3 py-1 rounded text-sm bg-sky-600/20 text-sky-400 hover:bg-sky-600/30"
          >
            对比（{selected.length}/2）
          </button>
        )}
      </div>

      {items.length === 0 && (
        <div className="text-zinc-600 text-sm py-10 text-center">
          暂无收藏。在流量详情面板点「收藏 ☆」把请求快照保存到这里（retention 清理流量后快照仍在）。
        </div>
      )}

      {[...groups.entries()].map(([group, list]) => (
        <div key={group} className="mb-4">
          {group && <div className="text-xs text-zinc-500 mb-1">{group}</div>}
          <div className="rounded-lg border border-zinc-800 divide-y divide-zinc-800/60">
            {list.map((item) => (
              <div key={item.id} className="flex items-center gap-3 px-3 py-2 hover:bg-zinc-900/60">
                <input
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  onChange={() => toggle(item.id)}
                  className="accent-sky-600"
                />
                <span className="font-mono text-xs text-sky-400 w-14 shrink-0">{item.request.method}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] text-zinc-200 truncate">{item.name}</span>
                  <span className="block text-xs text-zinc-500 truncate font-mono">{item.request.url}</span>
                </span>
                {item.response && (
                  <span
                    className={`text-xs font-mono shrink-0 ${
                      item.response.status < 400 ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    {item.response.status}
                  </span>
                )}
                <span className="text-xs text-zinc-600 shrink-0 w-32 text-right">
                  {new Date(item.createdAt).toLocaleString()}
                </span>
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => loadFromCollection(item)}
                    className="px-2 py-0.5 rounded text-xs text-zinc-400 hover:text-zinc-200"
                    title="在 Composer 中打开"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => void resend(item)}
                    className="px-2 py-0.5 rounded text-xs text-zinc-400 hover:text-zinc-200"
                    title="直接重发该请求"
                  >
                    重发
                  </button>
                  <button
                    onClick={() => void remove(item.id)}
                    className="px-2 py-0.5 rounded text-xs text-zinc-500 hover:text-red-400"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {msg && (
        <div className="fixed bottom-4 right-4 px-3 py-2 rounded bg-zinc-800 text-sm text-zinc-200 shadow-lg">
          {msg}
        </div>
      )}

      {diff && <CollectionDiffModal a={diff[0]} b={diff[1]} onClose={() => setDiff(null)} />}
    </div>
  )
}

// ------------------------------------------------------------------
// Diff
// ------------------------------------------------------------------

function CollectionDiffModal({ a, b, onClose }: { a: CollectionItem; b: CollectionItem; onClose: () => void }) {
  const reqPayload: DiffPayload = {
    lines: [
      { label: 'Method', l: a.request.method, r: b.request.method },
      { label: 'URL', l: a.request.url, r: b.request.url }
    ],
    lHeaders: a.request.headers,
    rHeaders: b.request.headers,
    lBody: base64ToUtf8(a.request.bodyBase64),
    rBody: base64ToUtf8(b.request.bodyBase64),
    lTitle: a.name,
    rTitle: b.name
  }
  const respPayload: DiffPayload | null =
    a.response && b.response
      ? {
          lines: [
            {
              label: 'Status',
              l: `${a.response.status} ${a.response.statusText}`.trim(),
              r: `${b.response.status} ${b.response.statusText}`.trim()
            }
          ],
          lHeaders: a.response.headers,
          rHeaders: b.response.headers,
          lBody: base64ToUtf8(a.response.bodyBase64),
          rBody: base64ToUtf8(b.response.bodyBase64),
          lTitle: `Status ${a.response.status}`,
          rTitle: `Status ${b.response.status}`
        }
      : null
  return (
    <DiffModal
      title="流量对比"
      tabs={[
        { id: 'request', label: '请求', payload: reqPayload },
        { id: 'response', label: '响应', payload: respPayload }
      ]}
      onClose={onClose}
    />
  )
}

