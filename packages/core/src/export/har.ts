import type { BodyMeta, Flow, FlowState, HeaderPair } from '@proxy/shared'
import { decompress, decodeBytes, isTextualContentType } from '../capture/body'

export interface HarNameValuePair {
  name: string
  value: string
}

export interface HarContent {
  size: number
  mimeType: string
  text?: string
  encoding?: string
  comment?: string
}

export interface HarRequest {
  method: string
  url: string
  httpVersion: string
  cookies: HarNameValuePair[]
  headers: HarNameValuePair[]
  queryString: HarNameValuePair[]
  postData?: { mimeType: string; params: HarNameValuePair[]; text: string }
  headersSize: number
  bodySize: number
}

export interface HarResponse {
  status: number
  statusText: string
  httpVersion: string
  cookies: HarNameValuePair[]
  headers: HarNameValuePair[]
  content: HarContent
  redirectURL: string
  headersSize: number
  bodySize: number
}

export interface HarTimings {
  blocked: number
  dns: number
  connect: number
  send: number
  wait: number
  receive: number
  ssl: number
  comment?: string
}

export interface HarEntry {
  startedDateTime: string
  time: number
  request: HarRequest
  response: HarResponse
  cache: Record<string, never>
  timings: HarTimings
  serverIPAddress?: string
  _state?: string
  _error?: string
}

export interface HarLog {
  log: {
    version: '1.2'
    creator: { name: string; version: string }
    entries: HarEntry[]
  }
}

export function flowToHarEntry(
  flow: Flow,
  reqRaw: Buffer | null,
  respRaw: Buffer | null
): HarEntry | null {
  if (!flow.request) return null
  const req = flow.request
  const url = parseUrl(req.url)
  const timing = flow.timing
  const end = timing.end ?? timing.firstByte ?? timing.start
  const send = num(timing.requestSent) - timing.start
  const wait = num(timing.firstByte) - num(timing.requestSent, timing.start)
  const receive = end - num(timing.firstByte, timing.requestSent, timing.start)
  const dns = timing.dns !== undefined ? timing.dns - num(timing.requestSent) : -1
  const connect = timing.connect !== undefined ? timing.connect - num(timing.dns, timing.requestSent) : -1
  const ssl = timing.tls !== undefined ? timing.tls - num(timing.connect, timing.dns) : -1

  const resp = flow.response
  const entry: HarEntry = {
    startedDateTime: new Date(timing.start).toISOString(),
    time: end - timing.start,
    request: {
      method: req.method,
      url: req.url,
      httpVersion: `HTTP/${req.httpVersion}`,
      cookies: [],
      headers: req.headers.map(toHarHeader),
      queryString: url ? [...url.searchParams].map(([name, value]) => ({ name, value })) : [],
      headersSize: flow.size.reqHeader,
      bodySize: flow.size.reqBody,
      ...(req.body.size > 0
        ? {
            postData: {
              mimeType: req.body.contentType || 'application/octet-stream',
              params: [],
              text: bodyText(reqRaw, req.body, req.headers)
            }
          }
        : {})
    },
    response: {
      status: resp?.status ?? 0,
      statusText: resp?.statusText ?? '',
      httpVersion: `HTTP/${resp?.httpVersion ?? '1.1'}`,
      cookies: [],
      headers: (resp?.headers ?? []).map(toHarHeader),
      content: resp
        ? harContent(respRaw, resp.body, resp.headers)
        : { size: 0, mimeType: 'x-unknown', comment: flow.error ? `${flow.error.stage}: ${flow.error.message}` : 'no response' },
      redirectURL: headerValue(resp?.headers ?? [], 'location') ?? '',
      headersSize: flow.size.respHeader,
      bodySize: flow.size.respBody
    },
    cache: {},
    timings: {
      blocked: -1,
      dns,
      connect,
      send: Math.max(send, 0),
      wait: Math.max(wait, 0),
      receive: Math.max(receive, 0),
      ssl
    },
    serverIPAddress: url?.hostname,
    _state: flow.state
  }
  if (flow.error) entry._error = `${flow.error.stage}: ${flow.error.message}`
  return entry
}

export function buildHarLog(entries: HarEntry[], creator: { name: string; version: string }): HarLog {
  return {
    log: {
      version: '1.2',
      creator,
      entries
    }
  }
}

const IMPORT_PREVIEW_LIMIT = 64 * 1024

export interface ImportedFlowParts {
  flow: Flow
  reqRaw: Buffer
  respRaw: Buffer | null
}

