import { useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'

const INPUT =
  'w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm font-mono text-zinc-200 focus:outline-none focus:border-sky-700'
const LABEL = 'text-xs text-zinc-500 mb-1'

export default function ToolboxPage() {
  const [tab, setTab] = useState('codec')
  const TABS = [
    { id: 'codec', label: '编解码' },
    { id: 'hash', label: 'Hash' },
    { id: 'hmac', label: 'HMAC' },
    { id: 'aes', label: 'AES' },
    { id: 'time', label: '时间戳' },
    { id: 'uuid', label: 'UUID' },
    { id: 'regex', label: '正则' },
    { id: 'qr', label: '二维码' }
  ]
  return (
    <div className="h-full overflow-auto p-6 max-w-3xl">
      <h1 className="text-base font-medium text-zinc-200 mb-4">工具箱</h1>
      <div className="flex items-center gap-1 border-b border-zinc-800 mb-4">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 text-xs border-b-2 -mb-px ${
              tab === t.id ? 'border-sky-500 text-sky-400' : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'codec' && <CodecTool />}
      {tab === 'hash' && <HashTool />}
      {tab === 'hmac' && <HmacTool />}
      {tab === 'aes' && <AesTool />}
      {tab === 'time' && <TimeTool />}
      {tab === 'uuid' && <UuidTool />}
      {tab === 'regex' && <RegexTool />}
      {tab === 'qr' && <QrTool />}
    </div>
  )
}

function Out({ label, value }: { label?: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className={LABEL}>{label ?? '输出'}</span>
        <button
          onClick={() => {
            navigator.clipboard.writeText(value).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            })
          }}
          className="text-[11px] text-sky-400 hover:text-sky-300"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <div className="min-h-[2.4rem] rounded bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm font-mono text-zinc-200 whitespace-pre-wrap break-all">
        {value || <span className="text-zinc-600">—</span>}
      </div>
    </div>
  )
}

function CodecTool() {
  const [text, setText] = useState('')
  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">URL / Base64 / Hex / JSON 编解码，输入即时计算。</p>
      <div>
        <div className={LABEL}>输入</div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} className={`${INPUT} h-24 resize-none`} placeholder="输入文本" />
      </div>
      <div className="grid gap-4">
        <Out label="URL 编码" value={text ? encodeURIComponent(text) : ''} />
        <Out label="URL 解码" value={safe(() => decodeURIComponent(text))} />
        <Out label="Base64 编码" value={text ? btoa(String.fromCharCode(...new TextEncoder().encode(text))) : ''} />
        <Out label="Base64 解码" value={safe(() => new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0))))} />
        <Out label="Hex 编码" value={text ? [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join(' ') : ''} />
        <Out label="Hex 解码" value={safe(() => new TextDecoder().decode(new Uint8Array((text.match(/[0-9a-f]{2}/gi) ?? []).map((h) => parseInt(h, 16)))))} />
      </div>
    </div>
  )
}

function safe(fn: () => string): string {
  try {
    return fn() ?? ''
  } catch {
    return ''
  }
}

async function digest(algo: string, text: string): Promise<string> {
  const buf = await crypto.subtle.digest(algo, new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function HashTool() {
  const [text, setText] = useState('')
  const [hashes, setHashes] = useState<Record<string, string>>({})
  const run = async (t: string) => {
    setText(t)
    if (!t) return setHashes({})
    const out: Record<string, string> = {}
    for (const algo of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']) {
      out[algo] = await digest(algo.replace('-', ''), t)
    }
    setHashes(out)
  }
  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">SHA 系列 Hash 计算（Web Crypto 不提供 MD5）。</p>
      <div>
        <div className={LABEL}>输入</div>
        <textarea value={text} onChange={(e) => run(e.target.value)} className={`${INPUT} h-24 resize-none`} placeholder="输入文本" />
      </div>
      {Object.entries(hashes).map(([algo, value]) => (
        <Out key={algo} label={algo} value={value} />
      ))}
    </div>
  )
}

function HmacTool() {
  const [text, setText] = useState('')
  const [key, setKey] = useState('')
  const [hmacs, setHmacs] = useState<Record<string, string>>({})
  const run = async (t: string, k: string) => {
    setText(t)
    setKey(k)
    if (!t) return setHmacs({})
    const enc = new TextEncoder()
    const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(k), { name: 'HMAC' }, false, ['sign'])
    const out: Record<string, string> = {}
    for (const algo of ['SHA-1', 'SHA-256', 'SHA-512']) {
      const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(t))
      out[algo] = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
    }
    setHmacs(out)
  }
  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">HMAC 签名计算。</p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className={LABEL}>密钥</div>
          <input value={key} onChange={(e) => run(text, e.target.value)} className={INPUT} placeholder="secret" />
        </div>
      </div>
      <div>
        <div className={LABEL}>消息</div>
        <textarea value={text} onChange={(e) => run(e.target.value, key)} className={`${INPUT} h-24 resize-none`} placeholder="输入文本" />
      </div>
      {Object.entries(hmacs).map(([algo, value]) => (
        <Out key={algo} label={`HMAC-${algo}`} value={value} />
      ))}
    </div>
  )
}

