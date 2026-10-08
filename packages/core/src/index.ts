import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { AppSettings } from '@proxy/shared'
import type {
  BreakpointEdit,
  BreakpointHit,
  BreakpointRule,
  CodegenLang,
  CollectionItem,
  ComposerCookie,
  ComposerEnv,
  ComposerHistoryEntry,
  ComposerSpec,
  Flow,
  PluginLogLine,
  PluginStatus,
  Rule,
  WbNode,
  WbScope,
  WsMessage
} from '@proxy/shared'
import { defaultSettings, mergeSettings, APP_VERSION } from '@proxy/shared'
import { loadOrCreateCa, type CaHandle } from './certs/ca'
import { LeafCertFactory } from './certs/leaf'
import { Db } from './db/database'
import { FlowsRepo } from './db/flows-repo'
import { RetentionManager } from './db/retention'
import { decodeBytes, decompress } from './capture/body'
import { ProxyServer } from './server/proxy-server'
import { PluginManager, ensurePluginsDir } from './plugins/manager'
import { McpServer } from './mcp/server'
import { ruleMatches } from './rules/engine'
import { buildHarLog, flowToHarEntry, harEntryToFlow, type HarEntry, type HarLog } from './export/har'
import { generateCode } from './export/codegen'

export interface CoreOptions {
  dataDir: string
  version?: string
}

export class ProxyCore {
  private db: Db
  private repo: FlowsRepo
  private ca: CaHandle
  private certFactory: LeafCertFactory
  private server: ProxyServer
  private settings: AppSettings
  private flowListeners = new Set<(flows: Flow[]) => void>()
  private logListeners = new Set<(level: string, message: string) => void>()
  private breakpointListeners = new Set<(hits: BreakpointHit[]) => void>()
  private pluginLogListeners = new Set<(line: PluginLogLine) => void>()
  private plugins: PluginManager
  private retention: RetentionManager
  private mcp: McpServer
  private pendingEvents = new Map<string, Flow>()
  private eventTimer: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(private options: CoreOptions) {
    this.settings = defaultSettings()
    this.db = new Db(join(options.dataDir, 'data', 'proxy.db'))
    this.repo = new FlowsRepo(this.db, options.dataDir)
    const saved = this.repo.getSetting<AppSettings>('settings')
    if (saved) this.settings = mergeSettings(defaultSettings(), saved)
    this.ca = loadOrCreateCa(join(options.dataDir, 'certs'))
    this.certFactory = new LeafCertFactory(this.ca, join(options.dataDir, 'certs', 'cache'))
    this.server = new ProxyServer(
      this.ca,
      this.certFactory,
      this.repo,
      {
        onFlowUpdate: (flow) => this.onFlowUpdate(flow),
        onLog: (level, message) => this.emitLog(level, message)
      },
      this.settings,
      options.dataDir
    )
    const savedRules = this.repo.getSetting<BreakpointRule[]>('breakpoint.rules')
    if (Array.isArray(savedRules)) this.server.breakpoints.setRules(savedRules)
    const savedFlowRules = this.repo.getSetting<Rule[]>('rules')
    if (Array.isArray(savedFlowRules)) this.server.setRules(savedFlowRules)
    this.server.breakpoints.onHit((hits) => {
      for (const l of this.breakpointListeners) l(hits)
    })
    const pluginsDir = join(options.dataDir, 'plugins')
    ensurePluginsDir(pluginsDir)
    const enabledNames = this.repo.getSetting<string[]>('plugins.enabled') ?? []
    this.plugins = new PluginManager(pluginsDir, Array.isArray(enabledNames) ? enabledNames : [], PluginManager.resolveRunnerPath())
    this.plugins.onLog((line) => {
      for (const l of this.pluginLogListeners) l(line)
    })
    this.server.setPluginManager(this.plugins)
    this.retention = new RetentionManager(
      this.repo,
      this.db,
      join(options.dataDir, 'data', 'proxy.db'),
      join(options.dataDir, 'data', 'bodies'),
      () => this.settings,
      (stats) => {
        const total = stats.deletedByAge + stats.deletedByCount + stats.deletedByDisk
        const mb = (stats.freedBytes / 1024 / 1024).toFixed(1)
        this.emitLog(
          'info',
          `retention: deleted ${total} flows (age ${stats.deletedByAge}, count ${stats.deletedByCount}, disk ${stats.deletedByDisk}), freed ${mb} MB${stats.vacuumed ? ', vacuumed' : ''}`
        )
      }
    )
    this.mcp = new McpServer(this.repo, (level, message) => this.emitLog(level, message), options.version ?? '0.0.0')
  }

