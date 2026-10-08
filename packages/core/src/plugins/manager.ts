import { readdirSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  HeaderPair,
  PluginEdit,
  PluginLogLine,
  PluginRequestCtx,
  PluginResponseCtx,
  PluginStatus
} from '@proxy/shared'
import { JsPluginHost } from './js-host'
import { PythonPluginBridge } from './python-bridge'
import { pluginTemplateFiles } from './templates'

interface LoadedPlugin {
  name: string
  type: 'js' | 'python'
  host: JsPluginHost | PythonPluginBridge
  enabled: boolean
  forceDisabled: boolean
}

const MAX_LOGS = 500

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>()
  private logs: PluginLogLine[] = []
  private logListeners = new Set<(line: PluginLogLine) => void>()
  private enabledNames: string[]

  constructor(
    private readonly pluginsDir: string,
    enabledNames: string[],
    private readonly runnerPath: string
  ) {
    this.enabledNames = [...enabledNames]
    this.reload()
  }

  static resolveRunnerPath(): string {
    try {
      return fileURLToPath(new URL('./runner.py', import.meta.url))
    } catch {
      return join(__dirname, 'runner.py')
    }
  }

  reload(): void {
    for (const [, p] of this.plugins) p.host.close()
    this.plugins.clear()
    if (!existsSync(this.pluginsDir)) {
      this.enabledNames = []
      return
    }
    for (const name of readdirSync(this.pluginsDir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      const dir = join(this.pluginsDir, name.name)
      const jsEntry = join(dir, 'index.js')
      const pyEntry = join(dir, 'plugin.py')
      try {
        if (existsSync(jsEntry)) {
          // 无 package.json 时 Node 会把 index.js 当 CommonJS，ESM 插件将加载失败
          const pkgPath = join(dir, 'package.json')
          if (!existsSync(pkgPath)) {
            writeFileSync(pkgPath, '{\n  "type": "module"\n}\n')
          }
          const host = new JsPluginHost(
            name.name,
            jsEntry,
            (message) => this.log(name.name, message),
            () => this.forceDisable(name.name)
          )
          this.plugins.set(name.name, {
            name: name.name,
            type: 'js',
            host,
            enabled: this.enabledNames.includes(name.name),
            forceDisabled: false
          })
        } else if (existsSync(pyEntry)) {
          const host = new PythonPluginBridge(
            name.name,
            dir,
            this.runnerPath,
            (message) => this.log(name.name, message),
            () => this.forceDisable(name.name)
          )
          this.plugins.set(name.name, {
            name: name.name,
            type: 'python',
            host,
            enabled: this.enabledNames.includes(name.name),
            forceDisabled: false
          })
        }
      } catch (err) {
        this.log(name.name, `init failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.enabledNames = this.getEnabledNames()
  }

  private forceDisable(name: string): void {
    const p = this.plugins.get(name)
    if (p) {
      p.forceDisabled = true
      p.enabled = false
      this.enabledNames = this.getEnabledNames()
    }
  }

  setEnabled(name: string, enabled: boolean): void {
    const p = this.plugins.get(name)
    if (!p) return
    if (enabled && p.forceDisabled) {
      p.forceDisabled = false
      if (p.host instanceof JsPluginHost) p.host.strikes = 0
      else p.host.strikes = 0
      this.log(name, 're-enabled')
    }
    p.enabled = enabled
    this.enabledNames = this.getEnabledNames()
  }

  getEnabledNames(): string[] {
    return [...this.plugins.values()].filter((p) => p.enabled).map((p) => p.name)
  }

  list(): PluginStatus[] {
    return [...this.plugins.values()].map((p) => ({
      name: p.name,
      type: p.type,
      enabled: p.enabled,
      status: p.forceDisabled
        ? 'disabled-by-strikes'
        : p.host instanceof PythonPluginBridge && p.host.pythonMissing
          ? 'missing-python'
          : p.host.lastError
            ? 'error'
            : 'ok',
      errors: p.host.strikes,
      lastError: p.host.lastError
    }))
  }

  getLogs(): PluginLogLine[] {
    return this.logs
  }

  onLog(listener: (line: PluginLogLine) => void): () => void {
    this.logListeners.add(listener)
    return () => this.logListeners.delete(listener)
  }

  private log(plugin: string, message: string): void {
    const line = { plugin, message, at: Date.now() }
    this.logs.push(line)
    if (this.logs.length > MAX_LOGS) this.logs.shift()
    for (const l of this.logListeners) l(line)
  }

  async onRequest(ctx: PluginRequestCtx): Promise<PluginEdit & { plugin?: string }> {
    for (const [, p] of this.plugins) {
      if (!p.enabled || p.forceDisabled) continue
      const result = await p.host.onRequest({ ...ctx, log: (m) => this.log(p.name, m) })
      if (!result) continue
      if (result.respond || result.request) {
        this.log(p.name, `onRequest edited ${ctx.method} ${ctx.url}`)
        return { ...result, plugin: p.name }
      }
    }
    return {}
  }

  async onResponse(ctx: PluginResponseCtx): Promise<PluginEdit & { plugin?: string }> {
    for (const [, p] of this.plugins) {
      if (!p.enabled || p.forceDisabled) continue
      const result = await p.host.onResponse({ ...ctx, log: (m) => this.log(p.name, m) })
      if (!result) continue
      if (result.response) {
        this.log(p.name, `onResponse edited ${ctx.method} ${ctx.url}`)
        return { ...result, plugin: p.name }
      }
    }
    return {}
  }

  createPlugin(name: string, type: 'js' | 'python'): void {
    const safe = name.trim().replace(/[^a-zA-Z0-9_-]/g, '-')
    if (!safe) throw new Error('插件名不能为空')
    const dir = join(this.pluginsDir, safe)
    if (existsSync(dir)) throw new Error(`插件 ${safe} 已存在`)
    mkdirSync(dir, { recursive: true })
    for (const [file, content] of Object.entries(pluginTemplateFiles(type))) {
      writeFileSync(join(dir, file), content)
    }
    this.reload()
    this.setEnabled(safe, true)
    this.enabledNames = this.getEnabledNames()
    this.log(safe, `created from ${type} template`)
  }

  close(): void {
    for (const [, p] of this.plugins) p.host.close()
    this.plugins.clear()
  }
}

export function ensurePluginsDir(pluginsDir: string): void {
  if (!existsSync(pluginsDir)) mkdirSync(pluginsDir, { recursive: true })
}
