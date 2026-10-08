import { beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { ComposerSpec, Flow } from '@proxy/shared'
import type { ComposerDraft, KV } from '../src/stores/composer'
const sentSpecs: ComposerSpec[] = []
const codegenSpecs: ComposerSpec[] = []
const flowsGetQueue: Array<Flow | undefined> = []
/** app.readFileBase64 桩返回的文件内容（0-255 全字节，验证二进制安全） */
const fileBase64: string = btoa(String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i)))
let store: typeof import('../src/stores/composer')

const emptyDraft: ComposerDraft = {
  method: 'GET',
  url: 'http://x.test/api',
  params: [],
  headers: [],
  bodyType: 'none',
  bodyText: '',
  bodyForm: [],
  bodyFilePath: null,
  auth: { type: 'none' }
}

function makeFlow(headers: Array<{ name: string; value: string }>): Flow {
  return {
    id: 'f1',
    seq: 1,
    kind: 'http',
    state: 'done',
    clientIp: '127.0.0.1',
    clientPort: 1,
    tls: false,
    mitm: false,
    request: {
      method: 'GET',
      url: 'http://x.test/api',
      httpVersion: 'HTTP/1.1',
      headers,
      body: { size: 0, contentType: '', stored: 'none' }
    },
    timing: { start: 0 },
    size: { reqHeader: 0, reqBody: 0, respHeader: 0, respBody: 0, total: 0 },
    flags: [],
    createdAt: 0
  }
}

/** 把当前活动 tab 的 draft 换成指定值（其余状态保留） */
function setDraft(draft: ComposerDraft): void {
  const s = store.useComposerStore.getState()
  store.useComposerStore.setState({
    tabs: s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, draft } : t))
  })
}

function activeDraft(): ComposerDraft {
  return store.activeTabOf(store.useComposerStore.getState()).draft
}

beforeAll(async () => {
  ;(globalThis as { api?: unknown }).api = {
    invoke: async (channel: string, payload: unknown) => {
      switch (channel) {
        case 'composer.send':
          sentSpecs.push((payload as { spec: ComposerSpec }).spec)
          return { flowId: 'flow-1' }
        case 'composer.codegen':
          codegenSpecs.push((payload as { spec: ComposerSpec; lang: string }).spec)
          return { code: 'generated' }
        case 'composer.cookies':
          return { cookies: [] }
        case 'composer.setCookies':
          return { cookies: (payload as { cookies: unknown[] }).cookies }
        case 'composer.history':
          return { history: [] }
        case 'flows.get':
          return { flow: flowsGetQueue.shift() }
        case 'flows.getBody':
          return { body: null }
        case 'app.readFileBase64':
          return { ok: true, base64: fileBase64 }
        default:
          return {}
      }
    },
    on: () => () => {}
  }
  // 渲染进程没有全局 Buffer；store 代码（含 multipart/base64 组包）必须纯浏览器 API
  store = await import('../src/stores/composer')
})

