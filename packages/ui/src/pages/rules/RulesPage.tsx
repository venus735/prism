import { useEffect, useState } from 'react'
import type { BodyReplace, HeaderRuleOp, Rule, RuleAction } from '@proxy/shared'
import { useRulesStore } from '../../stores/rules'
import { call } from '../../api/client'

const ACTION_LABELS: Record<RuleAction['type'], string> = {
  mock: 'Mock 响应',
  'map-local': '本地映射',
  block: '断开连接',
  hold: '挂起请求',
  'rewrite-request': '重写请求',
  'rewrite-response': '重写响应',
  throttle: '弱网/限速',
  'bypass-tls': 'SSL 透传'
}

const NET_PRESETS: Array<{ name: string; kbps: number; latencyMs: number; lossPercent: number }> = [
  { name: '弱网', kbps: 16, latencyMs: 800, lossPercent: 10 },
  { name: '2G', kbps: 30, latencyMs: 500, lossPercent: 1 },
  { name: '3G', kbps: 128, latencyMs: 200, lossPercent: 0 },
  { name: '4G', kbps: 1024, latencyMs: 60, lossPercent: 0 },
  { name: '断网', kbps: 1024, latencyMs: 0, lossPercent: 100 }
]

export default function RulesPage() {
  const rules = useRulesStore((s) => s.rules)
  const matchCounts = useRulesStore((s) => s.matchCounts)
  const setRules = useRulesStore((s) => s.setRules)
  const load = useRulesStore((s) => s.load)
  const [editingId, setEditingId] = useState<string | null>(null)

  useEffect(() => {
    void load()
    // 命中数随抓包增长，30s 轮询刷新（页面隐藏时浏览器会自动节流）
    const t = setInterval(() => void load(), 30_000)
    return () => clearInterval(t)
  }, [load])

  const update = (patched: Rule[]) => void setRules(patched)

  const addRule = () => {
    const rule: Rule = {
      id: crypto.randomUUID(),
      name: '新规则',
      enabled: true,
      match: { host: '', path: '', method: '' },
      action: { type: 'mock', status: 200, headers: [], bodyBase64: '' }
    }
    update([rule, ...rules])
    setEditingId(rule.id)
  }

  const exportRules = () => {
    const blob = new Blob([JSON.stringify(rules, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'proxy-rules.json'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-zinc-300 flex-1">
          规则（按顺序匹配，首条命中生效）
        </h2>
        <label className="px-3 py-1 rounded text-sm text-zinc-300 bg-zinc-800 hover:bg-zinc-700 cursor-pointer">
          导入
          <input
            type="file"
            accept=".json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (!file) return
              file
                .text()
                .then((t) => JSON.parse(t))
                .then((imported) => {
                  if (Array.isArray(imported)) update(imported)
                })
                .catch(() => {})
              e.target.value = ''
            }}
          />
        </label>
        <button
          onClick={exportRules}
          className="px-3 py-1 rounded text-sm text-zinc-300 bg-zinc-800 hover:bg-zinc-700"
        >
          导出
        </button>
        <button
          onClick={addRule}
          className="px-3 py-1 rounded text-sm bg-sky-600/20 text-sky-400 hover:bg-sky-600/30"
        >
          + 新规则
        </button>
      </div>

      {rules.length === 0 && (
        <div className="text-sm text-zinc-600 py-10 text-center border border-dashed border-zinc-800 rounded">
          暂无规则。规则可 Mock 响应、本地映射文件、重写请求/响应（含搜索替换）、断开、挂起、弱网模拟、SSL 透传。
        </div>
      )}

      <div className="space-y-2">
        {rules.map((rule, i) => (
          <div key={rule.id} className="rounded-lg bg-zinc-900 border border-zinc-800 overflow-hidden">
            <div className="flex items-center gap-3 px-3 py-2">
              <span className="text-xs text-zinc-600 w-6">{i + 1}</span>
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) =>
                  update(rules.map((r) => (r.id === rule.id ? { ...r, enabled: e.target.checked } : r)))
                }
                className="accent-sky-600"
              />
              <input
                value={rule.name}
                onChange={(e) =>
                  update(rules.map((r) => (r.id === rule.id ? { ...r, name: e.target.value } : r)))
                }
                className="w-40 bg-transparent border-b border-transparent hover:border-zinc-700 focus:border-sky-700 px-1 py-0.5 text-sm text-zinc-200 focus:outline-none"
              />
              <span className="px-2 py-0.5 rounded bg-violet-600/20 text-violet-400 text-xs">
                {ACTION_LABELS[rule.action.type]}
              </span>
              {(matchCounts[rule.id] ?? 0) > 0 && (
                <span
                  className="px-1.5 py-0.5 rounded bg-emerald-600/15 text-emerald-400 text-[10px] shrink-0"
                  title="该规则自保存起累计命中的请求数（含所有动作类型）"
                >
                  命中 {matchCounts[rule.id]}
                </span>
              )}
              <span className="flex-1 truncate font-mono text-xs text-zinc-500">
                {rule.match.host || '*'}{rule.match.path ? ` · ${rule.match.path}` : ''}
                {rule.match.method ? ` · ${rule.match.method}` : ''}
              </span>
              <button
                onClick={() => setEditingId(editingId === rule.id ? null : rule.id)}
                className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
              >
                {editingId === rule.id ? '收起' : '编辑'}
              </button>
              <button
                onClick={() => update(rules.filter((r) => r.id !== rule.id))}
                className="px-2 py-1 text-xs text-zinc-500 hover:text-red-400"
              >
                删除
              </button>
            </div>
            {editingId === rule.id && (
              <RuleEditor
                rule={rule}
                onChange={(patch) => update(rules.map((r) => (r.id === rule.id ? { ...r, ...patch } : r)))}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

const inputCls =
  'bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-sky-700'

function RuleEditor({
  rule,
  onChange
}: {
  rule: Rule
  onChange: (patch: Partial<Rule>) => void
}) {
  const a = rule.action
  const setAction = (action: RuleAction) => onChange({ action })
  const matchPreview = useRulesStore((s) => s.matchPreview)
  const [preview, setPreview] = useState<{ n: number | null; timer: number }>({ n: null, timer: 0 })

  // 匹配条件变化时防抖预览「最近 1000 条流量中有多少命中」
  useEffect(() => {
    window.clearTimeout(preview.timer)
    const t = window.setTimeout(() => {
      void matchPreview(rule).then((n) => setPreview((p) => ({ ...p, n })))
    }, 400)
    setPreview((p) => ({ ...p, timer: t }))
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rule.match.host, rule.match.path, rule.match.method, rule.match.urlRegex, rule.enabled, matchPreview])

  const previewView =
    preview.n === null ? null : preview.n < 0 ? (
      <span className="text-[10px] text-zinc-600">预览不可用</span>
    ) : (
      <span
        className={`text-[10px] ${preview.n > 0 ? 'text-emerald-400' : 'text-zinc-500'}`}
        title="该匹配条件在最近 1000 条流量中的命中数"
      >
        最近流量命中 {preview.n} 条
      </span>
    )

  return (
    <div className="px-3 pb-3 pt-1 border-t border-zinc-800 space-y-3">
      <div className="flex gap-2 items-center">
        <span className="text-xs text-zinc-500 w-16">匹配</span>
        <input
          value={rule.match.host}
          onChange={(e) => onChange({ match: { ...rule.match, host: e.target.value } })}
          placeholder="host 如 *example.com"
          className={`${inputCls} w-44`}
        />
        <input
          value={rule.match.path}
          onChange={(e) => onChange({ match: { ...rule.match, path: e.target.value } })}
          placeholder="路径子串"
          className={`${inputCls} w-36`}
        />
        <select
          value={rule.match.method}
          onChange={(e) => onChange({ match: { ...rule.match, method: e.target.value } })}
          className={`${inputCls} w-24`}
        >
          <option value="">任意方法</option>
          {['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <input
          value={rule.match.urlRegex ?? ''}
          onChange={(e) =>
            onChange({ match: { ...rule.match, urlRegex: e.target.value || undefined } })
          }
          placeholder="URL 正则（可选）"
          className={`${inputCls} flex-1 font-mono`}
        />
        {previewView}
      </div>

      <div className="flex gap-2 items-center">
        <span className="text-xs text-zinc-500 w-16">动作</span>
        <select
          value={a.type}
          onChange={(e) => {
            const type = e.target.value as RuleAction['type']
            setAction(defaultAction(type))
          }}
          className={`${inputCls} w-36`}
        >
          {Object.entries(ACTION_LABELS).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {a.type === 'mock' && (
        <div className="space-y-2 pl-[4.5rem]">
          <div className="flex gap-2">
            <input
              type="number"
              value={a.status}
              onChange={(e) => setAction({ ...a, status: Number(e.target.value) || 200 })}
              className={`${inputCls} w-24`}
              placeholder="状态码"
            />
          </div>
          <HeadersEditor
            headers={a.headers}
            onChange={(headers) => setAction({ ...a, headers })}
          />
          <BodyEditor bodyBase64={a.bodyBase64} onChange={(bodyBase64) => setAction({ ...a, bodyBase64 })} />
        </div>
      )}

      {a.type === 'map-local' && (
        <div className="space-y-1 pl-[4.5rem]">
          <div className="flex gap-2 items-center">
            <input
              value={a.path}
              onChange={(e) => setAction({ ...a, path: e.target.value })}
              placeholder="/Users/you/mock-data/api.json（本地文件绝对路径）"
              className={`${inputCls} flex-1 font-mono`}
            />
            <button
              onClick={() => {
                void call('app.pickFile').then((r) => {
                  if (!r.canceled && r.filePath) setAction({ ...a, path: r.filePath })
                })
              }}
              className="px-2 py-1 rounded text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 shrink-0"
            >
              浏览…
            </button>
          </div>
          <div className="text-[10px] text-zinc-600">
            命中的请求不再转发上游，直接返回该文件内容；Content-Type 按扩展名推断（json/html/js/png…）。文件不存在时返回 502。
          </div>
        </div>
      )}

      {(a.type === 'rewrite-request' || a.type === 'rewrite-response') && (
        <div className="space-y-2 pl-[4.5rem]">
          {a.type === 'rewrite-request' ? (
            <input
              value={a.urlReplace ?? ''}
              onChange={(e) => setAction({ ...a, urlReplace: e.target.value || undefined })}
              placeholder="重定向到 URL（完整替换，可选）"
              className={`${inputCls} w-full font-mono`}
            />
          ) : (
            <input
              type="number"
              value={a.status ?? ''}
              onChange={(e) => setAction({ ...a, status: e.target.value ? Number(e.target.value) : undefined })}
              placeholder="状态码（可选）"
              className={`${inputCls} w-24`}
            />
          )}
          <HeaderOpsEditor ops={a.headerOps} onChange={(headerOps) => setAction({ ...a, headerOps })} />
          <BodyEditor
            bodyBase64={a.bodyBase64 ?? ''}
            onChange={(bodyBase64) => setAction({ ...a, bodyBase64 })}
          />
          <ReplacesEditor
            replaces={a.replaces ?? []}
            onChange={(replaces) => setAction({ ...a, replaces })}
          />
        </div>
      )}

      {a.type === 'throttle' && (
        <div className="space-y-2 pl-[4.5rem]">
          <div className="flex gap-1.5 items-center flex-wrap">
            <span className="text-xs text-zinc-500">预设：</span>
            {NET_PRESETS.map((p) => (
              <button
                key={p.name}
                onClick={() =>
                  setAction({ type: 'throttle', kbps: p.kbps, latencyMs: p.latencyMs, lossPercent: p.lossPercent })
                }
                className={`px-2 py-0.5 rounded text-xs border ${
                  a.kbps === p.kbps && (a.latencyMs ?? 0) === p.latencyMs && (a.lossPercent ?? 0) === p.lossPercent
                    ? 'border-sky-600 text-sky-400 bg-sky-600/10'
                    : 'border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500'
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <input
              type="number"
              min={1}
              value={a.kbps}
              onChange={(e) => setAction({ ...a, kbps: Math.max(1, Number(e.target.value) || 1) })}
              className={`${inputCls} w-24`}
            />
            <span className="text-xs text-zinc-500">KB/s 带宽（响应方向）</span>
            <input
              type="number"
              min={0}
              step={50}
              value={a.latencyMs ?? 0}
              onChange={(e) => setAction({ ...a, latencyMs: Math.max(0, Number(e.target.value) || 0) })}
              className={`${inputCls} w-24`}
            />
            <span className="text-xs text-zinc-500">ms 延迟（转发前）</span>
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={a.lossPercent ?? 0}
              onChange={(e) => setAction({ ...a, lossPercent: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })}
              className={`${inputCls} w-20`}
            />
            <span className="text-xs text-zinc-500">% 丢包（随机断流）</span>
          </div>
          <div className="text-[10px] text-zinc-600">
            匹配的请求转发前延迟 latencyMs；按 lossPercent 概率随机失败（flow 标记 loss）；响应按 kbps 限速写回。0 表示不启用该项。
          </div>
        </div>
      )}

      {(a.type === 'block' || a.type === 'hold' || a.type === 'bypass-tls') && (
        <div className="text-xs text-zinc-600 pl-[4.5rem]">
          {a.type === 'block' && '命中后立即断开客户端连接。'}
          {a.type === 'hold' && '命中后不响应，请求挂起直到客户端断开。'}
          {a.type === 'bypass-tls' && '命中后 CONNECT 隧道直接透传（不解密，适用于证书固定等场景）。'}
        </div>
      )}
    </div>
  )
}

function defaultAction(type: RuleAction['type']): RuleAction {
  switch (type) {
    case 'mock':
      return { type, status: 200, headers: [], bodyBase64: '' }
    case 'map-local':
      return { type, path: '' }
    case 'block':
    case 'hold':
    case 'bypass-tls':
      return { type }
    case 'rewrite-request':
      return { type, headerOps: [] }
    case 'rewrite-response':
      return { type, headerOps: [] }
    case 'throttle':
      return { type, kbps: 64 }
  }
}

function HeadersEditor({
  headers,
  onChange
}: {
  headers: Array<{ name: string; value: string }>
  onChange: (headers: Array<{ name: string; value: string }>) => void
}) {
  const text = headers.map((h) => `${h.name}: ${h.value}`).join('\n')
  return (
    <div>
      <div className="text-xs text-zinc-500 mb-1">响应 Headers（每行 Name: Value）</div>
      <textarea
        value={text}
        onChange={(e) =>
          onChange(
            e.target.value
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .map((l) => {
                const idx = l.indexOf(':')
                return idx > 0
                  ? { name: l.slice(0, idx).trim(), value: l.slice(idx + 1).trim() }
                  : { name: l, value: '' }
              })
          )
        }
        rows={3}
        className="w-full bg-zinc-800 border border-zinc-700 rounded p-2 text-xs font-mono text-zinc-200 resize-y focus:outline-none focus:border-sky-700"
        placeholder={'Content-Type: application/json'}
      />
    </div>
  )
}

function HeaderOpsEditor({
  ops,
  onChange
}: {
  ops: HeaderRuleOp[]
  onChange: (ops: HeaderRuleOp[]) => void
}) {
  const text = ops
    .map((op) => (op.op === 'set' ? `set ${op.name}: ${op.value ?? ''}` : `remove ${op.name}`))
    .join('\n')
  return (
    <div>
      <div className="text-xs text-zinc-500 mb-1">
        Header 操作（每行：`set Name: Value` 或 `remove Name`）
      </div>
      <textarea
        value={text}
        onChange={(e) =>
          onChange(
            e.target.value
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .map((l) => {
                const setMatch = /^set\s+(.+?)\s*:\s*(.*)$/i.exec(l)
                if (setMatch) return { op: 'set' as const, name: setMatch[1], value: setMatch[2] }
                const rmMatch = /^remove\s+(.+)$/i.exec(l)
                if (rmMatch) return { op: 'remove' as const, name: rmMatch[1] }
                return { op: 'set' as const, name: l, value: '' }
              })
          )
        }
        rows={3}
        className="w-full bg-zinc-800 border border-zinc-700 rounded p-2 text-xs font-mono text-zinc-200 resize-y focus:outline-none focus:border-sky-700"
        placeholder={'set Authorization: Bearer xxx\nremove Cookie'}
      />
    </div>
  )
}

function ReplacesEditor({
  replaces,
  onChange
}: {
  replaces: BodyReplace[]
  onChange: (replaces: BodyReplace[]) => void
}) {
  const text = replaces
    .map((r) => `${r.regex ? '~' : ''}${r.search} => ${r.replace}`)
    .join('\n')
  return (
    <div>
      <div className="text-xs text-zinc-500 mb-1">
        搜索替换（每行：<code className="text-zinc-400">{'搜索 => 替换'}</code>，<code className="text-zinc-400">~</code> 前缀为正则；先解压再替换）
      </div>
      <textarea
        value={text}
        onChange={(e) =>
          onChange(
            e.target.value
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .map((l): BodyReplace | null => {
                const idx = l.indexOf('=>')
                if (idx < 0) return null
                let search = l.slice(0, idx).trim()
                const replace = l.slice(idx + 2).trim()
                const regex = search.startsWith('~')
                if (regex) search = search.slice(1)
                return search ? { search, replace, regex } : null
              })
              .filter((r): r is BodyReplace => r !== null)
          )
        }
        rows={2}
        className="w-full bg-zinc-800 border border-zinc-700 rounded p-2 text-xs font-mono text-zinc-200 resize-y focus:outline-none focus:border-sky-700"
        placeholder={'"debug" => "release"\n~/v\\d+/ => /v2/'}
      />
    </div>
  )
}

function BodyEditor({
  bodyBase64,
  onChange
}: {
  bodyBase64: string
  onChange: (bodyBase64: string) => void
}) {
  let text = ''
  try {
    text = bodyBase64 ? new TextDecoder().decode(Uint8Array.from(atob(bodyBase64), (c) => c.charCodeAt(0))) : ''
  } catch {
    text = ''
  }
  return (
    <div>
      <div className="text-xs text-zinc-500 mb-1">Body（留空 = 不替换）</div>
      <textarea
        value={text}
        onChange={(e) => {
          const bytes = new TextEncoder().encode(e.target.value)
          let bin = ''
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
          onChange(btoa(bin))
        }}
        rows={4}
        className="w-full bg-zinc-800 border border-zinc-700 rounded p-2 text-xs font-mono text-zinc-200 resize-y focus:outline-none focus:border-sky-700"
      />
    </div>
  )
}
