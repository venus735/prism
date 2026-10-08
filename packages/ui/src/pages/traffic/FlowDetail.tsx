import { useEffect, useRef, useState } from 'react'
import type { CodegenLang, Flow, HeaderPair, WsMessage } from '@proxy/shared'
import { CODEGEN_LANGS } from '@proxy/shared'
import { call } from '../../api/client'
import { BodyViewer } from './BodyViewer'
import { useComposerStore } from '../../stores/composer'

type Part = 'overview' | 'request' | 'response' | 'ws'

export function FlowDetail({ flowId }: { flowId: string }) {
  const [flow, setFlow] = useState<Flow | null>(null)
  const [part, setPart] = useState<Part>('overview')
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [starred, setStarred] = useState(false)
  const [decoding, setDecoding] = useState(false)
  const [decoded, setDecoded] = useState<
    { plugin: string | null; body: { size: number; contentType: string; isText: boolean; text?: string; base64?: string } } | 'none'
  | null
  >(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const loadFromFlow = useComposerStore((s) => s.loadFromFlow)

  useEffect(() => {
    setFlow(null)
    setPart('overview')
    setCode('')
    let alive = true
    call('flows.get', { id: flowId })
      .then((r) => alive && setFlow(r.flow))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [flowId])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  if (!flow) {
    return <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">加载中…</div>
  }

  const generate = async (lang: CodegenLang) => {
    setMenuOpen(false)
    try {
      const r = await call('flows.codegen', { id: flowId, lang })
      setCode(r.code)
      await navigator.clipboard.writeText(r.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  const star = async () => {
    try {
      await call('collections.addFromFlow', { flowId })
      setStarred(true)
      setTimeout(() => setStarred(false), 1500)
    } catch {
      /* ignore */
    }
  }

  const decodeWithPlugins = async () => {
    setDecoding(true)
    try {
      const r = await call('plugins.decodeFlow', { id: flowId })
      setDecoded(r.edited && r.body ? { plugin: r.plugin, body: r.body } : 'none')
    } catch (e) {
      setDecoded('none')
      console.warn(e)
    } finally {
      setDecoding(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-zinc-800 shrink-0">
        {(['overview', 'request', 'response'] as Part[]).map((p) => (
          <button
            key={p}
            onClick={() => setPart(p)}
            className={`px-3 py-1 rounded text-[13px] ${
              part === p ? 'bg-sky-600/20 text-sky-400' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {p === 'overview' ? '概览' : p === 'request' ? '请求' : '响应'}
          </button>
        ))}
        {(flow.kind === 'ws' || flow.flags.includes('grpc')) && (
          <button
            onClick={() => setPart('ws')}
            className={`px-3 py-1 rounded text-[13px] ${
              part === 'ws' ? 'bg-sky-600/20 text-sky-400' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {flow.flags.includes('grpc') ? 'gRPC 消息' : 'WebSocket 消息'}
          </button>
        )}
        <span className="flex-1" />
        {flow.request && (
          <button
            onClick={() => void loadFromFlow(flowId)}
            className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200"
            title="在 Composer 中编辑并重放此请求"
          >
            发送到 Composer
          </button>
        )}
        {flow.request && (
          <button
            onClick={() => void star()}
            className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-amber-300"
            title="保存请求/响应快照到收藏夹"
          >
            {starred ? '已收藏 ✓' : '收藏 ☆'}
          </button>
        )}
        {flow.response && (
          <button
            onClick={() => void decodeWithPlugins()}
            disabled={decoding}
            className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-amber-300 disabled:opacity-40"
            title="用已启用插件的 onResponse 重解码此响应（不覆盖原始数据）"
          >
            {decoding ? '解码中…' : '⚡ 插件解码'}
          </button>
        )}
        {flow.request && (
          <div ref={menuRef} className="relative">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200"
              title="生成重放代码并复制到剪贴板"
            >
              {copied ? '已复制 ✓' : '代码生成 ▾'}
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 z-20 rounded border border-zinc-800 bg-zinc-900 shadow-lg py-1 min-w-[150px]">
                {CODEGEN_LANGS.map(({ lang, label }) => (
                  <button
                    key={lang}
                    onClick={() => void generate(lang)}
                    className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {code && (
        <pre className="mx-2 my-1 p-2 rounded bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-400 overflow-auto max-h-24 shrink-0">
          {code}
        </pre>
      )}

      {decoded === 'none' && (
        <div className="mx-2 my-1 px-2 py-1 rounded border border-zinc-800 bg-zinc-900 text-[11px] text-zinc-500 flex items-center gap-2 shrink-0">
          没有插件修改此响应（确认插件已启用且匹配该请求）
          <span className="flex-1" />
          <button onClick={() => setDecoded(null)} className="text-zinc-600 hover:text-zinc-300">
            关闭
          </button>
        </div>
      )}

      {decoded && decoded !== 'none' && (
        <div className="mx-2 my-1 rounded border border-amber-700/50 bg-amber-950/20 shrink-0 flex flex-col max-h-80">
          <div className="flex items-center gap-2 px-2 py-1 text-[11px] text-amber-400 border-b border-amber-700/30">
            ⚡ {decoded.plugin ? `插件 ${decoded.plugin} ` : ''}解码结果（{decoded.body.size} B · {decoded.body.contentType}，不覆盖原始数据）
            <span className="flex-1" />
            <button
              onClick={() => void navigator.clipboard.writeText(decoded.body.text ?? decoded.body.base64 ?? '')}
              className="text-zinc-500 hover:text-amber-300"
            >
              复制
            </button>
            <button onClick={() => setDecoded(null)} className="text-zinc-500 hover:text-amber-300">
              关闭
            </button>
          </div>
          <pre className="overflow-auto p-2 text-[11px] font-mono text-zinc-200 whitespace-pre-wrap break-all">
            {decoded.body.text ?? decoded.body.base64}
          </pre>
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        {part === 'overview' && <Overview flow={flow} />}
        {part === 'request' && (
          <PartView
            flowId={flow.id}
            headers={flow.request?.headers}
            body={flow.request?.body}
            part="req"
          />
        )}
        {part === 'response' && (
          flow.response ? (
            <PartView
              flowId={flow.id}
              headers={flow.response.headers}
              body={flow.response.body}
              part="resp"
              trailers={flow.response.trailers}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
              {flow.error ? `错误: ${flow.error.message}` : '暂无响应'}
            </div>
          )
        )}
        {part === 'ws' && <WsTimeline flowId={flow.id} live={flow.state !== 'done' && flow.state !== 'aborted' && flow.state !== 'error'} grpc={flow.flags.includes('grpc')} />}
      </div>
    </div>
  )
}

function WsTimeline({ flowId, live, grpc = false }: { flowId: string; live: boolean; grpc?: boolean }) {
  const [messages, setMessages] = useState<WsMessage[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    const load = () => {
      call('flows.wsMessages', { id: flowId })
        .then((r) => alive && setMessages(r.messages))
        .catch(() => {})
    }
    load()
    if (!live) return () => {
      alive = false
    }
    const timer = setInterval(load, 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [flowId, live])

  const opcodeLabel = (op: number): { text: string; cls: string } => {
    if (grpc) {
      if (op === 0) return { text: 'data', cls: 'bg-violet-600/20 text-violet-400' }
      if ((op & 0x80) !== 0) return { text: 'trailer', cls: 'bg-zinc-700 text-zinc-300' }
      return { text: `f${op}`, cls: 'bg-zinc-700 text-zinc-300' }
    }
    switch (op) {
      case 1: return { text: 'text', cls: 'bg-sky-600/20 text-sky-400' }
      case 2: return { text: 'binary', cls: 'bg-violet-600/20 text-violet-400' }
      case 8: return { text: 'close', cls: 'bg-red-600/20 text-red-400' }
      case 9: return { text: 'ping', cls: 'bg-zinc-700 text-zinc-300' }
      case 10: return { text: 'pong', cls: 'bg-zinc-700 text-zinc-300' }
      default: return { text: `op${op}`, cls: 'bg-zinc-700 text-zinc-300' }
    }
  }

  return (
    <div className="h-full overflow-auto p-2 font-mono text-[12px] space-y-1">
      {messages.length === 0 && (
        <div className="text-zinc-600 text-center py-4">
          {live ? `等待${grpc ? ' gRPC' : ' WebSocket'}消息…` : '无消息记录'}
        </div>
      )}
      {messages.map((m) => {
        const op = opcodeLabel(m.opcode)
        const body = m.text ?? `${m.size} B`
        return (
          <div key={m.seq}>
            <button
              onClick={() => setExpanded(expanded === m.seq ? null : m.seq)}
              className="w-full flex items-start gap-2 px-2 py-1 rounded bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-left"
            >
              <span className="text-zinc-600 shrink-0 w-8 text-right">{m.seq}</span>
              <span
                className={`shrink-0 px-1.5 rounded text-[11px] ${
                  m.dir === 'c2s' ? 'bg-amber-600/20 text-amber-400' : 'bg-emerald-600/20 text-emerald-400'
                }`}
              >
                {m.dir === 'c2s' ? '↑ 发送' : '↓ 接收'}
              </span>
              <span className={`shrink-0 px-1.5 rounded text-[11px] ${op.cls}`}>{op.text}</span>
              <span className={`flex-1 break-all ${expanded === m.seq ? '' : 'truncate line-clamp-1'}`}>
                {body}
              </span>
              <span className="text-zinc-600 shrink-0">{m.size} B</span>
            </button>
          </div>
        )
      })}
    </div>
  )
}

function Overview({ flow }: { flow: Flow }) {
  const rows: Array<[string, string]> = [
    ['URL', flow.request?.url ?? `${flow.host ?? '?'}:${flow.port ?? '?'} (tunnel)`],
    ['Method', flow.request?.method ?? '—'],
    ['Status', flow.response ? `${flow.response.status} ${flow.response.statusText}`.trim() : '—'],
    ['State', flow.state],
    ['Kind', `${flow.kind}${flow.tls ? (flow.mitm ? ' · MITM' : ' · TLS 隧道') : ''}`],
    ['Client', `${flow.clientIp}:${flow.clientPort}`],
    ['Host', flow.host ?? '—'],
    ['SNI', flow.sni ?? '—'],
    ['Req Size', `${flow.size.reqHeader + flow.size.reqBody} B`],
    ['Resp Size', `${flow.size.respHeader + flow.size.respBody} B`],
    ['Duration', flow.timing.end ? `${flow.timing.end - flow.timing.start} ms` : '—'],
    ['Trace ID', flow.traceId ?? '—'],
    ['Flags', flow.flags.join(', ') || '—'],
    ['Error', flow.error ? `${flow.error.stage}: ${flow.error.message}` : '—']
  ]
  return (
    <div className="h-full overflow-auto p-3 text-[13px]">
      <table className="w-full border-collapse">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-b border-zinc-800/60">
              <td className="py-1 pr-4 text-zinc-500 whitespace-nowrap align-top w-24">{k}</td>
              <td className="py-1 text-zinc-300 break-all">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <TimingBar flow={flow} />
    </div>
  )
}

/** 时序瀑布：按里程碑切分（排队 → DNS → TCP → TLS → 等待TTFB → 下载），复用连接无 DNS/TLS 段 */
function TimingBar({ flow }: { flow: Flow }) {
  const t = flow.timing
  const def: Array<{ label: string; from?: number; to?: number; color: string }> = [
    { label: '请求排队', from: t.start, to: t.requestSent, color: 'bg-zinc-500' },
    { label: 'DNS 解析', from: t.requestSent ?? t.start, to: t.dns, color: 'bg-violet-500' },
    { label: 'TCP 连接', from: t.dns ?? t.requestSent ?? t.start, to: t.connect, color: 'bg-sky-500' },
    { label: 'TLS 握手', from: t.connect, to: t.tls, color: 'bg-amber-500' },
    {
      label: '等待响应',
      from: t.tls ?? t.connect ?? t.dns ?? t.requestSent ?? t.start,
      to: t.firstByte,
      color: 'bg-rose-500'
    },
    { label: '内容下载', from: t.firstByte, to: t.end, color: 'bg-emerald-500' }
  ]
  const segs = def.filter((s) => s.from !== undefined && s.to !== undefined && s.to > s.from)
  const total = t.end ? t.end - t.start : 0
  if (segs.length === 0) return null
  const reused = flow.tls && t.tls === undefined && t.connect !== undefined
  return (
    <div className="mt-3 pt-2 border-t border-zinc-800/60">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-zinc-500">时序</span>
        <span className="text-zinc-300 tabular-nums">{total} ms</span>
        {reused && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">连接复用</span>
        )}
      </div>
      <div className="h-3 rounded overflow-hidden flex bg-zinc-800 mb-2">
        {segs.map((s) => (
          <div
            key={s.label}
            className={`${s.color} h-full`}
            style={{ width: `${Math.max(((s.to! - s.from!) / Math.max(total, 1)) * 100, 0.5)}%` }}
            title={`${s.label} ${s.to! - s.from!} ms`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {segs.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5 text-xs text-zinc-400">
            <span className={`w-2 h-2 rounded-sm ${s.color}`} />
            {s.label}
            <span className="text-zinc-300 tabular-nums">{s.to! - s.from!} ms</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function PartView({
  flowId,
  headers,
  body,
  part,
  trailers
}: {
  flowId: string
  headers: HeaderPair[] | undefined
  body: { size: number; contentType: string; stored: string; isText?: boolean } | undefined
  part: 'req' | 'resp'
  trailers?: HeaderPair[]
}) {
  const [tab, setTab] = useState<'headers' | 'body'>('headers')
  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 px-2 py-1 border-b border-zinc-800 shrink-0">
        <button
          onClick={() => setTab('headers')}
          className={`px-2 py-0.5 rounded text-xs ${tab === 'headers' ? 'bg-sky-600/20 text-sky-400' : 'text-zinc-400 hover:text-zinc-200'}`}
        >
          Headers
        </button>
        <button
          onClick={() => setTab('body')}
          className={`px-2 py-0.5 rounded text-xs ${tab === 'body' ? 'bg-sky-600/20 text-sky-400' : 'text-zinc-400 hover:text-zinc-200'}`}
        >
          Body
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        {tab === 'headers' && (
          <div className="h-full overflow-auto p-2 font-mono text-[12px]">
            {(headers ?? []).map((h, i) => (
              <div key={i} className="flex gap-2 py-0.5 border-b border-zinc-800/40">
                <span className="text-sky-400 shrink-0">{h.name}:</span>
                <span className="text-zinc-300 break-all">{h.value}</span>
              </div>
            ))}
            {(!headers || headers.length === 0) && <span className="text-zinc-600">(无)</span>}
            {trailers && trailers.length > 0 && (
              <>
                <div className="mt-2 mb-1 text-zinc-500 text-[11px] uppercase tracking-wide">Trailers</div>
                {trailers.map((h, i) => (
                  <div key={`t-${i}`} className="flex gap-2 py-0.5 border-b border-zinc-800/40">
                    <span className="text-violet-400 shrink-0">{h.name}:</span>
                    <span className="text-zinc-300 break-all">{h.value}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
        {tab === 'body' &&
          (body && body.size > 0 ? (
            <BodyViewer
              flowId={flowId}
              part={part}
              contentType={body.contentType}
              isText={body.isText ?? false}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-zinc-600 text-sm">(无 Body)</div>
          ))}
      </div>
    </div>
  )
}
