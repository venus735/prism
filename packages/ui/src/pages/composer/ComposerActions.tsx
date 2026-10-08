import { useEffect, useRef, useState } from 'react'
import type { CodegenLang, ComposerCookie } from '@proxy/shared'
import { CODEGEN_LANGS } from '@proxy/shared'
import { call } from '../../api/client'
import {
  useComposerStore,
  activeTabOf,
  utf8ToBase64,
  parseRawHttp,
  parseCurl,
  type ComposerDraft
} from '../../stores/composer'

const INPUT =
  'bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-sky-700'

const TEXTAREA =
  'w-full bg-zinc-900 border border-zinc-800 rounded p-2 text-xs font-mono text-zinc-200 resize-y placeholder:text-zinc-600 focus:outline-none focus:border-sky-700'

export function ComposerActions() {
  const [open, setOpen] = useState(false)
  const [modal, setModal] = useState<'raw' | 'curl' | 'codegen' | 'cookies' | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const ref = useRef<HTMLDivElement>(null)

  const showToast = (msg: string): void => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 1800)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const applyDraft = (draft: ComposerDraft | null, okMsg: string): void => {
    if (!draft) {
      showToast('无法解析，请检查内容格式')
      return
    }
    useComposerStore.getState().setDraft(draft)
    setModal(null)
    setOpen(false)
    showToast(okMsg)
  }

  const download = async (): Promise<void> => {
    const s = useComposerStore.getState()
    const tab = activeTabOf(s)
    if (!tab.resultFlowId) {
      showToast('当前请求还没有响应，请先发送')
      return
    }
    const { body } = await call('flows.getBody', { id: tab.resultFlowId, part: 'resp' })
    if (!body) {
      showToast('没有可下载的响应体')
      return
    }
    const data = body.base64 ?? (body.text ? utf8ToBase64(body.text) : '')
    if (!data) {
      showToast('响应体为空')
      return
    }
    let name = 'response'
    try {
      const p = new URL(activeTabOf(useComposerStore.getState()).draft.url).pathname
      const base = decodeURIComponent(p.split('/').pop() ?? '')
      if (base) name = base
    } catch {
      /* URL 无效时用默认名 */
    }
    const r = await call('app.saveFile', { defaultPath: name, base64: data, title: '下载响应体' })
    showToast(r.saved ? `已保存到 ${r.path}` : (r.error ?? '已取消'))
  }

  const exportCurl = async (): Promise<void> => {
    try {
      const code = await useComposerStore.getState().codegen('curl')
      await call('app.clipboard.writeText', { text: code })
      showToast('cURL 已复制到剪贴板')
    } catch (err) {
      showToast(`生成失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const items: Array<{ label: string; onClick: () => void }> = [
    { label: '⬇ 下载响应', onClick: () => void download() },
    { label: '↺ 重置请求', onClick: () => useComposerStore.getState().resetTab() },
    { label: '🗑 清除全部', onClick: () => useComposerStore.getState().clearTabs() },
    { label: '📋 导入报文…', onClick: () => setModal('raw') },
    { label: '🐚 导入 cURL…', onClick: () => setModal('curl') },
    { label: '📤 导出 cURL', onClick: () => void exportCurl() },
    { label: '</> 生成代码…', onClick: () => setModal('codegen') },
    { label: '🍪 管理 Cookie…', onClick: () => setModal('cookies') }
  ]

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="更多操作"
        className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-sky-400 hover:bg-zinc-800"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 min-w-40 bg-zinc-900 border border-zinc-800 rounded shadow-xl py-1">
          {items.map((it) => (
            <button
              key={it.label}
              onClick={() => {
                setOpen(false)
                it.onClick()
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            >
              {it.label}
            </button>
          ))}
        </div>
      )}

      {modal === 'raw' && (
        <PasteImportModal
          title="导入报文"
          placeholder={'GET /api/user HTTP/1.1\nHost: example.com\nAccept: application/json\n\n{"id": 1}'}
          hint="粘贴完整 HTTP 请求报文（请求行 + 请求头 + 空行 + body），填充到当前请求"
          onParse={(text) => applyDraft(parseRawHttp(text), '报文已导入当前请求')}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'curl' && (
        <PasteImportModal
          title="导入 cURL"
          placeholder={"curl -X POST 'https://example.com/api' \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"a\":1}'"}
          hint="粘贴 cURL 命令（支持 -X / -H / -d / --data-raw / -u / -b），填充到当前请求"
          onParse={(text) => applyDraft(parseCurl(text), 'cURL 已导入当前请求')}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'codegen' && <CodegenModal onClose={() => setModal(null)} onError={showToast} />}
      {modal === 'cookies' && <CookieManagerModal onClose={() => setModal(null)} />}

      {toast && (
        <div className="fixed bottom-4 right-4 z-50 px-3 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-200 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-4 py-2.5 border-b border-zinc-800">
          <span className="text-sm text-zinc-200">{title}</span>
          <span className="flex-1" />
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-sm px-1">
            ✕
          </button>
        </div>
        <div className="p-4 overflow-auto">{children}</div>
      </div>
    </div>
  )
}

function PasteImportModal({
  title,
  placeholder,
  hint,
  onParse,
  onClose
}: {
  title: string
  placeholder: string
  hint: string
  onParse: (text: string) => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3">
        <div className="text-[11px] text-zinc-500">{hint}</div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={12}
          placeholder={placeholder}
          className={TEXTAREA}
          autoFocus
        />
        <div className="flex items-center gap-2">
          <span className="flex-1" />
          <button
            onClick={() => onParse(text)}
            disabled={!text.trim()}
            className="px-3 py-1 rounded text-xs bg-sky-600/20 text-sky-400 hover:bg-sky-600/30 disabled:opacity-40"
          >
            解析并填充
          </button>
        </div>
      </div>
    </Modal>
  )
}

function CodegenModal({ onClose, onError }: { onClose: () => void; onError: (msg: string) => void }) {
  const [lang, setLang] = useState<CodegenLang>('curl')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setLoading(true)
    useComposerStore
      .getState()
      .codegen(lang)
      .then(setCode)
      .catch((err: unknown) => onError(`生成失败：${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setLoading(false))
  }, [lang, onError])

  const copy = async (): Promise<void> => {
    await call('app.clipboard.writeText', { text: code })
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <Modal title="生成代码" onClose={onClose}>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <select value={lang} onChange={(e) => setLang(e.target.value as CodegenLang)} className={INPUT}>
            {CODEGEN_LANGS.map((l) => (
              <option key={l.lang} value={l.lang}>
                {l.label}
              </option>
            ))}
          </select>
          <span className="flex-1" />
          <button onClick={() => void copy()} className="px-2 py-1 rounded text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700">
            {copied ? '已复制' : '复制'}
          </button>
        </div>
        <pre className="bg-zinc-950 border border-zinc-800 rounded p-3 text-[11px] font-mono text-zinc-300 overflow-auto max-h-[50vh] whitespace-pre">
          {loading ? '生成中…' : code}
        </pre>
        <div className="text-[10px] text-zinc-600">由当前请求草稿生成（含环境变量替换、授权头与 Cookie 注入的结果）</div>
      </div>
    </Modal>
  )
}