  async start(): Promise<void> {
    if (this.running) return
    const { port, bindAddress, socksPort } = this.settings.proxy
    await this.server.listen(port, bindAddress, socksPort)
    this.running = true
    this.retention.start()
    if (this.settings.mcp.enabled) await this.syncMcp()
    this.emitLog('info', `proxy listening on ${bindAddress}:${port}`)
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.retention.stop()
    await this.mcp.close()
    await this.server.close()
    this.running = false
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  onFlow(listener: (flows: Flow[]) => void): () => void {
    this.flowListeners.add(listener)
    return () => this.flowListeners.delete(listener)
  }

  onLog(listener: (level: string, message: string) => void): () => void {
    this.logListeners.add(listener)
    return () => this.logListeners.delete(listener)
  }

  onBreakpoint(listener: (hits: BreakpointHit[]) => void): () => void {
    this.breakpointListeners.add(listener)
    return () => this.breakpointListeners.delete(listener)
  }

  listBreakpoints() {
    return {
      hits: this.server.breakpoints.listHits(),
      rules: this.server.breakpoints.getRules()
    }
  }

  setBreakpointRules(rules: BreakpointRule[]) {
    this.server.breakpoints.setRules(rules)
    this.repo.setSetting('breakpoint.rules', rules)
    return { rules: this.server.breakpoints.getRules() }
  }

  resolveBreakpoint(flowId: string, phase: 'request' | 'response', edit: BreakpointEdit): { ok: true } {
    void phase
    const ok = this.server.breakpoints.resolve(flowId, edit)
    if (!ok) this.emitLog('warn', `breakpoint resolve: no pending gate for ${flowId}`)
    return { ok: true }
  }

  async sendComposerRequest(spec: ComposerSpec) {
    const flowId = await this.server.sendRequest(spec)
    this.pushComposerHistory(spec)
    return { flowId }
  }

  listComposerHistory(): { history: ComposerHistoryEntry[] } {
    return { history: this.loadComposerHistory() }
  }

  clearComposerHistory(): { ok: true } {
    this.repo.setSetting('composer.history', [])
    return { ok: true }
  }

  private loadComposerHistory(): ComposerHistoryEntry[] {
    const saved = this.repo.getSetting<ComposerHistoryEntry[]>('composer.history')
    return Array.isArray(saved) ? saved : []
  }

  private pushComposerHistory(spec: ComposerSpec): void {
    const history = this.loadComposerHistory()
    const last = history[0]
    if (!(last && last.spec.method === spec.method && last.spec.url === spec.url && last.spec.bodyBase64 === spec.bodyBase64)) {
      history.unshift({ spec, sentAt: Date.now() })
      this.repo.setSetting('composer.history', history.slice(0, 50))
    }
  }

  listComposerEnvs(): { envs: ComposerEnv[]; activeName: string | null } {
    const envs = this.loadComposerEnvs()
    const activeName = this.repo.getSetting<string | null>('composer.activeEnv') ?? null
    return { envs, activeName: activeName && envs.some((e) => e.name === activeName) ? activeName : null }
  }

  setComposerEnvs(envs: ComposerEnv[], activeName: string | null): { envs: ComposerEnv[]; activeName: string | null } {
    const valid = Array.isArray(envs)
      ? envs.filter((e) => e && typeof e.name === 'string' && e.name && e.vars && typeof e.vars === 'object')
      : []
    this.repo.setSetting('composer.envs', valid)
    const active = activeName && valid.some((e) => e.name === activeName) ? activeName : null
    this.repo.setSetting('composer.activeEnv', active)
    return { envs: valid, activeName: active }
  }

  private loadComposerEnvs(): ComposerEnv[] {
    const saved = this.repo.getSetting<ComposerEnv[]>('composer.envs')
    return Array.isArray(saved) ? saved : []
  }

  /** 从 Composer spec 生成多语言请求代码（合成最小 Flow 复用 flows.codegen 的生成器） */
  composerCodegen(spec: ComposerSpec, lang: CodegenLang): { code: string } {
    const buf = Buffer.from(spec.bodyBase64 ?? '', 'base64')
    const contentType = spec.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? ''
    const texty = contentType.startsWith('text/') || /json|xml|urlencoded|javascript/.test(contentType)
    const requestBody =
      buf.length > 0 && texty ? buf.toString('utf8') : buf.length > 0 && !contentType ? buf.toString('utf8') : null
    const flow: Flow = {
      id: 'composer',
      seq: 0,
      kind: 'http',
      state: 'done',
      clientIp: '127.0.0.1',
      clientPort: 0,
      tls: spec.url.startsWith('https://'),
      mitm: false,
      request: {
        method: spec.method,
        url: spec.url,
        httpVersion: 'HTTP/1.1',
        headers: spec.headers,
        body: { size: buf.length, contentType, stored: buf.length ? 'inline' : 'none' }
      },
      timing: { start: 0 },
      size: { reqHeader: 0, reqBody: buf.length, respHeader: 0, respBody: 0, total: buf.length },
      flags: [],
      createdAt: Date.now()
    }
    return { code: generateCode(lang, { flow, requestBody }) }
  }

  listComposerCookies(): { cookies: ComposerCookie[] } {
    return { cookies: this.loadComposerCookies() }
  }

  setComposerCookies(cookies: ComposerCookie[]): { cookies: ComposerCookie[] } {
    const valid = Array.isArray(cookies)
      ? cookies.filter((c) => c && typeof c.domain === 'string' && c.domain && typeof c.name === 'string' && c.name)
      : []
    this.repo.setSetting('composer.cookies', valid)
    return { cookies: valid }
  }

  private loadComposerCookies(): ComposerCookie[] {
    const saved = this.repo.getSetting<ComposerCookie[]>('composer.cookies')
    return Array.isArray(saved) ? saved : []
  }

  setFlowMeta(id: string, label?: string | null, note?: string | null): { ok: true } {
    this.repo.flush()
    const flow = this.repo.get(id)
    if (!flow) throw new Error(`flow not found: ${id}`)
    const nextLabel = label === undefined ? flow.label ?? null : label || null
    const nextNote = note === undefined ? flow.note ?? null : note || null
    this.repo.updateFlowMeta(id, nextLabel, nextNote)
    return { ok: true }
  }

  /** 重放：从已存 flow 重建 spec，重复发送 N 次（可设间隔），生成新 flow */
  async repeatFlow(id: string, count: number, intervalMs: number): Promise<{ flowIds: string[] }> {
    this.repo.flush()
    const flow = this.repo.get(id)
    if (!flow?.request) throw new Error(`flow not found or no request: ${id}`)
    const body = this.repo.getRawBody(id, 'req')
    const headers = flow.request.headers.filter((h) => {
      const n = h.name.toLowerCase()
      return n !== 'host' && n !== 'content-length' && n !== 'connection'
    })
    const spec: ComposerSpec = {
      method: flow.request.method,
      url: flow.request.url,
      headers,
      bodyBase64: body ? body.raw.toString('base64') : ''
    }
    const flowIds: string[] = []
    const n = Math.min(Math.max(Math.floor(count), 1), 100)
    for (let i = 0; i < n; i++) {
      if (i > 0 && intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs))
      flowIds.push(await this.server.sendRequest(spec, { clientApp: '重放', flags: ['replay'] }))
    }
    return { flowIds }
  }