function TimeTool() {
  const [ts, setTs] = useState('')
  const [dateStr, setDateStr] = useState('')
  const parsedTs = useMemo(() => {
    if (!ts) return null
    const n = Number(ts)
    if (!Number.isFinite(n)) return null
    return n < 1e12 ? n * 1000 : n
  }, [ts])
  const parsedDate = useMemo(() => (dateStr ? new Date(dateStr) : null), [dateStr])
  const now = Date.now()
  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">Unix 时间戳与日期互转（秒/毫秒自适应）。</p>
      <div className="rounded bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm font-mono text-zinc-200 flex items-center gap-3">
        <span className="text-zinc-500">当前</span>
        <span className="text-sky-400">{Math.floor(now / 1000)}</span>
        <span className="text-zinc-600">({now} ms)</span>
      </div>
      <div>
        <div className={LABEL}>时间戳 → 日期</div>
        <input value={ts} onChange={(e) => setTs(e.target.value)} className={INPUT} placeholder="1758595200 或 1758595200000" />
      </div>
      <Out label="结果" value={parsedTs ? new Date(parsedTs).toLocaleString('zh-CN', { hour12: false }) : ''} />
      <div>
        <div className={LABEL}>日期 → 时间戳</div>
        <input value={dateStr} onChange={(e) => setDateStr(e.target.value)} className={INPUT} placeholder="2026-09-22 23:00:00" />
      </div>
      <Out
        label="结果"
        value={parsedDate && !Number.isNaN(parsedDate.getTime()) ? `${Math.floor(parsedDate.getTime() / 1000)} (${parsedDate.getTime()} ms)` : ''}
      />
    </div>
  )
}

