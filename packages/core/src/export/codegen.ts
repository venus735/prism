import type { CodegenLang, Flow, HeaderPair } from '@proxy/shared'

export interface CodegenInput {
  flow: Flow
  /** 请求 body 明文（已解压）；二进制/过大时为 null */
  requestBody: string | null
}

export function generateCode(lang: CodegenLang, input: CodegenInput): string {
  if (!input.flow.request) return `# no request to generate ${lang} code from`
  switch (lang) {
    case 'curl':
      return genCurl(input)
    case 'python':
      return genPython(input)
    case 'fetch':
      return genFetch(input)
    case 'axios':
      return genAxios(input)
    case 'go':
      return genGo(input)
  }
}

// ------------------------------------------------------------------
// 公共处理
// ------------------------------------------------------------------

/** 生成代码中不应携带的头：逐跳头 / 代理头 / 由运行时重算的头 */
function usableHeaders(flow: Flow): HeaderPair[] {
  const skip = new Set([
    'host',
    'content-length',
    'transfer-encoding',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'upgrade'
  ])
  return (flow.request?.headers ?? []).filter((h) => {
    const n = h.name.toLowerCase()
    return !skip.has(n) && !n.startsWith('proxy-')
  })
}

function method(flow: Flow): string {
  return flow.request?.method ?? 'GET'
}

function sanitizedUrl(flow: Flow): string {
  const url = flow.request?.url ?? ''
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return url
  }
}

function isJsonRequest(flow: Flow, body: string | null): body is string {
  const ct = (flow.request?.body.contentType ?? '').toLowerCase()
  if (!body || !ct.includes('json')) return false
  try {
    JSON.parse(body)
    return true
  } catch {
    return false
  }
}

function hasBody(flow: Flow, requestBody: string | null): boolean {
  const m = method(flow)
  if (m === 'GET' || m === 'HEAD') return false
  const size = flow.request?.body.size ?? 0
  return size > 0 || requestBody !== null
}

/** body 三态：json（可解析的 JSON 文本）/ text（普通文本）/ binary（占位） */
type BodyKind = { kind: 'none' } | { kind: 'json'; text: string } | { kind: 'text'; text: string } | { kind: 'binary' }

function bodyKind(input: CodegenInput): BodyKind {
  const { flow, requestBody } = input
  if (!hasBody(flow, requestBody)) return { kind: 'none' }
  if (requestBody === null) return { kind: 'binary' }
  if (isJsonRequest(flow, requestBody)) return { kind: 'json', text: requestBody }
  return { kind: 'text', text: requestBody }
}

// ------------------------------------------------------------------
// cURL
// ------------------------------------------------------------------

function genCurl(input: CodegenInput): string {
  const parts: string[] = [`curl -X ${method(input.flow)}`]
  parts.push(shQuote(sanitizedUrl(input.flow)))
  for (const h of usableHeaders(input.flow)) {
    parts.push(`-H ${shQuote(`${h.name}: ${h.value}`)}`)
  }
  const body = bodyKind(input)
  if (body.kind !== 'none') {
    const data = body.kind === 'binary' ? '<binary request body>' : body.text
    parts.push(`--data-raw ${shQuote(data)}`)
  }
  return parts.join(' \\\n  ')
}

