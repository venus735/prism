import { useMemo, useState } from 'react'

export interface DiffScalarLine {
  label: string
  l: string
  r: string
}

export interface DiffPayload {
  lines: DiffScalarLine[]
  lHeaders: Array<{ name: string; value: string }>
  rHeaders: Array<{ name: string; value: string }>
  lBody: string
  rBody: string
  lTitle: string
  rTitle: string
}

export function DiffModal({
  title,
  tabs,
  onClose
}: {
  title: string
  tabs: { id: string; label: string; payload: DiffPayload | null }[]
  onClose: () => void
}) {
  const available = tabs.filter((t) => t.payload)
  const [active, setActive] = useState(available[0]?.id ?? '')
  const current = tabs.find((t) => t.id === active)?.payload ?? available[0]?.payload ?? null
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-5xl h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800">
          <span className="text-sm text-zinc-200 font-medium">{title}</span>
          <span className="flex-1" />
          {available.length > 1 &&
            available.map((t) => (
              <button
                key={t.id}
                onClick={() => setActive(t.id)}
                className={`px-3 py-1 rounded text-xs ${
                  active === t.id ? 'bg-sky-600/20 text-sky-400' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          <button onClick={onClose} className="ml-2 px-2 py-0.5 text-zinc-500 hover:text-zinc-200 text-sm">
            ✕
          </button>
        </div>
        {current ? <DiffBody p={current} /> : null}
      </div>
    </div>
  )
}

function DiffBody({ p }: { p: DiffPayload }) {
  const headerLines = useMemo(() => {
    const names: string[] = []
    for (const h of p.lHeaders) if (!names.includes(h.name.toLowerCase())) names.push(h.name.toLowerCase())
    for (const h of p.rHeaders) if (!names.includes(h.name.toLowerCase())) names.push(h.name.toLowerCase())
    names.sort()
    const find = (hs: Array<{ name: string; value: string }>, n: string) =>
      hs.find((h) => h.name.toLowerCase() === n)
    const out: DiffScalarLine[] = []
    for (const n of names) {
      const lh = find(p.lHeaders, n)
      const rh = find(p.rHeaders, n)
      out.push({ label: lh?.name ?? rh?.name ?? n, l: lh?.value ?? '(缺失)', r: rh?.value ?? '(缺失)' })
    }
    return out
  }, [p.lHeaders, p.rHeaders])

  const bodyDiff = useMemo(() => lineDiff(p.lBody, p.rBody), [p.lBody, p.rBody])
  const scalarDiff = useMemo(() => p.lines.map((x) => ({ ...x, same: x.l === x.r })), [p.lines])
  const allHeadersSame = headerLines.every((x) => x.l === x.r)

  return (
    <div className="flex-1 overflow-auto p-3 space-y-3 font-mono text-[12px]">
      <div className="grid grid-cols-[110px_1fr_1fr] gap-px rounded border border-zinc-800 overflow-hidden">
        <div className="bg-zinc-900 text-zinc-500 px-2 py-1">字段</div>
        <div className="bg-zinc-900 text-zinc-500 px-2 py-1 truncate">{p.lTitle}</div>
        <div className="bg-zinc-900 text-zinc-500 px-2 py-1 truncate">{p.rTitle}</div>
        {scalarDiff.map((x) => (
          <Row3 key={x.label} label={x.label} l={x.l} r={x.r} same={x.same} />
        ))}
      </div>

      <div className="rounded border border-zinc-800 overflow-hidden">
        <div className="bg-zinc-900 text-zinc-500 px-2 py-1">
          Headers {allHeadersSame ? '（一致）' : ''}
        </div>
        <div className="grid grid-cols-[110px_1fr_1fr] gap-px">
          {headerLines.map((x, i) => (
            <Row3 key={`${x.label}-${i}`} label={x.label} l={x.l} r={x.r} same={x.l === x.r} />
          ))}
        </div>
      </div>

      <div className="rounded border border-zinc-800 overflow-hidden">
        <div className="bg-zinc-900 text-zinc-500 px-2 py-1">
          Body{bodyDiff.some((l) => l.type !== 'same') ? '' : '（一致）'}
        </div>
        <div className="max-h-[45vh] overflow-auto">
          {bodyDiff.map((l, i) => (
            <div
              key={i}
              className={`grid grid-cols-2 gap-px ${
                l.type === 'same' ? '' : l.type === 'left' ? 'bg-red-950/40' : 'bg-emerald-950/40'
              }`}
            >
              <div className={`px-2 whitespace-pre-wrap break-all ${l.type === 'left' ? 'text-red-300' : 'text-zinc-400'}`}>
                {l.type === 'right' ? '' : l.text || ' '}
              </div>
              <div className={`px-2 whitespace-pre-wrap break-all ${l.type === 'right' ? 'text-emerald-300' : 'text-zinc-400'}`}>
                {l.type === 'left' ? '' : l.text || ' '}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Row3({ label, l, r, same }: { label: string; l: string; r: string; same: boolean }) {
  return (
    <>
      <div className="bg-zinc-900/60 text-zinc-500 px-2 py-0.5 truncate">{label}</div>
      <div className={`px-2 py-0.5 break-all ${same ? 'text-zinc-400' : 'text-red-300 bg-red-950/40'}`}>{l}</div>
      <div className={`px-2 py-0.5 break-all ${same ? 'text-zinc-400' : 'text-emerald-300 bg-emerald-950/40'}`}>{r}</div>
    </>
  )
}

type DiffLine = { type: 'same' | 'left' | 'right'; text: string }

/** 简易 LCS 行级 diff */
function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.length ? a.split('\n') : []
  const B = b.length ? b.split('\n') : []
  const n = A.length
  const m = B.length
  if (n * m > 4_000_000) {
    return [...A.map((t) => ({ type: 'left' as const, text: t })), ...B.map((t) => ({ type: 'right' as const, text: t }))]
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ type: 'same', text: A[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'left', text: A[i] })
      i++
    } else {
      out.push({ type: 'right', text: B[j] })
      j++
    }
  }
  while (i < n) out.push({ type: 'left', text: A[i++] })
  while (j < m) out.push({ type: 'right', text: B[j++] })
  return out
}