describe('Composer 授权 tab', () => {
  it('bearer 注入 Authorization 并覆盖请求头表格同名头', async () => {
    store.useComposerStore.setState({ envs: [], activeEnvName: null })
    setDraft({
      ...emptyDraft,
      headers: [
        { key: 'Authorization', value: 'Bearer old', enabled: true },
        { key: 'X-Keep', value: '1', enabled: true }
      ],
      auth: { type: 'bearer', token: 'new-token' }
    })
    await store.useComposerStore.getState().send()
    expect(store.useComposerStore.getState().sendError).toBeNull()
    expect(sentSpecs.at(-1)!.headers).toEqual([
      { name: 'X-Keep', value: '1' },
      { name: 'Authorization', value: 'Bearer new-token' }
    ])
  })

  it('basic 编码 user:pass 且支持 {{var}} 替换', async () => {
    store.useComposerStore.setState({
      envs: [{ name: 'dev', vars: { user: 'alice', pass: 's3cret' } }],
      activeEnvName: 'dev'
    })
    setDraft({ ...emptyDraft, auth: { type: 'basic', user: '{{user}}', pass: '{{pass}}' } })
    await store.useComposerStore.getState().send()
    expect(store.useComposerStore.getState().sendError).toBeNull()
    expect(sentSpecs.at(-1)!.headers).toContainEqual({
      name: 'Authorization',
      value: `Basic ${store.utf8ToBase64('alice:s3cret')}`
    })
  })

  it('custom 注入自定义头，json body 的自动 Content-Type 不受影响', async () => {
    store.useComposerStore.setState({
      envs: [{ name: 'dev', vars: { user: 'alice', pass: 's3cret' } }],
      activeEnvName: 'dev'
    })
    setDraft({
      ...emptyDraft,
      bodyType: 'json',
      bodyText: '{"a":1}',
      auth: { type: 'custom', headerKey: 'X-Api-Key', headerValue: '{{user}}' }
    })
    await store.useComposerStore.getState().send()
    expect(store.useComposerStore.getState().sendError).toBeNull()
    expect(sentSpecs.at(-1)!.headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Api-Key', value: 'alice' }
    ])
  })

  it('空 token 不注入（授权 tab 静默不生效）', async () => {
    store.useComposerStore.setState({ envs: [], activeEnvName: null })
    setDraft({ ...emptyDraft, auth: { type: 'bearer', token: '   ' } })
    await store.useComposerStore.getState().send()
    expect(store.useComposerStore.getState().sendError).toBeNull()
    expect(sentSpecs.at(-1)!.headers).toEqual([])
  })

  it('从流量回填时识别 Bearer/Basic 并从请求头表格移除，且开新 tab', async () => {
    const before = store.useComposerStore.getState().tabs.length
    flowsGetQueue.push(
      makeFlow([
        { name: 'Host', value: 'x.test' },
        { name: 'Authorization', value: `Basic ${store.utf8ToBase64('u:p')}` }
      ])
    )
    await store.useComposerStore.getState().loadFromFlow('f1')
    expect(store.useComposerStore.getState().tabs.length).toBe(before + 1)
    const d = activeDraft()
    expect(d.auth).toEqual({ type: 'basic', user: 'u', pass: 'p' })
    expect(d.headers).toEqual([])

    flowsGetQueue.push(makeFlow([{ name: 'Authorization', value: 'Bearer abc.def' }]))
    await store.useComposerStore.getState().loadFromFlow('f2')
    const d2 = activeDraft()
    expect(d2.auth).toEqual({ type: 'bearer', token: 'abc.def' })
    expect(d2.headers).toEqual([])
  })

  it('无法识别的 Authorization 方案留在请求头表格', async () => {
    flowsGetQueue.push(makeFlow([{ name: 'Authorization', value: 'Digest realm="x"' }]))
    await store.useComposerStore.getState().loadFromFlow('f3')
    const d = activeDraft()
    expect(d.auth).toEqual({ type: 'none' })
    expect(d.headers.map((h) => h.key)).toEqual(['Authorization'])
  })
})

describe('Composer 多 tab', () => {
  it('newTab 新建空白 tab 并激活，原 tab 草稿保留', () => {
    setDraft({ ...emptyDraft, url: 'http://a.test/' })
    const before = store.useComposerStore.getState()
    const firstId = before.activeTabId
    before.newTab()
    const after = store.useComposerStore.getState()
    expect(after.tabs.length).toBe(before.tabs.length + 1)
    expect(after.activeTabId).not.toBe(firstId)
    expect(after.tabs.find((t) => t.id === firstId)!.draft.url).toBe('http://a.test/')
    expect(activeDraft().url).toBe('https://')
  })

  it('switchTab 切回后草稿还在，setDraft 只改活动 tab', () => {
    const s = store.useComposerStore.getState()
    const blankId = s.activeTabId
    s.switchTab(s.tabs.find((t) => t.id !== blankId)!.id)
    store.useComposerStore.getState().setDraft({ method: 'POST' })
    expect(activeDraft().method).toBe('POST')
    store.useComposerStore.getState().switchTab(blankId)
    expect(activeDraft().method).toBe('GET')
  })

  it('closeTab 关活动 tab 激活邻位；最后一个关闭回退新空白', () => {
    const s = store.useComposerStore.getState()
    s.closeTab(s.activeTabId)
    const after = store.useComposerStore.getState()
    expect(after.tabs.length).toBe(s.tabs.length - 1)
    expect(after.tabs.some((t) => t.id === after.activeTabId)).toBe(true)

    // 关到只剩一个再关：应回退为一个新空白 tab
    while (store.useComposerStore.getState().tabs.length > 1) {
      const cur = store.useComposerStore.getState()
      cur.closeTab(cur.tabs.find((t) => t.id !== cur.activeTabId)!.id)
    }
    const one = store.useComposerStore.getState()
    one.closeTab(one.activeTabId)
    const final = store.useComposerStore.getState()
    expect(final.tabs).toHaveLength(1)
    expect(final.tabs[0].draft.url).toBe('https://')
  })
})