  listRules() {
    return { rules: this.server.getRules(), matchCounts: this.server.getRuleMatchCounts() }
  }

  setRules(rules: Rule[]) {
    this.server.setRules(rules)
    this.repo.setSetting('rules', rules)
    return { rules }
  }

  /** 编辑中的规则（未保存）在最近流量里的命中预览：返回命中的 seq 列表 */
  ruleMatchPreview(rule: Rule, limit = 200): { count: number; sampleSeqs: number[] } {
    const summaries = this.repo.list({ limit: 1000 })
    const matched: number[] = []
    for (const s of summaries) {
      if (!s.host) continue
      const input = {
        host: s.host,
        path: s.path ?? '',
        method: s.method ?? '',
        url: s.url ?? (s.path ? `${s.tls ? 'https' : 'http'}://${s.host}${s.path}` : '')
      }
      if (ruleMatches(rule, input)) {
        matched.push(s.seq)
        if (matched.length >= limit) break
      }
    }
    return { count: matched.length, sampleSeqs: matched.slice(0, 20) }
  }

  listPlugins(): { plugins: PluginStatus[] } {
    return { plugins: this.plugins.list() }
  }

  setPluginEnabled(name: string, enabled: boolean) {
    this.plugins.setEnabled(name, enabled)
    this.repo.setSetting('plugins.enabled', this.plugins.getEnabledNames())
    return { plugins: this.plugins.list() }
  }

  reloadPlugins() {
    this.plugins.reload()
    this.repo.setSetting('plugins.enabled', this.plugins.getEnabledNames())
    return { plugins: this.plugins.list() }
  }

  createPlugin(name: string, type: 'js' | 'python') {
    this.plugins.createPlugin(name, type)
    this.repo.setSetting('plugins.enabled', this.plugins.getEnabledNames())
    return { plugins: this.plugins.list() }
  }

  getPluginsDir(): string {
    return join(this.options.dataDir, 'plugins')
  }

  getPluginLogs(): { logs: PluginLogLine[] } {
    return { logs: this.plugins.getLogs() }
  }

  /** 历史流量手动解码：对已落盘 body 重建插件上下文重跑 onResponse，不落库不覆盖原始数据 */
  async decodeFlowWithPlugins(id: string) {
    const flow = this.repo.get(id)
    if (!flow?.request || !flow.response) throw new Error('该流量缺少请求或响应，无法解码')
    const reqBody = this.repo.getRawBody(id, 'req')
    const respBody = this.repo.getRawBody(id, 'resp')
    const result = await this.plugins.onResponse({
      flowId: id,
      method: flow.request.method,
      url: flow.request.url,
      headers: flow.request.headers,
      bodyBase64: reqBody ? reqBody.raw.toString('base64') : '',
      status: flow.response.status,
      statusText: flow.response.statusText,
      respHeaders: flow.response.headers,
      respBodyBase64: respBody ? respBody.raw.toString('base64') : ''
    })
    const outB64 = result.response?.bodyBase64
    if (outB64 === undefined) return { edited: false, plugin: null, body: null }
    const buf = Buffer.from(outB64, 'base64')
    const finalHeaders = result.response?.headers ?? flow.response.headers
    const ct =
      finalHeaders.find((h) => h.name.toLowerCase() === 'content-type')?.value ||
      flow.response.body.contentType ||
      'application/octet-stream'
    const isText = ct.startsWith('text/') || /json|xml|urlencoded|javascript/.test(ct)
    return {
      edited: true,
      plugin: result.plugin ?? null,
      body: {
        size: buf.length,
        contentType: ct,
        isText,
        truncated: false,
        ...(isText ? { text: decodeBytes(buf, 'utf-8') } : { base64: buf.toString('base64') })
      }
    }
  }

