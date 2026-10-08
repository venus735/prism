import { useEffect, useRef, useState } from 'react'
import type { PluginStatus } from '@proxy/shared'
import { usePluginsStore } from '../../stores/plugins'

const STATUS_LABEL: Record<PluginStatus['status'], { text: string; cls: string }> = {
  ok: { text: '正常', cls: 'bg-emerald-600/20 text-emerald-400' },
  error: { text: '错误', cls: 'bg-red-600/20 text-red-400' },
  'disabled-by-strikes': { text: '连续出错已禁用', cls: 'bg-amber-600/20 text-amber-400' },
  'missing-python': { text: '未找到 python3', cls: 'bg-amber-600/20 text-amber-400' }
}

export default function PluginsPage() {
  const plugins = usePluginsStore((s) => s.plugins)
  const logs = usePluginsStore((s) => s.logs)
  const load = usePluginsStore((s) => s.load)
  const reload = usePluginsStore((s) => s.reload)
  const openDir = usePluginsStore((s) => s.openDir)
  const [creating, setCreating] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  return (
    <div className="h-full overflow-auto p-4 space-y-6">
      <section>
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-sm font-medium text-zinc-300">插件</h2>
          <button
            onClick={() => void reload()}
            className="px-2.5 py-1 rounded text-xs bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
          >
            重新扫描
          </button>
          <button
            onClick={() => void openDir()}
            className="px-2.5 py-1 rounded text-xs bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
          >
            打开插件目录
          </button>
          <div className="flex-1" />
          <button
            onClick={() => setCreating(true)}
            className="px-2.5 py-1 rounded text-xs bg-sky-600/20 text-sky-400 hover:bg-sky-600/30"
          >
            + 新建插件
          </button>
        </div>

        {plugins.length === 0 ? (
          <div className="text-sm text-zinc-600 py-6 text-center border border-dashed border-zinc-800 rounded">
            暂无插件。点击「新建插件」从模板创建，或把 index.js（JS）/ plugin.py（Python）放进插件目录后「重新扫描」。
          </div>
        ) : (
          <div className="space-y-1">
            {plugins.map((p) => (
              <PluginRow key={p.name} plugin={p} />
            ))}
          </div>
        )}

        <p className="mt-3 text-xs text-zinc-600 leading-relaxed">
          JS 插件保存后自动热重载；Python 插件修改后需「重新扫描」。请求体/响应体超过 2MB 时跳过 Python 插件；
          连续抛错 3 次自动禁用。onRequest 可修改请求或直接返回响应（respond），onResponse 可修改响应，适合加解密 body。
        </p>
      </section>

      <section>
        <h2 className="text-sm font-medium text-zinc-300 mb-2">插件日志</h2>
        <div
          ref={logRef}
          className="h-64 overflow-auto bg-zinc-950 border border-zinc-800 rounded p-2 font-mono text-xs space-y-0.5"
        >
          {logs.length === 0 && <div className="text-zinc-700">暂无日志</div>}
          {logs.map((l, i) => (
            <div key={`${l.at}-${i}`} className="flex gap-2">
              <span className="text-zinc-600 shrink-0">
                {new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false })}
              </span>
              <span className="text-sky-400 shrink-0">[{l.plugin}]</span>
              <span className="text-zinc-300 break-all">{l.message}</span>
            </div>
          ))}
        </div>
      </section>

      {creating && <CreateDialog onClose={() => setCreating(false)} />}
    </div>
  )
}

function PluginRow({ plugin }: { plugin: PluginStatus }) {
  const setEnabled = usePluginsStore((s) => s.setEnabled)
  const status = STATUS_LABEL[plugin.status]
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded bg-zinc-900 border border-zinc-800 text-[13px]">
      <input
        type="checkbox"
        checked={plugin.enabled}
        onChange={(e) => void setEnabled(plugin.name, e.target.checked)}
        className="accent-sky-600"
        title={plugin.enabled ? '禁用' : '启用'}
      />
      <span className="font-mono text-zinc-200">{plugin.name}</span>
      <span
        className={`px-1.5 py-0.5 rounded text-[11px] ${
          plugin.type === 'js' ? 'bg-amber-600/20 text-amber-400' : 'bg-sky-600/20 text-sky-400'
        }`}
      >
        {plugin.type === 'js' ? 'JS' : 'Python'}
      </span>
      <span className={`px-1.5 py-0.5 rounded text-[11px] ${status.cls}`}>{status.text}</span>
      {plugin.lastError && (
        <span className="flex-1 truncate text-zinc-500" title={plugin.lastError}>
          {plugin.lastError}
        </span>
      )}
      {!plugin.lastError && <span className="flex-1" />}
      {plugin.status === 'disabled-by-strikes' && (
        <span className="text-xs text-zinc-500">重新勾选可重置计数并启用</span>
      )}
    </div>
  )
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const create = usePluginsStore((s) => s.create)
  const [name, setName] = useState('')
  const [type, setType] = useState<'js' | 'python'>('js')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await create(name, type)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-6">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-md shadow-2xl">
        <div className="px-4 py-3 border-b border-zinc-800 text-sm text-zinc-300">新建插件（从模板）</div>
        <div className="p-4 space-y-3">
          <div>
            <div className="text-xs text-zinc-500 mb-1">名称（目录名，字母数字-_）</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-decryptor"
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 font-mono focus:outline-none focus:border-sky-700"
            />
          </div>
          <div>
            <div className="text-xs text-zinc-500 mb-1">类型</div>
            <div className="flex gap-2">
              <button
                onClick={() => setType('js')}
                className={`flex-1 px-3 py-2 rounded text-sm border ${
                  type === 'js'
                    ? 'bg-sky-600/20 border-sky-700 text-sky-300'
                    : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                JS（热重载）
              </button>
              <button
                onClick={() => setType('python')}
                className={`flex-1 px-3 py-2 rounded text-sm border ${
                  type === 'python'
                    ? 'bg-sky-600/20 border-sky-700 text-sky-300'
                    : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Python
              </button>
            </div>
          </div>
          {error && <div className="text-xs text-red-400">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-800">
          <button onClick={onClose} className="px-3 py-1.5 rounded text-sm text-zinc-400 hover:text-zinc-200">
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !name.trim()}
            className="px-4 py-1.5 rounded text-sm text-sky-300 bg-sky-600/20 hover:bg-sky-600/30 disabled:opacity-50"
          >
            {busy ? '创建中…' : '创建并启用'}
          </button>
        </div>
      </div>
    </div>
  )
}
