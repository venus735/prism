import { execFileSync } from 'node:child_process'

const CACHE_TTL_MS = 30_000
const CACHE_MAX = 4096

const cache = new Map<number, { name: string | null; ts: number }>()

const LSOF_CANDIDATES = ['/usr/sbin/lsof', 'lsof']
let lsofPath: string | null = null

function findLsof(): string | null {
  if (lsofPath !== null) return lsofPath
  for (const candidate of LSOF_CANDIDATES) {
    try {
      execFileSync(candidate, ['-v'], { stdio: 'ignore' })
      lsofPath = candidate
      return lsofPath
    } catch {
      /* try next */
    }
  }
  lsofPath = ''
  return null
}

/**
 * 把本机回环连接的客户端端口归属到进程名（macOS via lsof）。
 * 仅当客户端与代理同机时才有意义；失败返回 null，绝不抛错。
 */
export function resolveClientApp(port: number): string | null {
  if (process.platform !== 'darwin' || !Number.isInteger(port) || port <= 0) return null
  const hit = cache.get(port)
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.name
  const name = lookup(port)
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(port, { name, ts: Date.now() })
  return name
}

function lookup(port: number): string | null {
  const bin = findLsof()
  if (!bin) return null
  try {
    const out = execFileSync(bin, ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fpcn'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    // F 格式按记录分组：p<pid> c<command> n<addr→port>。取本地端口等于 port 的记录
    // （客户端侧 socket；代理自身侧的本地端口是监听端口，不会匹配 ephemeral port）
    let command: string | null = null
    for (const line of out.split('\n')) {
      const tag = line[0]
      const value = line.slice(1)
      if (tag === 'c') {
        command = value
      } else if (tag === 'n') {
        // 形如 127.0.0.1:54321->127.0.0.1:9090 或 *:54321
        const local = value.split('->')[0]
        const localPort = Number(local.slice(local.lastIndexOf(':') + 1))
        if (localPort === port && command) return command
        command = null
      }
    }
    return null
  } catch {
    return null
  }
}