  onPluginLog(listener: (line: PluginLogLine) => void): () => void {
    this.pluginLogListeners.add(listener)
    return () => this.pluginLogListeners.delete(listener)
  }

  private onFlowUpdate(flow: Flow): void {
    this.pendingEvents.set(flow.id, flow)
    if (this.eventTimer) return
    this.eventTimer = setTimeout(() => {
      this.eventTimer = null
      const batch = [...this.pendingEvents.values()]
      this.pendingEvents.clear()
      for (const l of this.flowListeners) l(batch)
    }, 100)
    this.eventTimer.unref?.()
  }

  private emitLog(level: string, message: string): void {
    for (const l of this.logListeners) l(level, message)
  }

  // ---- api surface ----

  listFlows(opts: { filter?: string; beforeSeq?: number; limit?: number }) {
    return { flows: this.repo.list(opts) }
  }

  getFlow(id: string) {
    return { flow: this.repo.get(id) }
  }

  getBody(id: string, part: 'req' | 'resp') {
    const result = this.repo.getRawBody(id, part)
    if (!result) return { body: null }
    const { raw, meta } = result
    const isText = meta.isText ?? false
    const ct = meta.contentType || 'application/octet-stream'
    if (isText || ct.startsWith('text/') || /json|xml|urlencoded|javascript/.test(ct)) {
      let text: string
      try {
        text = decodeBytes(decompress(meta.encoding, raw), 'utf-8')
      } catch {
        text = raw.toString('utf8')
      }
      return {
        body: { size: meta.size, contentType: ct, isText: true, truncated: meta.stored === 'truncated', text }
      }
    }
    return {
      body: {
        size: meta.size,
        contentType: ct,
        isText: false,
        truncated: meta.stored === 'truncated',
        base64: raw.toString('base64')
      }
    }
  }

  getWsMessages(id: string): { messages: WsMessage[] } {
    return { messages: this.repo.listWsMessages(id) }
  }

  listCollections() {
    return { items: this.repo.listCollections() }
  }

  addFlowToCollection(flowId: string, name?: string, group = '', folderId: string | null = null): {
    items: CollectionItem[]
  } {
    const flow = this.repo.get(flowId)
    if (!flow?.request) throw new Error('flow has no request to snapshot')
    const reqBody = this.decompressedBody(flowId, 'req')
    const item: CollectionItem = {
      id: randomUUID(),
      name: name?.trim() || `${flow.request.method} ${flow.host ?? ''}${new URL(flow.request.url).pathname}`,
      group,
      folderId,
      createdAt: Date.now(),
      request: {
        method: flow.request.method,
        url: flow.request.url,
        headers: flow.request.headers.filter((h) => {
          const n = h.name.toLowerCase()
          return n !== 'host' && n !== 'content-length' && n !== 'connection' && !n.startsWith('proxy-')
        }),
        bodyBase64: (reqBody ?? Buffer.alloc(0)).toString('base64')
      }
    }
    if (flow.response) {
      const respBody = this.decompressedBody(flowId, 'resp')
      item.response = {
        status: flow.response.status,
        statusText: flow.response.statusText,
        headers: flow.response.headers,
        bodyBase64: (respBody ?? Buffer.alloc(0)).toString('base64')
      }
    }
    this.repo.addCollection(item)
    return { items: this.repo.listCollections() }
  }

  removeCollection(id: string): { items: CollectionItem[] } {
    this.repo.removeCollection(id)
    return { items: this.repo.listCollections() }
  }

  setCollectionFolder(id: string, folderId: string | null): { items: CollectionItem[] } {
    if (folderId) {
      const node = this.repo.listWbNodes().find((n) => n.id === folderId)
      if (!node || node.scope !== 'favorite' || node.kind !== 'folder') {
        throw new Error('target folder not found')
      }
    }
    this.repo.setCollectionFolder(id, folderId)
    return { items: this.repo.listCollections() }
  }

  // ------------------------------------------------------------------
  // 工作台树（收藏文件夹 / 书签）
  // ------------------------------------------------------------------

  listWorkbench(): { nodes: WbNode[] } {
    return { nodes: this.repo.listWbNodes() }
  }

