import { useEffect, useState } from 'react'
import type { ComposerEnv } from '@proxy/shared'
import {
  useComposerStore,
  activeTabOf,
  BODY_TYPE_LABELS,
  AUTH_TYPE_LABELS,
  parseKvText,
  kvTextOf,
  type AuthType,
  type BodyType,
  type ComposerAuth,
  type FormKV,
  type KV
} from '../../stores/composer'
import { call } from '../../api/client'
import { FlowDetail } from '../traffic/FlowDetail'
import { ComposerActions } from './ComposerActions'

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

const AUTO_HEADERS = new Set(['host', 'content-length', 'connection'])

const INPUT =
  'bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-sky-700'

const TABS = [
  { id: 'params', label: '参数' },
  { id: 'headers', label: '请求头' },
  { id: 'body', label: '请求体' },
  { id: 'auth', label: '授权' },
  { id: 'script', label: '脚本' }
] as const

type TabId = (typeof TABS)[number]['id']

const METHOD_COLORS: Record<string, string> = {
  GET: 'text-emerald-400',
  POST: 'text-amber-400',
  PUT: 'text-sky-400',
  DELETE: 'text-red-400',
  PATCH: 'text-fuchsia-400'
}

function tabTitleOf(draft: { url: string }): string {
  if (!/^https?:\/\//i.test(draft.url)) return draft.url || '新请求'
  try {
    return new URL(draft.url).host || '新请求'
  } catch {
    return '新请求'
  }
}

type KvMode = 'table' | 'text'

function ModeToggle({ mode, onChange }: { mode: KvMode; onChange: (m: KvMode) => void }) {
  const btn = (m: KvMode, label: string, title: string) => (
    <button
      onClick={() => onChange(m)}
      title={title}
      className={`px-1.5 py-0.5 border-l border-zinc-800 first:border-l-0 ${
        mode === m ? 'bg-sky-600/20 text-sky-400' : 'text-zinc-500 hover:text-zinc-300'
      }`}
    >
      {label}
    </button>
  )
  return (
    <div className="flex items-center rounded border border-zinc-800 overflow-hidden text-[10px] leading-none">
      {btn('table', '▦ 表格', '表格模式')}
      {btn('text', '☰ 文本', '文本模式（每行一条，# 前缀停用）')}
    </div>
  )
}

export default function ComposerPage() {
  const draft = useComposerStore((s) => activeTabOf(s).draft)
  const resultFlowId = useComposerStore((s) => activeTabOf(s).resultFlowId)
  const tabs = useComposerStore((s) => s.tabs)
  const activeTabId = useComposerStore((s) => s.activeTabId)
  const newTab = useComposerStore((s) => s.newTab)
  const closeTab = useComposerStore((s) => s.closeTab)
  const switchTab = useComposerStore((s) => s.switchTab)
  const setDraft = useComposerStore((s) => s.setDraft)
  const setUrl = useComposerStore((s) => s.setUrl)
  const send = useComposerStore((s) => s.send)
  const sending = useComposerStore((s) => s.sending)
  const sendError = useComposerStore((s) => s.sendError)
  const history = useComposerStore((s) => s.history)
  const loadHistory = useComposerStore((s) => s.loadHistory)
  const clearHistory = useComposerStore((s) => s.clearHistory)
  const loadFromHistory = useComposerStore((s) => s.loadFromHistory)
  const envs = useComposerStore((s) => s.envs)
  const activeEnvName = useComposerStore((s) => s.activeEnvName)
  const loadEnvs = useComposerStore((s) => s.loadEnvs)
  const setEnvs = useComposerStore((s) => s.setEnvs)
  const [showHistory, setShowHistory] = useState(true)
  const [showEnvMgr, setShowEnvMgr] = useState(false)
  const [tab, setTab] = useState<TabId>('body')

  useEffect(() => {
    void loadHistory()
    void loadEnvs()
    void useComposerStore.getState().loadCookies()
  }, [loadHistory, loadEnvs])

  const setActiveEnv = (name: string | null): void => {
    void setEnvs(envs, name)
  }

  const paramCount = draft.params.filter((p) => p.enabled && p.key).length
  const headerCount = draft.headers.filter((h) => h.enabled && h.key).length
  const authBadge =
    draft.auth.type === 'none'
      ? null
      : draft.auth.type === 'bearer'
        ? 'Bearer'
        : draft.auth.type === 'basic'
          ? 'Basic'
          : '自定义'

  return (
    <div className="h-full flex">
      <div className="w-1/2 min-w-96 flex flex-col border-r border-zinc-800 overflow-hidden">
        <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-300">Composer</span>
          <span className="flex-1" />
          <select
            value={activeEnvName ?? ''}
            onChange={(e) => setActiveEnv(e.target.value || null)}
            className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-sky-700"
            title="环境变量集（发送时替换 {{key}}）"
          >
            <option value="">无环境</option>
            {envs.map((e) => (
              <option key={e.name}>{e.name}</option>
            ))}
          </select>
          <button
            onClick={() => setShowEnvMgr((v) => !v)}
            className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-sky-400 hover:bg-zinc-800"
            title="管理环境变量"
          >
            环境
          </button>
          <ComposerActions />
          <button
            onClick={() => void send()}
            disabled={sending || !draft.url.startsWith('http')}
            className="px-4 py-1 rounded text-sm bg-sky-600/20 text-sky-400 hover:bg-sky-600/30 disabled:opacity-40"
          >
            {sending ? '发送中…' : '发送'}
          </button>
        </div>

        {showEnvMgr && (
          <EnvManager
            envs={envs}
            activeName={activeEnvName}
            onChange={(next, active) => void setEnvs(next, active)}
            onSelect={setActiveEnv}
          />
        )}

        <div className="flex items-stretch border-b border-zinc-800 overflow-x-auto shrink-0">
          {tabs.map((t) => {
            const active = t.id === activeTabId
            const dirty = JSON.stringify(t.draft) !== t.sentSnapshot
            return (
              <div
                key={t.id}
                onClick={() => switchTab(t.id)}
                title={`${t.draft.method} ${t.draft.url}`}
                className={`group flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 text-xs border-r border-zinc-800 cursor-pointer whitespace-nowrap select-none ${
                  active
                    ? 'bg-zinc-900 text-zinc-200 border-b-2 border-b-sky-500'
                    : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/50'
                }`}
              >
                <span className={`font-mono text-[10px] ${METHOD_COLORS[t.draft.method] ?? 'text-zinc-400'}`}>
                  {t.draft.method}
                </span>
                <span className="max-w-40 truncate">{tabTitleOf(t.draft)}</span>
                {dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" title="有未发送的修改" />}
                {t.resultFlowId && !dirty && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" title="已有响应" />}
                <span
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(t.id)
                  }}
                  className="px-1 rounded text-zinc-600 hover:text-red-400 opacity-60 group-hover:opacity-100"
                  title="关闭"
                >
                  ×
                </span>
              </div>
            )
          })}
          <button
            onClick={newTab}
            title="新建空白请求"
            className="px-2.5 text-zinc-500 hover:text-sky-400 hover:bg-zinc-900/50 text-sm"
          >
            ＋
          </button>
        </div>

        <div className="flex-1 overflow-auto flex flex-col">
          <div className="flex gap-2 p-3 pb-2">
            <input
              list="composer-methods"
              value={draft.method}
              onChange={(e) => setDraft({ method: e.target.value.toUpperCase().slice(0, 32) })}
              title="可输入自定义方法（如 PROPFIND）"
              className={`${INPUT} w-28 text-sm font-mono`}
            />
            <datalist id="composer-methods">
              {['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <input
              value={draft.url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/api"
              className={`${INPUT} flex-1 text-sm font-mono`}
            />
          </div>

          <div className="flex items-center gap-1 px-3 border-b border-zinc-800">
            {TABS.map((t) => {
              const n =
                t.id === 'params'
                  ? paramCount > 0
                    ? String(paramCount)
                    : null
                  : t.id === 'headers'
                    ? headerCount > 0
                      ? String(headerCount)
                      : null
                    : t.id === 'auth'
                      ? authBadge
                      : null
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`px-3 py-1.5 text-xs border-b-2 -mb-px ${
                    tab === t.id
                      ? 'border-sky-500 text-sky-400'
                      : 'border-transparent text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {t.label}
                  {n && <span className="ml-1 text-zinc-600">{n}</span>}
                </button>
              )
            })}
          </div>

          <div className="flex-1 overflow-auto p-3">
            {tab === 'params' && <ParamsEditor />}
            {tab === 'headers' && <HeadersEditor />}
            {tab === 'body' && <BodyEditor />}
            {tab === 'auth' && <AuthEditor />}
            {tab === 'script' && <ScriptEditor />}
          </div>
        </div>

        <div className="border-t border-zinc-800 p-3 space-y-2 shrink-0">
          {sendError && <div className="text-xs text-red-400">发送失败: {sendError}</div>}
          <div className="border border-zinc-800 rounded">
            <button
              onClick={() => setShowHistory((v) => !v)}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
            >
              <span className={`transition-transform ${showHistory ? 'rotate-90' : ''}`}>▶</span>
              <span>请求历史</span>
              <span className="text-zinc-600">{history.length}</span>
            </button>
            {showHistory && (
              <div className="max-h-40 overflow-y-auto border-t border-zinc-800">
                {history.length === 0 && (
                  <div className="px-3 py-3 text-[11px] text-zinc-600">发送请求后在此回溯（保留最近 50 条）</div>
                )}
                {history.map((entry, i) => (
                  <button
                    key={`${entry.sentAt}-${i}`}
                    onClick={() => loadFromHistory(entry)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-zinc-800/60"
                    title={`${entry.spec.method} ${entry.spec.url}\n点击回填到编辑区`}
                  >
                    <span className="text-[10px] font-mono text-sky-400 shrink-0 w-12">{entry.spec.method}</span>
                    <span className="flex-1 truncate text-[11px] text-zinc-300 font-mono">
                      {entry.spec.url.replace(/^https?:\/\//, '')}
                    </span>
                    <span className="text-[10px] text-zinc-600 shrink-0">{timeAgo(entry.sentAt)}</span>
                  </button>
                ))}
                {history.length > 0 && (
                  <button
                    onClick={() => void clearHistory()}
                    className="w-full px-2 py-1.5 text-left text-[10px] text-zinc-600 hover:text-red-400 border-t border-zinc-800"
                  >
                    清空历史
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {resultFlowId ? (
          <FlowDetail key={resultFlowId} flowId={resultFlowId} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
            发送请求后在此查看响应；也可在流量详情点「发送到 Composer」编辑重放
          </div>
        )}
      </div>
    </div>
  )
}

function RowBtn({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-5 h-5 rounded-full border border-zinc-600 text-zinc-500 hover:text-red-400 hover:border-red-500 flex items-center justify-center text-[10px] leading-none shrink-0"
    >
      {children}
    </button>
  )
}

/** KV 行表格（参数 / 请求头 / urlencode body 共用） */
function KVTable({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  emptyHint,
  toolbar
}: {
  rows: KV[]
  onChange: (rows: KV[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
  emptyHint: string
  toolbar?: React.ReactNode
}) {
  const set = (i: number, patch: Partial<KV>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i))
  const add = () => onChange([...rows, { key: '', value: '', enabled: true }])
  return (
    <div className="space-y-1.5">
      {(toolbar || rows.length > 0) && (
        <div className="flex items-center gap-1.5 text-[10px]">
          {toolbar}
          <span className="flex-1" />
          <button onClick={add} className="px-2 py-0.5 rounded text-sky-400 bg-sky-600/10 hover:bg-sky-600/20">
            + 添加
          </button>
        </div>
      )}
      {rows.length === 0 && <div className="text-xs text-zinc-600 py-3 text-center">{emptyHint}</div>}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={(e) => set(i, { enabled: e.target.checked })}
            className="accent-sky-600 shrink-0"
          />
          <input
            value={r.key}
            onChange={(e) => set(i, { key: e.target.value })}
            placeholder={keyPlaceholder}
            className={`${INPUT} w-44 font-mono`}
          />
          {AUTO_HEADERS.has(r.key.trim().toLowerCase()) ? (
            <span className="flex-1 text-xs text-zinc-500 italic" title="引擎自动处理，不会随请求发送">
              🔒 默认自动生成
            </span>
          ) : (
            <input
              value={r.value}
              onChange={(e) => set(i, { value: e.target.value })}
              placeholder={valuePlaceholder}
              className={`${INPUT} flex-1 font-mono`}
            />
          )}
          <RowBtn onClick={() => remove(i)} title="删除">
            −
          </RowBtn>
        </div>
      ))}
      {rows.length > 0 && (
        <button onClick={add} className="text-[10px] text-zinc-600 hover:text-zinc-400">
          + 再加一行
        </button>
      )}
    </div>
  )
}

function ParamsEditor() {
  const params = useComposerStore((s) => activeTabOf(s).draft.params)
  const setParams = useComposerStore((s) => s.setParams)
  const [mode, setMode] = useState<KvMode>('table')
  const [text, setText] = useState('')

  const enterText = () => {
    setText(kvTextOf(params, '='))
    setMode('text')
  }
  const onText = (v: string) => {
    setText(v)
    setParams(parseKvText(v, '='))
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <ModeToggle mode={mode} onChange={(m) => (m === 'text' ? enterText() : setMode(m))} />
        <span className="text-[10px] text-zinc-600">文本模式每行一条，自动同步到 URL</span>
      </div>
      {mode === 'table' ? (
        <KVTable
          rows={params}
          onChange={setParams}
          keyPlaceholder="参数名"
          valuePlaceholder="值（支持 {{var}}）"
          emptyHint="无查询参数；添加行会自动同步到 URL"
        />
      ) : (
        <textarea
          value={text}
          onChange={(e) => onText(e.target.value)}
          rows={12}
          placeholder={'seq=3956\n#debug=1  （# 开头的行停用）'}
          className={TEXTAREA}
        />
      )}
    </div>
  )
}

function HeadersEditor() {
  const headers = useComposerStore((s) => activeTabOf(s).draft.headers)
  const setDraft = useComposerStore((s) => s.setDraft)
  const [msg, setMsg] = useState('')
  const [mode, setMode] = useState<KvMode>('table')
  const [text, setText] = useState('')

  const flash = (m: string) => {
    setMsg(m)
    setTimeout(() => setMsg(''), 1500)
  }

  const enterText = () => {
    setText(kvTextOf(headers, ':'))
    setMode('text')
  }
  const onText = (v: string) => {
    setText(v)
    setDraft({ headers: parseKvText(v, ':') })
  }

  const copyAll = async () => {
    const text2 = headers
      .filter((h) => h.key)
      .map((h) => `${h.key}: ${h.value}`)
      .join('\n')
    await call('app.clipboard.writeText', { text: text2 })
    flash('已复制')
  }

  const paste = async () => {
    const { text } = await call('app.clipboard.readText')
    const parsed = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const idx = l.indexOf(':')
        return idx > 0
          ? { key: l.slice(0, idx).trim(), value: l.slice(idx + 1).trim(), enabled: true }
          : null
      })
      .filter((h): h is KV => h !== null)
    if (!parsed.length) {
      flash('剪贴板没有可解析的 Header')
      return
    }
    setDraft({ headers: [...headers, ...parsed] })
    flash(`已粘贴 ${parsed.length} 条`)
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px]">
        <ModeToggle mode={mode} onChange={(m) => (m === 'text' ? enterText() : setMode(m))} />
        {mode === 'table' ? (
          <>
            {msg && <span className="text-sky-400">{msg}</span>}
            <span className="flex-1" />
            <button onClick={() => void copyAll()} className="px-1.5 py-0.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800">
              复制
            </button>
            <button onClick={() => void paste()} className="px-1.5 py-0.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800">
              粘贴
            </button>
            <button
              onClick={() => setDraft({ headers: [] })}
              className="px-1.5 py-0.5 rounded text-zinc-400 hover:text-red-400 hover:bg-zinc-800"
            >
              清空
            </button>
          </>
        ) : (
          <span className="text-zinc-600">每行一条 Name: Value；# 开头的行停用</span>
        )}
      </div>
      {mode === 'table' ? (
        <KVTable
          rows={headers}
          onChange={(rows) => setDraft({ headers: rows })}
          keyPlaceholder="Header 名"
          valuePlaceholder="值（支持 {{var}}）"
          emptyHint="无自定义请求头；Host / Content-Length / Connection 由引擎自动处理"
        />
      ) : (
        <textarea
          value={text}
          onChange={(e) => onText(e.target.value)}
          rows={12}
          placeholder={'accept-language: zh-CN, zh;q=0.9\n#x-debug: 1  （# 开头的行停用）'}
          className={TEXTAREA}
        />
      )}
    </div>
  )
}

const AUTH_HINT =
  '发送时注入对应请求头；与「请求头」表格同名头以此处为准。从流量/收藏/历史回填时自动识别 Authorization。'

const SCRIPT_PLACEHOLDER = `// 发送前运行；ctx = { method, url, headers, body, log }
// 返回 { method?, url?, headers?, body? } 覆盖最终请求
ctx.log('sending ' + ctx.url)
const h = [...ctx.headers, { name: 'X-Trace-Id', value: Date.now().toString(36) }]
return { headers: h }`

function ScriptEditor() {
  const preScript = useComposerStore((s) => activeTabOf(s).draft.preScript ?? '')
  const setDraft = useComposerStore((s) => s.setDraft)

  return (
    <div className="space-y-2 max-w-3xl">
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500">前置脚本（发送前对最终请求做最后处理，如签名 / 注入 trace 头）</span>
      </div>
      <textarea
        value={preScript}
        onChange={(e) => setDraft({ preScript: e.target.value })}
        rows={14}
        spellCheck={false}
        placeholder={SCRIPT_PLACEHOLDER}
        className={TEXTAREA}
      />
      <div className="text-[10px] text-zinc-600">
        ctx.headers 为 {'{name, value}[]'}；ctx.body 为解出的文本（改写后以 UTF-8 重新编码）。脚本抛错时发送中止并在下方显示错误。
      </div>
    </div>
  )
}

function AuthEditor() {
  const auth = useComposerStore((s) => activeTabOf(s).draft.auth)
  const setDraft = useComposerStore((s) => s.setDraft)
  const set = (patch: Partial<ComposerAuth>): void => setDraft({ auth: { ...auth, ...patch } })

  return (
    <div className="space-y-3 max-w-xl">
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500 shrink-0">类型</span>
        <select
          value={auth.type}
          onChange={(e) => set({ type: e.target.value as AuthType })}
          className={`${INPUT} text-zinc-300`}
        >
          {(Object.keys(AUTH_TYPE_LABELS) as AuthType[]).map((t) => (
            <option key={t} value={t}>
              {AUTH_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </div>

      {auth.type === 'none' && (
        <div className="text-xs text-zinc-600 py-8 text-center border border-dashed border-zinc-800 rounded">
          未设置授权；也可直接在「请求头」添加 Authorization
        </div>
      )}

      {auth.type === 'bearer' && (
        <label className="block space-y-1">
          <span className="text-xs text-zinc-500">{'Token（支持 {{var}}，发送为 Authorization: Bearer <token>）'}</span>
          <input
            value={auth.token ?? ''}
            onChange={(e) => set({ token: e.target.value })}
            placeholder="粘贴访问令牌"
            className={`${INPUT} w-full font-mono`}
          />
        </label>
      )}

      {auth.type === 'basic' && (
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="text-xs text-zinc-500">{'用户名（支持 {{var}}）'}</span>
            <input
              value={auth.user ?? ''}
              onChange={(e) => set({ user: e.target.value })}
              className={`${INPUT} w-full font-mono`}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-zinc-500">{'密码（支持 {{var}}）'}</span>
            <input
              type="password"
              value={auth.pass ?? ''}
              onChange={(e) => set({ pass: e.target.value })}
              className={`${INPUT} w-full font-mono`}
            />
          </label>
        </div>
      )}

      {auth.type === 'custom' && (
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="text-xs text-zinc-500">{'请求头名（支持 {{var}}，如 X-Api-Key）'}</span>
            <input
              value={auth.headerKey ?? ''}
              onChange={(e) => set({ headerKey: e.target.value })}
              placeholder="X-Api-Key"
              className={`${INPUT} w-full font-mono`}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-zinc-500">{'值（支持 {{var}}）'}</span>
            <input
              value={auth.headerValue ?? ''}
              onChange={(e) => set({ headerValue: e.target.value })}
              className={`${INPUT} w-full font-mono`}
            />
          </label>
        </div>
      )}

      <div className="text-[10px] text-zinc-600">{AUTH_HINT}</div>
    </div>
  )
}

const TEXTAREA =
  'w-full bg-zinc-900 border border-zinc-800 rounded p-2 text-xs font-mono text-zinc-200 resize-y placeholder:text-zinc-600 focus:outline-none focus:border-sky-700'

function BodyEditor() {
  const draft = useComposerStore((s) => activeTabOf(s).draft)
  const setDraft = useComposerStore((s) => s.setDraft)
  const [bodyError, setBodyError] = useState('')
  const type = draft.bodyType

  const setText = (bodyText: string) => setDraft({ bodyText })

  const beautify = () => {
    try {
      setText(JSON.stringify(JSON.parse(draft.bodyText), null, 2))
      setBodyError('')
    } catch (err) {
      setBodyError(`不是合法 JSON：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const minify = () => {
    try {
      setText(JSON.stringify(JSON.parse(draft.bodyText)))
      setBodyError('')
    } catch (err) {
      setBodyError(`不是合法 JSON：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const pickFile = () => {
    void call('app.pickFile').then((r) => {
      if (!r.canceled && r.filePath) setDraft({ bodyFilePath: r.filePath })
    })
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <select
          value={type}
          onChange={(e) => setDraft({ bodyType: e.target.value as BodyType })}
          className={`${INPUT} text-zinc-300`}
        >
          {(Object.keys(BODY_TYPE_LABELS) as BodyType[]).map((t) => (
            <option key={t} value={t}>
              {BODY_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        {type === 'json' && (
          <>
            <button onClick={beautify} className="px-2 py-1 rounded text-[11px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700">
              美化
            </button>
            <button onClick={minify} className="px-2 py-1 rounded text-[11px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700">
              压缩
            </button>
          </>
        )}
        {bodyError && <span className="text-[10px] text-red-400 truncate" title={bodyError}>{bodyError}</span>}
      </div>

      {type === 'none' && (
        <div className="text-xs text-zinc-600 py-8 text-center border border-dashed border-zinc-800 rounded">
          未设置任何请求体
        </div>
      )}

      {(type === 'json' || type === 'text' || type === 'xml' || type === 'raw') && (
        <textarea
          value={draft.bodyText}
          onChange={(e) => setText(e.target.value)}
          rows={14}
          placeholder={
            type === 'json'
              ? '{\n  "key": "value"\n}'
              : type === 'xml'
                ? '<root>\n  <item>value</item>\n</root>'
                : '请求体内容（支持 {{var}}）'
          }
          className={TEXTAREA}
        />
      )}

      {type === 'form-data' && (
        <FormDataTable
          rows={draft.bodyForm}
          onChange={(rows) => setDraft({ bodyForm: rows })}
        />
      )}

      {type === 'urlencode' && (
        <KVTable
          rows={draft.bodyForm}
          onChange={(rows) => setDraft({ bodyForm: rows })}
          keyPlaceholder="字段名"
          valuePlaceholder="值（支持 {{var}}）"
          emptyHint="无表单字段"
        />
      )}

      {type === 'file' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <button
              onClick={pickFile}
              className="px-3 py-1 rounded text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700"
            >
              选择文件…
            </button>
            <span className="flex-1 truncate font-mono text-[11px] text-zinc-400" title={draft.bodyFilePath ?? ''}>
              {draft.bodyFilePath ?? '未选择文件（将以空 body 发送）'}
            </span>
            {draft.bodyFilePath && (
              <RowBtn onClick={() => setDraft({ bodyFilePath: null })} title="移除文件">
                −
              </RowBtn>
            )}
          </div>
          <div className="text-[10px] text-zinc-600">
            文件以二进制 body 发送（Content-Type 默认 application/octet-stream，可在请求头覆盖）
          </div>
        </div>
      )}
    </div>
  )
}

/** form-data 表格：行可切换文本/文件 */
function FormDataTable({
  rows,
  onChange
}: {
  rows: FormKV[]
  onChange: (rows: FormKV[]) => void
}) {
  const set = (i: number, patch: Partial<FormKV>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i))
  const add = () => onChange([...rows, { key: '', value: '', enabled: true }])

  const pickFile = (i: number) => {
    void call('app.pickFile').then((r) => {
      if (!r.canceled && r.filePath) set(i, { filePath: r.filePath })
    })
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px]">
        <span className="text-zinc-500">multipart/form-data</span>
        <span className="flex-1" />
        <button onClick={add} className="px-2 py-0.5 rounded text-sky-400 bg-sky-600/10 hover:bg-sky-600/20">
          + 添加
        </button>
      </div>
      {rows.length === 0 && (
        <div className="text-xs text-zinc-600 py-3 text-center border border-dashed border-zinc-800 rounded">
          无表单字段；行类型可切换 文本 / 文件
        </div>
      )}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={(e) => set(i, { enabled: e.target.checked })}
            className="accent-sky-600 shrink-0"
          />
          <input
            value={r.key}
            onChange={(e) => set(i, { key: e.target.value })}
            placeholder="字段名"
            className={`${INPUT} w-40 font-mono`}
          />
          <button
            onClick={() => set(i, { isFile: !r.isFile })}
            className={`px-1.5 py-0.5 rounded text-[10px] border ${
              r.isFile
                ? 'border-amber-600 text-amber-400 bg-amber-600/10'
                : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
            }`}
            title="切换 文本 / 文件"
          >
            {r.isFile ? '文件' : '文本'}
          </button>
          {r.isFile ? (
            <button
              onClick={() => pickFile(i)}
              className={`${INPUT} flex-1 text-left font-mono truncate`}
              title={r.filePath ?? '选择文件'}
            >
              {r.filePath ?? '选择文件…'}
            </button>
          ) : (
            <input
              value={r.value}
              onChange={(e) => set(i, { value: e.target.value })}
              placeholder="值（支持 {{var}}）"
              className={`${INPUT} flex-1 font-mono`}
            />
          )}
          <RowBtn onClick={() => remove(i)} title="删除">
            −
          </RowBtn>
        </div>
      ))}
      {rows.length > 0 && (
        <button onClick={add} className="text-[10px] text-zinc-600 hover:text-zinc-400">
          + 再加一行
        </button>
      )}
    </div>
  )
}

const ENV_INPUT =
  'bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-sky-700'

function EnvManager({
  envs,
  activeName,
  onChange,
  onSelect
}: {
  envs: ComposerEnv[]
  activeName: string | null
  onChange: (envs: ComposerEnv[], activeName: string | null) => void
  onSelect: (name: string | null) => void
}) {
  const [draftName, setDraftName] = useState('')
  const [varDrafts, setVarDrafts] = useState<Record<string, { key: string; value: string }>>({})

  const addEnv = () => {
    const name = draftName.trim()
    if (!name || envs.some((e) => e.name === name)) return
    onChange([...envs, { name, vars: {} }], activeName)
    setDraftName('')
  }

  const removeEnv = (name: string) => {
    const next = envs.filter((e) => e.name !== name)
    onChange(next, activeName === name ? null : activeName)
  }

  const setVars = (name: string, vars: Record<string, string>) => {
    onChange(
      envs.map((e) => (e.name === name ? { ...e, vars } : e)),
      activeName
    )
  }

  const addVar = (envName: string) => {
    const d = varDrafts[envName] ?? { key: '', value: '' }
    const key = d.key.trim()
    if (!key) return
    const env = envs.find((e) => e.name === envName)
    setVars(envName, { ...env?.vars, [key]: d.value })
    setVarDrafts((s) => ({ ...s, [envName]: { key: '', value: '' } }))
  }

  return (
    <div className="border-b border-zinc-800 bg-zinc-900/40 p-3 space-y-3 max-h-64 overflow-y-auto">
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500">环境变量（发送时替换 URL/Headers/Body 中的 {'{{key}}'}）</span>
      </div>
      {envs.length === 0 && (
        <div className="text-[11px] text-zinc-600">尚无环境。例：建 dev / staging 两套，变量 baseUrl、token。</div>
      )}
      {envs.map((env) => {
        const draft = varDrafts[env.name] ?? { key: '', value: '' }
        return (
          <div key={env.name} className="rounded border border-zinc-800 p-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <button
                onClick={() => onSelect(activeName === env.name ? null : env.name)}
                className={`px-2 py-0.5 rounded text-xs ${
                  activeName === env.name
                    ? 'bg-sky-600/20 text-sky-400 border border-sky-700'
                    : 'text-zinc-300 border border-zinc-700 hover:border-zinc-500'
                }`}
              >
                {activeName === env.name ? '✓ ' : ''}
                {env.name}
              </button>
              <span className="text-[10px] text-zinc-600">{Object.keys(env.vars).length} 个变量</span>
              <span className="flex-1" />
              <button
                onClick={() => removeEnv(env.name)}
                className="text-[10px] text-zinc-600 hover:text-red-400"
              >
                删除环境
              </button>
            </div>
            <div className="space-y-1">
              {Object.entries(env.vars).map(([k, v]) => (
                <div key={k} className="flex items-center gap-1.5 font-mono text-[11px]">
                  <span className="w-32 shrink-0 truncate text-sky-400" title={k}>{`{{${k}}}`}</span>
                  <span className="flex-1 truncate text-zinc-400" title={v}>{v || '(空)'}</span>
                  <button
                    onClick={() => {
                      const next = { ...env.vars }
                      delete next[k]
                      setVars(env.name, next)
                    }}
                    className="text-zinc-600 hover:text-red-400"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <input
                value={draft.key}
                onChange={(e) => setVarDrafts((s) => ({ ...s, [env.name]: { ...draft, key: e.target.value } }))}
                onKeyDown={(e) => e.key === 'Enter' && addVar(env.name)}
                placeholder="变量名"
                className={`${ENV_INPUT} w-28 font-mono`}
              />
              <input
                value={draft.value}
                onChange={(e) => setVarDrafts((s) => ({ ...s, [env.name]: { ...draft, value: e.target.value } }))}
                onKeyDown={(e) => e.key === 'Enter' && addVar(env.name)}
                placeholder="值"
                className={`${ENV_INPUT} flex-1 font-mono`}
              />
              <button
                onClick={() => addVar(env.name)}
                className="px-2 py-0.5 rounded text-[11px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700"
              >
                添加
              </button>
            </div>
          </div>
        )
      })}
      <div className="flex items-center gap-1.5">
        <input
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addEnv()}
          placeholder="新环境名（如 dev / staging）"
          className={`${ENV_INPUT} w-48`}
        />
        <button
          onClick={addEnv}
          className="px-2 py-0.5 rounded text-[11px] text-sky-400 bg-sky-600/10 hover:bg-sky-600/20"
        >
          + 环境
        </button>
      </div>
    </div>
  )
}
