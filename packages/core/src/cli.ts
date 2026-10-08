import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Flow } from '@proxy/shared'
import { ProxyCore } from './index'

interface CliArgs {
  dataDir?: string
  port?: number
  socksPort?: number
  bindAddress?: string
  quiet: boolean
  help: boolean
}

const USAGE = `用法: proxy-cli [选项]

  无 Electron 依赖的 headless 代理核心，适合服务器 / CI / 远程抓包。
  流量摘要输出到 stdout，日志输出到 stderr。

选项:
  --data-dir <dir>    数据目录（证书 / SQLite / 插件），默认 $PRISM_DATA_DIR 或 ~/.prism
  --port <n>          HTTP 代理端口（默认读取已保存设置，初始 9090）
  --socks-port <n>    SOCKS5 入站端口，0 = 禁用（默认 9091）
  --bind <addr>       监听地址（默认 0.0.0.0）
  --quiet             只输出流量摘要，不输出日志
  -h, --help          显示帮助

示例:
  npm run cli -- --port 9090
  npm run cli -- --data-dir ./capture-session
  PRISM_DATA_DIR=/tmp/cap npm run cli
`

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { quiet: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string | undefined => (i + 1 < argv.length ? argv[++i] : undefined)
    switch (a) {
      case '--data-dir':
        args.dataDir = next()
        break
      case '--port':
        args.port = parsePort(next(), '--port')
        break
      case '--socks-port':
        args.socksPort = parsePort(next(), '--socks-port')
        break
      case '--bind':
        args.bindAddress = next()
        break
      case '--quiet':
        args.quiet = true
        break
      case '-h':
      case '--help':
        args.help = true
        break
      default:
        throw new Error(`未知参数: ${a}\n\n${USAGE}`)
    }
  }
  return args
}

function parsePort(raw: string | undefined, name: string): number {
  const n = Number(raw)
  if (raw === undefined || !Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`${name} 需要一个 0-65535 的端口号`)
  }
  return n
}

function hhmmss(at: number): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour12: false })
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

function fmtDuration(flow: Flow): string {
  const { timing } = flow
  const end = timing.end ?? timing.firstByte
  const start = timing.start
  if (end === undefined || start === undefined) return '-'
  return `${Math.max(0, Math.round(end - start))}ms`
}

/** 一行流量摘要：时间 方法 状态 host+path 耗时 大小 标记 */
function flowLine(flow: Flow): string {
  const time = hhmmss(flow.createdAt)
  const parts: string[] = [time]
  if (flow.kind === 'tunnel') {
    parts.push('TUNNEL', `${flow.host ?? '?'}:${flow.port ?? '?'}`)
  } else {
    const url = flow.request?.url ?? ''
    let target = url
    try {
      const u = new URL(url)
      target = u.host + u.pathname + u.search
    } catch {
      /* 保持原样 */
    }
    parts.push(flow.request?.method ?? '?')
    const status = flow.response?.status
    if (flow.error) parts.push(`ERR/${flow.error.code}`)
    else if (status !== undefined) parts.push(String(status))
    else parts.push(flow.state)
    parts.push(target)
  }
  parts.push(fmtDuration(flow), fmtBytes(flow.size.total))
  if (flow.flags.length > 0) parts.push(flow.flags.map((f) => `[${f}]`).join(''))
  return parts.join(' ')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(USAGE)
    return
  }
  const dataDir = args.dataDir ?? process.env.PRISM_DATA_DIR ?? join(homedir(), '.prism')

  const core = new ProxyCore({ dataDir, version: 'cli' })

  if (args.port !== undefined || args.socksPort !== undefined || args.bindAddress !== undefined) {
    const cur = core.getSettings().proxy
    core.setSettings({
      proxy: {
        port: args.port ?? cur.port,
        socksPort: args.socksPort ?? cur.socksPort,
        bindAddress: args.bindAddress ?? cur.bindAddress,
        upstream: cur.upstream
      }
    })
  }

  core.onFlow((flows) => {
    for (const f of flows) process.stdout.write(flowLine(f) + '\n')
  })
  if (!args.quiet) {
    core.onLog((level, message) => process.stderr.write(`[${level}] ${message}\n`))
  }

  let stopping = false
  const shutdown = (signal: string) => {
    if (stopping) return
    stopping = true
    if (!args.quiet) process.stderr.write(`\n收到 ${signal}，正在关闭…\n`)
    core
      .stop()
      .catch(() => {})
      .finally(() => {
        core.close()
        process.exit(0)
      })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  try {
    await core.start()
  } catch (err) {
    process.stderr.write(`启动失败: ${err instanceof Error ? err.message : String(err)}\n`)
    core.close()
    process.exit(1)
  }

  const { port, bindAddress, socksPort } = core.getSettings().proxy
  process.stderr.write(
    `数据目录: ${dataDir}\n` +
      `HTTP 代理: ${bindAddress}:${port}\n` +
      `SOCKS5 代理: ${socksPort > 0 ? `${bindAddress}:${socksPort}` : '已禁用'}\n` +
      `CA 证书: ${join(dataDir, 'certs', 'ca.pem')}（客户端需导入并信任）\n` +
      `Ctrl+C 退出\n`
  )
  // server 监听 socket 维持事件循环，无需显式 hold
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(message.endsWith('\n') ? message : message + '\n')
  process.exit(1)
})
