import * as http from 'node:http'
import * as http2 from 'node:http2'
import * as https from 'node:https'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { BodyMeta, BodyReplace, BreakpointEdit, BreakpointHit, ComposerSpec, Flow, HeaderPair, ReverseProxyRule, WsMessage } from '@proxy/shared'
import type { AppSettings } from '@proxy/shared'
import { LeafCertFactory } from '../certs/leaf'
import type { CaHandle } from '../certs/ca'
import { FlowsRepo } from '../db/flows-repo'
import { finalizeBodyCapture, decompress, encodingOf } from '../capture/body'
import { resolveClientApp } from '../capture/proc-resolver'
import { WsFrameParser } from '../capture/ws-parser'
import { GrpcFrameParser, decodeProtobufToText, grpcBodyIsText, isGrpcContentType, needsH2Upstream, type GrpcFrame } from '../capture/grpc-parser'
import { BreakpointManager } from '../pipeline/breakpoints'
import { applyHeaderOps, firstMatchingRule, ruleMatches, type MatchInput } from '../rules/engine'
import type { Rule } from '@proxy/shared'
import type { PluginManager } from '../plugins/manager'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

/** body 文本搜索替换：先解压，替换成功返回新 buffer（调用方须去掉 content-encoding），未命中返回 null */
function applyBodyReplaces(
  buf: Buffer,
  headers: HeaderPair[],
  replaces: BodyReplace[]
): Buffer | null {
  if (!replaces.length) return null
  let text = decompress(encodingOf(headers), buf).toString('utf8')
  let changed = false
  for (const r of replaces) {
    if (!r.search) continue
    if (r.regex) {
      try {
        const next = text.replace(new RegExp(r.search, 'g'), r.replace)
        if (next !== text) {
          changed = true
          text = next
        }
      } catch {
        /* 非法正则跳过 */
      }
    } else if (text.includes(r.search)) {
      text = text.split(r.search).join(r.replace)
      changed = true
    }
  }
  return changed ? Buffer.from(text, 'utf8') : null
}

export interface ProxyCoreEvents {
  onFlowUpdate: (flow: Flow) => void
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void
}

interface ActiveFlow {
  flow: Flow
  reqChunks: Buffer[]
  reqSize: number
  respChunks: Buffer[]
  respSize: number
  paused: boolean
  /** 极速模式：不落库（WS/gRPC 消息同理），但仍实时推送 UI */
  turbo: boolean
  /** gRPC 消息时间线序号（请求/响应共用，与 WebSocket 一致） */
  grpcSeq: number
  /** 上游 HTTP/2 trailers（grpc-status 等），写回客户端并入 flow 供 UI 展示 */
  respTrailers: HeaderPair[]
}

/** 反向代理目标覆盖：把监听端口收到的请求重写到该地址再走标准管线 */
interface ReverseTarget {
  host: string
  port: number
  tls: boolean
}

export class ProxyServer {
  private server: http.Server
  private socksServer: net.Server | null = null
  /** 反向代理监听器（规则 id → server） */
  private reverseServers = new Map<string, http.Server>()
  /** 运行中规则的目标（规则 id → target，用于变更检测） */
  private reverseTargets = new Map<string, ReverseTarget>()
  /** MITM 统一入口：ALPN h2 → HTTP/2 compat，http/1.1 → HTTP/1.1（allowHTTP1） */
  private mitmServer: http2.Http2SecureServer
  /** 透明 HTTP 解析：SOCKS5 中的明文 HTTP 注入此处（isMitm=false，按 Host 转发） */
  private transparentServer: http.Server
  private activeFlows = new Map<string, ActiveFlow>()
  private tunnelSockets = new Set<net.Socket>()
  /** gRPC 上游的 HTTP/2 session 池（按 origin 复用，h2 多路复用） */
  private h2Sessions = new Map<string, http2.ClientHttp2Session>()
  private seq: number
  private settings: AppSettings
  private events: ProxyCoreEvents
  private rules: Rule[] = []
  private pluginManager: PluginManager | null = null
  readonly breakpoints = new BreakpointManager()

