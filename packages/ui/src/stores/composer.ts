import { create } from 'zustand'
import type {
  CodegenLang,
  CollectionItem,
  ComposerCookie,
  ComposerEnv,
  ComposerHistoryEntry,
  ComposerSpec,
  Flow
} from '@proxy/shared'
import { call } from '../api/client'
import { useUiStore } from './ui'

export interface KV {
  key: string
  value: string
  enabled: boolean
}

/** form-data 行：isFile 时 filePath 为文件路径 */
export interface FormKV extends KV {
  isFile?: boolean
  filePath?: string
}

export type BodyType = 'none' | 'json' | 'text' | 'xml' | 'raw' | 'form-data' | 'urlencode' | 'file'

export type AuthType = 'none' | 'bearer' | 'basic' | 'custom'

export interface ComposerAuth {
  type: AuthType
  token?: string
  user?: string
  pass?: string
  headerKey?: string
  headerValue?: string
}

export interface ComposerDraft {
  method: string
  url: string
  params: KV[]
  headers: KV[]
  bodyType: BodyType
  bodyText: string
  bodyForm: FormKV[]
  bodyFilePath: string | null
  auth: ComposerAuth
  /** 发送前置脚本：ctx={method,url,headers,body,log} → return {method?,url?,headers?,body?} 改写最终请求 */
  preScript?: string
}

const emptyDraft: ComposerDraft = {
  method: 'GET',
  url: 'https://',
  params: [],
  headers: [],
  bodyType: 'none',
  bodyText: '',
  bodyForm: [],
  bodyFilePath: null,
  auth: { type: 'none' }
}

/** 一个 tab = 一份独立请求草稿及其发送结果 */
export interface ComposerTab {
  id: string
  draft: ComposerDraft
  resultFlowId: string | null
  resultError: string | null
  /** 最近一次发送/回填时的 draft 序列化；与当前 draft 不一致 = 有未发送修改 */
  sentSnapshot: string
}

const MAX_TABS = 10
let tabSeq = 0

function snapshotOf(draft: ComposerDraft): string {
  return JSON.stringify(draft)
}

function makeTab(draft?: ComposerDraft): ComposerTab {
  const d = draft ?? emptyDraft
  const copy = { ...d, params: [...d.params], headers: [...d.headers], bodyForm: [...d.bodyForm] }
  return {
    id: `t${++tabSeq}`,
    draft: copy,
    resultFlowId: null,
    resultError: null,
    sentSnapshot: snapshotOf(copy)
  }
}

/** localStorage 草稿持久化：只存 id/draft，响应结果与快照在恢复时重建 */
const STORAGE_KEY = 'composer.tabs.v1'

function persistTabs(tabs: ComposerTab[], activeTabId: string): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ tabs: tabs.map(({ id, draft }) => ({ id, draft })), activeTabId })
    )
  } catch {
    /* 配额满等异常时放弃持久化 */
  }
}

function restoreTabs(): { tabs: ComposerTab[]; activeTabId: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { tabs?: Array<{ id?: string; draft?: ComposerDraft }>; activeTabId?: string }
    if (!Array.isArray(parsed.tabs) || !parsed.tabs.length) return null
    const tabs: ComposerTab[] = []
    for (const t of parsed.tabs.slice(0, MAX_TABS)) {
      if (typeof t?.id !== 'string' || !t.draft || typeof t.draft.url !== 'string') continue
      const draft = { ...emptyDraft, ...t.draft }
      tabs.push({
        id: t.id,
        draft,
        resultFlowId: null,
        resultError: null,
        sentSnapshot: snapshotOf(draft)
      })
    }
    if (!tabs.length) return null
    const maxSeq = Math.max(...tabs.map((t) => Number(t.id.replace(/^t/, '')) || 0))
    tabSeq = Math.max(tabSeq, maxSeq)
    const activeTabId = tabs.some((t) => t.id === parsed.activeTabId) ? parsed.activeTabId! : tabs[0].id
    return { tabs, activeTabId }
  } catch {
    return null
  }
}

/** 引擎自动处理的头：锁标展示，不随 spec 发送 */
const AUTO_HEADERS = new Set(['host', 'content-length', 'connection'])

