import { app, dialog, shell, BrowserWindow, ipcMain, clipboard } from 'electron'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { ProxyCore } from '@proxy/core'
import { APP_VERSION, toSummary, type IpcChannel, type IpcContract } from '@proxy/shared'

let core: ProxyCore | null = null
let mainWindow: BrowserWindow | null = null

function getDataDir(): string {
  return process.env.PRISM_DATA_DIR ?? join(app.getPath('userData'), 'data')
}

// ---- macOS 系统 CA 信任 ----

function getCaPemPath(): string {
  const dir = join(app.getPath('userData'), 'cert-install')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const p = join(dir, 'ca.pem')
  if (core) writeFileSync(p, core.getCaCertPem())
  return p
}

function isCaTrustedMac(): boolean {
  try {
    execFileSync('security', ['verify-cert', '-c', getCaPemPath()], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** 弹出系统管理员密码框，把 CA 装入 System keychain 并设为信任 */
function installCaUserDomain(pem: string): boolean {
  const keychain = join(process.env.HOME ?? '', 'Library/Keychains/login.keychain-db')
  try {
    execFileSync('security', ['add-trusted-cert', '-r', 'trustRoot', '-k', keychain, pem], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function installCaMac(): { ok: boolean; error?: string } {
  const pem = getCaPemPath()

  // macOS 15+：系统域 add-trusted-cert 即使提权也要求 GUI 交互确认，
  // osascript 提权 shell 无法弹出（"no user interaction was possible"），
  // 用户域信任（login keychain）免密且对本机调试足够，优先使用
  if (installCaUserDomain(pem) && isCaTrustedMac()) {
    return { ok: true }
  }

  const shPath = `'${pem.replace(/'/g, "'\\''")}'`
  const shCmd = `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${shPath}`
  try {
    execFileSync('osascript', [
      '-e',
      `do shell script "${shCmd.replace(/"/g, '\\"')}" with administrator privileges`
    ])
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/cancel|canceled|取消/i.test(msg)) return { ok: false, error: '已取消' }
    const manual = `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain '${pem}'`
    return {
      ok: false,
      error: `自动安装失败（macOS 限制了后台进程修改系统信任设置）。请在「终端」中手动执行：\n${manual}`
    }
  }
}

async function maybePromptCertInstall(): Promise<void> {
  if (process.platform !== 'darwin' || !core || !mainWindow) return
  if (isCaTrustedMac()) return
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '安装 CA 证书',
    message: '检测到 HTTPS 解密用的 CA 证书尚未被 macOS 信任',
    detail:
      '安装后本机浏览器才能无告警访问被解密的 HTTPS 站点。\n' +
      '点击「安装」将把证书加入当前用户钥匙串并设为始终信任（通常无需输入密码）。',
    buttons: ['安装', '暂不'],
    defaultId: 0,
    cancelId: 1
  })
  if (r.response !== 0) return
  const res = installCaMac()
  if (res.ok) {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      message: 'CA 证书已安装并被系统信任'
    })
  } else if (res.error !== '已取消') {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      message: 'CA 证书安装失败',
      detail: res.error
    })
  }
}

// ---- adb（手机 USB 直连，adb reverse 通道管理）----

