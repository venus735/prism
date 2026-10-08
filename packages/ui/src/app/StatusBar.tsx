import { useEffect, useState } from 'react'
import type { AppInfo } from '@proxy/shared'
import { call } from '../api/client'
import { useFlowsStore } from '../stores/flows'
import { useBreakpointsStore } from '../stores/breakpoints'
import { useUiStore, type Page } from '../stores/ui'
import { useThemeStore, effectiveMode } from '../stores/theme'

const PAGE_HINTS: Record<Page, string> = {
  traffic: '⌘F 过滤 · ↑↓ 或 j/k 导航 · Esc 取消选择 · 右键行更多操作（复制 / 重放 / 对比 / 标签备注）',
  stats: '数据源：最近 1000 条历史 + 实时流量',
  breakpoints: '命中的请求会暂停转发，编辑请求/响应后放行或中止',
  composer: '多 tab 独立草稿 · {{var}} 引用环境变量 · 更多操作在右上角 ⋯ 菜单',
  collections: '收藏的请求可一键回填 Composer、重放或两两对比',
  rules: '规则自上而下顺序匹配，首条命中即生效并短路后续',
  plugins: 'JS 插件保存即热重载 · Python 插件走桥接进程',
  toolbox: '编解码 / Hash / HMAC / AES / 时间戳 / UUID / 正则 / 二维码',
  settings: '安装并信任 CA 证书后，本机浏览器可无告警访问被解密的 HTTPS 站点'
}

/** 顶部状态栏：代理监听状态（Reqable「Proxying on IP:PORT」）+ 跨页快捷状态 */
export function TopStatusBar() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [copied, setCopied] = useState(false)
  const flowCount = useFlowsStore((s) => s.flows.length)
  const hitCount = useBreakpointsStore((s) => s.hits.length)
  const setPage = useUiStore((s) => s.setPage)
  const themeMode = useThemeStore((s) => s.mode)
  const toggleThemeMode = useThemeStore((s) => s.toggleMode)

  useEffect(() => {
    call('app.info')
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [])

  const lanIp = info?.localIps.find((ip) => !ip.startsWith('127.')) ?? info?.localIps[0]
  const running = info?.proxyRunning ?? false
  const addr = lanIp ? `${lanIp}:${info!.proxyPort}` : `:${info?.proxyPort ?? '—'}`

  const copy = async (): Promise<void> => {
    if (!lanIp) return
    await call('app.clipboard.writeText', { text: addr })
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="h-8 shrink-0 flex items-center gap-2 px-3 bg-zinc-900 border-b border-zinc-800 text-xs select-none">
      <button
        onClick={() => void copy()}
        title={lanIp ? `局域网设备（手机 / 其他电脑）将 HTTP 代理指向 ${addr} 即可抓包，点击复制` : '代理状态'}
        className="flex items-center gap-1.5 text-zinc-300 hover:text-sky-400"
      >
        <span className={`w-2 h-2 rounded-full ${running ? 'bg-emerald-500' : 'bg-zinc-600'}`} />
        <span>{running ? '代理中' : '代理未运行'}</span>
        {lanIp && (
          <span className="font-mono text-zinc-500">
            {copied ? '已复制 ✓' : addr}
          </span>
        )}
      </button>
      <span className="flex-1" />
      {hitCount > 0 && (
        <button
          onClick={() => setPage('breakpoints')}
          title="断点命中待处理，点击前往"
          className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-600/15 text-amber-400 hover:bg-amber-600/25"
        >
          ⏸ {hitCount}
        </button>
      )}
      <button
        onClick={() => setPage('traffic')}
        title="流量总数，点击前往流量页"
        className="text-zinc-500 hover:text-zinc-300"
      >
        {flowCount} 条流量
      </button>
      <button
        onClick={toggleThemeMode}
        title="切换亮色/暗色主题（设置页可跟随系统、选强调色与代码配色）"
        className="px-1.5 py-0.5 rounded text-zinc-500 hover:text-sky-400"
      >
        {effectiveMode(themeMode) === 'dark' ? '暗色' : '亮色'}
      </button>
    </div>
  )
}

/** 底部状态栏：页面操作提示 + 版本（Reqable 底部栏的「低频功能/提示」区） */
export function BottomStatusBar() {
  const page = useUiStore((s) => s.page)
  const [version, setVersion] = useState('')

  useEffect(() => {
    call('app.info')
      .then((i) => setVersion(i.version))
      .catch(() => setVersion(''))
  }, [])

  return (
    <div className="h-6 shrink-0 flex items-center gap-3 px-3 bg-zinc-900 border-t border-zinc-800 text-[10px] text-zinc-500 select-none">
      <span className="truncate">{PAGE_HINTS[page]}</span>
      <span className="flex-1" />
      {version && <span className="shrink-0 font-mono">v{version}</span>}
    </div>
  )
}