/** HAR entry → Flow（导入用）。缺 request.method/url 或 URL 无法解析时返回 null（调用方计为 skipped）。 */
export function harEntryToFlow(entry: HarEntry, init: { id: string; seq: number }): ImportedFlowParts | null {
  const req = entry?.request
  if (!req?.method || !req.url) return null
  const url = parseUrl(req.url)
  if (!url) return null

  const parsedStart = Date.parse(entry.startedDateTime)
  const start = Number.isFinite(parsedStart) ? parsedStart : Date.now()
  const timings = entry.timings
  const send = Math.max(timings?.send ?? -1, 0)
  const wait = Math.max(timings?.wait ?? -1, 0)
  const receive = Math.max(timings?.receive ?? -1, 0)
  const requestSent = start + send
  const firstByte = requestSent + wait
  const total = entry.time >= 0 ? entry.time : send + wait + receive
  const end = total > 0 ? start + total : firstByte

  const reqHeaders = toHeaders(req.headers)
  const reqRaw = req.postData?.text != null ? Buffer.from(req.postData.text, 'utf8') : Buffer.alloc(0)
  const reqContentType = req.postData?.mimeType || headerValue(reqHeaders, 'content-type') || ''

  const resp = entry.response
  const respHeaders = toHeaders(resp?.headers)
  const content = resp?.content
  let respRaw: Buffer | null = null
  if (content?.text) {
    respRaw =
      content.encoding === 'base64' ? Buffer.from(content.text, 'base64') : Buffer.from(content.text, 'utf8')
  }
  const respContentType = content?.mimeType || headerValue(respHeaders, 'content-type') || ''

  const tls = url.protocol === 'https:'
  const state: FlowState = resp && resp.status > 0 ? 'done' : entry._error ? 'error' : 'aborted'

  const flow: Flow = {
    id: init.id,
    seq: init.seq,
    kind: 'http',
    state,
    clientIp: '',
    clientPort: 0,
    tls,
    mitm: tls,
    sni: tls ? url.hostname : undefined,
    host: url.hostname,
    port: url.port ? Number(url.port) : tls ? 443 : 80,
    request: {
      method: req.method,
      url: req.url,
      httpVersion: stripHttpVersion(req.httpVersion),
      headers: reqHeaders,
      body: bodyMeta(reqRaw, reqContentType)
    },
    response: resp
      ? {
          status: resp.status ?? 0,
          statusText: resp.statusText ?? '',
          httpVersion: stripHttpVersion(resp.httpVersion),
          headers: respHeaders,
          body: bodyMeta(respRaw ?? Buffer.alloc(0), respContentType)
        }
      : undefined,
    timing: { start, requestSent, firstByte, end },
    size: {
      reqHeader: Math.max(req.headersSize ?? 0, 0),
      reqBody: reqRaw.length,
      respHeader: Math.max(resp?.headersSize ?? 0, 0),
      respBody: respRaw?.length ?? 0,
      total: 0
    },
    error: entry._error ? { stage: 'import', code: 'HAR_IMPORT', message: entry._error } : undefined,
    flags: ['imported'],
    createdAt: start
  }
  flow.size.total =
    flow.size.reqHeader + flow.size.reqBody + flow.size.respHeader + flow.size.respBody
  return { flow, reqRaw, respRaw }
}

function toHeaders(list: HarNameValuePair[] | undefined): HeaderPair[] {
  return (list ?? []).map((h) => ({ name: h?.name ?? '', value: h?.value ?? '' }))
}

function stripHttpVersion(v: string | undefined): string {
  const s = v?.replace(/^HTTP\//i, '').trim()
  return s || '1.1'
}

function bodyMeta(raw: Buffer, contentType: string): BodyMeta {
  const meta: BodyMeta = {
    size: raw.length,
    contentType,
    stored: raw.length > 0 ? 'inline' : 'none'
  }
  if (raw.length > 0 && isTextualContentType(contentType)) {
    meta.isText = true
    meta.preview = decodeBytes(raw, 'utf-8').slice(0, IMPORT_PREVIEW_LIMIT)
  }
  return meta
}

function harContent(raw: Buffer | null, meta: BodyMeta, headers: HeaderPair[]): HarContent {
  const mimeType = meta.contentType || headerValue(headers, 'content-type') || 'application/octet-stream'
  if (meta.size === 0 || !raw || raw.length === 0) return { size: meta.size, mimeType }
  const decoded = decompress(meta.encoding, raw)
  const textual =
    meta.isText === true ||
    /^text\//i.test(mimeType) ||
    /^(application\/(json|xml|javascript|x-javascript|x-www-form-urlencoded|soap|graphql))/i.test(mimeType)
  if (textual) {
    let text: string
    try {
      text = decodeBytes(decoded, 'utf-8')
    } catch {
      text = decoded.toString('utf8')
    }
    return { size: meta.size, mimeType, text }
  }
  return {
    size: meta.size,
    mimeType,
    text: decoded.toString('base64'),
    encoding: 'base64'
  }
}

function bodyText(raw: Buffer | null, meta: BodyMeta, headers: HeaderPair[]): string {
  if (!raw || raw.length === 0) return ''
  return decodeBytes(decompress(meta.encoding, raw), 'utf-8')
}

function toHarHeader(h: HeaderPair): HarNameValuePair {
  return { name: h.name, value: h.value }
}

function headerValue(headers: HeaderPair[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name)?.value
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function num(...values: Array<number | undefined>): number {
  for (const v of values) if (v !== undefined) return v
  return 0
}
