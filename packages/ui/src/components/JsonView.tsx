import { createElement, type ReactNode } from 'react'

const TOKEN_RE =
  /"(?:[^"\\]|\\.)*"\s*:|"(?:[^"\\]|\\.)*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],:]|\s+|[^\s]/g

const HIGHLIGHT_LIMIT = 200_000

/** JSON 词法着色：键/字符串/数字/字面量/标点五类 token，颜色来自 --code-* 变量（15 种代码配色） */
export function jsonNodes(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let m: RegExpExecArray | null
  let i = 0
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const t = m[0]
    let cls: string | null = null
    if (t.startsWith('"')) cls = /:\s*$/u.test(t) ? 'tj-key' : 'tj-str'
    else if (t === 'true' || t === 'false' || t === 'null') cls = 'tj-lit'
    else if (/^-?\d/.test(t)) cls = 'tj-num'
    else if (t.trim() !== '') cls = 'tj-punct'
    nodes.push(cls ? createElement('span', { key: i++, className: cls }, t) : t)
  }
  return nodes
}

/** 合法 JSON 才着色；超长或非法时退回纯文本 */
export function JsonView({ text }: { text: string | undefined }): ReactNode {
  if (!text) return '(无文本内容)'
  try {
    const pretty = JSON.stringify(JSON.parse(text), null, 2)
    if (pretty.length > HIGHLIGHT_LIMIT) return pretty
    return jsonNodes(pretty)
  } catch {
    return '(不是合法 JSON)\n\n' + text
  }
}