interface ComposerState {
  tabs: ComposerTab[]
  activeTabId: string
  sending: boolean
  sendError: string | null
  history: ComposerHistoryEntry[]
  envs: ComposerEnv[]
  activeEnvName: string | null
  cookies: ComposerCookie[]
  newTab: () => void
  closeTab: (id: string) => void
  switchTab: (id: string) => void
  resetTab: () => void
  clearTabs: () => void
  setDraft: (patch: Partial<ComposerDraft>) => void
  setUrl: (url: string) => void
  setParams: (params: KV[]) => void
  loadFromFlow: (flowId: string) => Promise<void>
  loadFromCollection: (item: CollectionItem) => void
  loadFromHistory: (entry: ComposerHistoryEntry) => void
  loadHistory: () => Promise<void>
  clearHistory: () => Promise<void>
  loadEnvs: () => Promise<void>
  setEnvs: (envs: ComposerEnv[], activeName: string | null) => Promise<void>
  loadCookies: () => Promise<void>
  setCookies: (cookies: ComposerCookie[]) => Promise<void>
  send: () => Promise<void>
  codegen: (lang: CodegenLang) => Promise<string>
}

export function activeTabOf(s: { tabs: ComposerTab[]; activeTabId: string }): ComposerTab {
  return s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0]
}

/** 满了先淘汰最旧的非活动 tab */
function withTab(s: ComposerState, tab: ComposerTab): Pick<ComposerState, 'tabs' | 'activeTabId'> {
  let tabs = s.tabs
  if (tabs.length >= MAX_TABS) {
    const victim = tabs.find((t) => t.id !== s.activeTabId) ?? tabs[0]
    tabs = tabs.filter((t) => t.id !== victim.id)
  }
  return { tabs: [...tabs, tab], activeTabId: tab.id }
}

function patchActiveDraft(s: ComposerState, patch: Partial<ComposerDraft>): Pick<ComposerState, 'tabs'> {
  return { tabs: s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, draft: { ...t.draft, ...patch } } : t)) }
}

/** 用当前环境的变量替换 {{key}}；未定义的变量原样保留 */
function substituteVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, key: string) => (key in vars ? vars[key] : m))
}

function activeVars(envs: ComposerEnv[], activeName: string | null): Record<string, string> {
  return envs.find((e) => e.name === activeName)?.vars ?? {}
}

/** URL query → KV 行 */
function parseQuery(url: string): KV[] {
  const idx = url.indexOf('?')
  if (idx < 0) return []
  return parsePairs(url.slice(idx + 1))
}

/** `a=1&b=2` 串 → KV 行（URL query 与 urlencoded body 共用） */
function parsePairs(qs: string): KV[] {
  const out: KV[] = []
  for (const pair of qs.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const k = eq < 0 ? pair : pair.slice(0, eq)
    const v = eq < 0 ? '' : pair.slice(eq + 1)
    const dec = (s: string): string => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    }
    out.push({ key: dec(k), value: dec(v), enabled: true })
  }
  return out
}

/** KV 行 → URL（保留 scheme/host/path，query 由参数重建） */
function buildUrl(url: string, params: KV[]): string {
  const idx = url.indexOf('?')
  const base = idx < 0 ? url : url.slice(0, idx)
  const active = params.filter((p) => p.enabled && p.key)
  if (!active.length) return base
  const qs = active
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join('&')
  return `${base}?${qs}`
}

/** 文本模式 → KV 行：`#` 前缀 = 停用行 */
export function parseKvText(text: string, sep: string): KV[] {
  const out: KV[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let enabled = true
    let s = line
    if (s.startsWith('#')) {
      enabled = false
      s = s.slice(1).trim()
    }
    const idx = s.indexOf(sep)
    out.push(idx < 0 ? { key: s, value: '', enabled } : { key: s.slice(0, idx).trim(), value: s.slice(idx + 1).trim(), enabled })
  }
  return out
}

/** KV 行 → 文本模式 */
export function kvTextOf(rows: KV[], sep: string): string {
  return rows.map((r) => `${r.enabled ? '' : '#'}${r.key}${sep}${r.value}`).join('\n')
}

/** Cookie 域匹配：`example.com` 匹配自身与子域；`.example.com` 同义 */
function cookieMatches(domain: string, host: string): boolean {
  const d = domain.toLowerCase()
  const h = host.toLowerCase()
  const bare = d.startsWith('.') ? d.slice(1) : d
  return h === bare || h.endsWith(`.${bare}`)
}

