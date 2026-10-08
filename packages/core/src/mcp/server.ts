import * as http from 'node:http'
import * as zlib from 'node:zlib'
import type { FlowsRepo } from '../db/flows-repo'
import type { Flow, HeaderPair } from '@proxy/shared'

/** MCP Streamable HTTP（无状态实现：POST /mcp 单 JSON 或批量数组，直接回 JSON，不用 SSE） */
const PROTOCOL_VERSION = '2025-06-18'
const MAX_BODY_CHARS = 20_000

interface JsonRpcRequest {
  jsonrpc: string
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export class McpServer {
  private server: http.Server | null = null
  private port = 0

  constructor(
    private repo: FlowsRepo,
    private log: (level: string, message: string) => void,
    private version: string
  ) {}

  get listeningPort(): number {
    return this.port
  }

  async listen(port: number): Promise<void> {
    if (this.server) return
    const srv = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.log('warn', `mcp: ${err instanceof Error ? err.message : String(err)}`)
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(port, '127.0.0.1', () => resolve())
    })
    this.server = srv
    this.port = port
    this.log('info', `mcp server listening on http://127.0.0.1:${port}/mcp`)
  }

  async close(): Promise<void> {
    const srv = this.server
    if (!srv) return
    this.server = null
    this.port = 0
    await new Promise<void>((resolve) => srv.close(() => resolve()))
    this.log('info', 'mcp server stopped')
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method !== 'POST' || (url.pathname !== '/mcp' && url.pathname !== '/')) {
      res.writeHead(405, { Allow: 'POST' })
      res.end()
      return
    }
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      res.writeHead(200, jsonHeaders())
      res.end(rpcError(null, -32700, 'parse error'))
      return
    }
    const batch = Array.isArray(parsed) ? (parsed as JsonRpcRequest[]) : [parsed as JsonRpcRequest]
    const results: string[] = []
    for (const msg of batch) {
      try {
        const result = await this.dispatch(msg)
        if (result !== null) results.push(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result }))
      } catch (err) {
        if (msg.id !== undefined) {
          results.push(
            rpcError(msg.id, err instanceof RpcError ? err.code : -32603, err instanceof Error ? err.message : String(err))
          )
        }
      }
    }
    // 纯通知批次：按规范回 202
    if (results.length === 0) {
      res.writeHead(202)
      res.end()
      return
    }
    res.writeHead(200, jsonHeaders())
    res.end(Array.isArray(parsed) ? `[${results.join(',')}]` : results[0])
  }

  private async dispatch(msg: JsonRpcRequest): Promise<unknown | null> {
    switch (msg.method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'prism', version: this.version }
        }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: TOOLS }
      case 'tools/call':
        return this.callTool(msg.params ?? {})
      default:
        throw new RpcError(-32601, `method not found: ${msg.method}`)
    }
  }

  private async callTool(params: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
    const name = String(params.name ?? '')
    const args = (params.arguments ?? {}) as Record<string, unknown>
    try {
      switch (name) {
        case 'list_flows':
          return text(this.toolListFlows(args))
        case 'get_flow':
          return text(this.toolGetFlow(args))
        case 'get_flow_body':
          return text(this.toolGetFlowBody(args))
        default:
          throw new RpcError(-32602, `unknown tool: ${name}`)
      }
    } catch (err) {
      if (err instanceof RpcError) throw err
      // 工具执行失败按 MCP 语义返回 isError 内容而非协议错误
      return text(`执行失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private toolListFlows(args: Record<string, unknown>): string {
    const filter = typeof args.filter === 'string' ? args.filter : ''
    const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500)
    const flows = this.repo.list({ filter, limit })
    if (flows.length === 0) return `没有匹配的流量（filter: ${filter || '无'}）。`
    const lines = flows.map(
      (f) =>
        `#${f.seq} [${f.state}] ${f.method ?? '—'} ${f.host ?? '?'}${f.path ?? ''} → ${
          f.status ?? '—'
        } ${f.durationMs ?? '—'}ms ${f.flags.length ? `(${f.flags.join(',')})` : ''} id=${f.id}`
    )
    return `${flows.length} 条流量（最新在前）：\n` + lines.join('\n')
  }

  private toolGetFlow(args: Record<string, unknown>): string {
    const flow = this.findFlow(args)
    if (!flow) return '未找到对应流量。'
    return JSON.stringify(flow, null, 2)
  }

  private toolGetFlowBody(args: Record<string, unknown>): string {
    const flow = this.findFlow(args)
    if (!flow) return '未找到对应流量。'
    const part = args.part === 'request' ? 'req' : 'resp'
    const body = this.repo.getRawBody(flow.id, part)
    if (!body || body.raw.length === 0) return `${part === 'req' ? '请求' : '响应'}体为空。`
    let raw = body.raw
    const headers: HeaderPair[] = (part === 'req' ? flow.request?.headers : flow.response?.headers) ?? []
    const enc = headers.find((h) => h.name.toLowerCase() === 'content-encoding')?.value?.toLowerCase()
    try {
      if (enc === 'gzip') raw = zlib.gunzipSync(raw)
      else if (enc === 'deflate') raw = zlib.inflateSync(raw)
      else if (enc === 'br') raw = zlib.brotliDecompressSync(raw)
    } catch {
      /* 保留原始字节 */
    }
    const ct = body.meta.contentType
    const texty = ct.startsWith('text/') || /json|xml|urlencoded|javascript/.test(ct) || (!ct && this.looksTexty(raw))
    if (!texty) return `二进制内容（${raw.length} B，Content-Type: ${ct || '未知'}），共 ${body.raw.length} 字节原始数据。`
    const decoded = raw.toString('utf8')
    if (decoded.length > MAX_BODY_CHARS) {
      return `${decoded.slice(0, MAX_BODY_CHARS)}\n…（截断，共 ${decoded.length} 字符）`
    }
    return decoded
  }

  private looksTexty(raw: Buffer): boolean {
    const probe = raw.subarray(0, 512)
    for (const b of probe) {
      if (b === 0) return false
    }
    return true
  }

  private findFlow(args: Record<string, unknown>): Flow | null {
    if (typeof args.id === 'string' && args.id) return this.repo.get(args.id)
    const seq = Number(args.seq)
    if (Number.isFinite(seq) && seq > 0) {
      const hit = this.repo.list({ limit: 5000 }).find((f) => f.seq === seq)
      if (hit) return this.repo.get(hit.id)
    }
    return null
  }
}

class RpcError extends Error {
  constructor(
    public code: number,
    message: string
  ) {
    super(message)
  }
}

function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'MCP-Protocol-Version': PROTOCOL_VERSION }
}

function rpcError(id: number | string | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

function text(t: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: t }] }
}

const TOOLS: ToolDef[] = [
  {
    name: 'list_flows',
    description: '列出抓包流量（最新在前）。filter 支持 host:/path:/method:/status:/app:/trace:/sni:/body: 等前缀语法',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '过滤表达式，如 "host:api.example.com status:2xx"' },
        limit: { type: 'number', description: '返回条数（默认 50，最大 500）' }
      }
    }
  },
  {
    name: 'get_flow',
    description: '获取单条流量的完整信息（URL、请求/响应头、状态、时序、尺寸）',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '流量 id（list_flows 结果中的 id=）' },
        seq: { type: 'number', description: '流量序号（#N），与 id 二选一' }
      }
    }
  },
  {
    name: 'get_flow_body',
    description: '读取流量的请求/响应体文本（自动解压 gzip/deflate/br，超长截断）',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        seq: { type: 'number' },
        part: { type: 'string', enum: ['request', 'response'], description: '默认 response' }
      }
    }
  }
]