  constructor(
    private ca: CaHandle,
    private certFactory: LeafCertFactory,
    private repo: FlowsRepo,
    events: ProxyCoreEvents,
    settings: AppSettings,
    private dataDir: string
  ) {
    this.settings = settings
    this.events = events
    this.seq = repo.maxSeq()
    this.mitmServer = this.createMitmServer()
    this.transparentServer = http.createServer((req, res) => {
      void this.handleHttp(req, res, false)
    })
    this.transparentServer.on('clientError', (_err, socket) => socket.destroy())
    this.transparentServer.on('connection', (sock) => this.enforceAccess(sock))
    this.server = http.createServer((req, res) => {
      void this.handleHttp(req, res, false)
    })
    this.server.on('connection', (sock) => this.enforceAccess(sock))
    this.server.on('connect', (req, clientSocket, head) => {
      void this.handleConnect(req, clientSocket as net.Socket, head)
    })
    this.server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as net.Socket, head, false)
    })
    this.mitmServer.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req as unknown as http.IncomingMessage, socket as net.Socket, head, true)
    })
  }

  updateSettings(next: AppSettings): void {
    this.settings = next
    this.syncReverseProxies()
  }

  /** 访问控制：按连接层来源 IP 拦截（IPv6-mapped 归一化；::1 视同 127.0.0.1） */
  private clientAllowed(remoteAddress: string | undefined): boolean {
    const ac = this.settings.accessControl
    if (!ac || ac.mode === 'off' || !ac.ips.length) return true
    const ip = normalizeClientIp(remoteAddress ?? '')
    const listed = ac.ips.some((p) => normalizeClientIp(p) === ip)
    return ac.mode === 'allowlist' ? listed : !listed
  }

  private enforceAccess(sock: net.Socket): void {
    if (!this.clientAllowed(sock.remoteAddress)) {
      this.events.onLog('warn', `access denied: ${sock.remoteAddress ?? '?'}`)
      sock.destroy()
    }
  }

  // ------------------------------------------------------------------
  // 反向代理：本地端口 → 目标地址透明转发（流量进抓包列表，规则/断点/插件全生效）
  // ------------------------------------------------------------------

  /** 对比设置里的规则与已起监听器，差异增删（端口被占/规则非法记日志） */
  syncReverseProxies(): void {
    const want = new Map<string, ReverseProxyRule>()
    for (const r of this.settings.reverse?.rules ?? []) {
      if (!r.enabled) continue
      if (!r.targetHost || !Number.isInteger(r.listenPort) || r.listenPort <= 0 || r.listenPort > 65535 ||
        !Number.isInteger(r.targetPort) || r.targetPort <= 0 || r.targetPort > 65535) continue
      want.set(r.id, r)
    }
    // 关停：被删/禁用/目标变更的规则
    for (const [id, srv] of this.reverseServers) {
      const rule = want.get(id)
      const cur = this.reverseTargets.get(id)
      if (!rule || !cur || cur.host !== rule.targetHost || cur.port !== rule.targetPort || cur.tls !== rule.targetTls) {
        srv.closeAllConnections?.()
        srv.close()
        this.reverseServers.delete(id)
        this.reverseTargets.delete(id)
      }
    }
    // 新起：只在主服务运行中起监听（stop 后由 start 重新拉起）
    if (this.listening) {
      for (const [id, rule] of want) {
        if (this.reverseServers.has(id)) continue
        this.startReverseListener(rule)
      }
    }
  }

  private get listening(): boolean {
    return this.server.listening
  }

  private startReverseListener(rule: ReverseProxyRule): void {
    const target: ReverseTarget = { host: rule.targetHost, port: rule.targetPort, tls: rule.targetTls }
    const srv = http.createServer((req, res) => {
      void this.handleHttp(req, res, false, target)
    })
    srv.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as net.Socket, head, false, target)
    })
    srv.on('clientError', (_err, socket) => socket.destroy())
    srv.once('error', (err) => {
      this.events.onLog('warn', `反向代理 ${rule.name} 监听 :${rule.listenPort} 失败: ${err.message}`)
      srv.close()
      this.reverseServers.delete(rule.id)
      this.reverseTargets.delete(rule.id)
    })
    srv.listen(rule.listenPort, this.settings.proxy.bindAddress, () => {
      this.events.onLog('info', `反向代理 ${rule.name} :${rule.listenPort} → ${rule.targetTls ? 'https' : 'http'}://${rule.targetHost}:${rule.targetPort}`)
    })
    this.reverseServers.set(rule.id, srv)
    this.reverseTargets.set(rule.id, target)
  }

  // ------------------------------------------------------------------
  // 上游代理（二级代理）
  // ------------------------------------------------------------------

  /** 生效中的上游代理配置；未启用/配置不完整返回 null（每次出站时读取，改设置即时生效） */
  private upstreamConf(): { protocol: 'http' | 'socks5'; host: string; port: number } | null {
    const up = this.settings.proxy.upstream
    if (!up?.enabled) return null
    if (!up.host || !Number.isInteger(up.port) || up.port <= 0 || up.port > 65535) return null
    return { protocol: up.protocol, host: up.host, port: up.port }
  }

  /** 经上游代理与 target 建立隧道：HTTP 代理走 CONNECT，SOCKS5 走无认证握手 */
  private connectViaUpstream(host: string, port: number): Promise<net.Socket> {
    const up = this.upstreamConf()!
    return new Promise((resolve, reject) => {
      let settled = false
      const sock = net.connect({ host: up.host, port: up.port })
      const settle = <T,>(fn: (v: T) => void, v: T): void => {
        if (settled) return
        settled = true
        sock.setTimeout(0)
        sock.removeAllListeners('data')
        fn(v)
      }
      const fail = (msg: string): void => {
        sock.destroy()
        settle(reject, new Error(`upstream proxy ${up.host}:${up.port}: ${msg}`))
      }
      sock.once('error', (err) => fail(err.message))
      sock.setTimeout(15_000, () => fail('tunnel handshake timeout'))

      if (up.protocol === 'http') {
        let head = ''
        const onData = (d: Buffer): void => {
          head += d.toString('latin1')
          if (!head.includes('\r\n\r\n')) return
          const status = Number(head.slice(9, 12))
          if (status >= 200 && status < 300) settle(resolve, sock)
          else fail(`CONNECT rejected: ${head.split('\r\n')[0]}`)
        }
        sock.on('data', onData)
        sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
      } else {
        let stage: 'greeting' | 'connect' = 'greeting'
        let buf = Buffer.alloc(0)
        const onData = (d: Buffer): void => {
          buf = Buffer.concat([buf, d])
          if (stage === 'greeting') {
            if (buf.length < 2) return
            if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail('socks5 greeting rejected')
            stage = 'connect'
            // IPv4 走 ATYP=0x01；域名/IPv6 统一走 ATYP=0x03 字节串（IPv6 打包易错且极少见）
            const parts: number[] = [0x05, 0x01, 0x00, net.isIPv4(host) ? 0x01 : 0x03]
            if (net.isIPv4(host)) {
              for (const b of host.split('.')) parts.push(Number(b))
            } else {
              parts.push(host.length, ...Buffer.from(host, 'utf8'))
            }
            parts.push((port >> 8) & 0xff, port & 0xff)
            sock.write(Buffer.from(parts))
            buf = Buffer.alloc(0)
            return
          }
          if (buf.length < 4) return
          if (buf[0] !== 0x05) return fail('bad socks5 reply')
          if (buf[1] !== 0x00) return fail(`socks5 connect failed (rep=${buf[1]})`)
          const atyp = buf[3]
          const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? 1 + buf[4] : -1
          if (addrLen < 0) return fail('bad socks5 reply atyp')
          if (buf.length < 4 + addrLen + 2) return
          settle(resolve, sock)
        }
        sock.on('data', onData)
        sock.write(Buffer.from([0x05, 0x01, 0x00]))
      }
    })
  }

  /** lib.request 的上游连接选项：
   *  - HTTP 上游 + 明文目标 → 绝对 URI 形式直接发给代理（返回 null，调用方改 host/port/path）
   *  - 其余（HTTPS 目标或 SOCKS5 上游）→ createConnection 经隧道（HTTPS 再套 TLS） */
  private upstreamRequestOptions(url: URL, options: https.RequestOptions): https.RequestOptions | null {
    const up = this.upstreamConf()
    if (!up) return null
    const targetPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    const isTls = url.protocol === 'https:'
    if (up.protocol === 'http' && !isTls) return null // 由调用方走绝对 URI
    // 不设 agent：Node 仅在无 agent 时才使用 options.createConnection（agent:false 也会忽略它）
    options.createConnection = (_opts, cb) => {
      this.connectViaUpstream(url.hostname, targetPort)
        .then((sock) => {
          if (!isTls) {
            cb(null, sock)
            return
          }
          const tlsSock = tls.connect({
            socket: sock,
            servername: net.isIP(url.hostname) ? undefined : url.hostname,
            rejectUnauthorized: this.settings.tls.rejectUpstream
          })
          cb(null, tlsSock)
        })
        .catch((err) => cb(err, undefined as unknown as net.Socket))
      return undefined
    }
    return options
  }

  /** 上游为 HTTP 代理且目标为明文 HTTP：请求改发代理（绝对 URI 形式）。Host 头已被
   *  cleanProxyHeaders 剥掉、Node 会按连接地址补成代理主机，须显式设回目标主机 */
  private absoluteUriViaProxy(url: URL, options: https.RequestOptions, up: { host: string; port: number }): https.RequestOptions {
    options.host = up.host
    options.port = up.port
    options.path = url.href
    const headers = (options.headers ?? {}) as http.OutgoingHttpHeaders
    headers.host = url.port ? `${url.hostname}:${url.port}` : url.hostname
    options.headers = headers
    return options
  }

  /** 外部写入高 seq flow（HAR 导入）后同步计数器，避免后续抓包 seq 撞车 */
  bumpSeq(min: number): void {
    if (min > this.seq) this.seq = min
  }

  setRules(rules: Rule[]): void {
    this.rules = rules
    // 清掉已删除规则的计数
    const ids = new Set(rules.map((r) => r.id))
    for (const id of this.ruleMatchCounts.keys()) {
      if (!ids.has(id)) this.ruleMatchCounts.delete(id)
    }
  }

  getRules(): Rule[] {
    return this.rules
  }

  /** 每条规则的历史命中次数（自规则保存起累计；重载进程清零） */
  private ruleMatchCounts = new Map<string, number>()

  getRuleMatchCounts(): Record<string, number> {
    return Object.fromEntries(this.ruleMatchCounts)
  }

  /** finishFlow 时对 http 流量重放全规则匹配，累计每条规则命中数（与实际生效逻辑同源：ruleMatches） */
  private countRuleMatches(flow: Flow): void {
    if (!flow.request || !this.rules.length) return
    const input: MatchInput = {
      host: flow.host ?? '',
      path: '',
      method: flow.request.method,
      url: flow.request.url
    }
    try {
      const u = new URL(flow.request.url)
      input.host = u.hostname
      input.path = u.pathname
    } catch {
      /* 无效 URL 时仅按 host 兜底 */
    }
    for (const rule of this.rules) {
      if (ruleMatches(rule, input)) {
        this.ruleMatchCounts.set(rule.id, (this.ruleMatchCounts.get(rule.id) ?? 0) + 1)
      }
    }
  }

  setPluginManager(pm: PluginManager): void {
    this.pluginManager = pm
  }

  listen(port: number, bindAddress: string, socksPort = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, bindAddress, () => {
        if (socksPort > 0) {
          this.startSocks(socksPort, bindAddress).catch((err) => {
            this.events.onLog('warn', `socks5 listen failed on ${bindAddress}:${socksPort}: ${err.message}`)
          })
        }
        this.syncReverseProxies()
        resolve()
      })
    })
  }

  private startSocks(port: number, bindAddress: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((socket) => {
        if (!this.clientAllowed(socket.remoteAddress)) {
          this.events.onLog('warn', `socks access denied: ${socket.remoteAddress ?? '?'}`)
          socket.destroy()
          return
        }
        this.handleSocksConnection(socket)
      })
      srv.once('error', reject)
      srv.listen(port, bindAddress, () => {
        this.socksServer = srv
        this.events.onLog('info', `socks5 listening on ${bindAddress}:${port}`)
        resolve()
      })
    })
  }

  close(): Promise<void> {
    this.breakpoints.abortAll()
    for (const [, af] of this.activeFlows) {
      af.flow.state = 'aborted'
    }
    for (const sock of this.tunnelSockets) {
      sock.destroy()
    }
    this.tunnelSockets.clear()
    if (this.socksServer) {
      this.socksServer.close()
      this.socksServer = null
    }
    for (const [, srv] of this.reverseServers) {
      srv.closeAllConnections?.()
      srv.close()
    }
    this.reverseServers.clear()
    this.reverseTargets.clear()
    for (const [, session] of this.h2Sessions) session.destroy()
    this.h2Sessions.clear()
    this.mitmServer.close()
    return new Promise((resolve) => {
      this.server.closeAllConnections?.()
      this.server.close(() => resolve())
    })
  }

  getBreakpoints(): BreakpointManager {
    return this.breakpoints
  }

  private trackSocket(sock: net.Socket): void {
    this.tunnelSockets.add(sock)
    sock.on('close', () => this.tunnelSockets.delete(sock))
    sock.on('error', () => sock.destroy())
  }

  // ------------------------------------------------------------------
  // HTTP (plain proxy request or transparent origin-form)
  // ------------------------------------------------------------------

  private createMitmServer(): http2.Http2SecureServer {
    const { key, cert } = this.certFactory.defaultKeyAndCert()
    const srv = http2.createSecureServer({
      key,
      cert,
      ALPNProtocols: ['h2', 'http/1.1'],
      allowHTTP1: true,
      SNICallback: (name, cb) => {
        cb(null, this.certFactory.secureContextFor(name || 'localhost'))
      }
    })
    srv.on('request', (req, res) => {
      void this.handleHttp(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, true)
    })
    srv.on('clientError', (_err, socket) => socket.destroy())
    srv.on('tlsClientError', (_err, socket) => socket.destroy())
    srv.on('error', (err) => {
      this.events.onLog('warn', `mitm http2 server error: ${err.message}`)
    })
    return srv
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse, isMitm: boolean, reverse?: ReverseTarget): Promise<void> {
    const clientIp = req.socket.remoteAddress ?? ''
    const clientPort = req.socket.remotePort ?? 0
    const rawHeaders = req.headers as Record<string, string | string[] | undefined>
    const hostHeader = String(rawHeaders.host ?? rawHeaders[':authority'] ?? '')
    let targetUrl: URL
    try {
      if (reverse) {
        // 反向代理：忽略请求自带的 Host/绝对地址，一律重写到规则目标
        const scheme = reverse.tls ? 'https' : 'http'
        const origin = `${scheme}://${reverse.host}:${reverse.port}`
        targetUrl = new URL(urlPathOnly(req.url), origin)
      } else if (/^https?:\/\//i.test(req.url ?? '')) {
        targetUrl = new URL(req.url!)
      } else if (hostHeader) {
        const scheme = isMitm ? 'https' : 'http'
        targetUrl = new URL(req.url || '/', `${scheme}://${hostHeader}`)
      } else {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('Bad Request: missing Host')
        return
      }
    } catch {
      res.writeHead(400)
      res.end('Bad Request')
      return
    }
    if (!reverse) {
      // 明文代理/透明请求：命中镜像规则时改写目标 host（CONNECT/SOCKS5 路径在各自入口已处理）
      const mt = this.mirrorTarget(targetUrl.hostname, Number(targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80)))
      if (mt.mirrored) {
        const newUrl = new URL(`${targetUrl.protocol}//${mt.host}:${mt.port}${targetUrl.pathname}${targetUrl.search}`)
        targetUrl = newUrl
      }
    }

    if (targetUrl.hostname === 'cert.local') {
      this.serveCertPage(req, res)
      return
    }

    const af = this.beginFlow({
      kind: 'http',
      clientIp,
      clientPort,
      clientApp: appLabelOf(req.socket) ?? undefined,
      tls: isMitm,
      mitm: isMitm,
      sni: isMitm ? hostHeader.split(':')[0] : undefined,
      host: targetUrl.hostname,
      port: Number(targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80))
    })

    const reqHeaders = headerPairs(req.headers)
    // H2 请求无 Host 头（伪头 :authority 已被过滤），补一条等价 host 头供展示/匹配/出站使用
    if (req.httpVersion === '2.0' && hostHeader && !reqHeaders.some((h) => h.name.toLowerCase() === 'host')) {
      reqHeaders.unshift({ name: 'host', value: hostHeader })
    }
    if (reverse) {
      // 反向代理：Host 改写为目标（后端虚拟主机路由依赖它；标准端口省略 :port）
      const stdPort = reverse.tls ? 443 : 80
      const hostValue = reverse.port === stdPort ? reverse.host : `${reverse.host}:${reverse.port}`
      const hostIdx = reqHeaders.findIndex((h) => h.name.toLowerCase() === 'host')
      if (hostIdx >= 0) reqHeaders[hostIdx] = { name: 'host', value: hostValue }
      else reqHeaders.unshift({ name: 'host', value: hostValue })
    }
    af.flow.request = {
      method: req.method ?? 'GET',
      url: targetUrl.toString(),
      httpVersion: req.httpVersion,
      headers: reqHeaders,
      body: { size: 0, contentType: '', stored: 'none' }
    }
    af.flow.timing.requestSent = Date.now()

    this.emit(af)

    const maxBody = this.settings.capture.maxBodySizeMB * 1024 * 1024

    try {
      let method = req.method ?? 'GET'
      let url = targetUrl
      let headers = reqHeaders
      let body = await this.collectBody(req, af, 'req')

      const matchInput = (): MatchInput => ({
        host: url.hostname,
        path: url.pathname,
        method,
        url: url.toString()
      })

      // ---- Mock / Map Local / Block / Hold（短路）----
      const shortRule = firstMatchingRule(this.rules, matchInput(), ['mock', 'map-local', 'block', 'hold'])
      if (shortRule) {
        const action = shortRule.action
        if (action.type === 'mock') {
          af.flow.flags.push('mock')
          const mockBody = Buffer.from(action.bodyBase64, 'base64')
          const reqCapturedMock = finalizeBodyCapture(body, headers, maxBody)
          af.flow.request!.body = reqCapturedMock.meta
          af.flow.size.reqBody = body.length
          af.flow.timing.firstByte = Date.now()
          const outH = action.headers.filter((h) => !HOP_BY_HOP.has(h.name.toLowerCase()))
          setContentLength(outH, mockBody.length)
          af.flow.response = {
            status: action.status,
            statusText: '',
            httpVersion: '1.1',
            headers: outH,
            body: { size: 0, contentType: '', stored: 'none' }
          }
          const capturedMock = finalizeBodyCapture(mockBody, outH, maxBody)
          af.flow.response.body = capturedMock.meta
          af.flow.size.respBody = mockBody.length
          this.emit(af)
          res.writeHead(action.status, headersToObject(outH))
          res.end(mockBody)
          this.finishFlow(af, 'done', {
            reqBody: { raw: reqCapturedMock.raw, meta: reqCapturedMock.meta },
            respBody: { raw: capturedMock.raw, meta: capturedMock.meta }
          })
          return
        }
        if (action.type === 'map-local') {
          af.flow.flags.push('maplocal')
          this.emit(af)
          try {
            const content = await readFile(action.path)
            const mime = MIME_BY_EXT[extname(action.path).toLowerCase()] ?? 'application/octet-stream'
            const reqCapturedMl = finalizeBodyCapture(body, headers, maxBody)
            af.flow.request!.body = reqCapturedMl.meta
            af.flow.size.reqBody = body.length
            af.flow.timing.firstByte = Date.now()
            const outH: HeaderPair[] = [{ name: 'content-type', value: mime }]
            setContentLength(outH, content.length)
            af.flow.response = {
              status: 200,
              statusText: '',
              httpVersion: '1.1',
              headers: outH,
              body: { size: 0, contentType: mime, stored: 'none' }
            }
            const capturedMl = finalizeBodyCapture(content, outH, maxBody)
            af.flow.response.body = capturedMl.meta
            af.flow.size.respBody = content.length
            this.emit(af)
            res.writeHead(200, headersToObject(outH))
            res.end(content)
            this.finishFlow(af, 'done', {
              reqBody: { raw: reqCapturedMl.raw, meta: reqCapturedMl.meta },
              respBody: { raw: capturedMl.raw, meta: capturedMl.meta }
            })
          } catch (err) {
            this.abortWith(
              res,
              af,
              'map-local',
              err instanceof Error ? err : new Error(String(err))
            )
          }
          return
        }
        if (action.type === 'block') {
          af.flow.flags.push('block')
          this.finishFlow(af, 'aborted')
          res.destroy()
          return
        }
        // hold: 不响应，直到客户端断开
        af.flow.flags.push('hold')
        this.emit(af)
        res.on('close', () => {
          if (this.activeFlows.has(af.flow.id)) {
            af.flow.state = 'aborted'
            this.finishFlow(af, 'aborted')
          }
        })
        return
      }

      // ---- 重写-请求 ----
      const rewriteReqRule = firstMatchingRule(this.rules, matchInput(), ['rewrite-request'])
      if (rewriteReqRule && rewriteReqRule.action.type === 'rewrite-request') {
        const a = rewriteReqRule.action
        af.flow.flags.push('rewrite')
        if (a.urlReplace) {
          try {
            url = new URL(a.urlReplace)
            af.flow.host = url.hostname
            af.flow.port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
          } catch {
            this.events.onLog('warn', `规则 ${rewriteReqRule.name} 的 urlReplace 不是合法 URL`)
          }
        }
        headers = applyHeaderOps(headers, a.headerOps)
        if (a.bodyBase64 !== undefined) {
          body = Buffer.from(a.bodyBase64, 'base64')
        }
        if (a.replaces?.length) {
          const replaced = applyBodyReplaces(body, headers, a.replaces)
          if (replaced) {
            body = replaced
            headers = headers.filter((h) => h.name.toLowerCase() !== 'content-encoding')
          }
        }
        af.flow.request!.method = method
        af.flow.request!.url = url.toString()
        af.flow.request!.headers = headers
      }

      // ---- 插件 onRequest ----
      if (this.pluginManager) {
        const pluginResult = await this.pluginManager.onRequest({
          flowId: af.flow.id,
          method,
          url: url.toString(),
          headers,
          bodyBase64: body.toString('base64')
        })
        if (pluginResult.respond) {
          af.flow.flags.push('plugin')
          const r = pluginResult.respond
          const respBodyBuf = Buffer.from(r.bodyBase64, 'base64')
          const reqCapturedP = finalizeBodyCapture(body, headers, maxBody)
          af.flow.request!.body = reqCapturedP.meta
          af.flow.size.reqBody = body.length
          af.flow.timing.firstByte = Date.now()
          const outH = r.headers.filter((h) => !HOP_BY_HOP.has(h.name.toLowerCase()))
          setContentLength(outH, respBodyBuf.length)
          af.flow.response = {
            status: r.status,
            statusText: r.statusText ?? '',
            httpVersion: '1.1',
            headers: outH,
            body: { size: 0, contentType: '', stored: 'none' }
          }
          const capturedP = finalizeBodyCapture(respBodyBuf, outH, maxBody)
          af.flow.response.body = capturedP.meta
          af.flow.size.respBody = respBodyBuf.length
          this.emit(af)
          res.writeHead(r.status, headersToObject(outH))
          res.end(respBodyBuf)
          this.finishFlow(af, 'done', {
            reqBody: { raw: reqCapturedP.raw, meta: reqCapturedP.meta },
            respBody: { raw: capturedP.raw, meta: capturedP.meta }
          })
          return
        }
        if (pluginResult.request) {
          const pr = pluginResult.request
          af.flow.flags.push('plugin')
          if (pr.method) method = pr.method
          if (pr.url) {
            try {
              url = new URL(pr.url)
              af.flow.host = url.hostname
              af.flow.port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
            } catch {
              this.events.onLog('warn', `插件返回的 url 不合法: ${pr.url}`)
            }
          }
          if (pr.headers) headers = pr.headers
          if (pr.bodyBase64 !== undefined) body = Buffer.from(pr.bodyBase64, 'base64')
          af.flow.request!.method = method
          af.flow.request!.url = url.toString()
          af.flow.request!.headers = headers
        }
      }

      if (
        this.breakpoints.shouldBreak(
          { host: url.hostname, path: url.pathname, method },
          'request'
        )
      ) {
        markBreakpoint(af)
        this.emit(af)
        const hit: BreakpointHit = {
          flowId: af.flow.id,
          seq: af.flow.seq,
          phase: 'request',
          host: af.flow.host,
          method,
          url: url.toString(),
          hitAt: Date.now(),
          request: {
            method,
            url: url.toString(),
            headers,
            bodyBase64: body.toString('base64')
          }
        }
        const edit = await this.raceGate(res, af, hit)
        if (edit.action === 'abort') {
          af.flow.state = 'aborted'
          this.finishFlow(af, 'aborted')
          res.destroy()
          return
        }
        if (edit.request) {
          method = edit.request.method
          url = new URL(edit.request.url)
          headers = edit.request.headers
          body = Buffer.from(edit.request.bodyBase64, 'base64')
          af.flow.request!.method = method
          af.flow.request!.url = url.toString()
          af.flow.request!.headers = headers
          af.flow.host = url.hostname
          af.flow.port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
        }
      }

      const reqCaptured = finalizeBodyCapture(body, headers, maxBody)
      af.flow.request!.body = reqCaptured.meta
      af.flow.size.reqBody = body.length

      // ---- 弱网：丢包 / 延迟（请求侧；kbps 在响应写回侧）----
      const netRule = firstMatchingRule(this.rules, matchInput(), ['throttle'])
      if (netRule && netRule.action.type === 'throttle') {
        const a = netRule.action
        if (a.lossPercent && a.lossPercent > 0 && Math.random() * 100 < a.lossPercent) {
          af.flow.flags.push('loss')
          this.emit(af)
          this.abortWith(res, af, 'request', new Error(`弱网丢包（${a.lossPercent}% 概率命中）`))
          return
        }
        if (a.latencyMs && a.latencyMs > 0) {
          af.flow.flags.push('throttle')
          this.emit(af)
          await new Promise<void>((r) => {
            const t = setTimeout(r, Math.min(a.latencyMs!, 60_000))
            t.unref?.()
          })
        }
      }

      const outcome = await this.performUpstream(af, method, url, headers, body, res)
      if (outcome === 'failed') return

      let status = af.flow.response!.status
      let statusText = af.flow.response!.statusText
      let respHeaders = af.flow.response!.headers
      let respBody = outcome.body

      // ---- 重写-响应 ----
      const rewriteRespRule = firstMatchingRule(this.rules, matchInput(), ['rewrite-response'])
      if (rewriteRespRule && rewriteRespRule.action.type === 'rewrite-response') {
        const a = rewriteRespRule.action
        af.flow.flags.push('rewrite')
        if (a.status !== undefined) {
          status = a.status
          statusText = ''
        }
        respHeaders = applyHeaderOps(respHeaders, a.headerOps)
        if (a.bodyBase64 !== undefined) {
          respBody = Buffer.from(a.bodyBase64, 'base64')
        }
        if (a.replaces?.length) {
          const replaced = applyBodyReplaces(respBody, respHeaders, a.replaces)
          if (replaced) {
            respBody = replaced
            respHeaders = respHeaders.filter((h) => h.name.toLowerCase() !== 'content-encoding')
          }
        }
        af.flow.response!.status = status
        af.flow.response!.statusText = statusText
        af.flow.response!.headers = respHeaders
      }

      // ---- 插件 onResponse ----
      if (this.pluginManager) {
        const pluginResult = await this.pluginManager.onResponse({
          flowId: af.flow.id,
          method,
          url: url.toString(),
          headers,
          bodyBase64: body.toString('base64'),
          status,
          statusText,
          respHeaders,
          respBodyBase64: respBody.toString('base64')
        })
        if (pluginResult.response) {
          const pr = pluginResult.response
          af.flow.flags.push('plugin')
          if (pr.status !== undefined) {
            status = pr.status
            statusText = pr.statusText ?? ''
          }
          if (pr.headers) respHeaders = pr.headers
          if (pr.bodyBase64 !== undefined) respBody = Buffer.from(pr.bodyBase64, 'base64')
          af.flow.response!.status = status
          af.flow.response!.statusText = statusText
          af.flow.response!.headers = respHeaders
        }
      }

      // ---- 限速（响应写回）----
      const throttleRule = firstMatchingRule(this.rules, matchInput(), ['throttle'])

      if (
        this.breakpoints.shouldBreak(
          { host: af.flow.host, path: url.pathname, method },
          'response'
        )
      ) {
        markBreakpoint(af)
        this.emit(af)
        const decoded = decompress(encodingOf(respHeaders), respBody)
        const hit: BreakpointHit = {
          flowId: af.flow.id,
          seq: af.flow.seq,
          phase: 'response',
          host: af.flow.host,
          method,
          url: url.toString(),
          status,
          hitAt: Date.now(),
          response: {
            status,
            statusText,
            headers: respHeaders,
            bodyBase64: decoded.toString('base64')
          }
        }
        const edit = await this.raceGate(res, af, hit)
        if (edit.action === 'abort') {
          af.flow.state = 'aborted'
          this.finishFlow(af, 'aborted')
          res.destroy()
          return
        }
        if (edit.response) {
          status = edit.response.status
          statusText = edit.response.statusText
          respHeaders = edit.response.headers
          respBody = Buffer.from(edit.response.bodyBase64, 'base64')
          af.flow.response!.status = status
          af.flow.response!.statusText = statusText
          af.flow.response!.headers = respHeaders
        }
      }

      const captured = finalizeBodyCapture(respBody, respHeaders, maxBody)
      af.flow.response!.body = captured.meta
      af.flow.size.respBody = respBody.length
      const outH = respHeaders.filter((h) => !HOP_BY_HOP.has(h.name.toLowerCase()))
      const isGrpcFlow = af.flow.flags.includes('grpc')
      // gRPC 响应不能定长：chunked + trailers（grpc-status），客户端在流结束时读取
      if (respBody.length > 0 && !isGrpcFlow) {
        setContentLength(outH, respBody.length)
      }
      if (isGrpcFlow && af.respTrailers.length > 0) {
        outH.push({ name: 'trailer', value: af.respTrailers.map((t) => t.name).join(', ') })
      }
      if (throttleRule && throttleRule.action.type === 'throttle' && respBody.length > 0) {
        af.flow.flags.push('throttle')
        this.emit(af)
        await this.writeThrottled(res, status, outH, respBody, throttleRule.action.kbps)
      } else if (isGrpcFlow && af.respTrailers.length > 0) {
        res.writeHead(status, headersToObject(outH))
        res.write(respBody)
        res.addTrailers(headersToObject(af.respTrailers))
        res.end()
      } else {
        res.writeHead(status, headersToObject(outH))
        res.end(respBody)
      }
      this.finishFlow(af, 'done', {
        reqBody: { raw: reqCaptured.raw, meta: reqCaptured.meta },
        respBody: { raw: captured.raw, meta: captured.meta }
      })
    } catch (err) {
      this.abortWith(res, af, 'request', err)
    }
  }

  /**
   * 发送 Composer 请求（不经客户端，直接出站），捕获为一条 flow。
   * 返回 flowId，flow 完成后可通过 getFlow 获取完整数据。
   */
  async sendRequest(
    spec: ComposerSpec,
    opts?: { clientApp?: string; flags?: string[] }
  ): Promise<string> {
    const url = new URL(spec.url)
    const af = this.beginFlow({
      kind: 'http',
      clientIp: '127.0.0.1',
      clientPort: 0,
      tls: url.protocol === 'https:',
      mitm: false,
      host: url.hostname,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    })
    af.flow.clientApp = opts?.clientApp ?? 'Composer'
    af.flow.flags.push(...(opts?.flags ?? ['composer']))
    af.flow.request = {
      method: spec.method,
      url: url.toString(),
      httpVersion: '1.1',
      headers: spec.headers,
      body: { size: 0, contentType: '', stored: 'none' }
    }
    af.flow.timing.requestSent = Date.now()
    this.emit(af)

    const maxBody = this.settings.capture.maxBodySizeMB * 1024 * 1024
    const body = Buffer.from(spec.bodyBase64, 'base64')
    const reqCaptured = finalizeBodyCapture(body, spec.headers, maxBody)
    af.flow.request.body = reqCaptured.meta
    af.flow.size.reqBody = body.length
    this.emit(af)

    const outcome = await this.performUpstream(af, spec.method, url, spec.headers, body, null)
    if (outcome === 'failed') {
      this.finishFlow(af, 'error')
      return af.flow.id
    }
    const captured = finalizeBodyCapture(outcome.body, af.flow.response!.headers, maxBody)
    af.flow.response!.body = captured.meta
    af.flow.size.respBody = outcome.body.length
    this.finishFlow(af, 'done', {
      reqBody: { raw: reqCaptured.raw, meta: reqCaptured.meta },
      respBody: { raw: captured.raw, meta: captured.meta }
    })
    return af.flow.id
  }

  private writeThrottled(
    res: http.ServerResponse,
    status: number,
    headers: HeaderPair[],
    body: Buffer,
    kbps: number
  ): Promise<void> {
    return new Promise((resolve) => {
      const bytesPerSecond = Math.max(kbps, 1) * 1024
      const chunkSize = Math.min(Math.ceil(bytesPerSecond / 10), 64 * 1024)
      const intervalMs = (chunkSize / bytesPerSecond) * 1000
      res.writeHead(status, headersToObject(headers))
      let offset = 0
      const timer = setInterval(() => {
        if (res.destroyed) {
          clearInterval(timer)
          resolve()
          return
        }
        const end = Math.min(offset + chunkSize, body.length)
        res.write(body.subarray(offset, end))
        offset = end
        if (offset >= body.length) {
          clearInterval(timer)
          res.end()
          resolve()
        }
      }, intervalMs)
      timer.unref?.()
    })
  }

  private raceGate(
    res: http.ServerResponse | null,
    af: ActiveFlow,
    hit: BreakpointHit
  ): Promise<BreakpointEdit> {
    const gate = this.breakpoints.gate(hit)
    if (!res) return gate
    return new Promise<BreakpointEdit>((resolve) => {
      let settled = false
      const onClientGone = () => {
        if (settled) return
        settled = true
        this.breakpoints.resolve(hit.flowId, { action: 'abort' })
        resolve({ action: 'abort' })
      }
      res.on('close', onClientGone)
      gate.then((edit) => {
        if (settled) return
        settled = true
        resolve(edit)
      })
    })
  }

  private performUpstream(
    af: ActiveFlow,
    method: string,
    url: URL,
    headers: HeaderPair[],
    body: Buffer,
    res: http.ServerResponse | null
  ): Promise<{ body: Buffer } | 'failed'> {
    // gRPC 服务端要求 HTTP/2（grpc-status 走 trailers），切换到 h2 上游；grpc-web 仍走 HTTP/1.1
    // 上游代理开启时不走 h2 池（h2-over-CONNECT 复杂且少见），回落 1.1 经代理转发
    const contentType = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value
    if (needsH2Upstream(contentType) && !this.upstreamConf()) {
      return this.performUpstreamH2(af, method, url, headers, body, res)
    }
    return new Promise((resolve) => {
      const upstreamHeaders = cleanProxyHeaders(headers, url)
      const traceH = this.traceHeader(af)
      if (traceH) {
        removeHeader(upstreamHeaders, traceH.name)
        upstreamHeaders.push(traceH)
      }
      if (body.length > 0) {
        setContentLength(upstreamHeaders, body.length)
      } else {
        removeHeader(upstreamHeaders, 'content-length')
      }
      const isTls = url.protocol === 'https:'
      const lib = isTls ? https : http
      const options: https.RequestOptions = {
        method,
        headers: headersToObject(upstreamHeaders),
        host: url.hostname,
        port: url.port || (isTls ? 443 : 80),
        path: url.pathname + url.search,
        rejectUnauthorized: this.settings.tls.rejectUpstream
      }
      if (isTls && !isIpAddress(url.hostname)) {
        options.servername = url.hostname
      }
      const upConf = this.upstreamConf()
      if (upConf) {
        af.flow.flags.push('upstream')
        // 明文 HTTP + HTTP 上游 → 绝对 URI；其余（HTTPS 目标 / SOCKS5 上游）→ createConnection 隧道
        if (this.upstreamRequestOptions(url, options) === null) {
          this.absoluteUriViaProxy(url, options, upConf)
        }
      }

      const upstreamReq = lib.request(options, (upstreamRes) => {
        const respHeaders = headerPairs(upstreamRes.headers)
        af.flow.response = {
          status: upstreamRes.statusCode ?? 0,
          statusText: upstreamRes.statusMessage ?? '',
          httpVersion: '1.1',
          headers: respHeaders,
          body: { size: 0, contentType: '', stored: 'none' }
        }
        af.flow.timing.firstByte = Date.now()
        af.flow.state = 'forwarded'
        this.emit(af)

        this.collectBody(upstreamRes, af, 'resp')
          .then((respBody) => resolve({ body: respBody }))
          .catch((err) => {
            if (res) this.abortWith(res, af, 'response', err)
            else this.markError(af, 'response', err)
            resolve('failed')
          })
      })

      upstreamReq.on('socket', (sock) => this.trackUpstreamTiming(af, sock))

      upstreamReq.on('error', (err) => {
        if (res) this.serveBadGateway(res, af, err)
        else this.markError(af, 'upstream', err)
        resolve('failed')
      })
      upstreamReq.end(body)
    })
  }

  /**
   * 上游 socket 计时里程碑（绝对时间戳）：DNS lookup 完成 / TCP 连接 / TLS 握手完成。
   * 复用的热连接记 connect=当前时刻（DNS/TLS 属于之前的请求）；
   * h2 池会话跨 flow 复用，不做细分（等待段已涵盖）。
   */
  private trackUpstreamTiming(af: ActiveFlow, sock: net.Socket): void {
    const t = af.flow.timing
    const mark = (k: 'dns' | 'connect' | 'tls'): void => {
      if (t[k] === undefined) t[k] = Date.now()
    }
    if (!sock.connecting) {
      mark('connect')
      return
    }
    // lookup 可能触发多次（A/AAAA），首个即 DNS 完成
    sock.on('lookup', () => mark('dns'))
    sock.on('connect', () => mark('connect'))
    if (sock instanceof tls.TLSSocket) sock.on('secureConnect', () => mark('tls'))
  }

  /** 请求跟踪：开启时生成 traceId（flow 只生成一次），返回要注入上游的头 */
  private traceHeader(af: ActiveFlow): HeaderPair | null {
    const tr = this.settings.trace
    if (!tr?.enabled) return null
    if (!af.flow.traceId) af.flow.traceId = randomUUID()
    if (af.flow.request) af.flow.request.headers.push({ name: tr.header, value: af.flow.traceId })
    return { name: tr.header, value: af.flow.traceId }
  }

  /** 按 origin 复用 HTTP/2 上游连接（http:// 为 h2c 先验知识，https:// 走 TLS+ALPN） */
  private getH2Session(url: URL): http2.ClientHttp2Session {
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    const origin = `${url.protocol}//${url.hostname}:${port}`
    const cached = this.h2Sessions.get(origin)
    if (cached && !cached.destroyed && !cached.closed) return cached
    const session = http2.connect(
      origin,
      url.protocol === 'https:' ? { rejectUnauthorized: this.settings.tls.rejectUpstream } : undefined
    )
    const drop = (): void => {
      if (this.h2Sessions.get(origin) === session) this.h2Sessions.delete(origin)
    }
    session.on('error', drop)
    session.on('close', drop)
    this.h2Sessions.set(origin, session)
    return session
  }

  private performUpstreamH2(
    af: ActiveFlow,
    method: string,
    url: URL,
    headers: HeaderPair[],
    body: Buffer,
    res: http.ServerResponse | null
  ): Promise<{ body: Buffer } | 'failed'> {
    return new Promise((resolve) => {
      let session: http2.ClientHttp2Session
      try {
        session = this.getH2Session(url)
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        if (res) this.serveBadGateway(res, af, e)
        else this.markError(af, 'upstream', e)
        resolve('failed')
        return
      }

      const h2headers: Record<string, string> = {
        ':method': method,
        ':path': url.pathname + url.search
      }
      for (const h of cleanProxyHeaders(headers, url)) {
        const n = h.name.toLowerCase()
        if (n === 'host' || n === 'connection' || n === 'keep-alive' || n === 'proxy-connection' || n === 'transfer-encoding' || n === 'upgrade' || n === 'te') continue
        h2headers[h.name] = h.value
      }
      const traceH = this.traceHeader(af)
      if (traceH) h2headers[traceH.name] = traceH.value
      if (body.length > 0) h2headers['content-length'] = String(body.length)

      let settled = false
      let stream: http2.ClientHttp2Stream
      try {
        stream = session.request(h2headers)
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        if (res) this.serveBadGateway(res, af, e)
        else this.markError(af, 'upstream', e)
        resolve('failed')
        return
      }

      stream.on('response', (respH) => {
        af.flow.response = {
          status: respH[':status'] ?? 0,
          statusText: '',
          httpVersion: '2.0',
          headers: headerPairs(respH),
          body: { size: 0, contentType: '', stored: 'none' },
          trailers: af.respTrailers
        }
        af.flow.timing.firstByte = Date.now()
        af.flow.state = 'forwarded'
        this.emit(af)
      })
      stream.on('trailers', (t) => {
        af.respTrailers.push(...headerPairs(t))
        this.emit(af)
      })
      stream.on('error', (err) => {
        if (settled) return
        settled = true
        if (res) this.serveBadGateway(res, af, err)
        else this.markError(af, 'upstream', err)
        resolve('failed')
      })
      this.collectBody(stream, af, 'resp')
        .then((respBody) => {
          if (settled) return
          settled = true
          resolve({ body: respBody })
        })
        .catch((err) => {
          if (settled) return
          settled = true
          if (res) this.abortWith(res, af, 'response', err)
          else this.markError(af, 'response', err)
          resolve('failed')
        })
      stream.end(body)
    })
  }

  private markError(af: ActiveFlow, stage: string, err: unknown): void {
    af.flow.error = {
      stage,
      code: (err as NodeJS.ErrnoException).code ?? 'UPSTREAM_ERROR',
      message: err instanceof Error ? err.message : String(err)
    }
  }

  // ------------------------------------------------------------------
  // WebSocket upgrade
  // ------------------------------------------------------------------

  private handleUpgrade(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer, isMitm: boolean, reverse?: ReverseTarget): void {
    this.trackSocket(clientSocket)
    const hostHeader = req.headers.host ?? ''
    let targetUrl: URL
    try {
      if (reverse) {
        const scheme = reverse.tls ? 'https' : 'http'
        const origin = `${scheme}://${reverse.host}:${reverse.port}`
        targetUrl = new URL(urlPathOnly(req.url), origin)
      } else if (/^wss?:\/\//i.test(req.url ?? '') || /^https?:\/\//i.test(req.url ?? '')) {
        targetUrl = new URL(req.url!)
      } else if (hostHeader) {
        const scheme = isMitm ? 'https' : 'http'
        targetUrl = new URL(req.url || '/', `${scheme}://${hostHeader}`)
      } else {
        clientSocket.destroy()
        return
      }
    } catch {
      clientSocket.destroy()
      return
    }

    const isWebSocket =
      (req.headers.upgrade ?? '').toLowerCase() === 'websocket' &&
      req.headers['sec-websocket-version'] !== undefined

    if (!isWebSocket) {
      // 非 WebSocket 的 Upgrade：盲隧道透传
      const initial = head && head.length > 0 ? head : null
      void this.blindTunnel(clientSocket, initial, targetUrl.hostname, Number(targetUrl.port || 443), true)
      return
    }

    const af = this.beginFlow({
      kind: 'ws',
      clientIp: clientSocket.remoteAddress ?? '',
      clientPort: clientSocket.remotePort ?? 0,
      clientApp: appLabelOf(clientSocket) ?? undefined,
      tls: isMitm,
      mitm: isMitm,
      sni: isMitm ? hostHeader.split(':')[0] : undefined,
      host: targetUrl.hostname,
      port: Number(targetUrl.port || (isMitm ? 443 : 80))
    })
    const reqHeaders = headerPairs(req.headers)
    af.flow.request = {
      method: req.method ?? 'GET',
      url: targetUrl.toString(),
      httpVersion: req.httpVersion,
      headers: reqHeaders,
      body: { size: 0, contentType: '', stored: 'none' }
    }
    af.flow.timing.requestSent = Date.now()
    af.flow.flags.push('ws')
    this.emit(af)

    const isTls = targetUrl.protocol === 'wss:' || targetUrl.protocol === 'https:'
    const lib = isTls ? https : http
    const upstreamHeaders = cleanProxyHeaders(reqHeaders, targetUrl)
    const options: https.RequestOptions = {
      method: req.method ?? 'GET',
      headers: headersToObject(upstreamHeaders),
      host: targetUrl.hostname,
      port: targetUrl.port || (isTls ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      rejectUnauthorized: this.settings.tls.rejectUpstream
    }
    if (isTls && !isIpAddress(targetUrl.hostname)) {
      options.servername = targetUrl.hostname
    }
    const wsUpConf = this.upstreamConf()
    if (wsUpConf) {
      af.flow.flags.push('upstream')
      if (this.upstreamRequestOptions(targetUrl, options) === null) {
        this.absoluteUriViaProxy(targetUrl, options, wsUpConf)
      }
    }

    const upstreamReq = lib.request(options)
    upstreamReq.on('upgrade', (res, upstreamSocket, upstreamHead) => {
      af.flow.response = {
        status: res.statusCode ?? 101,
        statusText: res.statusMessage ?? '',
        httpVersion: '1.1',
        headers: headerPairs(res.headers),
        body: { size: 0, contentType: '', stored: 'none' }
      }
      af.flow.state = 'forwarded'
      af.flow.timing.firstByte = Date.now()
      this.emit(af)

      // 把上游 101 原样回给客户端
      let respRaw = `HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? ''}\r\n`
      for (const [name, value] of Object.entries(res.headers)) {
        if (value === undefined) continue
        if (Array.isArray(value)) {
          for (const v of value) respRaw += `${name}: ${v}\r\n`
        } else {
          respRaw += `${name}: ${value}\r\n`
        }
      }
      respRaw += '\r\n'
      clientSocket.write(respRaw)
      this.trackSocket(upstreamSocket)
      if (upstreamHead && upstreamHead.length > 0) upstreamSocket.write(upstreamHead)

      this.pipeWs(af, clientSocket, upstreamSocket, head)
    })
    upstreamReq.on('response', (res) => {
      // 非 101：把状态和头转回客户端后结束
      af.flow.response = {
        status: res.statusCode ?? 0,
        statusText: res.statusMessage ?? '',
        httpVersion: '1.1',
        headers: headerPairs(res.headers),
        body: { size: 0, contentType: '', stored: 'none' }
      }
      let respRaw = `HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? ''}\r\n`
      for (const [name, value] of Object.entries(res.headers)) {
        if (value === undefined) continue
        respRaw += `${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`
      }
      respRaw += '\r\n'
      clientSocket.end(respRaw)
      res.resume()
      this.finishFlow(af, 'done')
    })
    upstreamReq.on('error', (err) => {
      af.flow.error = {
        stage: 'upstream',
        code: (err as NodeJS.ErrnoException).code ?? 'UPSTREAM_ERROR',
        message: err.message
      }
      this.finishFlow(af, 'error')
      clientSocket.destroy()
    })
    upstreamReq.end()
  }

  private pipeWs(af: ActiveFlow, clientSocket: net.Socket, upstreamSocket: net.Socket, head: Buffer): void {
    let wsSeq = 0
    let closed = false

    const record = (dir: 'c2s' | 's2c', frame: { opcode: number; payload: Buffer }): void => {
      const msg = {
        seq: ++wsSeq,
        dir,
        opcode: frame.opcode,
        size: frame.payload.length,
        at: Date.now()
      } as WsMessage
      if (frame.opcode === 1) {
        msg.text = frame.payload.toString('utf8').slice(0, 8192)
      } else if (frame.opcode === 8) {
        msg.text = `code=${frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : '—'}`
      }
      try {
        if (!af.paused && !af.turbo) this.repo.insertWsMessage(af.flow.id, msg)
      } catch {
        /* ignore */
      }
      if (dir === 'c2s') af.flow.size.reqBody += frame.payload.length
      else af.flow.size.respBody += frame.payload.length
      af.flow.size.total = af.flow.size.reqBody + af.flow.size.respBody
      af.flow.timing.end = Date.now()
      this.emit(af)
    }

    const c2sParser = new WsFrameParser((frame) => record('c2s', frame))
    const s2cParser = new WsFrameParser((frame) => record('s2c', frame))

    if (head && head.length > 0) c2sParser.push(head)

    clientSocket.on('data', (chunk: Buffer) => {
      c2sParser.push(chunk)
      upstreamSocket.write(chunk)
    })
    upstreamSocket.on('data', (chunk: Buffer) => {
      s2cParser.push(chunk)
      clientSocket.write(chunk)
    })

    const finish = (state: 'done' | 'aborted' | 'error'): void => {
      if (closed) return
      closed = true
      af.flow.timing.end = Date.now()
      this.finishFlow(af, state)
      clientSocket.destroy()
      upstreamSocket.destroy()
    }
    clientSocket.on('close', () => finish('done'))
    clientSocket.on('error', () => finish('aborted'))
    upstreamSocket.on('close', () => finish('done'))
    upstreamSocket.on('error', () => finish('aborted'))
  }

  // ------------------------------------------------------------------
  // CONNECT tunnel
  // ------------------------------------------------------------------

  private async handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): Promise<void> {
    const [rawHost, portStr] = parseAuthority(req.url ?? '')
    const port = Number(portStr || 443)
    if (!rawHost) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    this.trackSocket(clientSocket)
    const { host, mirrored } = this.mirrorTarget(rawHost, port)
    if (mirrored) this.events.onLog('info', `mirror: ${rawHost}:${port} → ${host}:${port}`)

    if (!this.shouldMitmHost(host, port)) {
      await this.blindTunnel(clientSocket, head, host, port)
      return
    }

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    await this.tunnelAfterEstablish(clientSocket, head, host, port)
  }

  /** 域名镜像映射：命中规则的 host 改道（SNI/出站随之替换）；未命中原样返回 */
  private mirrorTarget(host: string, port: number): { host: string; port: number; mirrored: boolean } {
    for (const r of this.settings.mirror?.rules ?? []) {
      if (!r.enabled || !r.mirrorHost) continue
      const from = r.fromHost
      const hit =
        from === '*' ||
        host === from ||
        (from.startsWith('*.') && host.endsWith(from.slice(1)))
      if (hit) {
        const portOverride = r.mirrorPort > 0 ? r.mirrorPort : port
        return { host: r.mirrorHost, port: portOverride, mirrored: true }
      }
    }
    return { host, port, mirrored: false }
  }

  /** CONNECT/SOCKS5 建立后：peek 首字节，TLS 走 MITM，否则盲隧道；httpFallback 时明文 HTTP 注入虚拟服务器解析 */
  private async tunnelAfterEstablish(
    clientSocket: net.Socket,
    head: Buffer,
    host: string,
    port: number,
    httpFallback = false
  ): Promise<void> {
    let prefix: Buffer | null
    try {
      prefix = await peekBytes(clientSocket, head, 8)
    } catch {
      clientSocket.destroy()
      return
    }
    if (prefix === null || prefix.length === 0) {
      clientSocket.destroy()
      return
    }

    if (prefix[0] !== 0x16) {
      if (httpFallback && /^([A-Z]+) \/.*/.test(prefix.toString('latin1'))) {
        if (head && head.length > 0) clientSocket.unshift(head)
        clientSocket.resume()
        this.transparentServer.emit('connection', clientSocket)
        return
      }
      const initial = head && head.length > 0 ? head : null
      await this.blindTunnel(clientSocket, initial, host, port, true)
      return
    }

    if (head && head.length > 0) clientSocket.unshift(head)

    // 原始 socket 交给 MITM 服务端：内部完成 TLS 握手（SNICallback 取叶子证书），
    // ALPN 协商 h2 → HTTP/2 compat、http/1.1 → HTTP/1.1，两种协议共用 handleHttp
    this.mitmServer.emit('connection', clientSocket)
  }

  private shouldMitmHost(host: string, port: number): boolean {
    const bypassRule = firstMatchingRule(
      this.rules,
      { host, path: '', method: 'CONNECT', url: `https://${host}:${port}` },
      ['bypass-tls']
    )
    const bypassed =
      bypassRule !== null ||
      this.settings.tls.bypassHosts.some(
        (pattern) => pattern && (host === pattern || host.endsWith(pattern.startsWith('.') ? pattern : `.${pattern}`))
      )
    return this.settings.tls.mitmEnabled && !bypassed
  }

  // ------------------------------------------------------------------
  // SOCKS5 inbound
  // ------------------------------------------------------------------

  private handleSocksConnection(socket: net.Socket): void {
    this.trackSocket(socket)
    let buf = Buffer.alloc(0)
    let stage: 'greeting' | 'auth' | 'request' = 'greeting'

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      if (stage === 'greeting') {
        if (buf.length < 2) return
        if (buf[0] !== 0x05) {
          socket.destroy()
          return
        }
        const nmethods = buf[1]
        if (buf.length < 2 + nmethods) return
        const offered = Array.from(buf.subarray(2, 2 + nmethods))
        buf = buf.subarray(2 + nmethods)
        if (offered.includes(0x02)) {
          // RFC1929 用户名/密码认证：用户名即客户端应用名（Android tun2socks 注入）
          socket.write(Buffer.from([0x05, 0x02]))
          stage = 'auth'
        } else {
          socket.write(Buffer.from([0x05, 0x00]))
          stage = 'request'
        }
      }
      if (stage === 'auth') {
        if (buf.length < 2) return
        if (buf[0] !== 0x01) {
          socket.destroy()
          return
        }
        const ulen = buf[1]
        if (buf.length < 2 + ulen + 1) return
        const plen = buf[2 + ulen]
        if (buf.length < 2 + ulen + 1 + plen) return
        const username = buf.subarray(2, 2 + ulen).toString('utf8')
        buf = buf.subarray(2 + ulen + 1 + plen)
        socket.write(Buffer.from([0x01, 0x00]))
        if (username) socksAppLabels.set(socket, username)
        stage = 'request'
      }
      if (stage !== 'request') return
      const parsed = parseSocksRequest(buf)
      if (parsed === null) {
        socket.write(socksReply(0x07)) // command not supported
        socket.destroy()
        return
      }
      if (parsed === 'more') return
      socket.removeListener('data', onData)
      socket.pause()
      const parsedTarget = this.mirrorTarget(parsed.host, parsed.port)
      if (parsedTarget.mirrored) {
        this.events.onLog('info', `mirror: ${parsed.host}:${parsed.port} → ${parsedTarget.host}:${parsedTarget.port}`)
      }
      const { host, port, rest } = { host: parsedTarget.host, port: parsedTarget.port, rest: parsed.rest }

      if (!this.shouldMitmHost(host, port)) {
        socket.write(socksReply(0x00))
        void this.blindTunnel(socket, rest.length > 0 ? rest : null, host, port, true)
        return
      }
      socket.write(socksReply(0x00))
      void this.tunnelAfterEstablish(socket, rest, host, port, true)
    }

    socket.on('data', onData)
    socket.on('error', () => socket.destroy())
  }

  private async blindTunnel(
    clientSocket: net.Socket,
    initial: Buffer | null,
    host: string,
    port: number,
    established = false
  ): Promise<void> {
    clientSocket.setTimeout(120_000)
    const af = this.beginFlow({
      kind: 'tunnel',
      clientIp: clientSocket.remoteAddress ?? '',
      clientPort: clientSocket.remotePort ?? 0,
      clientApp: appLabelOf(clientSocket) ?? undefined,
      tls: port === 443,
      mitm: false,
      host,
      port
    })
    af.flow.state = 'forwarded'
    this.emit(af)

    let bytesUp = 0
    let bytesDown = 0
    const upConf = this.upstreamConf()
    if (upConf) af.flow.flags.push('upstream')
    const connect = upConf ? this.connectViaUpstream(host, port) : Promise.resolve(net.connect({ host, port }))

    const wireUp = (upstream: net.Socket): void => {
      if (!established) {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      }
      if (initial && initial.length > 0) upstream.write(initial)
      clientSocket.pipe(upstream)
      upstream.pipe(clientSocket)
      // 计数监听必须在 pipe 之后挂载：提前挂 'data' 会把流切回 flowing，吞掉 peek 后缓冲的数据
      clientSocket.on('data', (d) => (bytesUp += d.length))
      upstream.on('data', (d) => (bytesDown += d.length))
      const done = () => {
        af.flow.timing.firstByte = Date.now()
        af.flow.timing.end = Date.now()
        af.flow.size.total = bytesUp + bytesDown
        af.flow.state = 'done'
        this.finishFlow(af, 'done')
      }
      upstream.on('error', (err) => {
        af.flow.error = { stage: 'tunnel', code: 'UPSTREAM_ERROR', message: err.message }
        this.finishFlow(af, 'error')
        clientSocket.destroy()
      })
      clientSocket.on('error', () => {
        af.flow.state = 'aborted'
        this.finishFlow(af, 'aborted')
        upstream.destroy()
      })
      upstream.on('close', done)
      clientSocket.on('close', () => {
        upstream.destroy()
      })
      upstream.setTimeout(120_000, () => {
        upstream.destroy()
        clientSocket.destroy()
      })
    }

    connect.then(wireUp).catch((err) => {
      // 隧道未建立：给客户端一个 502 而非静默断开（仅 HTTP CONNECT 场景，SOCKS 已回过 0x00）
      if (!established) {
        clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n`)
      }
      af.flow.error = { stage: 'tunnel', code: 'UPSTREAM_ERROR', message: err.message }
      this.finishFlow(af, 'error')
      clientSocket.destroy()
    })
  }

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  private serveCertPage(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '/'
    if (url === '/' || url.startsWith('/index') || url.startsWith('/download')) {
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="proxy-ca.crt"',
        'Content-Length': this.ca.der.length
      })
      res.end(this.ca.der)
    } else {
      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Prism CA</title></head>
<body style="font-family: -apple-system; padding: 40px; max-width: 640px; margin: auto;">
<h1>Prism 根证书</h1>
<p>点击下载 CA 证书，然后在手机上安装（设置 → 安全 → 安装证书）：</p>
<p><a href="/download" style="font-size: 18px;">⬇︎ 下载 proxy-ca.crt</a></p>
<p style="color: #888; font-size: 13px;">SHA-256: ${this.ca.fingerprintSha256}</p>
</body></html>`
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    }
  }

  private beginFlow(init: {
    kind: 'http' | 'tunnel' | 'ws'
    clientIp: string
    clientPort: number
    clientApp?: string
    tls: boolean
    mitm: boolean
    sni?: string
    host: string
    port: number
  }): ActiveFlow {
    const flow: Flow = {
      id: randomUUID(),
      seq: ++this.seq,
      kind: init.kind,
      state: 'pending',
      clientIp: init.clientIp,
      clientPort: init.clientPort,
      clientApp:
        init.clientApp ?? (isLoopback(init.clientIp) ? resolveClientApp(init.clientPort) ?? undefined : undefined),
      tls: init.tls,
      mitm: init.mitm,
      sni: init.sni,
      host: init.host,
      port: init.port,
      timing: { start: Date.now() },
      size: { reqHeader: 0, reqBody: 0, respHeader: 0, respBody: 0, total: 0 },
      flags: [],
      createdAt: Date.now()
    }
    const af: ActiveFlow = {
      flow,
      reqChunks: [],
      reqSize: 0,
      respChunks: [],
      respSize: 0,
      paused: this.settings.capture.paused,
      turbo: this.settings.capture.turbo,
      grpcSeq: 0,
      respTrailers: []
    }
    this.activeFlows.set(flow.id, af)
    return af
  }

  private collectBody(stream: NodeJS.ReadableStream, af: ActiveFlow, part: 'req' | 'resp'): Promise<Buffer> {
    // gRPC（含 grpc-web）：在收流的同时被动解析长度前缀帧，消息实时入库（长流式 RPC 不必等 flow 结束）。
    // 响应头异步到达，content-type 要等到首个数据块（或 end）时才能确定，故惰性创建 parser。
    let grpcParser: GrpcFrameParser | null = null
    let grpcChecked = false
    const ensureGrpcParser = (): void => {
      if (grpcChecked) return
      grpcChecked = true
      const partHeaders = part === 'req' ? af.flow.request?.headers : af.flow.response?.headers
      const contentType = partHeaders?.find((h) => h.name.toLowerCase() === 'content-type')?.value
      if (isGrpcContentType(contentType)) {
        grpcParser = new GrpcFrameParser((frame) => this.recordGrpc(af, part, frame, grpcBodyIsText(contentType)))
        if (!af.flow.flags.includes('grpc')) af.flow.flags.push('grpc')
      }
    }
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      let settled = false
      stream.on('data', (chunk: Buffer) => {
        ensureGrpcParser()
        total += chunk.length
        chunks.push(chunk)
        if (grpcParser) grpcParser.push(chunk)
        if (part === 'req') af.reqSize = total
        else af.respSize = total
      })
      stream.on('end', () => {
        if (settled) return
        settled = true
        ensureGrpcParser()
        resolve(Buffer.concat(chunks))
      })
      stream.on('error', (err) => {
        if (settled) return
        settled = true
        reject(err)
      })
    })
  }

  private recordGrpc(af: ActiveFlow, part: 'req' | 'resp', frame: GrpcFrame, asText: boolean): void {
    const msg: WsMessage = {
      seq: ++af.grpcSeq,
      dir: part === 'req' ? 'c2s' : 's2c',
      opcode: frame.flags,
      size: frame.payload.length,
      at: Date.now()
    }
    // grpc-web 的 trailer 帧以 flags 0x80 标记，负载是文本
    if (asText || (frame.flags & 0x80) !== 0) {
      msg.text = frame.payload.toString('utf8').slice(0, 8192)
    } else if (frame.payload.length > 0) {
      msg.text = decodeProtobufToText(frame.payload).slice(0, 8192)
    }
    try {
      if (!af.paused && !af.turbo) this.repo.insertWsMessage(af.flow.id, msg)
    } catch {
      /* ignore */
    }
    if (part === 'req') af.flow.size.reqBody += frame.payload.length
    else af.flow.size.respBody += frame.payload.length
    af.flow.timing.end = Date.now()
    this.emit(af)
  }

  private finishFlow(
    af: ActiveFlow,
    state: 'done' | 'error' | 'aborted',
    bodies?: {
      reqBody?: { raw: Buffer; meta: BodyMeta }
      respBody?: { raw: Buffer; meta: BodyMeta }
    }
  ): void {
    af.flow.state = state
    af.flow.timing.end = Date.now()
    af.flow.size.reqHeader = af.flow.request
      ? headerByteLength(af.flow.request.method, af.flow.request.url, af.flow.request.headers)
      : 0
    af.flow.size.respHeader = af.flow.response
      ? Buffer.byteLength(
          `${af.flow.response.status} ${af.flow.response.statusText}\r\n` +
            af.flow.response.headers.map((h) => `${h.name}: ${h.value}\r\n`).join('')
        )
      : 0
    af.flow.size.total =
      af.flow.size.reqHeader + af.flow.size.reqBody + af.flow.size.respHeader + af.flow.size.respBody
    this.countRuleMatches(af.flow)
    this.emit(af)
    if (!af.paused && !af.turbo) {
      this.repo.complete({
        flow: af.flow,
        reqBody: bodies?.reqBody,
        respBody: bodies?.respBody
      })
    }
    this.activeFlows.delete(af.flow.id)
  }

  private abortWith(
    res: http.ServerResponse,
    af: ActiveFlow,
    stage: string,
    err: unknown
  ): void {
    af.flow.error = {
      stage,
      code: 'ERR_BODY',
      message: err instanceof Error ? err.message : String(err)
    }
    this.finishFlow(af, 'error')
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
    }
    res.destroy()
  }

  private serveBadGateway(res: http.ServerResponse, af: ActiveFlow, err: Error): void {
    af.flow.state = 'error'
    af.flow.error = {
      stage: 'upstream',
      code: (err as NodeJS.ErrnoException).code ?? 'UPSTREAM_ERROR',
      message: err.message
    }
    this.finishFlow(af, 'error')
    if (!res.headersSent) {
      const body = `<!DOCTYPE html><html><body style="font-family:monospace;padding:24px">
<h2>502 Upstream Error</h2><pre>${escapeHtml(err.message)}</pre></body></html>`
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(body)
    } else {
      res.destroy()
    }
  }

  private emit(af: ActiveFlow): void {
    if (!af.paused) this.events.onFlowUpdate(af.flow)
  }

  getRepo(): FlowsRepo {
    return this.repo
  }
}

