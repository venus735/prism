import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { AdbInfo, AppInfo, AppSettings, CertInfo, MirrorRule, ReverseProxyRule } from '@proxy/shared'
import { call } from '../../api/client'
import { useThemeStore, ACCENTS, CODE_SCHEMES, CUSTOMIZABLE_VARS, effectiveMode, type ThemeMode } from '../../stores/theme'
import { jsonNodes } from '../../components/JsonView'

export default function SettingsPage() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [cert, setCert] = useState<CertInfo | null>(null)
  const [saveMsg, setSaveMsg] = useState('')
  const [qrError, setQrError] = useState(false)
  const [macTrust, setMacTrust] = useState<{ supported: boolean; trusted: boolean }>({
    supported: false,
    trusted: false
  })
  const [installing, setInstalling] = useState(false)
  const [pairScheme, setPairScheme] = useState<'wifi' | 'usb'>('wifi')
  const [adb, setAdb] = useState<AdbInfo | null>(null)
  const [adbBusy, setAdbBusy] = useState(false)
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const refresh = async () => {
    const [i, s, c] = await Promise.all([
      call('app.info'),
      call('app.settings.get'),
      call('cert.info')
    ])
    setInfo(i)
    setSettings(s)
    setCert(c)
  }

  useEffect(() => {
    refresh().catch(() => {})
    call('cert.checkTrust')
      .then((r) => setMacTrust({ supported: r.supported, trusted: r.trusted }))
      .catch(() => {})
  }, [])

  const installCert = async () => {
    setInstalling(true)
    try {
      const r = await call('cert.installSystem')
      setMacTrust({ supported: true, trusted: r.trusted })
      if (!r.ok) {
        setSaveMsg(`安装失败：${r.error ?? '未知错误'}`)
        setTimeout(() => setSaveMsg(''), 3000)
      } else {
        setSaveMsg('CA 证书已安装并被信任')
        setTimeout(() => setSaveMsg(''), 2500)
      }
    } finally {
      setInstalling(false)
    }
  }

  useEffect(() => {
    if (!info || !settings) return
    const ip = info.localIps.find((x) => !x.startsWith('127.')) ?? info.localIps[0]
    const canvas = qrCanvasRef.current
    if (!ip || settings.proxy.socksPort <= 0 || !canvas) {
      setQrError(true)
      return
    }
    // qrcode 浏览器构建只有 toCanvas（toDataURL 是 Node 专属）
    QRCode.toCanvas(canvas, `prism://pair?host=${ip}&port=${settings.proxy.socksPort}`, {
      width: 180,
      margin: 1,
      color: { dark: '#0f172a', light: '#ffffff' }
    })
      .then(() => setQrError(false))
      .catch((e: unknown) => {
        console.error('配对二维码生成失败', e)
        setQrError(true)
      })
  }, [info, settings])

  // USB 方案下轮询 adb 设备与反向通道状态
  useEffect(() => {
    if (pairScheme !== 'usb') return
    let alive = true
    const tick = () => {
      call('adb.status')
        .then((r) => alive && setAdb(r))
        .catch(() => {})
    }
    tick()
    const timer = setInterval(tick, 4000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [pairScheme])

  const usbPorts = (s: AppSettings): number[] =>
    [...new Set([s.proxy.socksPort, s.proxy.port])].filter((p) => p > 0)

  const doAdbReverse = async (undo: boolean) => {
    if (!settings) return
    setAdbBusy(true)
    try {
      const ports = usbPorts(settings)
      let lastErr = ''
      for (const port of ports) {
        const r = undo
          ? await call('adb.unreverse', { port })
          : await call('adb.reverse', { port })
        if (!r.ok && lastErr === '') lastErr = r.error ?? '执行失败'
      }
      if (lastErr) {
        setSaveMsg(`USB 通道${undo ? '断开' : '建立'}失败：${lastErr}`)
      } else {
        setSaveMsg(undo ? 'USB 通道已断开' : `USB 通道已建立（${ports.map((p) => `tcp:${p}`).join(' ')}）`)
      }
      setTimeout(() => setSaveMsg(''), 3000)
      const r = await call('adb.status')
      setAdb(r)
    } finally {
      setAdbBusy(false)
    }
  }

  if (!info || !settings || !cert) {
    return <div className="h-full flex items-center justify-center text-zinc-600">加载中…</div>
  }

  const patch = async (p: Partial<AppSettings>) => {
    const next = await call('app.settings.set', p)
    setSettings(next)
    setSaveMsg('已保存')
    setTimeout(() => setSaveMsg(''), 1500)
  }

  const restartProxy = async () => {
    const r = await call('proxy.restart')
    setSaveMsg(`代理已在端口 ${r.port} 重启`)
    setTimeout(() => setSaveMsg(''), 2500)
    refresh().catch(() => {})
  }

  const exportCert = async () => {
    const r = await call('cert.export')
    if (!r.canceled && r.path) {
      setSaveMsg(`证书已导出到 ${r.path}`)
      setTimeout(() => setSaveMsg(''), 3000)
    }
  }

  const lanIp = info.localIps.find((ip) => !ip.startsWith('127.')) ?? info.localIps[0] ?? '未知'

  return (
    <div className="h-full overflow-auto p-6 max-w-3xl space-y-8">
      <AppearanceSection />

      <Section title="代理服务">
        <Row label="端口">
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={settings.proxy.port}
              onChange={(e) =>
                patch({ proxy: { ...settings.proxy, port: Number(e.target.value) || 9090 } })
              }
              className="w-24 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-sky-700"
            />
            <button onClick={restartProxy} className="text-xs px-2 py-1 rounded bg-sky-600/20 text-sky-400 hover:bg-sky-600/30">
              重启代理生效
            </button>
          </div>
        </Row>
        <Row label="SOCKS5 端口">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              value={settings.proxy.socksPort}
              onChange={(e) =>
                patch({ proxy: { ...settings.proxy, socksPort: Math.max(0, Number(e.target.value) || 0) } })
              }
              className="w-24 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-sky-700"
            />
            <span className="text-xs text-zinc-500">
              0 = 禁用；Android VPN 类 App 可用 SOCKS5 接入（需重启代理）
            </span>
          </div>
        </Row>
        <Row label="监听地址">
          <span className="font-mono text-sm text-zinc-300">{settings.proxy.bindAddress}</span>
        </Row>
        <Row label="局域网 IP">
          <span className="font-mono text-sm text-sky-400">{lanIp}</span>
          <span className="text-xs text-zinc-500 ml-2">手机 Wi-Fi 代理填 {lanIp}:{settings.proxy.port}</span>
        </Row>
        <Row label="状态">
          <span className={info.proxyRunning ? 'text-emerald-400' : 'text-red-400'}>
            {info.proxyRunning ? `运行中 :${settings.proxy.port}` : '未运行'}
          </span>
        </Row>
      </Section>

      <Section title="上游代理（二级代理）">
        <Row label="启用">
          <Toggle
            checked={settings.proxy.upstream.enabled}
            onChange={(v) =>
              patch({ proxy: { ...settings.proxy, upstream: { ...settings.proxy.upstream, enabled: v } } })
            }
          />
          <span className="text-xs text-zinc-500 ml-2">全部出站流量转发给该代理，无需重启即时生效</span>
        </Row>
        <Row label="协议">
          <select
            value={settings.proxy.upstream.protocol}
            onChange={(e) =>
              patch({
                proxy: {
                  ...settings.proxy,
                  upstream: { ...settings.proxy.upstream, protocol: e.target.value as 'http' | 'socks5' }
                }
              })
            }
            className="w-28 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-sky-700"
          >
            <option value="http">HTTP</option>
            <option value="socks5">SOCKS5</option>
          </select>
          <span className="text-xs text-zinc-500 ml-2">SOCKS5 暂仅支持无认证</span>
        </Row>
        <Row label="代理地址">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={settings.proxy.upstream.host}
              onChange={(e) =>
                patch({
                  proxy: { ...settings.proxy, upstream: { ...settings.proxy.upstream, host: e.target.value.trim() } }
                })
              }
              placeholder="127.0.0.1"
              className="w-40 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-sky-700"
            />
            <input
              type="number"
              min={1}
              max={65535}
              value={settings.proxy.upstream.port}
              onChange={(e) =>
                patch({
                  proxy: {
                    ...settings.proxy,
                    upstream: { ...settings.proxy.upstream, port: Number(e.target.value) || 7890 }
                  }
                })
              }
              className="w-24 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-sky-700"
            />
          </div>
        </Row>
        <p className="text-xs text-zinc-500 pt-1">
          典型场景：本机 Clash/Surge 监听 127.0.0.1:7890，填入后抓包流量全部经其转发；
          流量列表中经上游转发的请求会带 upstream 标记。
        </p>
      </Section>

      <Section title="反向代理">
        <ReverseProxySection
          rules={settings.reverse?.rules ?? []}
          onSave={(rules) => patch({ reverse: { rules } })}
        />
        <p className="text-xs text-zinc-500 pt-1">
          本地监听端口透明转发到目标地址，客户端直连本地端口即可（无需配代理）；
          转发流量进抓包列表，重写/断点/脚本等规则全部生效。改配置即时生效。
        </p>
      </Section>

      <Section title="域名镜像">
        <MirrorSection rules={settings.mirror?.rules ?? []} onSave={(rules) => patch({ mirror: { rules } })} />
        <p className="text-xs text-zinc-500 pt-1">
          命中源域名的流量在代理层改道到镜像域名（TLS 的 SNI 同步替换），
          客户端无感知。支持精确域名与 *.example.com 通配。改配置即时生效。
        </p>
      </Section>

      <Section title="访问控制">
        <AccessControlSection
          mode={settings.accessControl?.mode ?? 'off'}
          ips={settings.accessControl?.ips ?? []}
          onSave={(ac) => patch({ accessControl: ac })}
        />
        <p className="text-xs text-zinc-500 pt-1">
          白名单：仅允许列表内 IP 连接代理；黑名单：拒绝列表内 IP。列表为空 = 不限制；
          支持 IPv4 / IPv6（::ffff: 映射地址自动归一化），在 TCP 层直接断开，修改实时生效。
          局域网开启 MITM 抓包时建议配置白名单，防止陌生设备接入。
        </p>
      </Section>

      <Section title="MCP 服务器">
        <McpSection settings={settings} patch={patch} />
      </Section>

      <Section title="HTTPS 解密（MITM）">
        <Row label="启用 MITM">
          <Toggle
            checked={settings.tls.mitmEnabled}
            onChange={(v) => patch({ tls: { ...settings.tls, mitmEnabled: v } })}
          />
        </Row>
        <Row label="校验上游证书">
          <Toggle
            checked={settings.tls.rejectUpstream}
            onChange={(v) => patch({ tls: { ...settings.tls, rejectUpstream: v } })}
          />
        </Row>
        <Row label="数据目录">
          <span className="font-mono text-xs text-zinc-400 break-all">{info.dataDir}</span>
        </Row>
      </Section>

      <Section title="数据保留">
        <Row label="保留天数">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              value={settings.retention.days}
              onChange={(e) =>
                patch({
                  retention: {
                    ...settings.retention,
                    days: Math.max(0, Number(e.target.value) || 0)
                  }
                })
              }
              className="w-24 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-sky-700"
            />
            <span className="text-xs text-zinc-500">0 = 不限制</span>
          </div>
        </Row>
        <Row label="最大条数">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              value={settings.retention.maxFlows}
              onChange={(e) =>
                patch({
                  retention: {
                    ...settings.retention,
                    maxFlows: Math.max(0, Number(e.target.value) || 0)
                  }
                })
              }
              className="w-32 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-sky-700"
            />
            <span className="text-xs text-zinc-500">超出时删除最旧的记录</span>
          </div>
        </Row>
        <Row label="磁盘上限 (GB)">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              step={0.5}
              value={settings.retention.maxDiskGB}
              onChange={(e) =>
                patch({
                  retention: {
                    ...settings.retention,
                    maxDiskGB: Math.max(0, Number(e.target.value) || 0)
                  }
                })
              }
              className="w-24 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-sky-700"
            />
            <span className="text-xs text-zinc-500">含数据库与 body 文件，超限时从最旧开始清理</span>
          </div>
        </Row>
        <p className="text-xs text-zinc-500 pt-1">清理在启动时与每小时执行，修改设置后立即生效。</p>
      </Section>

      <Section title="CA 证书">
        <div className="space-y-2">
          <Row label="指纹 (SHA-256)">
            <span className="font-mono text-xs text-zinc-400 break-all">{cert.fingerprintSha256}</span>
          </Row>
          <Row label="Subject">
            <span className="font-mono text-xs text-zinc-400">{cert.subject}</span>
          </Row>
          <Row label="有效期">
            <span className="text-sm text-zinc-300">
              {new Date(cert.notBefore).toLocaleDateString()} ~{' '}
              {new Date(cert.notAfter).toLocaleDateString()}
            </span>
          </Row>
          {macTrust.supported && (
            <Row label="本机信任">
              {macTrust.trusted ? (
                <span className="text-sm text-emerald-400">已安装并被 macOS 信任</span>
              ) : (
                <span className="text-sm text-amber-400">未安装（本机浏览器访问解密站点会有告警）</span>
              )}
            </Row>
          )}
          <div className="flex gap-2 pt-1">
            <button
              onClick={exportCert}
              className="px-3 py-1.5 rounded text-sm bg-sky-600/20 text-sky-400 hover:bg-sky-600/30"
            >
              导出证书…
            </button>
            {macTrust.supported && !macTrust.trusted && (
              <button
                onClick={installCert}
                disabled={installing}
                className="px-3 py-1.5 rounded text-sm bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 disabled:opacity-50"
              >
                {installing ? '安装中…' : '安装并信任（本机）'}
              </button>
            )}
          </div>
        </div>
      </Section>

      <Section title="手机接入指引">
        <div className="flex gap-1 p-1 rounded-lg bg-zinc-900 w-fit text-sm mb-3">
          {(
            [
              { id: 'wifi', label: 'Wi-Fi 无线' },
              { id: 'usb', label: 'USB 数据线' }
            ] as const
          ).map((s) => (
            <button
              key={s.id}
              onClick={() => setPairScheme(s.id)}
              className={`px-3 py-1 rounded-md transition-colors ${
                pairScheme === s.id ? 'bg-sky-600/30 text-sky-300' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {pairScheme === 'wifi' ? (
          <ol className="list-decimal list-inside space-y-2 text-sm text-zinc-400 leading-relaxed">
            <li>
              手机与 Mac 连接同一 Wi-Fi，在 Wi-Fi 高级设置中配置手动代理：
              <span className="font-mono text-sky-400"> {lanIp} </span>端口
              <span className="font-mono text-sky-400"> {settings.proxy.port}</span>
            </li>
            <li>
              手机浏览器访问 <span className="font-mono text-sky-400">http://cert.local</span> 下载 CA 证书
              （或点上方「导出证书」后传到手机）
            </li>
            <li>
              Android：设置 → 安全 → 加密与凭据 → 安装证书 → <b>CA 证书</b>；
              iOS：设置 → 已下载的描述文件 → 安装，并在「关于本机 → 证书信任设置」启用完全信任
            </li>
            <li>
              浏览器访问 HTTPS 站点，流量列表应显示绿色 <span className="font-mono">TLS</span> 标记即可明文查看
            </li>
          </ol>
        ) : (
          <div className="space-y-3">
            <ol className="list-decimal list-inside space-y-2 text-sm text-zinc-400 leading-relaxed">
              <li>USB 线连接手机与 Mac，手机上允许「USB 调试」授权</li>
              <li>
                点下方「一键建立 USB 通道」（adb reverse，把手机的
                <span className="font-mono text-sky-400"> 127.0.0.1:{settings.proxy.socksPort} </span>
                转发到 Mac 同端口）；也可在终端执行
                <span className="font-mono text-sky-400"> adb reverse tcp:{settings.proxy.socksPort} tcp:{settings.proxy.socksPort}</span>
              </li>
              <li>
                手机 App 连接方式选「USB 数据线」，地址自动填
                <span className="font-mono text-sky-400"> 127.0.0.1</span>，无需 Wi-Fi
              </li>
              <li>
                CA 证书下载与 Wi-Fi 相同：连接后手机访问
                <span className="font-mono text-sky-400"> http://cert.local</span>
              </li>
            </ol>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-sm space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-zinc-500 w-16 shrink-0">adb</span>
                {!adb ? (
                  <span className="text-zinc-500">检测中…</span>
                ) : !adb.available ? (
                  <span className="text-red-400">不可用：{adb.error}</span>
                ) : adb.devices.length === 0 ? (
                  <span className="text-amber-400">未检测到设备（确认 USB 调试已开启并授权）</span>
                ) : (
                  <span className="text-emerald-400">
                    已连接 {adb.devices.length} 台：{adb.devices.map((d) => d.model ?? d.serial).join('、')}
                  </span>
                )}
              </div>
              {adb?.available && adb.devices.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-zinc-500 w-16 shrink-0">通道</span>
                  {(() => {
                    const ports = usbPorts(settings)
                    const done = ports.filter((p) => adb.reversed.some((r) => r.remote === `tcp:${p}`))
                    return (
                      <span className={done.length === ports.length ? 'text-emerald-400' : 'text-zinc-400'}>
                        {done.length === ports.length
                          ? `已建立 ✓（${ports.map((p) => `tcp:${p}`).join(' ')}）`
                          : `未建立（需要 tcp:${ports.join(' tcp:')}）`}
                      </span>
                    )
                  })()}
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => doAdbReverse(false)}
                  disabled={adbBusy || !adb?.available || adb.devices.length === 0}
                  className="text-xs px-3 py-1.5 rounded bg-sky-600/20 text-sky-400 hover:bg-sky-600/30 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {adbBusy ? '执行中…' : '一键建立 USB 通道'}
                </button>
                <button
                  onClick={() => doAdbReverse(true)}
                  disabled={adbBusy || !adb?.available || adb.reversed.length === 0}
                  className="text-xs px-3 py-1.5 rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  断开通道
                </button>
              </div>
            </div>
          </div>
        )}
        <p className="mt-3 text-xs text-amber-500/80 leading-relaxed">
          注意：Android 7+ 默认不信任用户安装的 CA（仅浏览器与少数应用信任）。
          抓取自有 App 流量需在 debug 构建中添加 networkSecurityConfig 例外；
          开启私人 DNS（DoT/DoH）的流量无法在代理层解密，抓包前请关闭。
          部分应用使用 HTTP/3（QUIC over UDP）时会绕过 TCP 代理直接出网，
          可在 Chrome 地址栏输入 <span className="font-mono">chrome://flags</span> 搜索 QUIC 禁用，
          或在路由器/防火墙屏蔽 UDP 443 强制回退到 TCP 后即可抓到。
          SSL Pinning 无法在代理层绕过。
        </p>
      </Section>

      <Section title="Android VPN App 扫码配对">
        <div className="flex gap-5 items-start">
          <div className="w-[184px] h-[184px] rounded bg-white border border-zinc-800 shrink-0 flex items-center justify-center overflow-hidden">
            {qrError ? (
              <span className="text-xs text-zinc-500 text-center px-3">二维码不可用</span>
            ) : (
              <canvas ref={qrCanvasRef} width={180} height={180} />
            )}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-3">
              <span className="text-sm text-zinc-400">Mac 地址</span>
              <code className="px-2 py-1 rounded bg-zinc-800 text-sky-400 font-mono text-sm select-all">
                {lanIp}:{settings.proxy.socksPort}
              </code>
            </div>
            <ol className="list-decimal list-inside space-y-2 text-sm text-zinc-400 leading-relaxed">
              <li>
                手机安装「Prism 棱镜」App（本仓库 <span className="font-mono">android/</span> 目录构建）
              </li>
              <li>
                App 内点「扫码配对」扫描左侧二维码，或手动填入上方地址（Wi-Fi 方案）；
                USB 方案：上方「手机接入指引」切到「USB 数据线」一键建立通道，App 内选「USB 数据线」即可
              </li>
              <li>
                打开「VPN 隧道」开关并授权，整机 TCP 流量即转发到 Mac 抓包
                （Wi-Fi 手动代理仅对浏览器等少数应用生效，VPN 方式覆盖所有应用）
              </li>
              <li>
                HTTPS 解密仍需安装 CA 证书：连接后手机访问
                <span className="font-mono text-sky-400"> http://cert.local</span>
                （有 Root 的设备可在 App 内一键安装系统证书）
              </li>
            </ol>
          </div>
        </div>
      </Section>

      {saveMsg && <div className="fixed bottom-4 right-4 px-3 py-2 rounded bg-zinc-800 text-sm text-zinc-200 shadow-lg">{saveMsg}</div>}
    </div>
  )
}

function AppearanceSection() {
  const { mode, accent, codeScheme, setMode, setAccent, setCodeScheme } = useThemeStore()
  return (
    <Section title="外观">
      <Row label="主题">
        <div className="flex gap-2">
          {(
            [
              { id: 'dark', label: '暗色' },
              { id: 'light', label: '亮色' },
              { id: 'system', label: '跟随系统' }
            ] as { id: ThemeMode; label: string }[]
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setMode(t.id)}
              className={`px-3 py-1.5 rounded text-sm border ${
                mode === t.id
                  ? 'bg-sky-600/20 text-sky-400 border-sky-700'
                  : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </Row>
      <Row label="强调色">
        <div className="flex gap-2 flex-wrap">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              title={a.name}
              onClick={() => setAccent(a.id)}
              className={`w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 ${
                accent === a.id ? 'border-zinc-200' : 'border-transparent'
              }`}
              style={{ backgroundColor: a.shades[3] }}
            />
          ))}
        </div>
      </Row>
      <Row label="代码配色">
        <div className="flex-1">
          <select
            value={codeScheme}
            onChange={(e) => setCodeScheme(e.target.value)}
            className="w-56 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-sky-700"
          >
            {CODE_SCHEMES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <div className="mt-2 px-3 py-2 rounded bg-zinc-900 border border-zinc-800 font-mono text-xs whitespace-pre-wrap">
            {jsonNodes('{"code": "highlight", "n": 42, "ok": true, "list": [1, 2.5, null]}')}
          </div>
        </div>
      </Row>
      <CustomVarsPanel />
    </Section>
  )
}

function CustomVarsPanel() {
  const { mode, custom, setCustomVar, resetCustom } = useThemeStore()
  const [target, setTarget] = useState<'dark' | 'light'>(() => effectiveMode(mode))
  const [open, setOpen] = useState(false)
  const overrides = custom[target] ?? {}
  const count = Object.keys(overrides).length

  return (
    <div className="pt-1">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen(!open)}
          className="text-sm text-zinc-400 hover:text-zinc-200"
        >
          {open ? '▼' : '▶'} 自定义变量
          {count > 0 && <span className="ml-1.5 text-xs text-sky-400">{count} 项已覆盖</span>}
        </button>
      </div>
      {open && (
        <div className="mt-2 pl-2 border-l border-zinc-800 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">编辑对象</span>
            {(['dark', 'light'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setTarget(m)}
                className={`px-2 py-0.5 rounded text-xs border ${
                  target === m
                    ? 'bg-sky-600/20 text-sky-400 border-sky-700/50'
                    : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {m === 'dark' ? '暗色' : '亮色'}
              </button>
            ))}
            {count > 0 && (
              <button
                onClick={() => resetCustom(target)}
                className="ml-auto text-xs text-red-400 hover:text-red-300"
              >
                全部重置
              </button>
            )}
          </div>
          {CUSTOMIZABLE_VARS.map((v) => {
            const cur = overrides[v.name]
            const builtin = getComputedStyle(document.documentElement).getPropertyValue(v.name).trim()
            return (
              <div key={v.name} className="flex items-center gap-2">
                <input
                  type="color"
                  value={cur ?? normalizeHex(builtin)}
                  onChange={(e) => setCustomVar(target, v.name, e.target.value)}
                  className="w-7 h-7 rounded cursor-pointer bg-transparent border border-zinc-800"
                  title={cur ? `自定义 ${cur}` : `内置 ${builtin || '—'}，选取颜色覆盖`}
                />
                <span className="w-20 text-xs text-zinc-400">{v.label}</span>
                <span className="font-mono text-[11px] text-zinc-600 w-16">{v.name}</span>
                {cur ? (
                  <button
                    onClick={() => setCustomVar(target, v.name, null)}
                    className="text-xs text-zinc-500 hover:text-red-400"
                    title="恢复内置色"
                  >
                    ⨯ {cur}
                  </button>
                ) : (
                  <span className="text-[11px] text-zinc-600">内置 {builtin || '—'}</span>
                )}
              </div>
            )
          })}
          <p className="text-[11px] text-zinc-600">
            变量按明暗模式分别保存，实时生效并持久化；「全部重置」清空当前模式的全部覆盖。
          </p>
        </div>
      )}
    </div>
  )
}

/** getComputedStyle 返回的 rgb() 归一化为 #rrggbb（供 color input 回显） */
function normalizeHex(css: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(css.trim())
  if (m) return `#${m[1]}`
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css)
  if (rgb) {
    const hex = (n: string) => Number(n).toString(16).padStart(2, '0')
    return `#${hex(rgb[1])}${hex(rgb[2])}${hex(rgb[3])}`
  }
  return '#000000'
}

function ReverseProxySection({
  rules,
  onSave
}: {
  rules: ReverseProxyRule[]
  onSave: (rules: ReverseProxyRule[]) => void
}) {
  const [name, setName] = useState('')
  const [listenPort, setListenPort] = useState('')
  const [targetHost, setTargetHost] = useState('')
  const [targetPort, setTargetPort] = useState('')
  const [targetTls, setTargetTls] = useState(false)
  const [err, setErr] = useState('')

  const inputCls =
    'bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-sky-700'

  const add = () => {
    const lp = Number(listenPort)
    const tp = Number(targetPort)
    if (!Number.isInteger(lp) || lp <= 0 || lp > 65535) return setErr('监听端口无效')
    if (!targetHost.trim()) return setErr('目标地址不能为空')
    if (!Number.isInteger(tp) || tp <= 0 || tp > 65535) return setErr('目标端口无效')
    if (rules.some((r) => r.listenPort === lp)) return setErr(`端口 ${lp} 已被其他规则占用`)
    setErr('')
    onSave([
      ...rules,
      {
        id: crypto.randomUUID(),
        enabled: true,
        name: name.trim() || `${targetHost.trim()}:${tp}`,
        listenPort: lp,
        targetHost: targetHost.trim(),
        targetPort: tp,
        targetTls
      }
    ])
    setName('')
    setListenPort('')
    setTargetHost('')
    setTargetPort('')
    setTargetTls(false)
  }

  return (
    <div className="space-y-3">
      {rules.length === 0 && <p className="text-sm text-zinc-600">暂无规则</p>}
      {rules.map((r) => (
        <div key={r.id} className="flex items-center gap-3 text-sm bg-zinc-900/60 border border-zinc-800 rounded px-3 py-2">
          <Toggle
            checked={r.enabled}
            onChange={(v) => onSave(rules.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)))}
          />
          <span className="text-zinc-300 min-w-0 truncate" title={r.name}>
            {r.name}
          </span>
          <span className="font-mono text-sky-400">:{r.listenPort}</span>
          <span className="text-zinc-600">→</span>
          <span className={`font-mono ${r.targetTls ? 'text-emerald-400' : 'text-zinc-300'} truncate`}>
            {r.targetTls ? 'https' : 'http'}://{r.targetHost}:{r.targetPort}
          </span>
          <button
            onClick={() => onSave(rules.filter((x) => x.id !== r.id))}
            className="ml-auto text-xs px-2 py-1 rounded text-red-400 hover:bg-red-500/10"
          >
            删除
          </button>
        </div>
      ))}

      <div className="flex items-center gap-2 flex-wrap pt-1">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="名称（可选）"
          className={`w-36 ${inputCls}`}
        />
        <input
          type="number"
          value={listenPort}
          onChange={(e) => setListenPort(e.target.value)}
          placeholder="监听端口"
          className={`w-24 ${inputCls}`}
        />
        <span className="text-zinc-600">→</span>
        <input
          type="text"
          value={targetHost}
          onChange={(e) => setTargetHost(e.target.value)}
          placeholder="目标地址"
          className={`w-40 ${inputCls}`}
        />
        <input
          type="number"
          value={targetPort}
          onChange={(e) => setTargetPort(e.target.value)}
          placeholder="端口"
          className={`w-20 ${inputCls}`}
        />
        <label className="flex items-center gap-1 text-xs text-zinc-400 cursor-pointer select-none">
          <input type="checkbox" checked={targetTls} onChange={(e) => setTargetTls(e.target.checked)} />
          HTTPS
        </label>
        <button
          onClick={add}
          className="px-3 py-1 rounded text-sm bg-sky-600/20 text-sky-400 hover:bg-sky-600/30"
        >
          添加
        </button>
        {err && <span className="text-xs text-red-400">{err}</span>}
      </div>
    </div>
  )
}

function MirrorSection({
  rules,
  onSave
}: {
  rules: MirrorRule[]
  onSave: (rules: MirrorRule[]) => void
}) {
  const [fromHost, setFromHost] = useState('')
  const [mirrorHost, setMirrorHost] = useState('')
  const [mirrorPort, setMirrorPort] = useState('')
  const [err, setErr] = useState('')

  const inputCls =
    'bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-sky-700'

  const add = () => {
    const from = fromHost.trim()
    const to = mirrorHost.trim()
    const mp = Number(mirrorPort || 0)
    if (!from) return setErr('源域名不能为空')
    if (!to) return setErr('镜像域名不能为空')
    if (!Number.isInteger(mp) || mp < 0 || mp > 65535) return setErr('端口无效')
    if (rules.some((r) => r.fromHost === from)) return setErr(`${from} 已有镜像规则`)
    setErr('')
    onSave([
      ...rules,
      {
        id: crypto.randomUUID(),
        enabled: true,
        name: `${from} → ${to}`,
        fromHost: from,
        mirrorHost: to,
        mirrorPort: mp
      }
    ])
    setFromHost('')
    setMirrorHost('')
    setMirrorPort('')
  }

  return (
    <div className="space-y-3">
      {rules.length === 0 && <p className="text-sm text-zinc-600">暂无规则</p>}
      {rules.map((r) => (
        <div key={r.id} className="flex items-center gap-3 text-sm bg-zinc-900/60 border border-zinc-800 rounded px-3 py-2">
          <Toggle checked={r.enabled} onChange={(v) => onSave(rules.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)))} />
          <span className="font-mono text-zinc-300 truncate">{r.fromHost}</span>
          <span className="text-zinc-600">→</span>
          <span className="font-mono text-violet-400 truncate">
            {r.mirrorHost}
            {r.mirrorPort > 0 ? `:${r.mirrorPort}` : ''}
          </span>
          <button
            onClick={() => onSave(rules.filter((x) => x.id !== r.id))}
            className="ml-auto text-xs px-2 py-1 rounded text-red-400 hover:bg-red-500/10"
          >
            删除
          </button>
        </div>
      ))}

      <div className="flex items-center gap-2 flex-wrap pt-1">
        <input
          type="text"
          value={fromHost}
          onChange={(e) => setFromHost(e.target.value)}
          placeholder="源域名（或 *.example.com）"
          className={`w-48 ${inputCls}`}
        />
        <span className="text-zinc-600">→</span>
        <input
          type="text"
          value={mirrorHost}
          onChange={(e) => setMirrorHost(e.target.value)}
          placeholder="镜像到"
          className={`w-44 ${inputCls}`}
        />
        <input
          type="number"
          value={mirrorPort}
          onChange={(e) => setMirrorPort(e.target.value)}
          placeholder="端口 0=保持"
          className={`w-28 ${inputCls}`}
        />
        <button onClick={add} className="px-3 py-1 rounded text-sm bg-sky-600/20 text-sky-400 hover:bg-sky-600/30">
          添加
        </button>
        {err && <span className="text-xs text-red-400">{err}</span>}
      </div>
    </div>
  )
}

function McpSection({ settings, patch }: { settings: AppSettings; patch: (p: Partial<AppSettings>) => Promise<void> }) {
  const [info, setInfo] = useState<{ enabled: boolean; port: number; listening: boolean } | null>(null)

  const refresh = (): void => {
    call('mcp.info')
      .then(setInfo)
      .catch(() => {})
  }
  useEffect(refresh, [settings.mcp.enabled, settings.mcp.port])

  const mcp = settings.mcp
  const save = (next: { enabled?: boolean; port?: number }): void => {
    void patch({ mcp: { ...mcp, ...next } }).then(refresh)
  }

  return (
    <div className="space-y-2">
      <Row label="启用">
        <div className="flex items-center gap-3">
          <Toggle checked={mcp.enabled} onChange={(v) => save({ enabled: v })} />
          {info && mcp.enabled && (
            <span className={`text-xs ${info.listening ? 'text-emerald-400' : 'text-red-400'}`}>
              {info.listening ? `监听中` : `未监听（端口被占用？）`}
            </span>
          )}
        </div>
      </Row>
      <Row label="端口">
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={65535}
            value={mcp.port}
            onChange={(e) => save({ port: Math.max(1, Number(e.target.value) || 9092) })}
            className="w-24 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-sky-700"
          />
        </div>
      </Row>
      <p className="text-xs text-zinc-500 pt-1">
        让 AI 助手（Qoder / Claude 等 MCP 客户端）直接查询抓包数据：在客户端添加 Streamable HTTP 服务器
        <span className="font-mono text-sky-400"> http://127.0.0.1:{mcp.port}/mcp</span>。
        提供 3 个工具：list_flows（列流量）、get_flow（详情）、get_flow_body（请求/响应体）。仅本机可访问。
      </p>
    </div>
  )
}

function AccessControlSection({
  mode,
  ips,
  onSave
}: {
  mode: 'off' | 'allowlist' | 'blocklist'
  ips: string[]
  onSave: (ac: { mode: 'off' | 'allowlist' | 'blocklist'; ips: string[] }) => void
}) {
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState('')

  const inputCls =
    'bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-sky-700'

  const MODES: { key: 'off' | 'allowlist' | 'blocklist'; label: string }[] = [
    { key: 'off', label: '关闭' },
    { key: 'allowlist', label: '白名单' },
    { key: 'blocklist', label: '黑名单' }
  ]

  const add = () => {
    const ip = draft.trim()
    if (!ip) return
    if (!/^[0-9a-fA-F:.]+$/.test(ip)) return setErr('不是合法的 IP 地址')
    if (ips.some((x) => x.toLowerCase() === ip.toLowerCase())) return setErr(`${ip} 已在列表中`)
    setErr('')
    onSave({ mode, ips: [...ips, ip] })
    setDraft('')
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {MODES.map((m) => (
          <button
            key={m.key}
            onClick={() => onSave({ mode: m.key, ips })}
            className={`px-3 py-1 rounded text-sm border ${
              mode === m.key
                ? 'bg-sky-600/25 text-sky-300 border-sky-700/50'
                : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300 border-zinc-800'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      {mode !== 'off' && (
        <>
          {ips.length === 0 && (
            <p className="text-xs text-amber-400/80">列表为空 = 不限制任何客户端</p>
          )}
          {ips.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {ips.map((ip) => (
                <span
                  key={ip}
                  className="flex items-center gap-1.5 bg-zinc-900/60 border border-zinc-800 rounded px-2 py-1 text-sm font-mono text-zinc-300"
                >
                  {ip}
                  <button
                    onClick={() => onSave({ mode, ips: ips.filter((x) => x !== ip) })}
                    className="text-zinc-600 hover:text-red-400 text-xs"
                  >
                    ⨯
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setErr('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add()
              }}
              placeholder={mode === 'allowlist' ? '允许连接的 IP，如 192.168.1.20' : '拒绝连接的 IP，如 192.168.1.20'}
              className={`w-64 ${inputCls}`}
            />
            <button
              onClick={add}
              className="px-3 py-1 rounded text-sm bg-sky-600/20 text-sky-400 hover:bg-sky-600/30"
            >
              添加
            </button>
            {err && <span className="text-xs text-red-400">{err}</span>}
          </div>
        </>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-medium text-zinc-300 mb-3 border-b border-zinc-800 pb-1">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <span className="w-32 shrink-0 text-sm text-zinc-500">{label}</span>
      <div className="flex-1 flex items-center">{children}</div>
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`w-10 h-5 rounded-full relative transition-colors ${checked ? 'bg-sky-600' : 'bg-zinc-700'}`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${checked ? 'left-5' : 'left-0.5'}`}
      />
    </button>
  )
}