  private requireFolder(nodes: WbNode[], id: string): WbNode {
    const node = nodes.find((n) => n.id === id)
    if (!node || node.kind !== 'folder') throw new Error('folder not found')
    return node
  }

  createWbFolder(scope: WbScope, name: string, parentId: string | null = null): { nodes: WbNode[] } {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('folder name is empty')
    if (parentId) {
      const parent = this.requireFolder(this.repo.listWbNodes(), parentId)
      if (parent.scope !== scope) throw new Error('folder scope mismatch')
    }
    this.repo.addWbNode({
      id: randomUUID(),
      scope,
      kind: 'folder',
      parentId,
      name: trimmed,
      createdAt: Date.now()
    })
    return { nodes: this.repo.listWbNodes() }
  }

  createWbBookmark(name: string, filter: string, parentId: string | null = null): { nodes: WbNode[] } {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('bookmark name is empty')
    if (!filter.trim()) throw new Error('bookmark filter is empty')
    if (parentId) {
      const parent = this.requireFolder(this.repo.listWbNodes(), parentId)
      if (parent.scope !== 'bookmark') throw new Error('folder scope mismatch')
    }
    this.repo.addWbNode({
      id: randomUUID(),
      scope: 'bookmark',
      kind: 'bookmark',
      parentId,
      name: trimmed,
      filter: filter.trim(),
      createdAt: Date.now()
    })
    return { nodes: this.repo.listWbNodes() }
  }

  renameWbNode(id: string, name: string): { nodes: WbNode[] } {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('name is empty')
    this.repo.renameWbNode(id, trimmed)
    return { nodes: this.repo.listWbNodes() }
  }

  /** 目标父节点不得是自身或自身后代（防环） */
  private wouldCycle(nodes: WbNode[], id: string, targetParentId: string | null): boolean {
    let cur: string | null = targetParentId
    while (cur) {
      if (cur === id) return true
      cur = nodes.find((n) => n.id === cur)?.parentId ?? null
    }
    return false
  }

  moveWbNode(id: string, parentId: string | null): { nodes: WbNode[] } {
    const nodes = this.repo.listWbNodes()
    const node = nodes.find((n) => n.id === id)
    if (!node) throw new Error('node not found')
    if (parentId) {
      const parent = this.requireFolder(nodes, parentId)
      if (parent.scope !== node.scope) throw new Error('folder scope mismatch')
    }
    if (this.wouldCycle(nodes, id, parentId)) throw new Error('cannot move a folder into itself')
    this.repo.moveWbNode(id, parentId)
    return { nodes: this.repo.listWbNodes() }
  }

  /** 删除节点及后代文件夹；被删收藏文件夹内的条目移回根级（快照不丢），书签随文件夹一并删除 */
  removeWbNode(id: string): { nodes: WbNode[] } {
    const dead = this.repo.removeWbNodeCascade(id)
    for (const item of this.repo.listCollections()) {
      if (item.folderId && dead.has(item.folderId)) {
        this.repo.setCollectionFolder(item.id, null)
      }
    }
    return { nodes: this.repo.listWbNodes() }
  }

  // ------------------------------------------------------------------
  // Postman Collection 导入（v2.0/v2.1 → 收藏文件夹树）
  // ------------------------------------------------------------------

  /** 递归导入 Postman collection item：folder → favorite 文件夹，request → CollectionItem */
  importPostmanCollection(data: unknown): { imported: number; folders: number } {
    if (!data || typeof data !== 'object') throw new Error('invalid Postman collection')
    const root = data as {
      info?: { name?: string; schema?: string }
      item?: unknown[]
    }
    if (!Array.isArray(root.item)) throw new Error('not a Postman collection (missing item[])')
    const schema = root.info?.schema ?? ''
    if (!schema.includes('v2.0') && !schema.includes('v2.1')) {
      throw new Error(`unsupported Postman schema: ${schema || '(missing)'}`)
    }
    let imported = 0
    let folders = 0
    // 集合名作为根文件夹，避免多次导入混在根级
    const rootName = root.info?.name?.trim() || 'Postman 导入'
    const rootFolderId = randomUUID()
    this.repo.addWbNode({
      id: rootFolderId,
      scope: 'favorite',
      kind: 'folder',
      parentId: null,
      name: rootName,
      createdAt: Date.now()
    })
    folders++
    const walk = (items: unknown[], parentId: string): void => {
      for (const entry of items) {
        if (!entry || typeof entry !== 'object') continue
        const e = entry as {
          name?: string
          item?: unknown[]
          request?: PostmanRequest
        }
        if (Array.isArray(e.item)) {
          const folderId = randomUUID()
          this.repo.addWbNode({
            id: folderId,
            scope: 'favorite',
            kind: 'folder',
            parentId,
            name: e.name?.trim() || '未命名文件夹',
            createdAt: Date.now()
          })
          folders++
          walk(e.item, folderId)
          continue
        }
        const item = postmanToCollectionItem(e.request, e.name, parentId)
        if (item) {
          this.repo.addCollection(item)
          imported++
        }
      }
    }
    walk(root.item, rootFolderId)
    if (imported === 0 && folders === 1) {
      // 空集合：清掉刚建的根文件夹
      this.repo.removeWbNodeCascade(rootFolderId)
      throw new Error('collection has no requests')
    }
    return { imported, folders }
  }