function adbPath(): string | null {
  const candidates = [
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    '/usr/bin/adb',
    join(process.env.HOME ?? '', 'Library/Android/sdk/platform-tools/adb')
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

function runAdb(args: string[], timeoutMs = 5000): { ok: boolean; out: string; err: string } {
  const adb = adbPath()
  if (!adb) return { ok: false, out: '', err: '未找到 adb（需安装 Android platform-tools）' }
  try {
    const out = execFileSync(adb, args, { timeout: timeoutMs, encoding: 'utf-8' })
    return { ok: true, out: out ?? '', err: '' }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const raw = (e.stderr?.toString() || e.stdout?.toString() || e.message || '')
    const errLine = raw.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? 'adb 执行失败'
    return { ok: false, out: e.stdout?.toString() ?? '', err: errLine }
  }
}

/** adb devices -l 输出 → 已授权设备列表 */
export function parseAdbDevices(out: string): { serial: string; model?: string }[] {
  const devices: { serial: string; model?: string }[] = []
  for (const line of out.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2 || parts[1] !== 'device') continue
    const model = parts.find((p) => p.startsWith('model:'))?.slice('model:'.length)
    devices.push({ serial: parts[0], model: model || undefined })
  }
  return devices
}

/** adb reverse --list 输出 → 已建立的反向通道（每行：transport remote local，remote 为手机侧） */
export function parseAdbReverseList(out: string): { device: string; remote: string }[] {
  const reversed: { device: string; remote: string }[] = []
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 3 && parts[1].startsWith('tcp:') && parts[2].startsWith('tcp:')) {
      reversed.push({ device: parts[0], remote: parts[1] })
    }
  }
  return reversed
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Prism',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

type Handler<K extends IpcChannel> = (payload: IpcContract[K]['req']) => IpcContract[K]['res'] | Promise<IpcContract[K]['res']>

function handle<K extends IpcChannel>(channel: K, handler: Handler<K>): void {
  ipcMain.handle(channel, (_e, payload: IpcContract[K]['req']) => handler(payload))
}

