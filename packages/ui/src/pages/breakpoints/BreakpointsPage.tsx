import { useEffect, useState } from 'react'
import type { BreakpointHit, BreakpointRule } from '@proxy/shared'
import { useBreakpointsStore } from '../../stores/breakpoints'
import { base64ToUtf8 } from '../../stores/composer'

export default function BreakpointsPage() {
  const hits = useBreakpointsStore((s) => s.hits)
  const rules = useBreakpointsStore((s) => s.rules)
  const load = useBreakpointsStore((s) => s.load)
  const [editing, setEditing] = useState<BreakpointHit | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="h-full overflow-auto p-4 space-y-6">
      <section>
        <h2 className="text-sm font-medium text-zinc-300 mb-2">
          等待中的断点{' '}
          {hits.length > 0 && (
            <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 text-xs">
              {hits.length}
            </span>
          )}
        </h2>
        {hits.length === 0 ? (
          <div className="text-sm text-zinc-600 py-6 text-center border border-dashed border-zinc-800 rounded">
            暂无挂起请求。命中断点规则的流量会在此等待，直到放行或中止。
          </div>
        ) : (
          <div className="space-y-1">
            {hits.map((hit) => (
              <button
                key={hit.flowId}
                onClick={() => setEditing(hit)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded bg-zinc-900 border border-zinc-800 hover:border-sky-700 text-left font-mono text-[13px]"
              >
                <span
                  className={`px-1.5 py-0.5 rounded text-[11px] ${
                    hit.phase === 'request' ? 'bg-sky-600/20 text-sky-400' : 'bg-violet-600/20 text-violet-400'
                  }`}
                >
                  {hit.phase === 'request' ? '请求' : '响应'}
                </span>
                <span className="text-zinc-500">{hit.method}</span>
                <span className="flex-1 truncate text-zinc-300">{hit.url}</span>
                {hit.status !== undefined && (
                  <span className="text-zinc-500">{hit.status}</span>
                )}
                <span className="text-xs text-amber-500">点击编辑 →</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium text-zinc-300 mb-2">断点规则</h2>
        <RulesEditor rules={rules} />
      </section>

      {editing && <HitDialog hit={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function RulesEditor({ rules }: { rules: BreakpointRule[] }) {
  const setRules = useBreakpointsStore((s) => s.setRules)

  const update = (patched: BreakpointRule[]) => void setRules(patched)
  const patchRule = (id: string, patch: Partial<BreakpointRule>) =>
    update(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const addRule = () =>
    update([
      ...rules,
      { id: crypto.randomUUID(), enabled: true, host: '', path: '', method: '', phase: 'both' }
    ])

  return (
    <div className="space-y-2">
      {rules.length === 0 && (
        <div className="text-xs text-zinc-600">无规则。添加 host/path 匹配规则来触发断点。</div>
      )}
      {rules.map((rule) => (
        <div key={rule.id} className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={(e) => patchRule(rule.id, { enabled: e.target.checked })}
            className="accent-sky-600"
          />
          <input
            value={rule.host}
            onChange={(e) => patchRule(rule.id, { host: e.target.value })}
            placeholder="host 如 *example.com"
            className="w-44 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-sky-700"
          />
          <input
            value={rule.path}
            onChange={(e) => patchRule(rule.id, { path: e.target.value })}
            placeholder="路径子串，空=任意"
            className="w-40 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-sky-700"
          />
          <select
            value={rule.method}
            onChange={(e) => patchRule(rule.id, { method: e.target.value })}
            className="w-24 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-zinc-200 focus:outline-none focus:border-sky-700"
          >
            <option value="">任意</option>
            {['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <select
            value={rule.phase}
            onChange={(e) => patchRule(rule.id, { phase: e.target.value as BreakpointRule['phase'] })}
            className="w-24 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-zinc-200 focus:outline-none focus:border-sky-700"
          >
            <option value="both">双向</option>
            <option value="request">请求</option>
            <option value="response">响应</option>
          </select>
          <button
            onClick={() => update(rules.filter((r) => r.id !== rule.id))}
            className="px-2 py-1 text-zinc-500 hover:text-red-400"
          >
            删除
          </button>
        </div>
      ))}
      <button
        onClick={addRule}
        className="px-3 py-1 rounded text-sm bg-sky-600/20 text-sky-400 hover:bg-sky-600/30"
      >
        + 添加规则
      </button>
    </div>
  )
}

function HitDialog({ hit, onClose }: { hit: BreakpointHit; onClose: () => void }) {
  const resolve = useBreakpointsStore((s) => s.resolve)
  const isReq = hit.phase === 'request'

  const [method, setMethod] = useState(hit.request?.method ?? 'GET')
  const [url, setUrl] = useState(hit.request?.url ?? '')
  const [status, setStatus] = useState(String(hit.response?.status ?? 200))
  const [statusText, setStatusText] = useState(hit.response?.statusText ?? '')
  const [headersText, setHeadersText] = useState(
    (isReq ? hit.request?.headers : hit.response?.headers)
      ?.map((h) => `${h.name}: ${h.value}`)
      .join('\n') ?? ''
  )
  const [bodyText, setBodyText] = useState(
    base64ToUtf8((isReq ? hit.request?.bodyBase64 : hit.response?.bodyBase64) ?? '')
  )
  const [busy, setBusy] = useState(false)

  const parseHeaders = () =>
    headersText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const idx = l.indexOf(':')
        return idx > 0 ? { name: l.slice(0, idx).trim(), value: l.slice(idx + 1).trim() } : null
      })
      .filter((h): h is { name: string; value: string } => h !== null)

  const act = async (action: 'continue' | 'abort') => {
    if (busy) return
    setBusy(true)
    try {
      const edit =
        action === 'abort'
          ? { action }
          : isReq
            ? {
                action,
                request: {
                  method,
                  url,
                  headers: parseHeaders(),
                  bodyBase64: utf8Body(bodyText)
                }
              }
            : {
                action,
                response: {
                  status: Number(status) || 200,
                  statusText,
                  headers: parseHeaders(),
                  bodyBase64: utf8Body(bodyText)
                }
              }
      await resolve(hit.flowId, hit.phase, edit)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-6">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800">
          <span
            className={`px-2 py-0.5 rounded text-xs ${
              isReq ? 'bg-sky-600/20 text-sky-400' : 'bg-violet-600/20 text-violet-400'
            }`}
          >
            {isReq ? '请求断点' : '响应断点'} #{hit.seq}
          </span>
          <span className="flex-1 truncate font-mono text-sm text-zinc-300">{hit.url}</span>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-3">
          {isReq ? (
            <div className="flex gap-2">
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="w-28 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200"
              >
                {['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 font-mono focus:outline-none focus:border-sky-700"
              />
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="w-20 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 font-mono"
                placeholder="状态码"
              />
              <input
                value={statusText}
                onChange={(e) => setStatusText(e.target.value)}
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200"
                placeholder="状态文本"
              />
            </div>
          )}

          <div>
            <div className="text-xs text-zinc-500 mb-1">Headers（每行 Name: Value）</div>
            <textarea
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              rows={8}
              className="w-full bg-zinc-800 border border-zinc-700 rounded p-2 text-xs font-mono text-zinc-200 resize-y focus:outline-none focus:border-sky-700"
            />
          </div>

          <div>
            <div className="text-xs text-zinc-500 mb-1">Body</div>
            <textarea
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              rows={10}
              className="w-full bg-zinc-800 border border-zinc-700 rounded p-2 text-xs font-mono text-zinc-200 resize-y focus:outline-none focus:border-sky-700"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-800">
          <button
            onClick={() => act('abort')}
            disabled={busy}
            className="px-4 py-1.5 rounded text-sm text-red-400 bg-red-600/10 hover:bg-red-600/20 disabled:opacity-50"
          >
            中止请求
          </button>
          <button
            onClick={() => act('continue')}
            disabled={busy}
            className="px-4 py-1.5 rounded text-sm text-emerald-400 bg-emerald-600/10 hover:bg-emerald-600/20 disabled:opacity-50"
          >
            {busy ? '处理中…' : '放行（含修改）'}
          </button>
        </div>
      </div>
    </div>
  )
}

function utf8Body(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