  // ------------------------------------------------------------------
  // OpenAPI 3.0 导入（ApiFox / ApiPost / Swagger 导出均兼容）
  // ------------------------------------------------------------------

  importOpenApiCollection(data: unknown): { imported: number; folders: number } {
    if (!data || typeof data !== 'object') throw new Error('invalid OpenAPI document')
    const root = data as {
      openapi?: string
      swagger?: string
      info?: { title?: string }
      servers?: { url?: string }[]
      paths?: Record<string, Record<string, unknown>>
    }
    if (!root.openapi && !root.swagger) throw new Error('not an OpenAPI/Swagger document (missing openapi/swagger field)')
    if (!root.paths || typeof root.paths !== 'object') throw new Error('document has no paths')
    const baseUrl = (root.servers?.[0]?.url ?? '').replace(/\/$/, '')

    const rootFolderId = randomUUID()
    this.repo.addWbNode({
      id: rootFolderId,
      scope: 'favorite',
      kind: 'folder',
      parentId: null,
      name: root.info?.title?.trim() || 'OpenAPI 导入',
      createdAt: Date.now()
    })
    let folders = 1
    let imported = 0
    const tagFolders = new Map<string, string>()

    for (const [path, methods] of Object.entries(root.paths)) {
      if (!methods || typeof methods !== 'object') continue
      for (const [method, opRaw] of Object.entries(methods)) {
        if (!['get', 'post', 'put', 'delete', 'patch', 'head', 'options'].includes(method)) continue
        if (!opRaw || typeof opRaw !== 'object') continue
        const op = opRaw as {
          summary?: string
          operationId?: string
          tags?: string[]
          parameters?: { name: string; in: string; required?: boolean }[]
          requestBody?: { content?: Record<string, { example?: unknown; examples?: Record<string, unknown> }> }
        }
        const query = (op.parameters ?? [])
          .filter((p) => p.in === 'query' && p.name)
          .map((p) => `${encodeURIComponent(p.name)}=`)
          .join('&')
        const url = `${baseUrl}${path}${query ? `?${query}` : ''}`
        const headers: Array<{ name: string; value: string }> = []
        for (const p of op.parameters ?? []) {
          if (p.in === 'header' && p.name) headers.push({ name: p.name, value: '' })
        }
        const content = op.requestBody?.content ?? {}
        const jsonContent = content['application/json'] as
          | { example?: unknown; examples?: Record<string, { value?: unknown }> }
          | undefined
        let body = Buffer.alloc(0)
        if (jsonContent) {
          const example = jsonContent.example ?? Object.values(jsonContent.examples ?? {})[0]?.value
          if (example !== undefined) {
            body = Buffer.from(typeof example === 'string' ? example : JSON.stringify(example, null, 2), 'utf8')
            headers.push({ name: 'Content-Type', value: 'application/json' })
          }
        }
        const tagName = op.tags?.[0]?.trim()
        let folderId: string = rootFolderId
        if (tagName) {
          let fid = tagFolders.get(tagName)
          if (!fid) {
            fid = randomUUID()
            this.repo.addWbNode({
              id: fid,
              scope: 'favorite',
              kind: 'folder',
              parentId: rootFolderId,
              name: tagName,
              createdAt: Date.now()
            })
            folders++
            tagFolders.set(tagName, fid)
          }
          folderId = fid
        }        this.repo.addCollection({
          id: randomUUID(),
          name: op.summary?.trim() || op.operationId?.trim() || `${method.toUpperCase()} ${path}`,
          group: '',
          folderId,
          createdAt: Date.now(),
          request: {
            method: method.toUpperCase(),
            url,
            headers,
            bodyBase64: body.toString('base64')
          }
        })
        imported++
      }
    }
    if (imported === 0) {
      this.repo.removeWbNodeCascade(rootFolderId)
      throw new Error('document has no operations')
    }
    return { imported, folders }
  }

  // ------------------------------------------------------------------
  // Hoppscotch collection 导入
  // ------------------------------------------------------------------