function headerPairs(headers: http.IncomingHttpHeaders): HeaderPair[] {
  const out: HeaderPair[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(':')) continue
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const v of value) out.push({ name, value: v })
    } else {
      out.push({ name, value })
    }
  }
  return out
}

function cleanProxyHeaders(headers: HeaderPair[], target: URL): HeaderPair[] {
  return headers.filter((h) => {
    const n = h.name.toLowerCase()
    if (n === 'host') return false
    if (HOP_BY_HOP.has(n)) return false
    if (n.startsWith('proxy-')) return false
    return true
  }).map((h) => ({ name: h.name, value: h.value }))
}

/** 绝对 URL 只取 path+search（反向代理强制重写目标时用） */
function urlPathOnly(url: string | undefined): string {
  if (!url || !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url || '/'
  try {
    const u = new URL(url)
    return u.pathname + u.search
  } catch {
    return '/'
  }
}

function headersToObject(headers: HeaderPair[]): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const h of headers) {
    const existing = out[h.name]
    if (existing === undefined) out[h.name] = h.value
    else if (Array.isArray(existing)) existing.push(h.value)
    else out[h.name] = [String(existing), h.value]
  }
  return out
}

function setContentLength(headers: HeaderPair[], length: number): void {
  const idx = headers.findIndex((h) => h.name.toLowerCase() === 'content-length')
  const pair = { name: 'Content-Length', value: String(length) }
  if (idx >= 0) headers[idx] = pair
  else headers.push(pair)
}

