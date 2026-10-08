import { writeFileSync, unlinkSync, readFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from './database'
import type { BodyMeta, BodyStorage, CollectionItem, Flow, FlowSummary, HeaderPair, WbNode, WsMessage } from '@proxy/shared'
import { parseFilter, type FilterNode } from '@proxy/shared'

const INLINE_LIMIT = 256 * 1024
const FLUSH_INTERVAL_MS = 200
const FLUSH_BATCH = 100

export interface BodyPersist {
  raw: Buffer
  meta: BodyMeta
}

export interface CompleteEntry {
  flow: Flow
  reqBody?: BodyPersist
  respBody?: BodyPersist
}

interface FlowRow {
  id: string
  seq: number
  kind: string
  state: string
  created_at: number
  client_ip: string | null
  client_port: number | null
  client_app: string | null
  tls: number
  mitm: number
  sni: string | null
  host: string | null
  port: number | null
  method: string | null
  path: string | null
  url: string | null
  http_version: string | null
  resp_http_version: string | null
  resp_trailers: string | null
  status: number | null
  status_text: string | null
  duration_ms: number | null
  req_headers: string | null
  resp_headers: string | null
  req_header_size: number
  req_body_size: number
  resp_header_size: number
  resp_body_size: number
  req_content_type: string | null
  resp_content_type: string | null
  t_request_sent: number | null
  t_dns: number | null
  t_connect: number | null
  t_tls: number | null
  t_first_byte: number | null
  t_end: number | null
  error: string | null
  flags: string
  label: string | null
  note: string | null
  trace_id: string | null
}

interface BodyRow {
  flow_id: string
  part: string
  size: number
  stored: string
  truncated: number
  inline: Uint8Array | null
  file_path: string | null
  encoding: string | null
  content_type: string | null
  is_text: number | null
  preview: string | null
}

type Stmt = ReturnType<Db['prepare']>

export class FlowsRepo {
  private queue: CompleteEntry[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private bodiesDir: string

  private stmtInsertFlow: Stmt
  private stmtInsertBody: Stmt
  private stmtGetFlow: Stmt
  private stmtGetBody: Stmt
  private stmtMaxSeq: Stmt
  private stmtGetSetting: Stmt
  private stmtSetSetting: Stmt
  private stmtInsertWs: Stmt
  private stmtListWs: Stmt

  constructor(
    private db: Db,
    dataDir: string
  ) {
    this.bodiesDir = join(dataDir, 'data', 'bodies')
    mkdirSync(this.bodiesDir, { recursive: true })
    this.stmtInsertFlow = db.prepare(`INSERT OR REPLACE INTO flows (
      id, seq, kind, state, created_at, client_ip, client_port, client_app, tls, mitm, sni, host, port,
      method, path, url, http_version, resp_http_version, resp_trailers, status, status_text, duration_ms,
      req_headers, resp_headers, req_header_size, req_body_size, resp_header_size, resp_body_size,
      req_content_type, resp_content_type, t_request_sent, t_dns, t_connect, t_tls, t_first_byte, t_end,
      error, flags, label, note, trace_id
    ) VALUES (
      @id, @seq, @kind, @state, @created_at, @client_ip, @client_port, @client_app, @tls, @mitm, @sni, @host, @port,
      @method, @path, @url, @http_version, @resp_http_version, @resp_trailers, @status, @status_text, @duration_ms,
      @req_headers, @resp_headers, @req_header_size, @req_body_size, @resp_header_size, @resp_body_size,
      @req_content_type, @resp_content_type, @t_request_sent, @t_dns, @t_connect, @t_tls, @t_first_byte, @t_end,
      @error, @flags, @label, @note, @trace_id
    )`)
    this.stmtInsertBody = db.prepare(`INSERT OR REPLACE INTO bodies (
      flow_id, part, size, stored, truncated, inline, file_path, encoding, content_type, is_text, preview
    ) VALUES (@flow_id, @part, @size, @stored, @truncated, @inline, @file_path, @encoding, @content_type, @is_text, @preview)`)
    this.stmtGetFlow = db.prepare('SELECT * FROM flows WHERE id = ?')
    this.stmtGetBody = db.prepare('SELECT * FROM bodies WHERE flow_id = ? AND part = ?')
    this.stmtMaxSeq = db.prepare('SELECT MAX(seq) AS m FROM flows')
    this.stmtGetSetting = db.prepare('SELECT value FROM settings WHERE key = ?')
    this.stmtSetSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    this.stmtInsertWs = db.prepare(
      'INSERT INTO ws_messages (flow_id, seq, dir, opcode, size, text, at) VALUES (@flow_id, @seq, @dir, @opcode, @size, @text, @at)'
    )
    this.stmtListWs = db.prepare('SELECT * FROM ws_messages WHERE flow_id = ? ORDER BY seq ASC')
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS)
    this.timer.unref?.()
  }

  maxSeq(): number {
    const row = this.stmtMaxSeq.get() as { m: number | null } | undefined
    return row?.m ?? 0
  }

  getSetting<T>(key: string): T | null {
    const row = this.stmtGetSetting.get(key) as { value: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.value) as T
    } catch {
      return null
    }
  }

  setSetting(key: string, value: unknown): void {
    this.stmtSetSetting.run(key, JSON.stringify(value))
  }

  complete(entry: CompleteEntry): void {
    this.queue.push(entry)
    if (this.queue.length >= FLUSH_BATCH) this.flush()
  }

  flush(): void {
    if (this.queue.length === 0) return
    const batch = this.queue.splice(0, this.queue.length)
    this.db.exec('BEGIN')
    try {
      for (const entry of batch) {
        this.writeEntry(entry)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private writeEntry(entry: CompleteEntry): void {
    this.stmtInsertFlow.run(namedParams(entry.flow) as Record<string, import('node:sqlite').SQLInputValue>)
    if (entry.reqBody) this.writeBody(entry.flow.id, 'req', entry.reqBody)
    if (entry.respBody) this.writeBody(entry.flow.id, 'resp', entry.respBody)
  }

  private writeBody(flowId: string, part: string, body: BodyPersist): void {
    const { raw, meta } = body
    const truncated = meta.stored === 'truncated' ? 1 : 0
    let stored: string = 'none'
    let inline: Buffer | null = null
    let filePath: string | null = null
    if (raw.length === 0) {
      stored = 'none'
    } else if (raw.length <= INLINE_LIMIT) {
      stored = 'inline'
      inline = raw
    } else {
      stored = 'file'
      filePath = join(this.bodiesDir, `${flowId}.${part}.bin`)
      writeFileSync(filePath, raw)
    }
    this.stmtInsertBody.run({
      flow_id: flowId,
      part,
      size: meta.size,
      stored,
      truncated,
      inline,
      file_path: filePath,
      encoding: meta.encoding ?? null,
      content_type: meta.contentType,
      is_text: meta.isText ? 1 : 0,
      preview: meta.preview ?? null
    } as unknown as Record<string, import('node:sqlite').SQLInputValue>)
  }

  list(opts: { filter?: string; beforeSeq?: number; limit?: number }): FlowSummary[] {
    const nodes = parseFilter(opts.filter ?? '')
    const { sql, params } = buildWhere(nodes, opts.beforeSeq)
    const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 5000)
    const stmt = this.db.prepare(`SELECT * FROM flows ${sql} ORDER BY seq DESC LIMIT ${limit}`)
    const rows = stmt.all(...(params as import('node:sqlite').SQLInputValue[])) as unknown as FlowRow[]
    return rows.map(rowToSummary)
  }

  get(id: string): Flow | null {
    const row = this.stmtGetFlow.get(id) as unknown as FlowRow | undefined
    if (!row) return null
    return rowToFlow(row, this.readBodyMeta(id, 'req'), this.readBodyMeta(id, 'resp'))
  }

  /** 更新用户标签/备注（空串清除）。flow 若仍在写入队列中，先落库避免 INSERT OR REPLACE 覆盖 */
  updateFlowMeta(id: string, label: string | null, note: string | null): void {
    const inQueue = this.queue.find((e) => e.flow.id === id)
    if (inQueue) {
      inQueue.flow.label = label ?? undefined
      inQueue.flow.note = note ?? undefined
    }
    this.flush()
    this.db.prepare('UPDATE flows SET label = ?, note = ? WHERE id = ?').run(label, note, id)
  }

  getRawBody(id: string, part: 'req' | 'resp'): { raw: Buffer; meta: BodyMeta } | null {
    const row = this.stmtGetBody.get(id, part) as unknown as BodyRow | undefined
    if (!row) return null
    let raw: Buffer | null = null
    if (row.stored === 'inline' && row.inline) {
      raw = Buffer.from(row.inline)
    } else if (row.file_path) {
      try {
        raw = readFileSync(row.file_path)
      } catch {
        raw = null
      }
    }
    return {
      raw: raw ?? Buffer.alloc(0),
      meta: bodyRowToMeta(row)
    }
  }

  private readBodyMeta(id: string, part: 'req' | 'resp'): BodyMeta {
    const row = this.stmtGetBody.get(id, part) as unknown as BodyRow | undefined
    if (!row) return { size: 0, contentType: '', stored: 'none' }
    return bodyRowToMeta(row)
  }

  insertWsMessage(flowId: string, msg: WsMessage): void {
    this.stmtInsertWs.run({
      flow_id: flowId,
      seq: msg.seq,
      dir: msg.dir,
      opcode: msg.opcode,
      size: msg.size,
      text: msg.text ?? null,
      at: msg.at
    } as unknown as Record<string, import('node:sqlite').SQLInputValue>)
  }

  listWsMessages(flowId: string): WsMessage[] {
    const rows = this.stmtListWs.all(flowId) as unknown as {
      seq: number
      dir: string
      opcode: number
      size: number
      text: string | null
      at: number
    }[]
    return rows.map((r) => ({
      seq: r.seq,
      dir: r.dir as WsMessage['dir'],
      opcode: r.opcode,
      size: r.size,
      text: r.text ?? undefined,
      at: r.at
    }))
  }

  clear(): void {
    this.flush()
    const rows = this.db
      .prepare('SELECT file_path FROM bodies WHERE file_path IS NOT NULL')
      .all() as unknown as { file_path: string }[]
    for (const r of rows) {
      try {
        unlinkSync(r.file_path)
      } catch {
        /* ignore */
      }
    }
    this.db.exec('DELETE FROM flows')
    this.db.exec('DELETE FROM bodies')
    this.db.exec('DELETE FROM ws_messages')
  }

  // ------------------------------------------------------------------
  // collections（快照存储，与 flows 生命周期解耦）
  // ------------------------------------------------------------------

  listCollections(): CollectionItem[] {
    const rows = this.db
      .prepare('SELECT id, name, group_name, folder_id, created_at, snapshot FROM collections ORDER BY created_at DESC')
      .all() as unknown as {
      id: string
      name: string
      group_name: string
      folder_id: string | null
      created_at: number
      snapshot: string
    }[]
    const out: CollectionItem[] = []
    for (const r of rows) {
      try {
        out.push({
          id: r.id,
          name: r.name,
          group: r.group_name,
          folderId: r.folder_id ?? null,
          createdAt: r.created_at,
          ...(JSON.parse(r.snapshot) as Omit<CollectionItem, 'id' | 'name' | 'group' | 'folderId' | 'createdAt'>)
        })
      } catch {
        /* 跳过损坏行 */
      }
    }
    return out
  }

  addCollection(item: CollectionItem): void {
    const { id, name, group, folderId, createdAt, ...snapshot } = item
    this.db
      .prepare('INSERT INTO collections (id, name, group_name, folder_id, created_at, snapshot) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, group, folderId ?? null, createdAt, JSON.stringify(snapshot))
  }

  removeCollection(id: string): void {
    this.db.prepare('DELETE FROM collections WHERE id = ?').run(id)
  }

  setCollectionFolder(id: string, folderId: string | null): void {
    this.db.prepare('UPDATE collections SET folder_id = ? WHERE id = ?').run(folderId, id)
  }

  // ------------------------------------------------------------------
  // 工作台树节点（收藏文件夹 / 书签）
  // ------------------------------------------------------------------

  listWbNodes(): WbNode[] {
    const rows = this.db
      .prepare('SELECT id, scope, kind, parent_id, name, filter, created_at FROM wb_nodes ORDER BY created_at ASC')
      .all() as unknown as {
      id: string
      scope: string
      kind: string
      parent_id: string | null
      name: string
      filter: string | null
      created_at: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope as WbNode['scope'],
      kind: r.kind as WbNode['kind'],
      parentId: r.parent_id ?? null,
      name: r.name,
      filter: r.filter ?? undefined,
      createdAt: r.created_at
    }))
  }

  addWbNode(node: WbNode): void {
    this.db
      .prepare('INSERT INTO wb_nodes (id, scope, kind, parent_id, name, filter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(node.id, node.scope, node.kind, node.parentId, node.name, node.filter ?? null, node.createdAt)
  }

  renameWbNode(id: string, name: string): void {
    this.db.prepare('UPDATE wb_nodes SET name = ? WHERE id = ?').run(name, id)
  }

  moveWbNode(id: string, parentId: string | null): void {
    this.db.prepare('UPDATE wb_nodes SET parent_id = ? WHERE id = ?').run(parentId, id)
  }

  /** 删除节点及其全部后代；返回被删除的 id 集合（调用方据此把收藏条目移回根级） */
  removeWbNodeCascade(id: string): Set<string> {
    const all = this.listWbNodes()
    const childrenOf = new Map<string | null, WbNode[]>()
    for (const n of all) {
      const key = n.parentId
      if (!childrenOf.has(key)) childrenOf.set(key, [])
      childrenOf.get(key)!.push(n)
    }
    const dead = new Set<string>()
    const stack = [id]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (dead.has(cur)) continue
      dead.add(cur)
      for (const child of childrenOf.get(cur) ?? []) stack.push(child.id)
    }
    const del = this.db.prepare('DELETE FROM wb_nodes WHERE id = ?')
    for (const target of dead) del.run(target)
    return dead
  }

  /** 按条件删除 flows 及其 bodies/ws_messages 关联数据，先落盘写缓冲；返回删除数与释放的文件字节数 */
  deleteFlowsWhere(whereSql: string, params: unknown[]): { count: number; freedBytes: number } {
    this.flush()
    const sqlParams = params as import('node:sqlite').SQLInputValue[]
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM flows WHERE ${whereSql}`)
      .get(...sqlParams) as unknown as { c: number } | undefined
    const count = countRow?.c ?? 0
    if (count === 0) return { count: 0, freedBytes: 0 }
    const files = this.db
      .prepare(
        `SELECT file_path FROM bodies WHERE file_path IS NOT NULL AND flow_id IN (SELECT id FROM flows WHERE ${whereSql})`
      )
      .all(...sqlParams) as unknown as { file_path: string }[]
    this.db.exec('BEGIN')
    try {
      this.db
        .prepare(`DELETE FROM ws_messages WHERE flow_id IN (SELECT id FROM flows WHERE ${whereSql})`)
        .run(...sqlParams)
      this.db
        .prepare(`DELETE FROM bodies WHERE flow_id IN (SELECT id FROM flows WHERE ${whereSql})`)
        .run(...sqlParams)
      this.db.prepare(`DELETE FROM flows WHERE ${whereSql}`).run(...sqlParams)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    let freedBytes = 0
    for (const f of files) {
      try {
        freedBytes += statSync(f.file_path).size
        unlinkSync(f.file_path)
      } catch {
        /* ignore */
      }
    }
    return { count, freedBytes }
  }

  /** 第 offset+1 新的 flow 的 seq（从新到旧排序）；不足则返回 null */
  seqAtOffset(offset: number): number | null {
    const row = this.db
      .prepare('SELECT seq FROM flows ORDER BY seq DESC LIMIT 1 OFFSET ?')
      .get(offset) as unknown as { seq: number } | undefined
    return row?.seq ?? null
  }

  countFlows(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM flows').get() as unknown as { c: number } | undefined
    return row?.c ?? 0
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.flush()
  }
}

function bodyRowToMeta(row: BodyRow): BodyMeta {
  return {
    size: row.size,
    contentType: row.content_type ?? 'application/octet-stream',
    encoding: row.encoding ?? undefined,
    stored: (row.truncated === 1 ? 'truncated' : row.stored) as BodyStorage,
    isText: row.is_text === 1,
    preview: row.preview ?? undefined
  }
}

function namedParams(f: Flow): Record<string, unknown> {
  const dur = f.timing.end !== undefined ? f.timing.end - f.timing.start : null
  return {
    id: f.id,
    seq: f.seq,
    kind: f.kind,
    state: f.state,
    created_at: f.createdAt,
    client_ip: f.clientIp,
    client_port: f.clientPort,
    client_app: f.clientApp ?? null,
    tls: f.tls ? 1 : 0,
    mitm: f.mitm ? 1 : 0,
    sni: f.sni ?? null,
    host: f.host ?? null,
    port: f.port ?? null,
    method: f.request?.method ?? null,
    path: f.request ? new URL(f.request.url).pathname : null,
    url: f.request?.url ?? null,
    http_version: f.request?.httpVersion ?? null,
    resp_http_version: f.response?.httpVersion ?? null,
    resp_trailers: f.response?.trailers ? JSON.stringify(f.response.trailers) : null,
    status: f.response?.status ?? null,
    status_text: f.response?.statusText ?? null,
    duration_ms: dur,
    req_headers: f.request ? JSON.stringify(f.request.headers) : null,
    resp_headers: f.response ? JSON.stringify(f.response.headers) : null,
    req_header_size: f.size.reqHeader,
    req_body_size: f.size.reqBody,
    resp_header_size: f.size.respHeader,
    resp_body_size: f.size.respBody,
    req_content_type: f.request?.body.contentType ?? null,
    resp_content_type: f.response?.body.contentType ?? null,
    t_request_sent: f.timing.requestSent ?? null,
    t_dns: f.timing.dns ?? null,
    t_connect: f.timing.connect ?? null,
    t_tls: f.timing.tls ?? null,
    t_first_byte: f.timing.firstByte ?? null,
    t_end: f.timing.end ?? null,
    error: f.error ? JSON.stringify(f.error) : null,
    flags: JSON.stringify(f.flags),
    label: f.label ?? null,
    note: f.note ?? null,
    trace_id: f.traceId ?? null
  }
}

function rowToSummary(r: FlowRow): FlowSummary {
  const err = r.error ? (safeParse(r.error, null) as Flow['error'] | null) : null
  return {
    id: r.id,
    seq: r.seq,
    kind: r.kind as FlowSummary['kind'],
    state: r.state as FlowSummary['state'],
    method: r.method ?? undefined,
    host: r.host ?? undefined,
    path: r.path ?? undefined,
    url: r.url ?? undefined,
    status: r.status ?? undefined,
    statusText: r.status_text ?? undefined,
    durationMs: r.duration_ms ?? undefined,
    reqSize: r.req_body_size,
    respSize: r.resp_body_size,
    totalSize: r.req_header_size + r.req_body_size + r.resp_header_size + r.resp_body_size,
    respContentType: r.resp_content_type ?? undefined,
    flags: safeParse(r.flags, []) as string[],
    error: err?.message,
    tls: r.tls === 1,
    mitm: r.mitm === 1,
    sni: r.sni ?? undefined,
    clientIp: r.client_ip ?? undefined,
    clientApp: r.client_app ?? undefined,
    label: r.label ?? undefined,
    note: r.note ?? undefined,
    traceId: r.trace_id ?? undefined,
    createdAt: r.created_at
  }
}

function rowToFlow(r: FlowRow, reqMeta: BodyMeta, respMeta: BodyMeta): Flow {
  const flow: Flow = {
    id: r.id,
    seq: r.seq,
    kind: r.kind as Flow['kind'],
    state: r.state as Flow['state'],
    clientIp: r.client_ip ?? '',
    clientPort: r.client_port ?? 0,
    clientApp: r.client_app ?? undefined,
    tls: r.tls === 1,
    mitm: r.mitm === 1,
    sni: r.sni ?? undefined,
    host: r.host ?? undefined,
    port: r.port ?? undefined,
    timing: {
      start: r.created_at,
      requestSent: r.t_request_sent ?? undefined,
      dns: r.t_dns ?? undefined,
      connect: r.t_connect ?? undefined,
      tls: r.t_tls ?? undefined,
      firstByte: r.t_first_byte ?? undefined,
      end: r.t_end ?? undefined
    },
    size: {
      reqHeader: r.req_header_size,
      reqBody: r.req_body_size,
      respHeader: r.resp_header_size,
      respBody: r.resp_body_size,
      total: r.req_header_size + r.req_body_size + r.resp_header_size + r.resp_body_size
    },
    error: r.error ? (safeParse(r.error, undefined) as Flow['error']) : undefined,
    flags: safeParse(r.flags, []) as string[],
    label: r.label ?? undefined,
    note: r.note ?? undefined,
    traceId: r.trace_id ?? undefined,
    createdAt: r.created_at
  }
  if (r.method && r.url) {
    flow.request = {
      method: r.method,
      url: r.url,
      httpVersion: r.http_version ?? '1.1',
      headers: safeParse(r.req_headers, []) as HeaderPair[],
      body: reqMeta
    }
  }
  if (r.status !== null) {
    flow.response = {
      status: r.status,
      statusText: r.status_text ?? '',
      httpVersion: r.resp_http_version ?? '1.1',
      headers: safeParse(r.resp_headers, []) as HeaderPair[],
      body: respMeta
    }
    const trailers = safeParse(r.resp_trailers, null) as HeaderPair[] | null
    if (trailers && trailers.length > 0) flow.response.trailers = trailers
  }
  return flow
}

function safeParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function buildWhere(nodes: FilterNode[], beforeSeq?: number): { sql: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  for (const node of nodes) {
    if (node.type === 'text') {
      const like = `%${node.value}%`
      conditions.push(
        `(host LIKE ? OR path LIKE ? OR url LIKE ? OR EXISTS (SELECT 1 FROM bodies b WHERE b.flow_id = flows.id AND b.preview LIKE ?))`
      )
      params.push(like, like, like, like)
      continue
    }
    const value = node.value
    switch (node.key) {
      case 'host':
        conditions.push('host LIKE ?')
        params.push(`%${value}%`)
        break
      case 'path':
        conditions.push('path LIKE ?')
        params.push(`%${value}%`)
        break
      case 'url':
        conditions.push('url LIKE ?')
        params.push(`%${value}%`)
        break
      case 'method': {
        const alts = value.split('|').map((a) => a.trim()).filter(Boolean)
        if (alts.length) {
          conditions.push(`method IN (${alts.map(() => '?').join(',')})`)
          params.push(...alts.map((a) => a.toUpperCase()))
        }
        break
      }
      case 'status': {
        const alts = value.split('|').map((a) => a.trim()).filter(Boolean)
        const ors: string[] = []
        for (const alt of alts) {
          const m = /^(\d)xx$/.exec(alt)
          if (m) {
            ors.push('(status >= ? AND status <= ?)')
            params.push(Number(m[1]) * 100, Number(m[1]) * 100 + 99)
          } else if (/^\d+$/.test(alt)) {
            ors.push('status = ?')
            params.push(Number(alt))
          }
        }
        if (ors.length) conditions.push(`(${ors.join(' OR ')})`)
        break
      }
      case 'type':
        conditions.push('kind = ?')
        params.push(value)
        break
      case 'app':
        conditions.push('client_app LIKE ?')
        params.push(`%${value}%`)
        break
      case 'ip':
        conditions.push('client_ip LIKE ?')
        params.push(`%${value}%`)
        break
      case 'label':
        conditions.push('label LIKE ?')
        params.push(`%${value}%`)
        break
      case 'note':
        conditions.push('note LIKE ?')
        params.push(`%${value}%`)
        break
      case 'trace':
        conditions.push('trace_id LIKE ?')
        params.push(`%${value}%`)
        break
      case 'sni':
        conditions.push('sni LIKE ?')
        params.push(`%${value}%`)
        break
      case 'flag':
        conditions.push('flags LIKE ?')
        params.push(`%"${value}"%`)
        break
      case 'body':
        conditions.push(
          'EXISTS (SELECT 1 FROM bodies b WHERE b.flow_id = flows.id AND b.preview LIKE ?)'
        )
        params.push(`%${value}%`)
        break
      case 'has': {
        for (const alt of value.split('|').map((a) => a.trim()).filter(Boolean)) {
          if (alt === 'response') conditions.push('status IS NOT NULL')
          else if (alt === 'reqbody') conditions.push('req_body_size > 0')
          else if (alt === 'respbody') conditions.push('resp_body_size > 0')
          else if (alt === 'error') conditions.push('error IS NOT NULL')
        }
        break
      }
      default:
        break
    }
  }
  if (beforeSeq !== undefined) {
    conditions.push('seq < ?')
    params.push(beforeSeq)
  }
  const sql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return { sql, params }
}