  importHoppscotchCollection(data: unknown): { imported: number; folders: number } {
    const collections = Array.isArray(data)
      ? data
      : (data as { collections?: unknown[] })?.collections
    if (!Array.isArray(collections) || !collections.length) {
      throw new Error('not a Hoppscotch export (expect array of collections)')
    }
    let imported = 0
    let folders = 0
    for (const colRaw of collections) {
      if (!colRaw || typeof colRaw !== 'object') continue
      const col = colRaw as {
        name?: string
        requests?: unknown[]
        folders?: unknown[]
      }
      const rootFolderId = randomUUID()
      this.repo.addWbNode({
        id: rootFolderId,
        scope: 'favorite',
        kind: 'folder',
        parentId: null,
        name: col.name?.trim() || 'Hoppscotch 导入',
        createdAt: Date.now()
      })
      folders++

      const walk = (reqs: unknown[], subFolders: unknown[], parentId: string): void => {
        for (const fRaw of subFolders ?? []) {
          if (!fRaw || typeof fRaw !== 'object') continue
          const f = fRaw as { name?: string; requests?: unknown[]; folders?: unknown[] }
          const fid = randomUUID()
          this.repo.addWbNode({
            id: fid,
            scope: 'favorite',
            kind: 'folder',
            parentId,
            name: f.name?.trim() || '未命名文件夹',
            createdAt: Date.now()
          })
          folders++
          walk(f.requests ?? [], f.folders ?? [], fid)
        }
        for (const rRaw of reqs ?? []) {
          if (!rRaw || typeof rRaw !== 'object') continue
          const r = rRaw as {
            name?: string
            method?: string
            url?: string
            pathParams?: { key?: string; value?: string }[]
            params?: { key?: string; value?: string }[]
            headers?: { key?: string; value?: string }[]
            body?: string
          }
          if (!r.url) continue
          const method = (r.method ?? 'GET').toUpperCase()
          const query = (r.params ?? [])
            .filter((p) => p.key)
            .map((p) => `${encodeURIComponent(p.key ?? '')}=${encodeURIComponent(p.value ?? '')}`)
            .join('&')
          const item = this.hoppscotchItem(r, `${r.url}${query ? `?${query}` : ''}`, method, parentId)
          if (item) {
            this.repo.addCollection(item)
            imported++
          }
        }
      }
      walk(col.requests ?? [], col.folders ?? [], rootFolderId)
    }
    if (imported === 0) throw new Error('no requests found in Hoppscotch export')
    return { imported, folders }
  }

  private hoppscotchItem(
    r: { name?: string; headers?: { key?: string; value?: string }[]; body?: string },
    url: string,
    method: string,
    folderId: string
  ): CollectionItem | null {
    const headers = (r.headers ?? [])
      .filter((h) => h.key)
      .map((h) => ({ name: h.key!, value: h.value ?? '' }))
    const body = r.body ? Buffer.from(r.body, 'utf8') : Buffer.alloc(0)
    if (body.length > 0 && !headers.some((h) => h.name.toLowerCase() === 'content-type')) {
      headers.push({ name: 'Content-Type', value: 'application/json' })
    }
    return {
      id: randomUUID(),
      name: r.name?.trim() || `${method} ${url}`,
      group: '',
      folderId,
      createdAt: Date.now(),
      request: { method, url, headers, bodyBase64: body.toString('base64') }
    }
  }

  /** 请求/响应 body 的解压明文；二进制或缺失返回 null */
  private decompressedBody(flowId: string, part: 'req' | 'resp'): Buffer | null {
    const raw = this.repo.getRawBody(flowId, part)
    if (!raw) return null
    try {
      return decompress(raw.meta.encoding, raw.raw)
    } catch {
      return raw.raw
    }
  }

  clearFlows() {
    this.repo.clear()
    return { ok: true as const }
  }

  codegen(id: string, lang: CodegenLang): { code: string } {
    const flow = this.repo.get(id)
    if (!flow?.request) return { code: `# no request to generate ${lang} code from` }
    let requestBody: string | null = null
    const raw = this.repo.getRawBody(id, 'req')
    if (raw) {
      const isText = raw.meta.isText ?? false
      const ct = raw.meta.contentType || ''
      if (isText || ct.startsWith('text/') || /json|xml|urlencoded|javascript/.test(ct)) {
        try {
          requestBody = decodeBytes(decompress(raw.meta.encoding, raw.raw), 'utf-8')
        } catch {
          requestBody = raw.raw.toString('utf8')
        }
      }
    }
    return { code: generateCode(lang, { flow, requestBody }) }
  }