function UuidTool() {
  const [uuids, setUuids] = useState<string[]>([])
  const gen = (n: number) => {
    const out: string[] = []
    for (let i = 0; i < n; i++) out.push(crypto.randomUUID())
    setUuids(out)
  }
  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">UUID v4 生成。</p>
      <div className="flex gap-2">
        {[1, 5, 10].map((n) => (
          <button
            key={n}
            onClick={() => gen(n)}
            className="px-3 py-1.5 rounded text-sm bg-sky-600/20 text-sky-400 hover:bg-sky-600/30"
          >
            生成 {n} 个
          </button>
        ))}
      </div>
      {uuids.length > 0 && (
        <div className="rounded bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800">
          {uuids.map((u) => (
            <div key={u} className="px-3 py-2 text-sm font-mono text-zinc-200 flex items-center gap-2">
              <span className="flex-1">{u}</span>
              <button
                onClick={() => navigator.clipboard.writeText(u)}
                className="text-[11px] text-sky-400 hover:text-sky-300"
              >
                复制
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AesTool() {
  const [text, setText] = useState('')
  const [password, setPassword] = useState('')
  const [cipher, setCipher] = useState('')
  const [result, setResult] = useState('')
  const [err, setErr] = useState('')

  const enc = new TextEncoder()

  async function deriveKey(pass: string): Promise<CryptoKey> {
    const salt = enc.encode('proxy-toolbox-aes-salt')
    const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey'])
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
  }

  const encrypt = async () => {
    setErr('')
    if (!text || !password) return setErr('请输入文本和密码')
    try {
      const key = await deriveKey(password)
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text))
      const buf = new Uint8Array(iv.length + ct.byteLength)
      buf.set(iv, 0)
      buf.set(new Uint8Array(ct), iv.length)
      const out = btoa(String.fromCharCode(...buf))
      setCipher(out)
      setResult(out)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const decrypt = async () => {
    setErr('')
    if (!cipher || !password) return setErr('请输入密文和密码')
    try {
      const buf = Uint8Array.from(atob(cipher), (c) => c.charCodeAt(0))
      const iv = buf.subarray(0, 12)
      const ct = buf.subarray(12)
      const key = await deriveKey(password)
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
      setResult(new TextDecoder().decode(pt))
    } catch {
      setErr('解密失败：密码错误或密文损坏')
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">AES-256-GCM 加解密（PBKDF2 派生密钥，输出 Base64，前 12 字节为 IV）。</p>
      <div>
        <div className={LABEL}>密码</div>
        <input value={password} onChange={(e) => setPassword(e.target.value)} className={INPUT} placeholder="secret" />
      </div>
      <div>
        <div className={LABEL}>明文 → 加密</div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} className={`${INPUT} h-20 resize-none`} placeholder="输入文本" />
        <button onClick={encrypt} className="mt-2 px-3 py-1.5 rounded text-sm bg-sky-600/20 text-sky-400 hover:bg-sky-600/30">
          加密
        </button>
      </div>
      <div>
        <div className={LABEL}>密文 → 解密</div>
        <textarea value={cipher} onChange={(e) => setCipher(e.target.value)} className={`${INPUT} h-20 resize-none`} placeholder="Base64 密文" />
        <button onClick={decrypt} className="mt-2 px-3 py-1.5 rounded text-sm bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30">
          解密
        </button>
      </div>
      {err && <div className="text-xs text-red-400">{err}</div>}
      {result && !err && <Out label="结果" value={result} />}
    </div>
  )
}

function QrTool() {
  const [text, setText] = useState('')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [error, setError] = useState(false)

  // canvas 首次输入才挂载，必须在挂载后绘制，故用 effect 而非 onChange
  useEffect(() => {
    if (!text) {
      setError(false)
      return
    }
    const canvas = canvasRef.current
    if (!canvas) return
    QRCode.toCanvas(canvas, text, { width: 220, margin: 2, color: { dark: '#0f172a', light: '#ffffff' } })
      .then(() => setError(false))
      .catch(() => setError(true))
  }, [text])

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">文本生成二维码（URL / 配对串等）。</p>
      <div>
        <div className={LABEL}>内容</div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} className={`${INPUT} h-20 resize-none`} placeholder="https://example.com" />
      </div>
      <div className="relative w-[224px] h-[224px] rounded bg-white border border-zinc-800 flex items-center justify-center overflow-hidden">
        <canvas ref={canvasRef} width={220} height={220} className={text && !error ? '' : 'invisible'} />
        {(!text || error) && (
          <span className="absolute inset-0 flex items-center justify-center text-xs text-zinc-500 bg-white">
            {error ? '内容过长或无法编码' : '输入内容生成二维码'}
          </span>
        )}
      </div>
    </div>
  )
}

function RegexTool() {
  const [pattern, setPattern] = useState('')
  const [flags, setFlags] = useState('g')
  const [text, setText] = useState('')
  const result = useMemo(() => {
    if (!pattern || !text) return null
    try {
      const re = new RegExp(pattern, flags)
      const matches = [...text.matchAll(re)]
      return { matches, error: null as string | null }
    } catch (e) {
      return { matches: [], error: e instanceof Error ? e.message : String(e) }
    }
  }, [pattern, flags, text])
  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">正则表达式测试。</p>
      <div className="flex gap-2">
        <div className="flex-1">
          <div className={LABEL}>正则</div>
          <input value={pattern} onChange={(e) => setPattern(e.target.value)} className={INPUT} placeholder="(\\w+)@(\\w+\\.com)" />
        </div>
        <div className="w-20">
          <div className={LABEL}>flags</div>
          <input value={flags} onChange={(e) => setFlags(e.target.value)} className={INPUT} />
        </div>
      </div>
      <div>
        <div className={LABEL}>测试文本</div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} className={`${INPUT} h-24 resize-none`} />
      </div>
      {result?.error && <div className="text-xs text-red-400">正则错误：{result.error}</div>}
      {result && !result.error && (
        <div>
          <div className={LABEL}>
            匹配结果（{result.matches.length} 个{result.matches.length > 0 ? '，高亮第一处' : ''}）
          </div>
          <div className="rounded bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm font-mono text-zinc-200 whitespace-pre-wrap break-all">
            {result.matches.length === 0 ? (
              <span className="text-zinc-600">无匹配</span>
            ) : (
              result.matches.map((m, i) => (
                <div key={i} className="py-0.5">
                  <span className="text-emerald-400">{m[0]}</span>
                  {m.length > 1 && <span className="text-zinc-500"> ← [{m.slice(1).join(', ')}]</span>}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