function removeHeader(headers: HeaderPair[], name: string): void {
  const n = name.toLowerCase()
  for (let i = headers.length - 1; i >= 0; i--) {
    if (headers[i].name.toLowerCase() === n) headers.splice(i, 1)
  }
}

function markBreakpoint(af: ActiveFlow): void {
  if (!af.flow.flags.includes('breakpoint')) af.flow.flags.push('breakpoint')
}

function parseAuthority(url: string): [string, string] {
  let authority = url.trim()
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    if (end > 0) {
      const host = authority.slice(0, end + 1)
      const port = authority.slice(end + 2)
      return [host, port]
    }
  }
  const idx = authority.lastIndexOf(':')
  if (idx > 0) return [authority.slice(0, idx), authority.slice(idx + 1)]
  return [authority, '']
}

/** 解析 SOCKS5 CONNECT 请求；'more' = 数据不足，null = 协议错误 */
function parseSocksRequest(
  buf: Buffer
): { host: string; port: number; rest: Buffer } | 'more' | null {
  if (buf.length < 4) return 'more'
  if (buf[0] !== 0x05) return null
  if (buf[1] !== 0x01) return null // 仅支持 CONNECT
  const atyp = buf[3]
  let host: string
  let offset: number
  if (atyp === 0x01) {
    if (buf.length < 8) return 'more'
    host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
    offset = 8
  } else if (atyp === 0x03) {
    if (buf.length < 5) return 'more'
    const len = buf[4]
    if (buf.length < 5 + len) return 'more'
    host = buf.subarray(5, 5 + len).toString('ascii')
    offset = 5 + len
  } else if (atyp === 0x04) {
    if (buf.length < 20) return 'more'
    host = formatIpv6(buf.subarray(4, 20))
    offset = 20
  } else {
    return null
  }
  if (buf.length < offset + 2) return 'more'
  const port = buf.readUInt16BE(offset)
  return { host, port, rest: buf.subarray(offset + 2) }
}

