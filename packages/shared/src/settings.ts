export interface ReverseProxyRule {
  id: string
  enabled: boolean
  name: string
  /** 本地监听端口（客户端直接访问 127.0.0.1:listenPort） */
  listenPort: number
  targetHost: string
  targetPort: number
  /** 目标是否为 HTTPS/WSS */
  targetTls: boolean
}

/** 域名镜像：命中 host 的流量在代理层改道到 mirrorHost（SNI/CN 同步替换） */
export interface MirrorRule {
  id: string
  enabled: boolean
  name: string
  /** 源 host：精确或 *.example.com 通配 */
  fromHost: string
  mirrorHost: string
  /** 端口映射为默认端口（80/443）；0 = 保持原端口 */
  mirrorPort: number
}

export interface AppSettings {
  proxy: {
    port: number
    bindAddress: string
    /** SOCKS5 入站端口（配合 Android VPN 类 App）；0 = 禁用 */
    socksPort: number
    /** 二级代理：全部出站流量转发给该上游代理 */
    upstream: {
      enabled: boolean
      protocol: 'http' | 'socks5'
      host: string
      port: number
    }
  }
  reverse: {
    rules: ReverseProxyRule[]
  }
  mirror: {
    rules: MirrorRule[]
  }
  /** 代理客户端访问控制：连接层按来源 IP 拦截 */
  accessControl: {
    mode: 'off' | 'allowlist' | 'blocklist'
    ips: string[]
  }
  /** 请求跟踪：为上游请求注入 trace 头并记录 traceId */
  trace: {
    enabled: boolean
    header: string
  }
  /** 内置 MCP 服务器（AI 助手读取抓包数据；仅监听 127.0.0.1） */
  mcp: {
    enabled: boolean
    port: number
  }
  capture: {
    paused: boolean
    /** 极速模式：流量仅在内存中实时展示，不写入磁盘（重启即清空） */
    turbo: boolean
    maxBodySizeMB: number
  }
  tls: {
    mitmEnabled: boolean
    rejectUpstream: boolean
    bypassHosts: string[]
  }
  retention: {
    days: number
    maxFlows: number
    maxDiskGB: number
  }
}

export function defaultSettings(): AppSettings {
  return {
    proxy: {
      port: 9090,
      bindAddress: '0.0.0.0',
      socksPort: 9091,
      upstream: { enabled: false, protocol: 'http', host: '127.0.0.1', port: 7890 }
    },
    reverse: { rules: [] },
    mirror: { rules: [] },
    accessControl: { mode: 'off', ips: [] },
    trace: { enabled: false, header: 'X-Trace-Id' },
    mcp: { enabled: false, port: 9092 },
    capture: {
      paused: false,
      turbo: false,
      maxBodySizeMB: 20
    },
    tls: {
      mitmEnabled: true,
      rejectUpstream: true,
      bypassHosts: []
    },
    retention: {
      days: 30,
      maxFlows: 200000,
      maxDiskGB: 10
    }
  }
}

export function mergeSettings(base: AppSettings, patch: unknown): AppSettings {
  if (!patch || typeof patch !== 'object') return base
  return deepMerge(base, patch as Record<string, unknown>) as AppSettings
}

function deepMerge(target: unknown, patch: Record<string, unknown>): unknown {
  const out: Record<string, unknown> =
    target && typeof target === 'object' ? { ...(target as Record<string, unknown>) } : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    const existing = out[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && existing && typeof existing === 'object' && !Array.isArray(existing)) {
      out[k] = deepMerge(existing, v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out
}
