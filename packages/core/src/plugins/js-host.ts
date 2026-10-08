import { Worker } from 'node:worker_threads'
import { watch } from 'node:fs'
import type { PluginEdit, PluginRequestCtx, PluginResponseCtx } from '@proxy/shared'

export interface JsHooks {
  onRequest?: (ctx: PluginRequestCtx) => Promise<PluginEdit | void> | PluginEdit | void
  onResponse?: (ctx: PluginResponseCtx) => Promise<PluginEdit | void> | PluginEdit | void
}

const STRIKE_LIMIT = 3
const CALL_TIMEOUT_MS = 5000
/** 等待 worker 完成插件加载的上限：加载中的插件先短暂等待而不是直接放行（保证插件确定性生效） */
const READY_TIMEOUT_MS = 2000

/**
 * worker 线程内的插件运行时（eval 模式，避免打包器路径问题）：
 * 加载插件 ESM、转发钩子调用、回传 ctx.log。worker 崩溃/卡死只影响该插件。
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { pathToFileURL } = require('node:url')

let mod = null

parentPort.on('message', (msg) => {
  if (msg.type !== 'call') return
  const fn = mod ? mod[msg.hook] : null
  if (typeof fn !== 'function') {
    parentPort.postMessage({ type: 'result', id: msg.id, ok: true, payload: null, skipped: true })
    return
  }
  Promise.resolve()
    .then(() => {
      const ctx = Object.assign({}, msg.ctx, {
        log: (m) => parentPort.postMessage({ type: 'log', message: String(m) })
      })
      return fn(ctx)
    })
    .then((result) => {
      parentPort.postMessage({ type: 'result', id: msg.id, ok: true, payload: result === undefined ? null : result })
    })
    .catch((err) => {
      parentPort.postMessage({ type: 'result', id: msg.id, ok: false, payload: String((err && err.message) || err) })
    })
})

import(pathToFileURL(workerData.entryPath).href)
  .then((m) => {
    mod = m
    parentPort.postMessage({ type: 'loaded', onRequest: typeof m.onRequest, onResponse: typeof m.onResponse })
  })
  .catch((err) => {
    parentPort.postMessage({ type: 'load-error', error: String((err && err.message) || err) })
  })
`

interface WorkerMsg {
  type: 'loaded' | 'load-error' | 'log' | 'result'
  onRequest?: string
  onResponse?: string
  error?: string
  message?: string
  id?: number
  ok?: boolean
  skipped?: boolean
  payload?: unknown
}

interface Pending {
  resolve: (v: PluginEdit | void) => void
  timer: ReturnType<typeof setTimeout>
}

/** JS 插件宿主：每个插件一个 worker 线程，插件崩溃/死循环只重启 worker，不影响代理主进程 */
export class JsPluginHost {
  private worker: Worker | null = null
  private ready = false
  private loadFailed = false
  private pending = new Map<number, Pending>()
  private callSeq = 0
  private watcher: ReturnType<typeof watch> | null = null
  private reloadTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  strikes = 0
  lastError?: string

  constructor(
    public readonly name: string,
    private readonly entryPath: string,
    private readonly onLog: (message: string) => void,
    private readonly onDisabled: () => void
  ) {
    this.spawn()
    this.watchEntry()
  }

  private spawn(): void {
    if (this.closed) return
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { entryPath: this.entryPath } })
    this.worker = worker
    this.ready = false
    this.loadFailed = false
    worker.on('message', (msg: WorkerMsg) => {
      if (this.worker !== worker) return
      this.onMessage(msg)
    })
    worker.on('error', (err: Error) => {
      if (this.worker === worker) this.handleCrash(err.message)
    })
    worker.on('exit', () => {
      if (this.worker === worker && !this.closed) this.handleCrash('worker exited unexpectedly')
    })
  }

  private onMessage(msg: WorkerMsg): void {
    switch (msg.type) {
      case 'loaded':
        this.ready = true
        this.onLog(`loaded (onRequest: ${msg.onRequest}, onResponse: ${msg.onResponse})`)
        break
      case 'load-error':
        this.loadFailed = true
        this.lastError = msg.error
        this.onLog(`load failed: ${msg.error}`)
        break
      case 'log':
        this.onLog(msg.message ?? '')
        break
      case 'result': {
        const p = this.pending.get(msg.id!)
        if (!p) return
        this.pending.delete(msg.id!)
        clearTimeout(p.timer)
        // 插件未定义该钩子：直接放行，不计成功也不计错误（否则会清空 strike 计数）
        if (msg.skipped) {
          p.resolve(undefined)
        } else if (msg.ok) {
          this.strikes = 0
          p.resolve((msg.payload as PluginEdit) ?? undefined)
        } else {
          this.strike(String(msg.payload))
          p.resolve(undefined)
        }
        break
      }
    }
  }

  private strike(err: string): void {
    this.strikes++
    this.lastError = err
    this.onLog(`error (${this.strikes}/${STRIKE_LIMIT}): ${err}`)
    if (this.strikes >= STRIKE_LIMIT) {
      this.onLog('too many errors, disabling plugin')
      this.onDisabled()
    }
  }

  private handleCrash(message: string): void {
    this.worker = null
    this.ready = false
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve(undefined)
      this.pending.delete(id)
    }
    this.strike(message)
    this.spawn()
  }

  private restartWorker(reason: string): void {
    if (this.closed) return
    this.onLog(reason)
    const old = this.worker
    this.worker = null
    this.ready = false
    // 重启（含热重载）时在途调用直接放行，不计 strike
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve(undefined)
      this.pending.delete(id)
    }
    old?.terminate().catch(() => {})
    this.spawn()
  }

  private watchEntry(): void {
    try {
      this.watcher = watch(this.entryPath, () => {
        if (this.reloadTimer) clearTimeout(this.reloadTimer)
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = null
          this.onLog('file changed, reloading…')
          this.restartWorker('reloading worker')
        }, 300)
      })
    } catch {
      /* file may not exist yet */
    }
  }

  /** worker 启动中时短暂等待加载完成，保证插件确定性生效；加载失败则直接放行 */
  private async waitReady(): Promise<boolean> {
    if (this.closed || this.loadFailed) return false
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (!this.ready && !this.closed && !this.loadFailed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    return this.ready && !this.closed
  }

  private async callHook(
    hook: 'onRequest' | 'onResponse',
    ctx: PluginRequestCtx | PluginResponseCtx
  ): Promise<PluginEdit | void> {
    if (this.closed) return undefined
    if (!this.ready && !(await this.waitReady())) return undefined
    const worker = this.worker
    if (!worker || !this.ready) return undefined
    const id = ++this.callSeq
    const cloneable = { ...ctx } as Record<string, unknown>
    delete cloneable.log
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id)
        if (!p) return
        this.pending.delete(id)
        this.strike(`timeout after ${CALL_TIMEOUT_MS}ms`)
        this.restartWorker(`plugin stuck >${CALL_TIMEOUT_MS}ms, restarting worker`)
        resolve(undefined)
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve, timer })
      worker.postMessage({ type: 'call', id, hook, ctx: cloneable })
    })
  }

  onRequest(ctx: PluginRequestCtx): Promise<PluginEdit | void> {
    return this.callHook('onRequest', ctx)
  }

  onResponse(ctx: PluginResponseCtx): Promise<PluginEdit | void> {
    return this.callHook('onResponse', ctx)
  }

  close(): void {
    this.closed = true
    this.watcher?.close()
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    const worker = this.worker
    this.worker = null
    this.ready = false
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve(undefined)
    }
    this.pending.clear()
    worker?.terminate().catch(() => {})
  }
}