/** 发送 URL 命中的启用 Cookie → Cookie 头值；无命中返回 null */
export function cookieHeaderFor(cookies: ComposerCookie[], url: string): string | null {
  let host: string
  try {
    host = new URL(url).host
  } catch {
    return null
  }
  const matched = cookies.filter((c) => c.enabled && c.name && cookieMatches(c.domain, host))
  return matched.length ? matched.map((c) => `${c.name}=${c.value}`).join('; ') : null
}

/** 裸 HTTP 报文（请求行 + 头 + 空行 + body）→ ComposerDraft；无法解析返回 null */
export function parseRawHttp(text: string): ComposerDraft | null {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return null
  const split = normalized.indexOf('\n\n')
  const head = split < 0 ? normalized : normalized.slice(0, split)
  const body = split < 0 ? '' : normalized.slice(split + 2)
  const lines = head.split('\n').filter(Boolean)
  const reqLine = /^(\S+)\s+(\S+)(?:\s+(HTTP\/[\d.]+))?$/.exec(lines[0] ?? '')
  if (!reqLine) return null
  const [, method, target] = reqLine
  const headers: Array<{ name: string; value: string }> = []
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':')
    if (idx <= 0) return null
    headers.push({ name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() })
  }
  let url: string
  if (/^https?:\/\//i.test(target)) {
    url = target
  } else {
    const host = headers.find((h) => h.name.toLowerCase() === 'host')?.value
    if (!host) return null
    url = `http://${host}${target.startsWith('/') ? '' : '/'}${target}`
  }
  return draftFromRequest(method, url, headers, body)
}

/** cURL 命令 → ComposerDraft；无法解析返回 null */
export function parseCurl(text: string): ComposerDraft | null {
  const cmdline = text.replace(/\\\r?\n/g, ' ').trim()
  const m = /^curl\s+([\s\S]+)$/.exec(cmdline)
  if (!m) return null
  const tokens: string[] = []
  // 分词：单引号 / 双引号 / $'...'（ANSI-C，处理常见转义） / 裸串
  for (let i = 0; i < m[1].length; ) {
    const rest = m[1].slice(i)
    if (/\s/.test(rest[0])) {
      i++
      continue
    }
    if (rest.startsWith('$\'')) {
      const end = findQuoteEnd(rest, "'", 2)
      if (end < 0) return null
      tokens.push(unescapeAnsi(rest.slice(2, end)))
      i += end + 1
      continue
    }
    if (rest[0] === "'" || rest[0] === '"') {
      const q = rest[0]
      const end = findQuoteEnd(rest, q, 1)
      if (end < 0) return null
      tokens.push(q === '"' ? rest.slice(1, end).replace(/\\"/g, '"').replace(/\\'/g, "'") : rest.slice(1, end))
      i += end + 1
      continue
    }
    const next = rest.search(/\s/)
    const len = next < 0 ? rest.length : next
    tokens.push(rest.slice(0, len))
    i += len
  }

  let method: string | null = null
  let url = ''
  const headers: Array<{ name: string; value: string }> = []
  const datas: string[] = []
  let user: string | null = null
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const next = (): string => (i + 1 < tokens.length ? tokens[++i] : '')
    if (t === '-X' || t === '--request') method = next()
    else if (t === '-H' || t === '--header') {
      const h = next()
      const idx = h.indexOf(':')
      if (idx > 0) headers.push({ name: h.slice(0, idx).trim(), value: h.slice(idx + 1).trim() })
    } else if (t === '-b' || t === '--cookie') {
      const c = next()
      if (c && !c.includes(':')) headers.push({ name: 'Cookie', value: c })
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-ascii') {
      datas.push(next())
    } else if (t === '--data-urlencode') {
      datas.push(next().replace(/&/g, '%26').replace(/=/g, '%3D'))
    } else if (t === '-u' || t === '--user') {
      user = next()
    } else if (t === '--url') {
      url = next()
    } else if (!t.startsWith('-') && !url && /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
      url = t
    } else if (!t.startsWith('-') && !url && t.includes('.')) {
      url = `https://${t}`
    }
  }
  if (!url) return null

  const data = datas.join('&')
  if (data && !headers.some((h) => h.name.toLowerCase() === 'content-type')) {
    headers.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' })
  }
  const finalMethod = (method ?? (data ? 'POST' : 'GET')).toUpperCase()
  const draft = draftFromRequest(finalMethod, url, headers, data)
  if (user && draft.auth.type === 'none') {
    const colon = user.indexOf(':')
    draft.auth = { type: 'basic', user: colon < 0 ? user : user.slice(0, colon), pass: colon < 0 ? '' : user.slice(colon + 1) }
  }
  return draft
}

