import { useEffect, useState } from 'react'
import type { BodyContent, Flow } from '@proxy/shared'
import { call } from '../../api/client'
import { JsonView } from '../../components/JsonView'

type View = 'text' | 'json' | 'hex' | 'image'

export function BodyViewer({
  flowId,
  part,
  contentType,
  isText
}: {
  flowId: string
  part: 'req' | 'resp'
  contentType: string
  isText: boolean
}) {
  const [body, setBody] = useState<BodyContent | null>(null)
  const isImage = contentType.startsWith('image/')
  const [view, setView] = useState<View>(() => (isImage ? 'image' : isText ? 'text' : 'hex'))

  useEffect(() => {
    setBody(null)
    setView(isImage ? 'image' : isText ? 'text' : 'hex')
    let alive = true
    call('flows.getBody', { id: flowId, part })
      .then((r) => alive && setBody(r.body))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [flowId, part, contentType, isText])

  const views: View[] = isImage ? ['image', 'text', 'hex'] : isText ? ['text', 'json', 'hex'] : ['hex']

  const bytes = body?.base64
    ? Uint8Array.from(atob(body.base64), (c) => c.charCodeAt(0))
    : undefined

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-zinc-800 text-xs text-zinc-500 shrink-0">
        <span className="truncate" title={contentType}>
          {contentType || 'unknown'}
        </span>
        {body && <span>{body.size} bytes</span>}
        {body?.truncated && <span className="text-amber-500">已截断</span>}
        <span className="flex-1" />
        {views.map((v) => (
          <button
            key={v}
            onClick={() => setView(v as View)}
            className={`px-2 py-0.5 rounded ${view === v ? 'bg-sky-600/20 text-sky-400' : 'hover:text-zinc-300'}`}
          >
            {v}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-2 font-mono text-[12px] whitespace-pre-wrap break-all text-zinc-300">
        {!body && <span className="text-zinc-600">加载中…</span>}
        {body && body.size === 0 && <span className="text-zinc-600">(空)</span>}
        {body && body.size > 0 && view === 'text' && (body.text ?? '(二进制内容)')}
        {body && body.size > 0 && view === 'json' && <JsonView text={body.text} />}
        {body && body.size > 0 && view === 'hex' && bytes && hexDump(bytes)}
        {body && body.size > 0 && view === 'image' && bytes && (
          <img
            src={`data:${contentType};base64,${body.base64}`}
            alt="response body"
            className="max-w-full"
          />
        )}
      </div>
    </div>
  )
}

function hexDump(bytes: Uint8Array): string {
  const lines: string[] = []
  const n = Math.min(bytes.length, 4096)
  for (let i = 0; i < n; i += 16) {
    const chunk = bytes.subarray(i, Math.min(i + 16, n))
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = Array.from(chunk, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47, ' ')}  ${ascii}`)
  }
  if (bytes.length > n) lines.push(`… (${bytes.length - n} more bytes)`)
  return lines.join('\n')
}