function shQuote(s: string): string {
  if (/^[A-Za-z0-9_\-:/.@]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// ------------------------------------------------------------------
// Python requests
// ------------------------------------------------------------------

function genPython(input: CodegenInput): string {
  const headers = usableHeaders(input.flow)
  const body = bodyKind(input)
  const lines: string[] = ['import requests', '']
  lines.push(`url = ${pyStr(sanitizedUrl(input.flow))}`)
  if (headers.length > 0) {
    lines.push('headers = {')
    for (const h of headers) lines.push(`    ${pyStr(h.name)}: ${pyStr(h.value)},`)
    lines.push('}')
  }
  let bodyArg = ''
  if (body.kind === 'json') {
    lines.push(`json_body = ${pyJson(body.text)}`)
    bodyArg = ', json=json_body'
  } else if (body.kind === 'text') {
    lines.push(`data = ${pyStr(body.text)}`)
    bodyArg = ', data=data'
  } else if (body.kind === 'binary') {
    lines.push(`data = b'<binary request body>'`)
    bodyArg = ', data=data'
  }
  lines.push('')
  lines.push(
    `response = requests.request(${pyStr(method(input.flow))}, url${headers.length ? ', headers=headers' : ''}${bodyArg})`
  )
  lines.push('print(response.status_code)')
  lines.push('print(response.text)')
  return lines.join('\n')
}

function pyStr(s: string): string {
  return JSON.stringify(s)
}

function pyJson(json: string): string {
  return JSON.stringify(JSON.parse(json), null, 4)
}

// ------------------------------------------------------------------
// JS fetch / Node axios
// ------------------------------------------------------------------

function jsStr(s: string): string {
  return JSON.stringify(s)
}

function jsonJsLiteral(json: string): string {
  return JSON.stringify(JSON.parse(json), null, 2)
}

function genFetch(input: CodegenInput): string {
  const headers = usableHeaders(input.flow)
  const body = bodyKind(input)
  const lines: string[] = []
  lines.push(`fetch(${jsStr(sanitizedUrl(input.flow))}, {`)
  lines.push(`  method: ${jsStr(method(input.flow))},`)
  if (headers.length > 0) {
    lines.push('  headers: {')
    for (const h of headers) lines.push(`    ${jsStr(h.name)}: ${jsStr(h.value)},`)
    lines.push('  },')
  }
  if (body.kind === 'json') {
    lines.push(`  body: JSON.stringify(${jsonJsLiteral(body.text)}),`)
  } else if (body.kind === 'text') {
    lines.push(`  body: ${jsStr(body.text)},`)
  } else if (body.kind === 'binary') {
    lines.push(`  body: ${jsStr('<binary request body>')},`)
  }
  lines.push('})')
  lines.push('  .then((res) => res.text())')
  lines.push('  .then((text) => console.log(text))')
  lines.push('  .catch((err) => console.error(err))')
  return lines.join('\n')
}

function genAxios(input: CodegenInput): string {
  const headers = usableHeaders(input.flow)
  const body = bodyKind(input)
  const lines: string[] = ["import axios from 'axios'", '']
  lines.push('const { data } = await axios({')
  lines.push(`  url: ${jsStr(sanitizedUrl(input.flow))},`)
  lines.push(`  method: ${jsStr(method(input.flow))},`)
  if (headers.length > 0) {
    lines.push('  headers: {')
    for (const h of headers) lines.push(`    ${jsStr(h.name)}: ${jsStr(h.value)},`)
    lines.push('  },')
  }
  if (body.kind === 'json') {
    lines.push(`  data: ${jsonJsLiteral(body.text)},`)
  } else if (body.kind === 'text' || body.kind === 'binary') {
    lines.push(`  data: ${jsStr(body.kind === 'binary' ? '<binary request body>' : body.text)},`)
  }
  lines.push('})')
  lines.push('')
  lines.push('console.log(data)')
  return lines.join('\n')
}

// ------------------------------------------------------------------
// Go net/http
// ------------------------------------------------------------------

function goStr(s: string): string {
  return JSON.stringify(s)
}

function genGo(input: CodegenInput): string {
  const headers = usableHeaders(input.flow)
  const body = bodyKind(input)
  const hasBodyReader = body.kind !== 'none'
  const lines: string[] = []
  lines.push('package main')
  lines.push('')
  lines.push('import (')
  lines.push('\t"fmt"')
  if (hasBodyReader) lines.push('\t"io"')
  lines.push('\t"net/http"')
  if (hasBodyReader) lines.push('\t"strings"')
  lines.push(')')
  lines.push('')
  lines.push('func main() {')
  const bodyExpr =
    body.kind === 'json' || body.kind === 'text'
      ? `strings.NewReader(${goStr(body.text)})`
      : body.kind === 'binary'
        ? `strings.NewReader(${goStr('<binary request body>')})`
        : 'nil'
  lines.push(`\treq, err := http.NewRequest(${goStr(method(input.flow))}, ${goStr(sanitizedUrl(input.flow))}, ${bodyExpr})`)
  lines.push('\tif err != nil {')
  lines.push('\t\tpanic(err)')
  lines.push('\t}')
  for (const h of headers) {
    lines.push(`\treq.Header.Set(${goStr(h.name)}, ${goStr(h.value)})`)
  }
  lines.push('')
  lines.push('\tres, err := http.DefaultClient.Do(req)')
  lines.push('\tif err != nil {')
  lines.push('\t\tpanic(err)')
  lines.push('\t}')
  lines.push('\tdefer res.Body.Close()')
  lines.push('')
  lines.push('\tfmt.Println(res.Status)')
  if (hasBodyReader) {
    lines.push('\tbody, _ := io.ReadAll(res.Body)')
    lines.push('\tfmt.Println(string(body))')
  }
  lines.push('}')
  return lines.join('\n')
}