function socksReply(rep: number): Buffer {
  // VER REP RSV ATYP=IPv4 BND.ADDR=0.0.0.0 BND.PORT=0
  return Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
}

function formatIpv6(bytes: Buffer): string {
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) {
    groups.push(bytes.readUInt16BE(i).toString(16))
  }
  return groups.join(':')
}

function peekByte(socket: net.Socket, head: Buffer): Promise<number | null> {
  return peekBytes(socket, head, 1).then((b) => (b && b.length > 0 ? b[0] : null))
}

/** 窥探流的前 n 字节（head 不足时从 socket 读取后再 unshift 回去，流保持原状）；返回实际可用前缀，无数据返回 null */
function peekBytes(socket: net.Socket, head: Buffer, n: number): Promise<Buffer | null> {
  if (head && head.length >= n) return Promise.resolve(head.subarray(0, n))
  return new Promise((resolve) => {
    let settled = false
    const collected: Buffer[] = []
    let collectedLen = 0
    const headLen = head ? head.length : 0
    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      const fromSocket = Buffer.concat(collected)
      if (fromSocket.length > 0) socket.unshift(fromSocket)
      const parts: Buffer[] = []
      if (headLen > 0) parts.push(head)
      if (fromSocket.length > 0) parts.push(fromSocket)
      const prefix = parts.length > 0 ? Buffer.concat(parts) : Buffer.alloc(0)
      resolve(prefix.length > 0 ? prefix : null)
    }
    const tryRead = () => {
      while (headLen + collectedLen < n) {
        const need = n - headLen - collectedLen
        const b = socket.read(need) as Buffer | null
        if (b === null) return
        collected.push(b)
        collectedLen += b.length
      }
      finish()
    }
    const cleanup = () => {
      socket.removeListener('readable', tryRead)
      socket.removeListener('end', finish)
      socket.removeListener('error', finish)
      socket.removeListener('close', finish)
    }
    socket.on('readable', tryRead)
    socket.on('end', finish)
    socket.on('error', finish)
    socket.on('close', finish)
    tryRead()
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function headerByteLength(method: string, url: string, headers: HeaderPair[]): number {
  let size = `${method} ${url} HTTP/1.1\r\n`.length
  for (const h of headers) size += `${h.name}: ${h.value}\r\n`.length
  return size + 2
}

function isIpAddress(host: string): boolean {
  return net.isIP(host) !== 0
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

/** 访问控制比对用 IP 归一化：去 ::ffff: 前缀；::1 与 127.0.0.1 视为同一本机 */
function normalizeClientIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase()
  const bare = trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed
  return bare === '::1' ? '127.0.0.1' : bare
}

// SOCKS5 RFC1929 用户名携带的客户端应用名（Android tun2socks 注入）
const socksAppLabels = new WeakMap<net.Socket, string>()

function appLabelOf(sock: unknown): string | null {
  let cur: unknown = sock
  for (let i = 0; i < 4 && cur; i++) {
    const label = socksAppLabels.get(cur as net.Socket)
    if (label) return label
    cur = (cur as { _parent?: unknown })._parent
  }
  return null
}
