import type { AppSettings } from './settings'
import type { BodyContent, Flow, FlowSummary, WsMessage } from './flow'
import type { BreakpointEdit, BreakpointHit, BreakpointRule, ComposerSpec } from './breakpoint'
import type { Rule } from './rule'
import type { PluginLogLine, PluginStatus } from './plugin-api'
import type { CodegenLang } from './codegen'
import type { CollectionItem } from './collection'
import type { WbNode, WbScope } from './workbench'

export interface AppInfo {
  localIps: string[]
  proxyPort: number
  version: string
  dataDir: string
  proxyRunning: boolean
}

export interface CertInfo {
  fingerprintSha256: string
  notBefore: number
  notAfter: number
  subject: string
  serial: string
}

export interface AdbInfo {
  available: boolean
  error?: string
  devices: { serial: string; model?: string }[]
  reversed: { device: string; remote: string }[]
}

export interface IpcContract {
  'flows.list': {
    req: { filter?: string; beforeSeq?: number; limit?: number }
    res: { flows: FlowSummary[] }
  }
  'flows.get': {
    req: { id: string }
    res: { flow: Flow | null }
  }
  'flows.getBody': {
    req: { id: string; part: 'req' | 'resp' }
    res: { body: BodyContent | null }
  }
  'flows.wsMessages': {
    req: { id: string }
    res: { messages: WsMessage[] }
  }
  'flows.clear': {
    req: void
    res: { ok: true }
  }
  'flows.codegen': {
    req: { id: string; lang: CodegenLang }
    res: { code: string }
  }
  'flows.exportHar': {
    req: { filter?: string; limit?: number }
    res: { saved: boolean; path?: string }
  }
  'flows.importHar': {
    req: void
    res: { canceled: boolean; imported?: number; skipped?: number; error?: string }
  }
  'flows.setMeta': {
    req: { id: string; label?: string | null; note?: string | null }
    res: { ok: true }
  }
  'flows.repeat': {
    req: { id: string; count: number; intervalMs?: number }
    res: { flowIds: string[] }
  }
  'collections.list': {
    req: void
    res: { items: CollectionItem[] }
  }
  'collections.addFromFlow': {
    req: { flowId: string; name?: string; group?: string; folderId?: string | null }
    res: { items: CollectionItem[] }
  }
  'collections.remove': {
    req: { id: string }
    res: { items: CollectionItem[] }
  }
  'collections.setFolder': {
    req: { id: string; folderId: string | null }
    res: { items: CollectionItem[] }
  }
  'collections.importPostman': {
    req: void
    res: { canceled: boolean; imported?: number; folders?: number; error?: string }
  }
  'collections.importOpenApi': {
    req: void
    res: { canceled: boolean; imported?: number; folders?: number; error?: string }
  }
  'collections.importHoppscotch': {
    req: void
    res: { canceled: boolean; imported?: number; folders?: number; error?: string }
  }
  'workbench.nodes': {
    req: void
    res: { nodes: WbNode[] }
  }
  'workbench.createFolder': {
    req: { scope: WbScope; name: string; parentId?: string | null }
    res: { nodes: WbNode[] }
  }
  'workbench.createBookmark': {
    req: { name: string; filter: string; parentId?: string | null }
    res: { nodes: WbNode[] }
  }
  'workbench.renameNode': {
    req: { id: string; name: string }
    res: { nodes: WbNode[] }
  }
  'workbench.removeNode': {
    req: { id: string }
    res: { nodes: WbNode[] }
  }
  'workbench.moveNode': {
    req: { id: string; parentId: string | null }
    res: { nodes: WbNode[] }
  }
  'app.settings.get': {
    req: void
    res: AppSettings
  }
  'app.settings.set': {
    req: Partial<AppSettings>
    res: AppSettings
  }
  'mcp.info': {
    req: void
    res: { enabled: boolean; port: number; listening: boolean }
  }
  'app.clipboard.writeText': {
    req: { text: string }
    res: { ok: true }
  }
  'app.clipboard.readText': {
    req: void
    res: { text: string }
  }
  'app.readFileBase64': {
    req: { path: string }
    res: { ok: boolean; base64?: string; error?: string }
  }
  'app.pickFile': {
    req: void
    res: { canceled: boolean; filePath?: string }
  }
  'app.saveFile': {
    req: { defaultPath: string; base64: string; title?: string }
    res: { saved: boolean; path?: string; error?: string }
  }
  'composer.codegen': {
    req: { spec: ComposerSpec; lang: CodegenLang }
    res: { code: string }
  }
  'composer.envs': {
    req: void
    res: { envs: ComposerEnv[]; activeName: string | null }
  }
  'composer.setEnvs': {
    req: { envs: ComposerEnv[]; activeName: string | null }
    res: { envs: ComposerEnv[]; activeName: string | null }
  }
  'composer.cookies': {
    req: void
    res: { cookies: ComposerCookie[] }
  }
  'composer.setCookies': {
    req: { cookies: ComposerCookie[] }
    res: { cookies: ComposerCookie[] }
  }
  'app.info': {
    req: void
    res: AppInfo
  }
  'cert.info': {
    req: void
    res: CertInfo
  }
  'cert.export': {
    req: void
    res: { canceled: boolean; path?: string }
  }
  'cert.checkTrust': {
    req: void
    res: { supported: boolean; trusted: boolean }
  }
  'cert.installSystem': {
    req: void
    res: { ok: boolean; trusted: boolean; error?: string }
  }
  'proxy.restart': {
    req: void
    res: { ok: true; port: number }
  }
  'adb.status': {
    req: void
    res: AdbInfo
  }
  'adb.reverse': {
    req: { port: number }
    res: { ok: boolean; error?: string }
  }
  'adb.unreverse': {
    req: { port: number }
    res: { ok: boolean; error?: string }
  }
  'breakpoints.list': {
    req: void
    res: { hits: BreakpointHit[]; rules: BreakpointRule[] }
  }
  'breakpoints.setRules': {
    req: { rules: BreakpointRule[] }
    res: { rules: BreakpointRule[] }
  }
  'breakpoints.resolve': {
    req: { flowId: string; phase: BreakpointHit['phase']; edit: BreakpointEdit }
    res: { ok: true }
  }
  'composer.send': {
    req: { spec: ComposerSpec }
    res: { flowId: string }
  }
  'composer.history': {
    req: void
    res: { history: ComposerHistoryEntry[] }
  }
  'composer.clearHistory': {
    req: void
    res: { ok: true }
  }
  'rules.list': {
    req: void
    res: { rules: Rule[]; matchCounts: Record<string, number> }
  }
  'rules.set': {
    req: { rules: Rule[] }
    res: { rules: Rule[] }
  }
  'rules.matchPreview': {
    req: { rule: Rule }
    res: { count: number; sampleSeqs: number[] }
  }
  'plugins.list': {
    req: void
    res: { plugins: PluginStatus[] }
  }
  'plugins.setEnabled': {
    req: { name: string; enabled: boolean }
    res: { plugins: PluginStatus[] }
  }
  'plugins.reload': {
    req: void
    res: { plugins: PluginStatus[] }
  }
  'plugins.create': {
    req: { name: string; type: 'js' | 'python' }
    res: { plugins: PluginStatus[] }
  }
  'plugins.openDir': {
    req: void
    res: { ok: true }
  }
  'plugins.logs': {
    req: void
    res: { logs: PluginLogLine[] }
  }
  'plugins.decodeFlow': {
    req: { id: string }
    res: {
      /** 是否有插件实际改写了响应 */
      edited: boolean
      plugin: string | null
      body: BodyContent | null
    }
  }
}

export interface ComposerHistoryEntry {
  spec: ComposerSpec
  sentAt: number
}

/** Composer 环境变量集合（如 dev/staging/prod），发送前替换 {{key}} */
export interface ComposerEnv {
  name: string
  vars: Record<string, string>
}

/** Composer Cookie：按域存取，发送时域匹配则注入 Cookie 头 */
export interface ComposerCookie {
  domain: string
  name: string
  value: string
  enabled: boolean
}

export type IpcChannel = keyof IpcContract & string

export interface IpcEventMessage {
  channel: string
  payload: unknown
}

export type CoreEventMap = {
  flow: FlowSummary[]
  log: { level: 'info' | 'warn' | 'error'; message: string }
  breakpoint: BreakpointHit[]
  'plugin-log': PluginLogLine
}

export type CoreEventName = keyof CoreEventMap & string