function setupIpc(): void {
  const getCore = (): ProxyCore => {
    if (!core) throw new Error('core not initialized')
    return core
  }

  handle('flows.list', (p) => getCore().listFlows(p ?? {}))
  handle('flows.get', (p) => getCore().getFlow(p.id))
  handle('flows.getBody', (p) => getCore().getBody(p.id, p.part))
  handle('flows.wsMessages', (p) => getCore().getWsMessages(p.id))
  handle('flows.clear', () => getCore().clearFlows())
  handle('flows.codegen', (p) => getCore().codegen(p.id, p.lang))
  handle('collections.list', () => getCore().listCollections())
  handle('collections.addFromFlow', (p) =>
    getCore().addFlowToCollection(p.flowId, p.name, p.group ?? '', p.folderId ?? null)
  )
  handle('collections.remove', (p) => getCore().removeCollection(p.id))
  handle('collections.setFolder', (p) => getCore().setCollectionFolder(p.id, p.folderId))
  handle('collections.importPostman', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入 Postman Collection',
      properties: ['openFile'],
      filters: [{ name: 'Postman Collection', extensions: ['json'] }, { name: '所有文件', extensions: ['*'] }]
    })
    const filePath = result.filePaths[0]
    if (result.canceled || !filePath) return { canceled: true }
    let data: unknown
    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8'))
    } catch (err) {
      return { canceled: false, error: `无法解析文件：${err instanceof Error ? err.message : String(err)}` }
    }
    try {
      return { canceled: false, ...getCore().importPostmanCollection(data) }
    } catch (err) {
      return { canceled: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  handle('collections.importOpenApi', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入 OpenAPI / Swagger（ApiFox / ApiPost 导出）',
      properties: ['openFile'],
      filters: [{ name: 'OpenAPI JSON', extensions: ['json'] }, { name: '所有文件', extensions: ['*'] }]
    })
    const filePath = result.filePaths[0]
    if (result.canceled || !filePath) return { canceled: true }
    let data: unknown
    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8'))
    } catch (err) {
      return { canceled: false, error: `无法解析文件：${err instanceof Error ? err.message : String(err)}` }
    }
    try {
      return { canceled: false, ...getCore().importOpenApiCollection(data) }
    } catch (err) {
      return { canceled: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  handle('collections.importHoppscotch', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入 Hoppscotch Collection',
      properties: ['openFile'],
      filters: [{ name: 'Hoppscotch JSON', extensions: ['json'] }, { name: '所有文件', extensions: ['*'] }]
    })
    const filePath = result.filePaths[0]
    if (result.canceled || !filePath) return { canceled: true }
    let data: unknown
    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8'))
    } catch (err) {
      return { canceled: false, error: `无法解析文件：${err instanceof Error ? err.message : String(err)}` }
    }
    try {
      return { canceled: false, ...getCore().importHoppscotchCollection(data) }
    } catch (err) {
      return { canceled: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  handle('workbench.nodes', () => getCore().listWorkbench())
  handle('workbench.createFolder', (p) =>
    getCore().createWbFolder(p.scope, p.name, p.parentId ?? null)
  )
  handle('workbench.createBookmark', (p) =>
    getCore().createWbBookmark(p.name, p.filter, p.parentId ?? null)
  )
  handle('workbench.renameNode', (p) => getCore().renameWbNode(p.id, p.name))
  handle('workbench.removeNode', (p) => getCore().removeWbNode(p.id))
  handle('workbench.moveNode', (p) => getCore().moveWbNode(p.id, p.parentId))
  handle('flows.exportHar', async (p) => {
    const { har } = getCore().exportHar(p ?? {})
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const result = await dialog.showSaveDialog({
      title: '导出 HAR',
      defaultPath: `capture-${stamp}.har`,
      filters: [{ name: 'HAR', extensions: ['har'] }, { name: '所有文件', extensions: ['*'] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    writeFileSync(result.filePath, JSON.stringify(har, null, 2))
    return { saved: true, path: result.filePath }
  })
  handle('flows.importHar', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入 HAR',
      properties: ['openFile'],
      filters: [{ name: 'HAR', extensions: ['har', 'json'] }, { name: '所有文件', extensions: ['*'] }]
    })
    const filePath = result.filePaths[0]
    if (result.canceled || !filePath) return { canceled: true }
    let har: unknown
    try {
      har = JSON.parse(readFileSync(filePath, 'utf-8'))
    } catch (err) {
      return { canceled: false, error: `无法解析文件：${err instanceof Error ? err.message : String(err)}` }
    }
    try {
      return { canceled: false, ...getCore().importHar(har) }
    } catch (err) {
      return { canceled: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  handle('app.settings.get', () => getCore().getSettings())
  handle('app.settings.set', (p) => getCore().setSettings(p))
  handle('mcp.info', () => getCore().getMcpInfo())
  handle('app.clipboard.writeText', (p) => {
    clipboard.writeText(p.text)
    return { ok: true as const }
  })
  handle('app.clipboard.readText', () => ({ text: clipboard.readText() }))
  handle('app.readFileBase64', (p) => {
    try {
      return { ok: true as const, base64: readFileSync(p.path).toString('base64') }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  handle('app.pickFile', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择文件',
      properties: ['openFile'],
      filters: [
        {
          name: '常用映射文件',
          extensions: ['json', 'js', 'mjs', 'html', 'htm', 'css', 'txt', 'xml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'wasm', 'pdf', 'mp4', 'webm', 'mp3', 'woff', 'woff2']
        },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    const filePath = result.filePaths[0]
    if (result.canceled || !filePath) return { canceled: true }
    return { canceled: false, filePath }
  })
  handle('app.saveFile', async (p) => {
    const result = await dialog.showSaveDialog({
      title: p.title ?? '保存文件',
      defaultPath: p.defaultPath
    })
    if (result.canceled || !result.filePath) return { saved: false }
    try {
      writeFileSync(result.filePath, Buffer.from(p.base64, 'base64'))
      return { saved: true, path: result.filePath }
    } catch (err) {
      return { saved: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  handle('app.info', () => getCore().info())
  handle('cert.info', () => getCore().getCertInfo())
  handle('cert.export', async () => {
    const c = getCore()
    const result = await dialog.showSaveDialog({
      title: '导出 CA 证书',
      defaultPath: 'proxy-ca.crt',
      filters: [{ name: '证书', extensions: ['crt', 'pem'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    writeFileSync(result.filePath, c.getCaCertDer())
    return { canceled: false, path: result.filePath }
  })
  handle('cert.checkTrust', () => {
    if (process.platform !== 'darwin') return { supported: false, trusted: false }
    return { supported: true, trusted: isCaTrustedMac() }
  })
  handle('cert.installSystem', () => {
    if (process.platform !== 'darwin') {
      return { ok: false, trusted: false, error: '仅支持 macOS' }
    }
    const res = installCaMac()
    return { ok: res.ok, trusted: isCaTrustedMac(), error: res.error }
  })
  handle('proxy.restart', async () => {
    const c = getCore()
    await c.restart()
    return { ok: true as const, port: c.info().proxyPort }
  })
  handle('adb.status', () => {
    const r = runAdb(['devices', '-l'])
    if (!r.ok) return { available: false, error: r.err, devices: [], reversed: [] }
    const rl = runAdb(['reverse', '--list'])
    return {
      available: true,
      devices: parseAdbDevices(r.out),
      reversed: rl.ok ? parseAdbReverseList(rl.out) : []
    }
  })
  handle('adb.reverse', (p) => {
    const r = runAdb(['reverse', `tcp:${p.port}`, `tcp:${p.port}`])
    return r.ok ? { ok: true } : { ok: false, error: r.err }
  })
  handle('adb.unreverse', (p) => {
    const r = runAdb(['reverse', '--remove', `tcp:${p.port}`])
    return r.ok ? { ok: true } : { ok: false, error: r.err }
  })
  handle('breakpoints.list', () => getCore().listBreakpoints())
  handle('breakpoints.setRules', (p) => getCore().setBreakpointRules(p.rules))
  handle('breakpoints.resolve', (p) => getCore().resolveBreakpoint(p.flowId, p.phase, p.edit))
  handle('composer.send', (p) => getCore().sendComposerRequest(p.spec))
  handle('composer.codegen', (p) => getCore().composerCodegen(p.spec, p.lang))
  handle('composer.history', () => getCore().listComposerHistory())
  handle('composer.clearHistory', () => getCore().clearComposerHistory())
  handle('composer.envs', () => getCore().listComposerEnvs())
  handle('composer.setEnvs', (p) => getCore().setComposerEnvs(p.envs, p.activeName))
  handle('composer.cookies', () => getCore().listComposerCookies())
  handle('composer.setCookies', (p) => getCore().setComposerCookies(p.cookies))
  handle('flows.setMeta', (p) => getCore().setFlowMeta(p.id, p.label, p.note))
  handle('flows.repeat', (p) => getCore().repeatFlow(p.id, p.count, p.intervalMs ?? 0))
  handle('rules.list', () => getCore().listRules())
  handle('rules.set', (p) => getCore().setRules(p.rules))
  handle('rules.matchPreview', (p) => getCore().ruleMatchPreview(p.rule))
  handle('plugins.list', () => getCore().listPlugins())
  handle('plugins.setEnabled', (p) => getCore().setPluginEnabled(p.name, p.enabled))
  handle('plugins.reload', () => getCore().reloadPlugins())
  handle('plugins.create', (p) => getCore().createPlugin(p.name, p.type))
  handle('plugins.openDir', () => {
    void shell.openPath(getCore().getPluginsDir())
    return { ok: true as const }
  })
  handle('plugins.logs', () => getCore().getPluginLogs())
  handle('plugins.decodeFlow', (p) => getCore().decodeFlowWithPlugins(p.id))
}

function pushEvents(): void {
  if (!core) return
  core.onFlow((flows) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('flow', flows.map((f) => toSummary(f)))
    }
  })
  core.onLog((level, message) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('log', { level, message })
    }
  })
  core.onBreakpoint((hits) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('breakpoint', hits)
    }
  })
  core.onPluginLog((line) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('plugin-log', line)
    }
  })
}

void app.whenReady().then(async () => {
  core = new ProxyCore({ dataDir: getDataDir(), version: APP_VERSION })
  setupIpc()
  pushEvents()
  try {
    await core.start()
  } catch (err) {
    console.error('proxy start failed:', err)
  }
  createWindow()

  // 启动时检测 CA 未信任则自动弹窗引导安装（每启动一次最多一次）
  void maybePromptCertInstall()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  core?.close()
})

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
})