describe('Composer KV 文本模式', () => {
  const rows: KV[] = [
    { key: 'accept-language', value: 'zh-CN, zh;q=0.9', enabled: true },
    { key: 'x-debug', value: '1', enabled: false }
  ]

  it('KV 行 → 文本 → KV 行 roundtrip 无损（# 前缀停用）', () => {
    const text = store.kvTextOf(rows, ':')
    expect(text).toBe('accept-language:zh-CN, zh;q=0.9\n#x-debug:1')
    expect(store.parseKvText(text, ':')).toEqual(rows)
  })

  it('值含分隔符只在第一个处切分；# 停用行解析正确；空行跳过', () => {
    expect(store.parseKvText('a=b=c\n\n#d=e\nf', '=')).toEqual([
      { key: 'a', value: 'b=c', enabled: true },
      { key: 'd', value: 'e', enabled: false },
      { key: 'f', value: '', enabled: true }
    ])
  })

  it('文本模式编辑实时同步到请求头（发送生效）', async () => {
    store.useComposerStore.setState({ envs: [], activeEnvName: null })
    const s = store.useComposerStore.getState()
    s.newTab()
    store.useComposerStore.getState().setDraft({ headers: store.parseKvText('X-A: 1\n#X-B: 2', ':') })
    await store.useComposerStore.getState().send()
    expect(sentSpecs.at(-1)!.headers).toEqual([{ name: 'X-A', value: '1' }])
  })
})

describe('Composer 重置 / 清除', () => {
  it('resetTab 清空当前 tab 草稿，其它 tab 不动', () => {
    const s = store.useComposerStore.getState()
    s.newTab()
    const dirtyId = store.useComposerStore.getState().activeTabId
    store.useComposerStore.getState().setDraft({ url: 'http://dirty.test/x', headers: [{ key: 'X-A', value: '1', enabled: true }] })
    const otherId = store.useComposerStore.getState().tabs.find((t) => t.id !== dirtyId)!.id
    store.useComposerStore.getState().switchTab(otherId)
    store.useComposerStore.getState().setDraft({ url: 'http://keep.test/' })
    store.useComposerStore.getState().switchTab(dirtyId)
    store.useComposerStore.getState().resetTab()
    const after = store.useComposerStore.getState()
    expect(activeDraft().url).toBe('https://')
    expect(activeDraft().headers).toEqual([])
    expect(after.tabs.find((t) => t.id === otherId)!.draft.url).toBe('http://keep.test/')
  })

  it('clearTabs 全部关闭并回到单个空白 tab', () => {
    store.useComposerStore.getState().newTab()
    store.useComposerStore.getState().clearTabs()
    const s = store.useComposerStore.getState()
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].draft.url).toBe('https://')
    expect(s.activeTabId).toBe(s.tabs[0].id)
  })
})

