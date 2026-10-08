export interface HeaderPair {
  name: string
  value: string
}

export type FlowKind = 'http' | 'tunnel' | 'ws'

export interface WsMessage {
  seq: number
  dir: 'c2s' | 's2c'
  /** 1=text 2=binary 8=close 9=ping 10=pong */
  opcode: number
  size: number
  text?: string
  at: number
}

export type FlowState =
  | 'pending'
  | 'forwarded'
  | 'done'
  | 'error'
  | 'aborted'

export type BodyStorage = 'none' | 'inline' | 'file' | 'truncated'

export interface BodyMeta {
  size: number
  contentType: string
  encoding?: string
  stored: BodyStorage
  isText?: boolean
  preview?: string
}

export interface RequestPart {
  method: string
  url: string
  httpVersion: string
  headers: HeaderPair[]
  body: BodyMeta
}

export interface ResponsePart {
  status: number
  statusText: string
  httpVersion: string
  headers: HeaderPair[]
  body: BodyMeta
  /** HTTP trailers（gRPC 的 grpc-status 等） */
  trailers?: HeaderPair[]
}

export interface Timing {
  start: number
  requestSent?: number
  dns?: number
  connect?: number
  tls?: number
  firstByte?: number
  end?: number
}

export interface FlowSize {
  reqHeader: number
  reqBody: number
  respHeader: number
  respBody: number
  total: number
}

export interface FlowError {
  stage: string
  code: string
  message: string
}

export interface Flow {
  id: string
  seq: number
  kind: FlowKind
  state: FlowState
  clientIp: string
  clientPort: number
  /** 发起流量的本机进程名（lsof 归属）；远程客户端无进程名时为 undefined */
  clientApp?: string
  tls: boolean
  mitm: boolean
  sni?: string
  host?: string
  port?: number
  request?: RequestPart
  response?: ResponsePart
  timing: Timing
  size: FlowSize
  error?: FlowError
  flags: string[]
  /** 用户标签（文本，UI 按内容散列出颜色） */
  label?: string
  /** 用户备注 */
  note?: string
  /** 请求跟踪 ID（开启跟踪后注入上游请求头并记录） */
  traceId?: string
  createdAt: number
}

export interface FlowSummary {
  id: string
  seq: number
  kind: FlowKind
  state: FlowState
  method?: string
  host?: string
  path?: string
  url?: string
  status?: number
  statusText?: string
  durationMs?: number
  reqSize: number
  respSize: number
  /** 请求+响应总大小（含头与体，列表 Size 列展示） */
  totalSize: number
  respContentType?: string
  flags: string[]
  error?: string
  tls: boolean
  mitm: boolean
  sni?: string
  clientIp?: string
  clientApp?: string
  label?: string
  note?: string
  traceId?: string
  createdAt: number
}

export interface BodyContent {
  size: number
  contentType: string
  isText: boolean
  truncated: boolean
  text?: string
  base64?: string
}

export function toSummary(flow: Flow): FlowSummary {
  const duration =
    flow.timing.end !== undefined ? flow.timing.end - flow.timing.start : undefined
  return {
    id: flow.id,
    seq: flow.seq,
    kind: flow.kind,
    state: flow.state,
    method: flow.request?.method,
    host: flow.host,
    path: flow.request ? new URL(flow.request.url).pathname : undefined,
    url: flow.request?.url,
    status: flow.response?.status,
    statusText: flow.response?.statusText,
    durationMs: duration,
    reqSize: flow.size.reqBody,
    respSize: flow.size.respBody,
    totalSize: flow.size.total,
    respContentType: flow.response?.body.contentType,
    flags: [...flow.flags],
    error: flow.error?.message,
    tls: flow.tls,
    mitm: flow.mitm,
    sni: flow.sni,
    clientIp: flow.clientIp || undefined,
    clientApp: flow.clientApp,
    label: flow.label,
    note: flow.note,
    traceId: flow.traceId,
    createdAt: flow.createdAt
  }
}
