import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { PluginEdit, PluginRequestCtx, PluginResponseCtx } from '@proxy/shared'

const CALL_TIMEOUT_MS = 5000
const MAX_BODY_BYTES = 2 * 1024 * 1024
const STRIKE_LIMIT = 3

interface PendingCall {
  resolve: (r: PluginEdit | void) => void
  timer: ReturnType<typeof setTimeout>
}

export class PythonPluginBridge {
  private proc: ChildProcess | null = null
  private pending = new Map<string, PendingCall>()
  private buffer = ''
  private restarting = false
  private restartDelay = 500
  strikes = 0
  lastError?: string
  pythonMissing = false

  constructor(
    public readonly name: string,
    private readonly pluginDir: string,
    private readonly runnerPath: string,
    private readonly onLog: (message: string) => void,
    private readonly onDisabled: () => void
  ) {
    this.start()
  }

  private start(): void {
    this.pythonMissing = false
    try {
      this.proc = spawn('python3', ['-u', this.runnerPath, this.pluginDir], {
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      this.pythonMissing = true
      this.lastError = err instanceof Error ? err.message : String(err)
      this.onLog(`spawn failed: ${this.lastError}`)
      return
    }
    this.proc.stdout!.setEncoding('utf8')
    this.proc.stdout!.on('data', (chunk: string) => this.onStdout(chunk))
    this.proc.stderr!.setEncoding('utf8')
    this.proc.stderr!.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) this.onLog(`stderr: ${line.trim()}`)
      }
    })
    this.proc.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.pythonMissing = true
      this.lastError = err.message
      this.onLog(`process error: ${err.message}`)
      this.failAllPending()
    })
    this.proc.on('exit', (code) => {
      this.proc = null
      this.failAllPending()
      if (!this.restarting && code !== null) {
        this.onLog(`process exited (${code}), restarting in ${this.restartDelay}ms`)
        this.scheduleRestart()
      }
    })
    this.onLog('started')
  }

  private scheduleRestart(): void {
    this.restarting = true
    setTimeout(
      () => {
        this.restarting = false
        this.restartDelay = Math.min(this.restartDelay * 2, 30000)
        this.start()
      },
      this.restartDelay
    ).unref?.()
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line) as { id?: string; result?: PluginEdit; error?: string }
        if (!msg.id) continue
        const call = this.pending.get(msg.id)
        if (!call) continue
        clearTimeout(call.timer)
        this.pending.delete(msg.id)
        if (msg.error) {
          this.strike(msg.error)
          call.resolve(undefined)
        } else {
          this.strikes = 0
          call.resolve(msg.result ?? undefined)
        }
      } catch {
        this.onLog(`stdout: ${line}`)
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

  private failAllPending(): void {
    for (const [, call] of this.pending) {
      clearTimeout(call.timer)
      call.resolve(undefined)
    }
    this.pending.clear()
  }

  private call(method: 'onRequest' | 'onResponse', params: Record<string, unknown>): Promise<PluginEdit | void> {
    if (this.pythonMissing || !this.proc || this.proc.killed) {
      return Promise.resolve(undefined)
    }
    for (const v of [params.bodyBase64, (params as { respBodyBase64?: string }).respBodyBase64]) {
      if (typeof v === 'string' && v.length > MAX_BODY_BYTES * 1.4) return Promise.resolve(undefined)
    }
    return new Promise((resolve) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.strike('timeout')
        resolve(undefined)
      }, CALL_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(id, { resolve, timer })
      this.proc!.stdin!.write(JSON.stringify({ id, method, params }) + '\n', (err) => {
        if (err) {
          this.pending.delete(id)
          clearTimeout(timer)
          resolve(undefined)
        }
      })
    })
  }

  onRequest(ctx: PluginRequestCtx): Promise<PluginEdit | void> {
    return this.call('onRequest', ctx as unknown as Record<string, unknown>)
  }

  onResponse(ctx: PluginResponseCtx): Promise<PluginEdit | void> {
    return this.call('onResponse', ctx as unknown as Record<string, unknown>)
  }

  close(): void {
    this.restarting = true
    this.proc?.kill()
    this.proc = null
    this.failAllPending()
  }
}

export function findRunnerPath(coreRoot: string): string {
  const candidates = [join(coreRoot, 'runner.py')]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]
}