describe('Composer 导入报文', () => {
  it('解析请求行 + 头 + body（Host 头拼 URL，CRLF 兼容）', () => {
    const d = store.parseRawHttp(
      'POST /api/user?id=1 HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\nAuthorization: Bearer tok\r\n\r\n{"a":1}'
    )
    expect(d).not.toBeNull()
    expect(d!.method).toBe('POST')
    expect(d!.url).toBe('http://example.com/api/user?id=1')
    expect(d!.params).toEqual([{ key: 'id', value: '1', enabled: true }])
    expect(d!.bodyType).toBe('json')
    expect(d!.bodyText).toBe('{\n  "a": 1\n}')
    expect(d!.auth).toEqual({ type: 'bearer', token: 'tok' })
  })

  it('绝对 URL 请求行直接用；缺 Host 且无绝对 URL 返回 null', () => {
    const d = store.parseRawHttp('GET https://x.test/a\nX-B: 1\n')
    expect(d!.url).toBe('https://x.test/a')
    expect(store.parseRawHttp('GET /only-path\nX-B: 1\n')).toBeNull()
  })
})

describe('Composer 导入 cURL', () => {
  it('解析 -X/-H/-d：data 自动 POST 与 urlencoded Content-Type', () => {
    const d = store.parseCurl(
      `curl -X POST 'https://api.test/login' \\\n  -H 'Accept: application/json' \\\n  -d 'user=a&pass=b'`
    )
    expect(d).not.toBeNull()
    expect(d!.method).toBe('POST')
    expect(d!.url).toBe('https://api.test/login')
    expect(d!.headers.find((h) => h.key === 'Accept')!.value).toBe('application/json')
    expect(d!.bodyType).toBe('urlencode')
    expect(d!.bodyForm).toEqual([
      { key: 'user', value: 'a', enabled: true },
      { key: 'pass', value: 'b', enabled: true }
    ])
  })

  it('-H JSON 头时 data 为 json；-u 映射 basic 授权；-b 映射 Cookie 头', () => {
    const d = store.parseCurl(
      `curl 'https://api.test/v1' -H 'Content-Type: application/json' -u 'alice:s3cret' -b 'sid=42' --data-raw '{"a":1}'`
    )
    expect(d!.bodyType).toBe('json')
    expect(d!.bodyText).toBe('{\n  "a": 1\n}')
    expect(d!.auth).toEqual({ type: 'basic', user: 'alice', pass: 's3cret' })
    expect(d!.headers.find((h) => h.key === 'Cookie')!.value).toBe('sid=42')
  })

  it('无 data 默认 GET；裸域名补 https；非 curl 命令返回 null', () => {
    const d = store.parseCurl(`curl api.test/health`)
    expect(d!.method).toBe('GET')
    expect(d!.url).toBe('https://api.test/health')
    expect(store.parseCurl('wget http://x.test')).toBeNull()
  })
})

describe('Composer Cookie 注入', () => {
  it('域匹配（子域/点前缀）注入 Cookie 头，显式 Cookie 头不被覆盖', async () => {
    store.useComposerStore.setState({
      envs: [],
      activeEnvName: null,
      cookies: [
        { domain: 'api.test', name: 'sid', value: '42', enabled: true },
        { domain: '.other.test', name: 'x', value: '1', enabled: true },
        { domain: 'api.test', name: 'off', value: '2', enabled: false }
      ]
    })
    const s = store.useComposerStore.getState()
    s.newTab()
    store.useComposerStore.getState().setDraft({ url: 'https://api.test/v1', headers: [{ key: 'X-A', value: '1', enabled: true }] })
    await store.useComposerStore.getState().send()
    expect(sentSpecs.at(-1)!.headers).toEqual([
      { name: 'X-A', value: '1' },
      { name: 'Cookie', value: 'sid=42' }
    ])

    // 显式 Cookie 头优先
    store.useComposerStore.getState().setDraft({
      headers: [{ key: 'Cookie', value: 'manual=1', enabled: true }]
    })
    await store.useComposerStore.getState().send()
    expect(sentSpecs.at(-1)!.headers).toEqual([{ name: 'Cookie', value: 'manual=1' }])

    // 子域匹配
    store.useComposerStore.getState().setDraft({
      url: 'https://sub.other.test/',
      headers: []
    })
    await store.useComposerStore.getState().send()
    expect(sentSpecs.at(-1)!.headers).toEqual([{ name: 'Cookie', value: 'x=1' }])

    store.useComposerStore.setState({ cookies: [] })
  })
})