function CookieManagerModal({ onClose }: { onClose: () => void }) {
  const cookies = useComposerStore((s) => s.cookies)
  const setCookies = useComposerStore((s) => s.setCookies)
  const url = useComposerStore((s) => activeTabOf(s).draft.url)
  const [domain, setDomain] = useState('')
  const [name, setName] = useState('')
  const [value, setValue] = useState('')

  useEffect(() => {
    void useComposerStore.getState().loadCookies()
  }, [])

  useEffect(() => {
    if (domain) return
    try {
      setDomain(new URL(url).host)
    } catch {
      /* URL 无效时留空手填 */
    }
  }, [url, domain])

  const update = (next: ComposerCookie[]): void => void setCookies(next)

  const set = (i: number, patch: Partial<ComposerCookie>) =>
    update(cookies.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  const remove = (i: number) => update(cookies.filter((_, j) => j !== i))

  const add = (): void => {
    const d = domain.trim()
    const n = name.trim()
    if (!d || !n) return
    if (cookies.some((c) => c.domain === d && c.name === n)) return
    update([...cookies, { domain: d, name: n, value, enabled: true }])
    setName('')
    setValue('')
  }

  return (
    <Modal title="管理 Cookie" onClose={onClose}>
      <div className="space-y-3">
        <div className="text-[11px] text-zinc-500">
          发送时自动为匹配域的请求注入 Cookie 头（请求头已显式设置 Cookie 时不覆盖）。子域自动匹配（example.com 覆盖 api.example.com）。
        </div>
        {cookies.length > 0 && (
          <div className="border border-zinc-800 rounded divide-y divide-zinc-800">
            {cookies.map((c, i) => (
              <div key={`${c.domain}-${c.name}`} className="flex items-center gap-2 px-2 py-1.5 text-[11px] font-mono">
                <input
                  type="checkbox"
                  checked={c.enabled}
                  onChange={(e) => set(i, { enabled: e.target.checked })}
                  className="accent-sky-600 shrink-0"
                />
                <input value={c.domain} onChange={(e) => set(i, { domain: e.target.value })} className={`${INPUT} w-40`} />
                <input value={c.name} onChange={(e) => set(i, { name: e.target.value })} className={`${INPUT} w-32`} />
                <input value={c.value} onChange={(e) => set(i, { value: e.target.value })} className={`${INPUT} flex-1`} />
                <button onClick={() => remove(i)} className="text-zinc-600 hover:text-red-400 px-1 shrink-0" title="删除">
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="域（如 example.com）"
            className={`${INPUT} w-40 font-mono`}
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="名称"
            className={`${INPUT} w-32 font-mono`}
          />
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="值"
            className={`${INPUT} flex-1 font-mono`}
          />
          <button
            onClick={add}
            className="px-2 py-1 rounded text-xs text-sky-400 bg-sky-600/10 hover:bg-sky-600/20 shrink-0"
          >
            + 添加
          </button>
        </div>
        {cookies.length === 0 && (
          <div className="text-xs text-zinc-600 py-4 text-center border border-dashed border-zinc-800 rounded">
            尚无 Cookie；添加后将按域自动注入发送的请求
          </div>
        )}
      </div>
    </Modal>
  )
}