function findQuoteEnd(s: string, quote: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') {
      i++
      continue
    }
    if (s[i] === quote) return i
  }
  return -1
}

function unescapeAnsi(s: string): string {
  return s.replace(/\\(n|r|t|\\|'")/g, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c))
}

export const BODY_TYPE_LABELS: Record<BodyType, string> = {
  none: '无',
  json: 'JSON',
  text: 'Text',
  xml: 'XML',
  raw: 'Raw',
  'form-data': 'Form-data',
  urlencode: 'Urlencode',
  file: '文件'
}

export const AUTH_TYPE_LABELS: Record<AuthType, string> = {
  none: '无',
  bearer: 'Bearer Token',
  basic: 'Basic Auth',
  custom: '自定义头'
}

function contentTypeOfBody(type: BodyType): string | null {
  switch (type) {
    case 'json':
      return 'application/json'
    case 'text':
      return 'text/plain'
    case 'xml':
      return 'application/xml'
    case 'form-data':
      return null // multipart 带 boundary，发送时生成
    case 'urlencode':
      return 'application/x-www-form-urlencoded'
    case 'file':
      return 'application/octet-stream'
    default:
      return null
  }
}

/** 授权配置 → 注入的请求头（关键字段为空则跳过） */
function authHeadersOf(auth: ComposerAuth, vars: Record<string, string>): Array<{ name: string; value: string }> {
  switch (auth.type) {
    case 'bearer': {
      const token = substituteVars(auth.token ?? '', vars).trim()
      return token ? [{ name: 'Authorization', value: `Bearer ${token}` }] : []
    }
    case 'basic': {
      const user = substituteVars(auth.user ?? '', vars)
      const pass = substituteVars(auth.pass ?? '', vars)
      if (!user && !pass) return []
      return [{ name: 'Authorization', value: `Basic ${utf8ToBase64(`${user}:${pass}`)}` }]
    }
    case 'custom': {
      const name = substituteVars(auth.headerKey ?? '', vars).trim()
      if (!name) return []
      return [{ name, value: substituteVars(auth.headerValue ?? '', vars).trim() }]
    }
    default:
      return []
  }
}

/** 从请求头里识别 Authorization → 授权 tab（仅 Bearer/Basic，其余留在请求头表格） */
function extractAuth(headers: Array<{ name: string; value: string }>): ComposerAuth {
  const h = headers.find((x) => x.name.toLowerCase() === 'authorization')
  if (!h) return { type: 'none' }
  const v = h.value.trim()
  const bearer = /^Bearer\s+(.+)$/i.exec(v)
  if (bearer) return { type: 'bearer', token: bearer[1] }
  if (/^Basic\s+\S+/i.test(v)) {
    try {
      const decoded = base64ToUtf8(v.replace(/^Basic\s+/i, ''))
      const colon = decoded.indexOf(':')
      return {
        type: 'basic',
        user: colon < 0 ? decoded : decoded.slice(0, colon),
        pass: colon < 0 ? '' : decoded.slice(colon + 1)
      }
    } catch {
      /* 非法 base64：留在请求头表格 */
    }
  }
  return { type: 'none' }
}

/** multipart/form-data 组包（含文件行）。
 *  渲染进程无 Node Buffer，全部走 Uint8Array + btoa/atob。 */
async function buildMultipart(rows: FormKV[]): Promise<{ bodyBase64: string; contentType: string }> {
  const boundary = `----prism${Math.random().toString(16).slice(2)}`
  const parts: Uint8Array[] = []
  for (const r of rows) {
    if (!r.enabled || !r.key) continue
    if (r.isFile && r.filePath) {
      const res = await call('app.readFileBase64', { path: r.filePath })
      if (!res.ok || !res.base64) throw new Error(`无法读取文件：${r.filePath}`)
      const name = r.filePath.split('/').pop() ?? 'file'
      parts.push(
        utf8Bytes(`--${boundary}\r\nContent-Disposition: form-data; name="${r.key}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        base64ToBytes(res.base64),
        utf8Bytes('\r\n')
      )
    } else {
      parts.push(utf8Bytes(`--${boundary}\r\nContent-Disposition: form-data; name="${r.key}"\r\n\r\n${r.value}\r\n`))
    }
  }
  parts.push(utf8Bytes(`--${boundary}--\r\n`))
  return {
    bodyBase64: bytesToBase64(concatBytes(parts)),
    contentType: `multipart/form-data; boundary=${boundary}`
  }
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function draftFromRequest(
  method: string,
  url: string,
  headers: Array<{ name: string; value: string }>,
  bodyText: string
): ComposerDraft {
  const contentType = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? ''
  const ct = contentType.toLowerCase()
  let bodyType: BodyType = 'none'
  let bodyForm: FormKV[] = []
  if (bodyText) {
    if (ct.includes('json')) {
      bodyType = 'json'
      try {
        bodyText = JSON.stringify(JSON.parse(bodyText), null, 2)
      } catch {
        /* 非法 JSON 原样保留 */
      }
    } else if (ct.includes('x-www-form-urlencoded')) {
      bodyType = 'urlencode'
      bodyForm = parsePairs(bodyText)
    } else if (ct.includes('xml')) {
      bodyType = 'xml'
    } else if (ct.startsWith('text/')) {
      bodyType = 'text'
    } else {
      bodyType = 'raw'
    }
  }
  const auth = extractAuth(headers)
  const authHeader = auth.type === 'none' ? null : headers.find((x) => x.name.toLowerCase() === 'authorization')
  return {
    method,
    url,
    params: parseQuery(url),
    headers: headers
      .filter((h) => !AUTO_HEADERS.has(h.name.toLowerCase()) && h !== authHeader)
      .map((h) => ({ key: h.name, value: h.value, enabled: true })),
    bodyType,
    bodyText: bodyType === 'urlencode' ? '' : bodyText,
    bodyForm,
    bodyFilePath: null,
    auth
  }
}

function collectionToDraft(item: CollectionItem): ComposerDraft {
  let text = ''
  try {
    text = base64ToUtf8(item.request.bodyBase64)
  } catch {
    text = ''
  }
  return draftFromRequest(item.request.method, item.request.url, item.request.headers, text)
}

/** draft → 实际发送的 spec（变量替换 + 授权头 + 自动 Content-Type + Cookie 注入）；发送与代码生成共用 */
async function buildSpec(
  draft: ComposerDraft,
  vars: Record<string, string>,
  cookies: ComposerCookie[]
): Promise<ComposerSpec> {
  const url = substituteVars(buildUrl(draft.url, draft.params), vars)
  const authHeaders = authHeadersOf(draft.auth, vars)
  const authNames = new Set(authHeaders.map((h) => h.name.toLowerCase()))
  const headers = draft.headers
    .filter((h) => h.enabled && h.key && !AUTO_HEADERS.has(h.key.trim().toLowerCase()))
    .map((h) => ({ name: substituteVars(h.key, vars).trim(), value: substituteVars(h.value, vars).trim() }))
    .filter((h) => h.name && !authNames.has(h.name.toLowerCase()))

  let bodyBase64 = ''
  let contentType = contentTypeOfBody(draft.bodyType)
  switch (draft.bodyType) {
    case 'none':
      break
    case 'json':
    case 'text':
    case 'xml':
    case 'raw':
      bodyBase64 = utf8ToBase64(substituteVars(draft.bodyText, vars))
      break
    case 'form-data': {
      const rows = draft.bodyForm.map((r) => ({
        ...r,
        key: substituteVars(r.key, vars),
        value: substituteVars(r.value, vars)
      }))
      const built = await buildMultipart(rows)
      bodyBase64 = built.bodyBase64
      contentType = built.contentType
      break
    }
    case 'urlencode': {
      const active = draft.bodyForm.filter((r) => r.enabled && r.key)
      bodyBase64 = utf8ToBase64(
        active
          .map((r) => `${encodeURIComponent(substituteVars(r.key, vars))}=${encodeURIComponent(substituteVars(r.value, vars))}`)
          .join('&')
      )
      break
    }
    case 'file': {
      if (draft.bodyFilePath) {
        const res = await call('app.readFileBase64', { path: draft.bodyFilePath })
        if (!res.ok || !res.base64) throw new Error(`无法读取文件：${draft.bodyFilePath}`)
        bodyBase64 = res.base64
      }
      break
    }
  }
  if (contentType && !authNames.has('content-type') && !headers.some((h) => h.name.toLowerCase() === 'content-type')) {
    headers.push({ name: 'Content-Type', value: contentType })
  }
  if (!authNames.has('cookie') && !headers.some((h) => h.name.toLowerCase() === 'cookie')) {
    const cookieHeader = cookieHeaderFor(cookies, url)
    if (cookieHeader) headers.push({ name: 'Cookie', value: cookieHeader })
  }
  headers.push(...authHeaders)

  return {
    method: draft.method,
    url,
    headers,
    bodyBase64
  }
}

export function collectionToSpec(item: CollectionItem): ComposerSpec {
  return {
    method: item.request.method,
    url: item.request.url,
    headers: item.request.headers,
    bodyBase64: item.request.bodyBase64
  }
}

/** 把活动 tab 的快照重置为当前 draft（回填/重置后视为干净） */
function snapshotActive(s: ComposerState): Pick<ComposerState, 'tabs'> {
  return {
    tabs: s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, sentSnapshot: snapshotOf(t.draft) } : t))
  }
}

const restored = restoreTabs()
const initialTab = makeTab()

/** 运行前置脚本：ctx={method,url,headers,body,log}，返回 patch 改写 spec；出错抛出 */
function runPreScript(script: string, spec: ComposerSpec): ComposerSpec {
  const logs: string[] = []
  const ctx = {
    method: spec.method,
    url: spec.url,
    headers: spec.headers,
    body: spec.bodyBase64 ? base64ToUtf8(spec.bodyBase64) : '',
    log: (m: unknown): void => {
      logs.push(String(m))
    }
  }
  const fn = new Function('ctx', script) as (c: typeof ctx) => unknown
  const patch = fn(ctx)
  if (logs.length) console.info('[composer preScript]', logs.join('\n'))
  if (!patch || typeof patch !== 'object') return spec
  const p = patch as {
    method?: unknown
    url?: unknown
    headers?: unknown
    body?: unknown
  }
  const next: ComposerSpec = {
    method: typeof p.method === 'string' && p.method ? p.method.toUpperCase() : spec.method,
    url: typeof p.url === 'string' && p.url ? p.url : spec.url,
    headers: Array.isArray(p.headers)
      ? (p.headers as Array<{ name: string; value: string }>).filter(
          (h) => h && typeof h.name === 'string' && h.name
        )
      : spec.headers,
    bodyBase64: typeof p.body === 'string' ? utf8ToBase64(p.body) : spec.bodyBase64
  }
  return next
}

export const useComposerStore = create<ComposerState>((set) => ({
  tabs: restored?.tabs ?? [initialTab],
  activeTabId: restored?.activeTabId ?? initialTab.id,
  sending: false,
  sendError: null,
  history: [],
  envs: [],
  activeEnvName: null,
  cookies: [],
  newTab: () => set((s) => withTab(s, makeTab())),
  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id)
      if (idx < 0) return s
      const tabs = s.tabs.filter((t) => t.id !== id)
      if (!tabs.length) {
        const t = makeTab()
        return { tabs: [t], activeTabId: t.id }
      }
      const activeTabId = s.activeTabId === id ? (tabs[idx] ?? tabs[Math.max(0, idx - 1)]).id : s.activeTabId
      return { tabs, activeTabId }
    }),
  switchTab: (id) => set({ activeTabId: id }),
  setDraft: (patch) => set((s) => patchActiveDraft(s, patch)),
  setUrl: (url) => set((s) => patchActiveDraft(s, { url, params: parseQuery(url) })),
  setParams: (params) =>
    set((s) => patchActiveDraft(s, { params, url: buildUrl(activeTabOf(s).draft.url, params) })),
  loadFromFlow: async (flowId) => {
    const { flow } = await call('flows.get', { id: flowId })
    if (!flow?.request) return
    const req = flow.request
    set((s) => withTab(s, makeTab(draftFromRequest(req.method, req.url, req.headers, ''))))
    const { body } = await call('flows.getBody', { id: flowId, part: 'req' })
    if (body?.text) {
      set((s) =>
        patchActiveDraft(s, draftFromRequest(req.method, req.url, req.headers, body.text!))
      )
      // 回填 body 后重置快照，避免把异步加载的 body 误判为用户修改
      set((s) => snapshotActive(s))
    }
    useUiStore.getState().setPage('composer')
  },
  loadFromCollection: (item) => {
    set((s) => withTab(s, makeTab(collectionToDraft(item))))
    useUiStore.getState().setPage('composer')
  },
  loadFromHistory: (entry) => {
    const spec = entry.spec
    let text = ''
    try {
      text = base64ToUtf8(spec.bodyBase64)
    } catch {
      text = ''
    }
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== s.activeTabId) return t
        const draft = draftFromRequest(spec.method, spec.url, spec.headers, text)
        return { ...t, draft, resultFlowId: null, resultError: null, sentSnapshot: snapshotOf(draft) }
      })
    }))
  },
  loadHistory: async () => {
    try {
      const { history } = await call('composer.history')
      set({ history })
    } catch {
      /* 主进程未就绪时忽略 */
    }
  },
  clearHistory: async () => {
    try {
      await call('composer.clearHistory')
      set({ history: [] })
    } catch {
      /* ignore */
    }
  },
  loadEnvs: async () => {
    try {
      const r = await call('composer.envs')
      set({ envs: r.envs, activeEnvName: r.activeName })
    } catch {
      /* 主进程未就绪时忽略 */
    }
  },
  setEnvs: async (envs, activeName) => {
    try {
      const r = await call('composer.setEnvs', { envs, activeName })
      set({ envs: r.envs, activeEnvName: r.activeName })
    } catch {
      /* ignore */
    }
  },
  loadCookies: async () => {
    try {
      const r = await call('composer.cookies')
      set({ cookies: r.cookies })
    } catch {
      /* 主进程未就绪时忽略 */
    }
  },
  setCookies: async (cookies) => {
    try {
      const r = await call('composer.setCookies', { cookies })
      set({ cookies: r.cookies })
    } catch {
      /* ignore */
    }
  },
  resetTab: () =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === s.activeTabId
          ? { ...t, draft: { ...emptyDraft }, resultFlowId: null, resultError: null, sentSnapshot: snapshotOf(emptyDraft) }
          : t
      )
    })),
  clearTabs: () => {
    const t = makeTab()
    set({ tabs: [t], activeTabId: t.id })
  },
  send: async () => {
    const s0 = useComposerStore.getState()
    const tab = activeTabOf(s0)
    const vars = activeVars(s0.envs, s0.activeEnvName)
    set((s) => ({
      sending: true,
      sendError: null,
      tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, resultFlowId: null, resultError: null } : t))
    }))
    try {
      let spec: ComposerSpec
      try {
        spec = await buildSpec(tab.draft, vars, s0.cookies)
        if (tab.draft.preScript?.trim()) spec = runPreScript(tab.draft.preScript, spec)
      } catch (err) {
        throw new Error(`前置脚本错误：${err instanceof Error ? err.message : String(err)}`)
      }
      const r = await call('composer.send', { spec })
      set((s) => ({
        sending: false,
        tabs: s.tabs.map((t) =>
          t.id === tab.id ? { ...t, resultFlowId: r.flowId, sentSnapshot: snapshotOf(tab.draft) } : t
        )
      }))
      void useComposerStore.getState().loadHistory()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set((s) => ({
        sending: false,
        sendError: msg,
        tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, resultError: msg } : t))
      }))
    }
  },
  codegen: async (lang) => {
    const s0 = useComposerStore.getState()
    const vars = activeVars(s0.envs, s0.activeEnvName)
    const spec = await buildSpec(activeTabOf(s0).draft, vars, s0.cookies)
    const r = await call('composer.codegen', { spec, lang })
    return r.code
  }
}))

useComposerStore.subscribe((s, prev) => {
  if (s.tabs !== prev.tabs || s.activeTabId !== prev.activeTabId) {
    persistTabs(s.tabs, s.activeTabId)
  }
})

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export function base64ToUtf8(b64: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}