  exportHar(opts: { filter?: string; limit?: number }): { har: HarLog } {
    const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 5000)
    const summaries = this.repo.list({ filter: opts.filter, limit })
    const entries: HarEntry[] = []
    for (const s of [...summaries].reverse()) {
      if (!s.url) continue
      const flow = this.repo.get(s.id)
      if (!flow?.request) continue
      const reqBody = this.repo.getRawBody(s.id, 'req')
      const respBody = this.repo.getRawBody(s.id, 'resp')
      const entry = flowToHarEntry(flow, reqBody?.raw ?? null, respBody?.raw ?? null)
      if (entry) entries.push(entry)
    }
    return {
      har: buildHarLog(entries, { name: 'Prism', version: this.options.version ?? APP_VERSION })
    }
  }

  /** 导入 HAR：entries → flows 落库并广播；缺 request 的 entry 计入 skipped；结构非法抛错 */
  importHar(har: unknown): { imported: number; skipped: number } {
    const log = (har as { log?: { entries?: unknown } } | null | undefined)?.log
    const entries = Array.isArray(log?.entries) ? (log.entries as HarEntry[]) : null
    if (!entries) throw new Error('不是合法的 HAR 文件（缺少 log.entries）')
    let seq = this.repo.maxSeq()
    let imported = 0
    let skipped = 0
    for (const entry of entries) {
      const parts = harEntryToFlow(entry, { id: randomUUID(), seq: seq + 1 })
      if (!parts) {
        skipped++
        continue
      }
      seq++
      imported++
      this.repo.complete({
        flow: parts.flow,
        reqBody: { raw: parts.reqRaw, meta: parts.flow.request!.body },
        respBody: parts.flow.response
          ? { raw: parts.respRaw ?? Buffer.alloc(0), meta: parts.flow.response.body }
          : undefined
      })
      this.onFlowUpdate(parts.flow)
    }
    this.repo.flush()
    if (imported > 0) this.server.bumpSeq(seq)
    this.emitLog('info', `har import: imported ${imported} entries, skipped ${skipped}`)
    return { imported, skipped }
  }

  getSettings(): AppSettings {
    return this.settings
  }

  setSettings(patch: Partial<AppSettings>): AppSettings {
    const oldRetention = this.settings.retention
    const oldMcp = this.settings.mcp
    this.settings = mergeSettings(this.settings, patch)
    this.repo.setSetting('settings', this.settings)
    this.server.updateSettings(this.settings)
    if (
      oldRetention.days !== this.settings.retention.days ||
      oldRetention.maxFlows !== this.settings.retention.maxFlows ||
      oldRetention.maxDiskGB !== this.settings.retention.maxDiskGB
    ) {
      void this.retention.run()
    }
    const mcp = this.settings.mcp
    if (oldMcp.enabled !== mcp.enabled || oldMcp.port !== mcp.port) void this.syncMcp()
    return this.settings
  }

  private async syncMcp(): Promise<void> {
    await this.mcp.close()
    const mcp = this.settings.mcp
    if (mcp.enabled && this.running) {
      try {
        await this.mcp.listen(mcp.port)
      } catch (err) {
        this.emitLog('warn', `mcp server listen failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  getMcpInfo(): { enabled: boolean; port: number; listening: boolean } {
    return {
      enabled: this.settings.mcp.enabled,
      port: this.settings.mcp.port,
      listening: this.mcp.listeningPort > 0
    }
  }

  getCertInfo() {
    return {
      fingerprintSha256: this.ca.fingerprintSha256,
      notBefore: this.ca.notBefore,
      notAfter: this.ca.notAfter,
      subject: this.ca.subject,
      serial: this.ca.serial
    }
  }

  getCaCertPem(): string {
    return this.ca.certPem
  }

  getCaCertDer(): Buffer {
    return this.ca.der
  }

  info() {
    return {
      localIps: getLocalIps(),
      proxyPort: this.settings.proxy.port,
      version: this.options.version ?? APP_VERSION,
      dataDir: this.options.dataDir,
      proxyRunning: this.running
    }
  }

  close(): void {
    this.retention.stop()
    this.server.close().catch(() => {})
    this.plugins.close()
    this.repo.close()
    this.db.close()
  }
}

export function getLocalIps(): string[] {
  const out: string[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address)
    }
  }
  return out
}

// ------------------------------------------------------------------
// Postman Collection v2 解析
// ------------------------------------------------------------------

interface PostmanRequest {
  method?: string
  url?: string | { raw?: string }
  header?: { key: string; value: string; disabled?: boolean }[]
  body?: {
    mode?: string
    raw?: string
    urlencoded?: { key: string; value: string; disabled?: boolean }[]
  }
}

function postmanUrl(u: PostmanRequest['url']): string {
  if (typeof u === 'string') return u
  return u?.raw ?? ''
}

function postmanBody(b: PostmanRequest['body']): Buffer {
  if (!b) return Buffer.alloc(0)
  if (b.mode === 'raw' && typeof b.raw === 'string') return Buffer.from(b.raw, 'utf8')
  if (b.mode === 'urlencoded' && Array.isArray(b.urlencoded)) {
    const pairs = b.urlencoded
      .filter((p) => !p.disabled)
      .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    return Buffer.from(pairs.join('&'), 'utf8')
  }
  return Buffer.alloc(0)
}

function postmanToCollectionItem(
  req: PostmanRequest | undefined,
  name: string | undefined,
  folderId: string
): CollectionItem | null {
  if (!req) return null
  const url = postmanUrl(req.url)
  if (!url) return null
  const method = (req.method ?? 'GET').toUpperCase()
  const headers = (req.header ?? [])
    .filter((h) => !h.disabled && h.key)
    .map((h) => ({ name: h.key, value: h.value }))
  const body = postmanBody(req.body)
  if (req.body?.mode === 'urlencoded' && body.length > 0) {
    headers.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' })
  }
  return {
    id: randomUUID(),
    name: name?.trim() || `${method} ${url}`,
    group: '',
    folderId,
    createdAt: Date.now(),
    request: {
      method,
      url,
      headers,
      bodyBase64: body.toString('base64')
    }
  }
}