describe('Composer 生成代码（buildSpec 复用）', () => {
  it('codegen 走与 send 相同的 spec 构建（变量替换 + 授权头 + body）', async () => {
    store.useComposerStore.setState({
      envs: [{ name: 'dev', vars: { host2: 'api.test' } }],
      activeEnvName: 'dev',
      cookies: []
    })
    const s = store.useComposerStore.getState()
    s.newTab()
    store.useComposerStore.getState().setUrl('https://{{host2}}/v1?x=1')
    store.useComposerStore.getState().setDraft({
      method: 'POST',
      bodyType: 'json',
      bodyText: '{"a":1}',
      auth: { type: 'bearer', token: 'tok' }
    })
    const code = await store.useComposerStore.getState().codegen('curl')
    expect(code).toBe('generated')
    const spec = codegenSpecs.at(-1)!
    expect(spec.method).toBe('POST')
    expect(spec.url).toBe('https://api.test/v1?x=1')
    expect(spec.headers).toContainEqual({ name: 'Content-Type', value: 'application/json' })
    expect(spec.headers).toContainEqual({ name: 'Authorization', value: 'Bearer tok' })
    expect(store.base64ToUtf8(spec.bodyBase64)).toBe('{"a":1}')
  })
})

describe('Composer 渲染层字节安全（无 Buffer 环境）', () => {
  it('store 源码不出现 Node Buffer（渲染进程无全局 Buffer，静态守卫）', async () => {
    const src = await readFile(new URL('../src/stores/composer.ts', import.meta.url), 'utf8')
    const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
    expect(noComments).not.toMatch(/\bBuffer\b/)
  })

  it('form-data multipart：文本行 + 二进制文件行 base64 组包无损', async () => {
    store.useComposerStore.setState({ envs: [], activeEnvName: null, cookies: [] })
    const s = store.useComposerStore.getState()
    s.newTab()
    store.useComposerStore.getState().setDraft({
      method: 'POST',
      url: 'https://api.test/upload',
      bodyType: 'form-data',
      bodyForm: [
        { key: 'name', value: '文件名测试', enabled: true },
        { key: 'file', value: '', enabled: true, isFile: true, filePath: '/tmp/x.bin' }
      ]
    })
    await store.useComposerStore.getState().send()
    const spec = sentSpecs.at(-1)!
    const ct = spec.headers.find((h) => h.name.toLowerCase() === 'content-type')!
    expect(ct.value).toMatch(/^multipart\/form-data; boundary=/)
    const bin = atob(spec.bodyBase64)
    expect(bin).toContain('Content-Disposition: form-data; name="name"')
    // bin 是字节串（每字符一字节），中文按 UTF-8 字节序列比对
    const utf8Bin = (t: string): string => String.fromCharCode(...new TextEncoder().encode(t))
    expect(bin).toContain(utf8Bin('文件名测试'))
    expect(bin).toContain('Content-Disposition: form-data; name="file"; filename="x.bin"')
    // 二进制行 0-255 全字节无损
    for (let i = 0; i < 256; i++) {
      if (!bin.includes(String.fromCharCode(i))) throw new Error(`byte ${i} lost in multipart`)
    }
  })

  it('urlencode body 走纯浏览器 API 编码（无 Buffer）', async () => {
    const s = store.useComposerStore.getState()
    s.newTab()
    store.useComposerStore.getState().setDraft({
      method: 'POST',
      url: 'https://api.test/form',
      bodyType: 'urlencode',
      bodyForm: [{ key: '中文', value: '值 & =1', enabled: true }]
    })
    await store.useComposerStore.getState().send()
    expect(store.base64ToUtf8(sentSpecs.at(-1)!.bodyBase64)).toBe(
      `${encodeURIComponent('中文')}=${encodeURIComponent('值 & =1')}`
    )
  })
})

