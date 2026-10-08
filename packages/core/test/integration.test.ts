import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as http from 'node:http'
import * as http2 from 'node:http2'
import * as https from 'node:https'
import * as net from 'node:net'
import * as tls from 'node:tls'
import * as zlib from 'node:zlib'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { generateKeyPairSync } from 'node:crypto'
import { spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { ProxyCore } from '../src/index'
import type { ComposerEnv, Rule } from '@proxy/shared'

let dataDir: string
let core: ProxyCore
let upstreamHttp: http.Server
let upstreamHttps: https.Server
let httpPort = 0
let httpsPort = 0
let upstreamTlsKeyPem = ''
let upstreamTlsCertPem = ''

const upstreamFlows: { method: string; url: string; body: string; headers: Record<string, string | string[]> }[] = []

async function startUpstreams(): Promise<void> {
  const handler: http.RequestListener = (req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const headers: Record<string, string | string[]> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined) headers[k] = v
      }
      upstreamFlows.push({ method: req.method ?? '', url: req.url ?? '', body, headers })
    if (req.url?.startsWith('/gzip')) {
      const payload = zlib.gzipSync(Buffer.from(JSON.stringify({ hello: 'world', big: 'x'.repeat(1000) })))
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' })
      res.end(payload)
    } else if (req.url?.startsWith('/echo')) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`echo:${body}`)
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, url: req.url }))
    }
  })
}

  await new Promise<void>((resolve) => {
    upstreamHttp = http.createServer(handler)
    upstreamHttp.listen(0, '127.0.0.1', () => {
      httpPort = (upstreamHttp.address() as { port: number }).port
      resolve()
    })
  })

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
  // self-signed cert via forge through core's export would be circular; use openssl-free approach:
  // simple tls server with a cert signed at runtime is complex; instead reuse forge from node_modules
  const forge = (await import('node-forge')).default
  const key = forge.pki.privateKeyFromPem(privateKey)
  const pub = forge.pki.publicKeyFromPem(publicKey)
  const cert = forge.pki.createCertificate()
  cert.publicKey = pub
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(Date.now() - 86400000)
  cert.validity.notAfter = new Date(Date.now() + 86400000 * 30)
  cert.setSubject([{ shortName: 'CN', value: 'localhost' }])
  cert.setIssuer([{ shortName: 'CN', value: 'localhost' }])
  cert.setExtensions([
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' }
      ]
    }
  ])
  cert.sign(key, forge.md.sha256.create())

  upstreamTlsKeyPem = privateKey
  upstreamTlsCertPem = forge.pki.certificateToPem(cert)
  await new Promise<void>((resolve) => {
    upstreamHttps = https.createServer({ key: privateKey, cert: forge.pki.certificateToPem(cert) }, handler)
    upstreamHttps.listen(0, '127.0.0.1', () => {
      httpsPort = (upstreamHttps.address() as { port: number }).port
      resolve()
    })
  })
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'proxy-core-test-'))
  await startUpstreams()
  core = new ProxyCore({ dataDir })
  const proxyPort = await getFreePort()
  const socksPort = await getFreePort()
  core.setSettings({ proxy: { port: proxyPort, bindAddress: '127.0.0.1', socksPort, upstream: { enabled: false, protocol: 'http', host: '127.0.0.1', port: 7890 } }, tls: { rejectUpstream: false } as never })
  await core.start()
})

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

afterAll(async () => {
  await core.stop()
  core.close()
  upstreamHttp.close()
  upstreamHttps.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('ProxyCore integration', () => {
  it('captures plain HTTP proxy requests', async () => {
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/hello?x=1`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; url: string }
    expect(json.ok).toBe(true)
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: `host:127.0.0.1 path:/hello` })
    expect(flows.length).toBeGreaterThan(0)
    expect(flows[0].method).toBe('GET')
    expect(flows[0].status).toBe(200)
  })

  it('captures request bodies (POST echo)', async () => {
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello-body'
    })
    expect(await res.text()).toBe('echo:hello-body')
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: `path:/echo` })
    expect(flows.length).toBeGreaterThan(0)
    const id = flows[0].id
    const { body } = core.getBody(id, 'req')
    expect(body?.text).toBe('hello-body')
  })

  it('decodes gzip responses', async () => {
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/gzip`)
    const json = (await res.json()) as { hello: string }
    expect(json.hello).toBe('world')
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/gzip' })
    expect(flows.length).toBeGreaterThan(0)
    const { body } = core.getBody(flows[0].id, 'resp')
    expect(body?.text).toContain('"hello":"world"')
  })

  it('MITMs HTTPS CONNECT tunnels', async () => {
    const res = await fetchViaProxy(`https://localhost:${httpsPort}/secure?token=abc`, undefined, true)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean }
    expect(json.ok).toBe(true)
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/secure' })
    expect(flows.length).toBeGreaterThan(0)
    expect(flows[0].mitm).toBe(true)
    expect(flows[0].tls).toBe(true)
  })

  it('negotiates HTTP/2 with the client via ALPN and captures the flow', async () => {
    const proxyPort = core.info().proxyPort
    const ca = readFileSync(join(dataDir, 'certs', 'ca.pem'), 'utf8')
    const sock = net.connect(proxyPort, '127.0.0.1')
    await new Promise<void>((resolve) => sock.once('connect', resolve))
    sock.write(`CONNECT localhost:${httpsPort} HTTP/1.1\r\nHost: localhost:${httpsPort}\r\n\r\n`)
    let connectHeader = ''
    while (!connectHeader.endsWith('\r\n\r\n')) {
      const chunk = await new Promise<Buffer>((resolve, reject) => {
        sock.once('data', (d: Buffer) => resolve(d))
        sock.once('error', reject)
      })
      connectHeader += chunk.toString('latin1')
    }
    expect(connectHeader).toContain('200')

    const tlsSock = tls.connect({
      socket: sock,
      servername: 'localhost',
      ALPNProtocols: ['h2'],
      ca,
      rejectUnauthorized: true
    })
    await new Promise<void>((resolve, reject) => {
      tlsSock.once('secureConnect', resolve)
      tlsSock.once('error', reject)
    })
    expect(tlsSock.alpnProtocol).toBe('h2')

    const session = http2.connect(`https://localhost:${httpsPort}`, { createConnection: () => tlsSock })
    session.on('error', () => {})
    const req = session.request({
      ':method': 'POST',
      ':path': '/h2-test',
      'content-type': 'application/json'
    })
    req.end(JSON.stringify({ h2: true }))
    const respHeaders = await new Promise<http2.IncomingHttpHeaders>((resolve, reject) => {
      req.once('response', (h) => resolve(h))
      req.once('error', reject)
    })
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    session.close()

    expect(respHeaders[':status']).toBe(200)
    expect(JSON.parse(body)).toEqual({ ok: true, url: '/h2-test' })

    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/h2-test' })
    expect(flows.length).toBe(1)
    const full = core.getFlow(flows[0].id).flow!
    expect(full.mitm).toBe(true)
    expect(full.tls).toBe(true)
    expect(full.request!.httpVersion).toBe('2.0')
    expect(full.request!.method).toBe('POST')
    expect(full.request!.headers.some((h) => h.name.startsWith(':'))).toBe(false)
    expect(full.request!.headers.some((h) => h.name.toLowerCase() === 'host')).toBe(true)
    expect(full.response!.status).toBe(200)
    const reqBody = core.getBody(flows[0].id, 'req').body
    expect(reqBody?.text).toBe(JSON.stringify({ h2: true }))
  })

  it('snapshots a flow into a collection and lists it', async () => {
    const payload = JSON.stringify({ save: 'me' })
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/collect-me`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload
    })
    expect(res.status).toBe(200)
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/collect-me' })
    expect(flows.length).toBeGreaterThan(0)

    const { items } = core.addFlowToCollection(flows[0].id)
    expect(items.length).toBe(1)
    const item = items[0]
    expect(item.request.method).toBe('POST')
    expect(item.request.url).toContain('/collect-me')
    expect(item.request.headers.some((h) => h.name.toLowerCase() === 'host')).toBe(false)
    expect(Buffer.from(item.request.bodyBase64, 'base64').toString()).toBe(payload)
    expect(item.response).toBeDefined()
    expect(item.response!.status).toBe(200)
    const respBody = Buffer.from(item.response!.bodyBase64, 'base64').toString()
    expect(JSON.parse(respBody)).toEqual({ ok: true, url: '/collect-me' })

    // 列表与删除
    expect(core.listCollections().items.length).toBe(1)
    const { items: afterRemove } = core.removeCollection(item.id)
    expect(afterRemove.length).toBe(0)
    expect(core.listCollections().items.length).toBe(0)
  })

  it('persists collections across restart', async () => {
    await fetchViaProxy(`http://127.0.0.1:${httpPort}/collect-keep`)
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/collect-keep' })
    core.addFlowToCollection(flows[0].id)
    await core.stop()
    await core.start()
    expect(core.listCollections().items.length).toBe(1)
    core.removeCollection(core.listCollections().items[0].id)
  })

  it('serves CA cert page at cert.local', async () => {
    const res = await fetchViaProxy('http://cert.local/')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('download')
    const dl = await fetchViaProxy('http://cert.local/download')
    expect(dl.status).toBe(200)
    const buf = Buffer.from(await dl.arrayBuffer())
    expect(buf.length).toBeGreaterThan(100)
  })

  it('generates replay code in all languages', async () => {
    const payload = JSON.stringify({ hello: 'codegen', n: 42 })
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/echo?lang=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload
    })
    expect(res.status).toBe(200)
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/echo' })
    const target = flows.find((f) => f.url?.includes('lang=1'))
    expect(target).toBeTruthy()

    const curl = core.codegen(target!.id, 'curl').code
    expect(curl).toContain('curl -X POST')
    expect(curl).toContain('/echo?lang=1')
    expect(curl).toContain(`--data-raw '${payload}'`)
    expect(curl).not.toContain('host:')
    expect(curl).not.toContain('content-length')

    const py = core.codegen(target!.id, 'python').code
    expect(py).toContain('import requests')
    expect(py).toContain(`url = "http://127.0.0.1:${httpPort}/echo?lang=1"`)
    expect(py).toContain('json_body = {')
    expect(py).toContain('"hello": "codegen"')
    expect(py).toContain('requests.request("POST", url')

    const fetchCode = core.codegen(target!.id, 'fetch').code
    expect(fetchCode).toContain('fetch("http://')
    expect(fetchCode).toContain('method: "POST"')
    expect(fetchCode).toContain('JSON.stringify({')

    const axios = core.codegen(target!.id, 'axios').code
    expect(axios).toContain("import axios from 'axios'")
    expect(axios).toContain('url: "http://')
    expect(axios).toContain('data: {')

    const go = core.codegen(target!.id, 'go').code
    expect(go).toContain('package main')
    expect(go).toContain('http.NewRequest("POST",')
    expect(go).toContain('strings.NewReader(')
    expect(go).toMatch(/req\.Header\.Set\("content-type", "application\/json"\)/i)

    // 无请求 body 的 GET：不应生成 body 相关行
    await fetchViaProxy(`http://127.0.0.1:${httpPort}/codegen-get`)
    await waitRepoFlush()
    const getFlows = core.listFlows({ filter: 'path:/codegen-get' }).flows
    expect(getFlows.length).toBeGreaterThan(0)
    const getCurl = core.codegen(getFlows[0].id, 'curl').code
    expect(getCurl).not.toContain('--data-raw')
    const getGo = core.codegen(getFlows[0].id, 'go').code
    expect(getGo).not.toContain('strings.NewReader')

    // 隧道 flow 无 request → 占位提示
    const { flows: tunnels } = core.listFlows({ filter: 'type:tunnel', limit: 5000 })
    if (tunnels.length > 0) {
      const t = core.codegen(tunnels[0].id, 'curl').code
      expect(t).toContain('no request to generate')
    }
  })

  it('exports flows as HAR 1.2', async () => {
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/echo?tag=har`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'har-body'
    })
    expect(await res.text()).toBe('echo:har-body')
    await waitRepoFlush()

    const { har } = core.exportHar({ filter: 'path:/echo' })
    expect(har.log.version).toBe('1.2')
    expect(har.log.creator.name).toBeTruthy()
    expect(har.log.entries.length).toBeGreaterThan(0)

    const entry = har.log.entries.find((e) => e.request.url.includes('tag=har'))
    expect(entry).toBeDefined()
    expect(entry!.request.method).toBe('POST')
    expect(entry!.request.httpVersion).toBe('HTTP/1.1')
    expect(entry!.request.postData!.text).toBe('har-body')
    expect(entry!.request.postData!.mimeType).toBe('text/plain')
    expect(entry!.request.queryString).toContainEqual({ name: 'tag', value: 'har' })
    expect(entry!.request.headers).toContainEqual({ name: 'content-type', value: 'text/plain' })
    expect(entry!.response.status).toBe(200)
    expect(entry!.response.content.mimeType).toBe('text/plain')
    expect(entry!.response.content.text).toBe('echo:har-body')
    expect(entry!.startedDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(entry!.time).toBeGreaterThanOrEqual(0)
    for (const key of ['blocked', 'dns', 'connect', 'send', 'wait', 'receive', 'ssl']) {
      expect(entry!.timings).toHaveProperty(key)
    }
    // 整体可 JSON 序列化
    expect(() => JSON.stringify(har)).not.toThrow()
    const parsed = JSON.parse(JSON.stringify(har)) as typeof har
    expect(parsed.log.entries.length).toBe(har.log.entries.length)
  })

  it('persists flows across restart', async () => {
    await fetchViaProxy(`http://127.0.0.1:${httpPort}/persist`)
    await waitRepoFlush()
    await core.stop()
    await core.start()
    const { flows } = core.listFlows({ filter: 'path:/persist' })
    expect(flows.length).toBe(1)
  })

  it('breaks and modifies a request at breakpoint', async () => {
    core.setBreakpointRules([
      {
        id: 'test-req',
        enabled: true,
        host: '127.0.0.1',
        path: '/echo-break',
        method: '',
        phase: 'request'
      }
    ])
    const requestPromise = fetchViaProxy(`http://127.0.0.1:${httpPort}/echo-break`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'original'
    })

    const hit = await waitForHit('/echo-break', 'request')
    expect(hit.request?.bodyBase64).toBe(Buffer.from('original').toString('base64'))
    expect(hit.request?.url).toContain('/echo-break')

    core.resolveBreakpoint(hit.flowId, 'request', {
      action: 'continue',
      request: {
        method: 'POST',
        url: hit.request!.url,
        headers: hit.request!.headers,
        bodyBase64: Buffer.from('modified-body').toString('base64')
      }
    })

    const res = await requestPromise
    expect(await res.text()).toBe('echo:modified-body')
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/echo-break' })
    expect(flows.length).toBe(1)
    expect(flows[0].flags).toContain('breakpoint')
    const { body } = core.getBody(flows[0].id, 'req')
    expect(body?.text).toBe('modified-body')
    core.setBreakpointRules([])
  })

  it('aborts a request at breakpoint', async () => {
    core.setBreakpointRules([
      {
        id: 'test-abort',
        enabled: true,
        host: '127.0.0.1',
        path: '/break-abort',
        method: '',
        phase: 'request'
      }
    ])
    const requestPromise = fetchViaProxy(`http://127.0.0.1:${httpPort}/break-abort`).then(
      (r) => r.status,
      () => 'rejected'
    )
    const hit = await waitForHit('/break-abort', 'request')
    core.resolveBreakpoint(hit.flowId, 'request', { action: 'abort' })
    const outcome = await requestPromise
    expect(outcome === 'rejected' || outcome === 502).toBe(true)
    core.setBreakpointRules([])
  })

  it('breaks and modifies a response at breakpoint', async () => {
    core.setBreakpointRules([
      {
        id: 'test-resp',
        enabled: true,
        host: '127.0.0.1',
        path: '/break-resp',
        method: '',
        phase: 'response'
      }
    ])
    const requestPromise = fetchViaProxy(`http://127.0.0.1:${httpPort}/break-resp`)
    const hit = await waitForHit('/break-resp', 'response')
    expect(hit.phase).toBe('response')
    expect(hit.response?.status).toBe(200)

    core.resolveBreakpoint(hit.flowId, 'response', {
      action: 'continue',
      response: {
        status: 418,
        statusText: "I'm a teapot",
        headers: [
          ...hit.response!.headers,
          { name: 'Content-Type', value: 'text/plain; charset=utf-8' }
        ],
        bodyBase64: Buffer.from('intercepted-response').toString('base64')
      }
    })

    const res = await requestPromise
    expect(res.status).toBe(418)
    expect(await res.text()).toBe('intercepted-response')
    core.setBreakpointRules([])
  })

  it('sends a Composer request and captures it as a flow', async () => {
    const { flowId } = await core.sendComposerRequest({
      method: 'POST',
      url: `http://127.0.0.1:${httpPort}/composer-test`,
      headers: [
        { name: 'Content-Type', value: 'text/plain' },
        { name: 'Host', value: `127.0.0.1:${httpPort}` }
      ],
      bodyBase64: Buffer.from('composer-body').toString('base64')
    })
    expect(flowId).toBeTruthy()
    await waitRepoFlush()
    const { flow } = core.getFlow(flowId)
    expect(flow).not.toBeNull()
    expect(flow!.request!.method).toBe('POST')
    expect(flow!.response!.status).toBe(200)
    expect(flow!.flags).toContain('composer')
    const { body } = core.getBody(flowId, 'req')
    expect(body?.text).toBe('composer-body')
  })

  it('persists composer environments', () => {
    expect(core.listComposerEnvs()).toEqual({ envs: [], activeName: null })
    const envs: ComposerEnv[] = [
      { name: 'dev', vars: { baseUrl: 'http://127.0.0.1:3000', token: 't-dev' } },
      { name: 'staging', vars: { baseUrl: 'http://staging.example.com' } }
    ]
    const saved = core.setComposerEnvs(envs, 'dev')
    expect(saved.activeName).toBe('dev')
    expect(core.listComposerEnvs()).toEqual({ envs, activeName: 'dev' })
    // 未知 activeName 归一化为 null；结构非法的条目被过滤
    const saved2 = core.setComposerEnvs([...envs, { name: '', vars: {} }], 'prod')
    expect(saved2.envs).toEqual(envs)
    expect(saved2.activeName).toBeNull()
    core.setComposerEnvs([], null)
  })
})

describe('HAR import', () => {
  it('imports HAR entries as flows with bodies, flags and timing', () => {
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'other-tool', version: '1.0' },
        entries: [
          {
            startedDateTime: '2026-01-02T03:04:05.678Z',
            time: 120,
            request: {
              method: 'POST',
              url: 'https://api.example.com/v1/users?x=1',
              httpVersion: 'HTTP/2',
              cookies: [],
              headers: [{ name: 'content-type', value: 'application/json' }],
              queryString: [{ name: 'x', value: '1' }],
              postData: { mimeType: 'application/json', params: [], text: '{"a":1}' },
              headersSize: 100,
              bodySize: 7
            },
            response: {
              status: 201,
              statusText: 'Created',
              httpVersion: 'HTTP/2',
              cookies: [],
              headers: [{ name: 'content-type', value: 'application/json' }],
              content: { size: 11, mimeType: 'application/json', text: '{"ok":true}' },
              redirectURL: '',
              headersSize: 80,
              bodySize: 11
            },
            cache: {},
            timings: { blocked: -1, dns: -1, connect: -1, send: 10, wait: 100, receive: 10, ssl: -1 }
          },
          {
            startedDateTime: '2026-01-02T03:04:06.000Z',
            time: 50,
            request: {
              method: 'GET',
              url: 'http://cdn.example.net/img.png',
              httpVersion: 'HTTP/1.1',
              cookies: [],
              headers: [],
              queryString: [],
              headersSize: -1,
              bodySize: 0
            },
            response: {
              status: 200,
              statusText: 'OK',
              httpVersion: 'HTTP/1.1',
              cookies: [],
              headers: [{ name: 'content-type', value: 'image/png' }],
              content: { size: 4, mimeType: 'image/png', text: 'iVBORw==', encoding: 'base64' },
              redirectURL: '',
              headersSize: -1,
              bodySize: 4
            },
            cache: {},
            timings: { blocked: -1, dns: -1, connect: -1, send: 0, wait: 50, receive: 0, ssl: -1 }
          },
          { startedDateTime: '2026-01-02T03:04:07.000Z', time: 0, cache: {} }
        ]
      }
    }
    const res = core.importHar(har)
    expect(res.imported).toBe(2)
    expect(res.skipped).toBe(1)

    const { flows } = core.listFlows({ filter: 'flag:imported' })
    const byUrl = new Map(flows.map((f) => [f.url, f]))
    const json = byUrl.get('https://api.example.com/v1/users?x=1')
    expect(json).toBeDefined()
    expect(json!.method).toBe('POST')
    expect(json!.host).toBe('api.example.com')
    expect(json!.status).toBe(201)
    expect(json!.tls).toBe(true)
    expect(json!.state).toBe('done')
    const png = byUrl.get('http://cdn.example.net/img.png')
    expect(png).toBeDefined()
    expect(png!.tls).toBe(false)
    expect(png!.state).toBe('done')

    const flow = core.getFlow(json!.id).flow!
    expect(flow.request!.httpVersion).toBe('2')
    expect(flow.request!.headers).toContainEqual({ name: 'content-type', value: 'application/json' })
    expect(flow.flags).toContain('imported')
    expect(flow.timing.start).toBe(Date.parse('2026-01-02T03:04:05.678Z'))
    expect(flow.timing.end! - flow.timing.start).toBe(120)
    expect(flow.size.reqBody).toBe(7)
    expect(flow.size.respBody).toBe(11)

    const reqBody = core.getBody(json!.id, 'req').body!
    expect(reqBody.isText).toBe(true)
    expect(reqBody.text).toBe('{"a":1}')
    const respBody = core.getBody(json!.id, 'resp').body!
    expect(respBody.isText).toBe(true)
    expect(respBody.text).toBe('{"ok":true}')

    const pngResp = core.getBody(png!.id, 'resp').body!
    expect(pngResp.isText).toBe(false)
    expect(pngResp.size).toBe(4)
    expect(pngResp.base64).toBe('iVBORw==')

    // 导入 body 的 preview 让 body: 过滤可命中
    const { flows: searched } = core.listFlows({ filter: 'body:ok' })
    expect(searched.some((f) => f.id === json!.id)).toBe(true)
  })

  it('rejects non-HAR input', () => {
    expect(() => core.importHar(null)).toThrow(/HAR/)
    expect(() => core.importHar({})).toThrow(/HAR/)
    expect(() => core.importHar({ log: {} })).toThrow(/HAR/)
    expect(() => core.importHar('{"log":{"entries":[]}}')).toThrow(/HAR/)
  })

  it('round-trips an export back through import without seq collision', async () => {
    const { har } = core.exportHar({})
    const count = har.log.entries.length
    expect(count).toBeGreaterThan(0)
    const res = core.importHar(har)
    expect(res.imported).toBe(count)
    expect(res.skipped).toBe(0)

    // 导入用了高 seq，后续抓包不得与之撞车
    await fetchViaProxy(`http://127.0.0.1:${httpPort}/after-import`)
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/after-import' })
    expect(flows).toHaveLength(1)
    const imported = core.listFlows({ filter: 'flag:imported' }).flows
    const maxImportedSeq = Math.max(...imported.map((f) => f.seq))
    expect(flows[0].seq).toBeGreaterThan(maxImportedSeq)
  })
})

describe('Client app attribution', () => {
  it('attributes loopback flows to the client process and filters by app:', async () => {
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/app-attr`)
    expect(res.status).toBe(200)
    await waitRepoFlush()

    const { flows } = core.listFlows({ filter: 'path:/app-attr' })
    expect(flows).toHaveLength(1)
    // 测试进程（node）经本机回环连代理，应归属到进程名
    expect(flows[0].clientIp).toBe('127.0.0.1')
    if (process.platform === 'darwin') {
      expect(flows[0].clientApp).toBeTruthy()
      const { flows: byApp } = core.listFlows({ filter: `app:${flows[0].clientApp}` })
      expect(byApp.some((f) => f.id === flows[0].id)).toBe(true)
    }

    const flow = core.getFlow(flows[0].id).flow!
    expect(flow.clientApp).toBe(flows[0].clientApp)

    // matchSummary 的 app: key（客户端实时过滤路径）
    const { matchSummary, parseFilter } = await import('@proxy/shared')
    const nodes = parseFilter('app:nonexistent-app')
    expect(matchSummary(flows[0], nodes)).toBe(false)
    if (flows[0].clientApp) {
      expect(matchSummary(flows[0], parseFilter(`app:${flows[0].clientApp}`))).toBe(true)
    }
  })

  it('labels composer flows as Composer', async () => {
    const { flowId } = await core.sendComposerRequest({
      method: 'GET',
      url: `http://127.0.0.1:${httpPort}/composer-app`,
      headers: [{ name: 'Host', value: `127.0.0.1:${httpPort}` }],
      bodyBase64: ''
    })
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'app:Composer' })
    expect(flows.some((f) => f.id === flowId)).toBe(true)
  })
})

describe('Rules engine', () => {
  const upstreamCountBefore = () => upstreamFlows.length

  it('mocks a response without hitting upstream', async () => {
    const before = upstreamCountBefore()
    core.setRules([
      {
        id: 'mock-1',
        name: 'mock test',
        enabled: true,
        match: { host: '127.0.0.1', path: '/mock-test', method: '', urlRegex: undefined },
        action: {
          type: 'mock',
          status: 200,
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          bodyBase64: Buffer.from('{"mocked":true}').toString('base64')
        }
      }
    ])
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/mock-test`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { mocked: boolean }
    expect(json.mocked).toBe(true)
    expect(upstreamFlows.length).toBe(before)
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/mock-test flag:mock' })
    expect(flows.length).toBe(1)
    core.setRules([])
  })

  it('counts rule matches per rule id and previews draft matches', async () => {
    const rule: Rule = {
      id: 'count-1',
      name: 'counter',
      enabled: true,
      match: { host: '127.0.0.1', path: '/count-test', method: '', urlRegex: undefined },
      action: {
        type: 'mock',
        status: 200,
        headers: [],
        bodyBase64: ''
      }
    }
    core.setRules([rule])
    await fetchViaProxy(`http://127.0.0.1:${httpPort}/count-test`)
    await fetchViaProxy(`http://127.0.0.1:${httpPort}/count-test`)
    await fetchViaProxy(`http://127.0.0.1:${httpPort}/other-path`)
    await waitRepoFlush()

    // rules.list 返回累计命中（前两条命中，第三条不命中）
    const listed = core.listRules()
    expect(listed.matchCounts['count-1']).toBe(2)

    // 未保存草稿的实时预览：改宽 host 仍能命中历史两条
    const preview = core.ruleMatchPreview({ ...rule, id: 'draft' })
    expect(preview.count).toBeGreaterThanOrEqual(2)
    expect(preview.sampleSeqs.length).toBeGreaterThan(0)

    // 删除规则时计数同步清除
    core.setRules([])
    expect(core.listRules().matchCounts['count-1']).toBeUndefined()
  })

  it('rewrites request URL and body', async () => {
    core.setRules([
      {
        id: 'rw-req',
        name: 'rewrite request',
        enabled: true,
        match: { host: '127.0.0.1', path: '/rewrite-src', method: '', urlRegex: undefined },
        action: {
          type: 'rewrite-request',
          urlReplace: `http://127.0.0.1:${httpPort}/rewrite-dst`,
          headerOps: [{ op: 'set', name: 'X-Rewritten', value: 'yes' }],
          bodyBase64: Buffer.from('rewritten-body').toString('base64')
        }
      }
    ])
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/rewrite-src`, {
      method: 'POST',
      body: 'original'
    })
    const json = (await res.json()) as { url: string }
    expect(json.url).toBe('/rewrite-dst')
    const last = upstreamFlows[upstreamFlows.length - 1]
    expect(last.body).toBe('rewritten-body')
    expect(last.headers['x-rewritten']).toBe('yes')
    core.setRules([])
  })

  it('rewrites response status and body', async () => {
    core.setRules([
      {
        id: 'rw-resp',
        name: 'rewrite response',
        enabled: true,
        match: { host: '127.0.0.1', path: '/resp-rewrite', method: '', urlRegex: undefined },
        action: {
          type: 'rewrite-response',
          status: 599,
          headerOps: [{ op: 'set', name: 'X-Rule', value: 'hit' }],
          bodyBase64: Buffer.from('replaced-response').toString('base64')
        }
      }
    ])
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/resp-rewrite`)
    expect(res.status).toBe(599)
    expect(res.headers.get('x-rule')).toBe('hit')
    expect(await res.text()).toBe('replaced-response')
    core.setRules([])
  })

  it('maps a URL to a local file', async () => {
    const localPath = join(dataDir, 'maplocal.json')
    writeFileSync(localPath, JSON.stringify({ mapped: true, source: 'local' }))
    const upstreamCount = upstreamFlows.length
    core.setRules([
      {
        id: 'ml-1',
        name: 'maplocal',
        enabled: true,
        match: { host: '127.0.0.1', path: '/map-me', method: '', urlRegex: undefined },
        action: { type: 'map-local', path: localPath }
      }
    ])
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/map-me`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.text()).toBe(JSON.stringify({ mapped: true, source: 'local' }))
    expect(upstreamFlows.length).toBe(upstreamCount)
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/map-me flag:maplocal' })
    expect(flows.length).toBeGreaterThan(0)
    core.setRules([])
  })

  it('maps to a missing file and returns 502', async () => {
    core.setRules([
      {
        id: 'ml-2',
        name: 'maplocal-missing',
        enabled: true,
        match: { host: '127.0.0.1', path: '/map-missing', method: '', urlRegex: undefined },
        action: { type: 'map-local', path: join(dataDir, 'no-such-file.json') }
      }
    ])
    const outcome = await fetchViaProxy(`http://127.0.0.1:${httpPort}/map-missing`).then(
      (r) => r.status,
      () => 'rejected'
    )
    expect(outcome === 'rejected' || outcome === 502).toBe(true)
    core.setRules([])
  })

  it('replaces text in a gzip response', async () => {
    core.setRules([
      {
        id: 'rep-1',
        name: 'replace',
        enabled: true,
        match: { host: '127.0.0.1', path: '/gzip', method: '', urlRegex: undefined },
        action: {
          type: 'rewrite-response',
          headerOps: [],
          replaces: [{ search: 'world', replace: 'reqable' }]
        }
      }
    ])
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/gzip`)
    const text = await res.text()
    expect(text).toContain('reqable')
    expect(text).not.toContain('world')
    core.setRules([])
  })

  it('blocks a request', async () => {
    core.setRules([
      {
        id: 'block-1',
        name: 'block',
        enabled: true,
        match: { host: '127.0.0.1', path: '/block-me', method: '', urlRegex: undefined },
        action: { type: 'block' }
      }
    ])
    const outcome = await fetchViaProxy(`http://127.0.0.1:${httpPort}/block-me`).then(
      (r) => r.status,
      () => 'rejected'
    )
    expect(outcome === 'rejected' || outcome === 502).toBe(true)
    core.setRules([])
  })

  it('throttles a response', async () => {
    core.setRules([
      {
        id: 'thr-1',
        name: 'throttle',
        enabled: true,
        match: { host: '127.0.0.1', path: '/echo', method: '', urlRegex: undefined },
        action: { type: 'throttle', kbps: 8 }
      }
    ])
    const bigBody = 'x'.repeat(2048)
    const start = Date.now()
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: bigBody
    })
    const text = await res.text()
    const elapsed = Date.now() - start
    expect(text).toBe(`echo:${bigBody}`)
    // 2KB at 8KB/s，chunk=819B/100ms → 至少 200ms
    expect(elapsed).toBeGreaterThanOrEqual(200)
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/echo flag:throttle' })
    expect(flows.length).toBeGreaterThan(0)
    core.setRules([])
  })

  it('adds weak-network latency before forwarding', async () => {
    core.setRules([
      {
        id: 'lat-1',
        name: 'latency',
        enabled: true,
        match: { host: '127.0.0.1', path: '/latency', method: '', urlRegex: undefined },
        action: { type: 'throttle', kbps: 1024, latencyMs: 300 }
      }
    ])
    const start = Date.now()
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/latency`)
    await res.text()
    expect(Date.now() - start).toBeGreaterThanOrEqual(280)
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/latency flag:throttle' })
    expect(flows.length).toBeGreaterThan(0)
    core.setRules([])
  })

  it('simulates packet loss with 100% lossPercent', async () => {
    core.setRules([
      {
        id: 'loss-1',
        name: 'loss',
        enabled: true,
        match: { host: '127.0.0.1', path: '/loss', method: '', urlRegex: undefined },
        action: { type: 'throttle', kbps: 1024, lossPercent: 100 }
      }
    ])
    const outcome = await fetchViaProxy(`http://127.0.0.1:${httpPort}/loss`).then(
      (r) => r.status,
      () => 'rejected'
    )
    expect(outcome === 'rejected' || outcome === 502).toBe(true)
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/loss flag:loss' })
    expect(flows.length).toBeGreaterThan(0)
    core.setRules([])
  })

  it('bypasses TLS MITM via rule', async () => {
    core.setRules([
      {
        id: 'bypass-1',
        name: 'bypass',
        enabled: true,
        match: { host: 'localhost', path: '', method: '', urlRegex: undefined },
        action: { type: 'bypass-tls' }
      }
    ])
    const outcome = await fetchViaProxy(`https://localhost:${httpsPort}/bypass-test`, undefined, true).then(
      (r) => r.status,
      () => 'rejected'
    )
    // 隧道模式下客户端直连自签证书上游：mitm=false，请求应成功或因证书失败
    expect(['rejected', 200]).toContain(outcome)
    await waitRepoFlush()
    core.setRules([])
  })
})

describe('Plugins', () => {
  const pluginsDir = () => join(dataDir, 'plugins')
  const hasPython =
    spawnSync('python3', ['-c', 'print(1)'], { timeout: 5000 }).status === 0

  function writeJsPlugin(name: string, code: string): void {
    mkdirSync(join(pluginsDir(), name), { recursive: true })
    writeFileSync(join(pluginsDir(), name, 'index.js'), code)
  }

  async function reloadAndEnable(name: string): Promise<void> {
    core.reloadPlugins()
    core.setPluginEnabled(name, true)
    await waitForPluginLog(name, 'loaded (', 5000)
  }

  async function waitForPluginLog(plugin: string, contains: string, timeoutMs = 8000, minCount = 1): Promise<void> {
    const start = Date.now()
    for (;;) {
      const { logs } = core.getPluginLogs()
      const count = logs.filter((l) => l.plugin === plugin && l.message.includes(contains)).length
      if (count >= minCount) return
      if (Date.now() - start > timeoutMs) {
        throw new Error(`no log from ${plugin} containing "${contains}" (x${minCount}): ${JSON.stringify(logs.slice(-10))}`)
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  it('modifies a request body via onRequest', async () => {
    await reloadAndEnable('body-mod')
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/echo-plugin-req`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'orig'
    })
    expect(await res.text()).toBe('echo:orig-plugin')
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/echo-plugin-req flag:plugin' })
    expect(flows.length).toBe(1)
    core.setPluginEnabled('body-mod', false)
  })

  it('short-circuits with a respond from onRequest', async () => {
    await reloadAndEnable('responder')
    const before = upstreamFlows.length
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/plugin-respond`)
    expect(res.status).toBe(299)
    expect(res.headers.get('x-plugin')).toBe('yes')
    expect(await res.text()).toBe('from-plugin')
    expect(upstreamFlows.length).toBe(before)
    core.setPluginEnabled('responder', false)
  })

  it('modifies a response via onResponse', async () => {
    await reloadAndEnable('resp-mod')
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/plugin-resp`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('response-edited-by-plugin')
    core.setPluginEnabled('resp-mod', false)
  })

  it('hot-reloads a JS plugin on file change', async () => {
    await reloadAndEnable('hot')
    const first = await fetchViaProxy(`http://127.0.0.1:${httpPort}/echo-plugin-hot`, {
      method: 'POST',
      body: 'x'
    })
    expect(await first.text()).toBe('echo:x-v1')

    writeJsPlugin(
      'hot',
      `export async function onRequest(ctx) {
  if (!ctx.url.includes('plugin-hot')) return
  const body = Buffer.from(ctx.bodyBase64, 'base64').toString('utf8')
  return { request: { bodyBase64: Buffer.from(body + '-v2').toString('base64') } }
}
`
    )
    await waitForPluginLog('hot', 'file changed, reloading…')
    await waitForPluginLog('hot', 'loaded (', 8000, 2)
    await new Promise((r) => setTimeout(r, 100))

    const second = await fetchViaProxy(`http://127.0.0.1:${httpPort}/echo-plugin-hot`, {
      method: 'POST',
      body: 'x'
    })
    expect(await second.text()).toBe('echo:x-v2')
    core.setPluginEnabled('hot', false)
  })

  it('keeps proxying when a plugin hangs and recovers after disable', async () => {
    writeJsPlugin(
      'stuck',
      `export async function onRequest(ctx) {
  if (!ctx.url.includes('plugin-stuck')) return
  await new Promise(() => {})
}
`
    )
    await reloadAndEnable('stuck')
    // 卡死钩子在 CALL_TIMEOUT(5s) 后放行并计 strike，代理本身不受影响
    const first = await fetchViaProxy(`http://127.0.0.1:${httpPort}/echo-plugin-stuck`, {
      method: 'POST',
      body: 'a'
    })
    expect(await first.text()).toBe('echo:a')
    const { plugins } = core.listPlugins()
    expect(plugins.find((p) => p.name === 'stuck')?.errors).toBe(1)

    core.setPluginEnabled('stuck', false)
    const second = await fetchViaProxy(`http://127.0.0.1:${httpPort}/echo-plugin-stuck`, {
      method: 'POST',
      body: 'd'
    })
    expect(await second.text()).toBe('echo:d')
  }, 15000)

  it('recovers when a plugin crashes its worker', async () => {
    writeJsPlugin(
      'crasher',
      `export async function onRequest(ctx) {
  if (!ctx.url.includes('plugin-crash')) return
  process.exit(17)
}
`
    )
    await reloadAndEnable('crasher')
    // worker 崩溃：在途调用放行，worker 重启
    const first = await fetchViaProxy(`http://127.0.0.1:${httpPort}/echo-plugin-crash`, {
      method: 'POST',
      body: 'b'
    })
    expect(await first.text()).toBe('echo:b')
    const { plugins } = core.listPlugins()
    expect(plugins.find((p) => p.name === 'crasher')?.errors).toBe(1)

    // 新 worker 就绪后再来一次，依旧放行且不拖垮代理
    const second = await fetchViaProxy(`http://127.0.0.1:${httpPort}/echo-plugin-crash`, {
      method: 'POST',
      body: 'c'
    })
    expect(await second.text()).toBe('echo:c')
    core.setPluginEnabled('crasher', false)
  })

  it('disables a plugin after three strikes', async () => {
    await reloadAndEnable('bad')
    for (let i = 0; i < 3; i++) {
      const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/echo-plugin-bad`, {
        method: 'POST',
        body: 'keep-going'
      })
      expect(await res.text()).toBe('echo:keep-going')
    }
    const { plugins } = core.listPlugins()
    const bad = plugins.find((p) => p.name === 'bad')
    expect(bad?.status).toBe('disabled-by-strikes')
    expect(bad?.enabled).toBe(false)

    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/echo-plugin-bad`, {
      method: 'POST',
      body: 'still-alive'
    })
    expect(await res.text()).toBe('echo:still-alive')
  })

  it('creates a plugin from template and keeps it enabled across rescan', async () => {
    core.createPlugin('tpl-test', 'js')
    const { plugins } = core.listPlugins()
    const p = plugins.find((x) => x.name === 'tpl-test')
    expect(p?.type).toBe('js')
    expect(p?.enabled).toBe(true)
    await waitForPluginLog('tpl-test', 'loaded (')

    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/echo-tpl`, {
      method: 'POST',
      body: 't'
    })
    expect(await res.text()).toBe('echo:t-by-js-plugin')

    core.reloadPlugins()
    await waitForPluginLog('tpl-test', 'loaded (', 8000, 2)
    const after = core.listPlugins().plugins.find((x) => x.name === 'tpl-test')
    expect(after?.enabled).toBe(true)
    core.setPluginEnabled('tpl-test', false)
  })

  it('modifies a request via a Python plugin', async () => {
    if (!hasPython) {
      console.warn('python3 not found, skipping python plugin test')
      return
    }
    mkdirSync(join(pluginsDir(), 'py-mod'), { recursive: true })
    writeFileSync(
      join(pluginsDir(), 'py-mod', 'plugin.py'),
      `import base64

def onRequest(ctx):
    if "plugin-py" not in ctx["url"]:
        return None
    body = base64.b64decode(ctx["bodyBase64"]).decode("utf-8")
    return {"request": {"bodyBase64": base64.b64encode((body + "-pymod").encode()).decode()}}
`
    )
    core.reloadPlugins()
    core.setPluginEnabled('py-mod', true)
    await waitForPluginLog('py-mod', 'loaded', 10000)

    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/echo-plugin-py`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'py-orig'
    })
    expect(await res.text()).toBe('echo:py-orig-pymod')
    core.setPluginEnabled('py-mod', false)
  })

  beforeAll(() => {
    writeJsPlugin(
      'body-mod',
      `export async function onRequest(ctx) {
  if (!ctx.url.includes('plugin-req')) return
  const body = Buffer.from(ctx.bodyBase64, 'base64').toString('utf8')
  return { request: { bodyBase64: Buffer.from(body + '-plugin').toString('base64') } }
}
`
    )
    writeJsPlugin(
      'responder',
      `export async function onRequest(ctx) {
  if (!ctx.url.includes('/plugin-respond')) return
  return {
    respond: {
      status: 299,
      statusText: 'Plugin Says Hi',
      headers: [
        { name: 'Content-Type', value: 'text/plain; charset=utf-8' },
        { name: 'X-Plugin', value: 'yes' }
      ],
      bodyBase64: Buffer.from('from-plugin').toString('base64')
    }
  }
}
`
    )
    writeJsPlugin(
      'resp-mod',
      `export async function onResponse(ctx) {
  if (!ctx.url.includes('/plugin-resp')) return
  return { response: { bodyBase64: Buffer.from('response-edited-by-plugin').toString('base64') } }
}
`
    )
    writeJsPlugin(
      'hot',
      `export async function onRequest(ctx) {
  if (!ctx.url.includes('plugin-hot')) return
  const body = Buffer.from(ctx.bodyBase64, 'base64').toString('utf8')
  return { request: { bodyBase64: Buffer.from(body + '-v1').toString('base64') } }
}
`
    )
    writeJsPlugin(
      'bad',
      `export async function onRequest() {
  throw new Error('boom')
}
`
    )
  })
})

describe('WebSocket capture', () => {
  const wsReceived: string[] = []
  let wsPort = 0
  let wsServer: net.Server
  const wsClients = new Set<net.Socket>()

  beforeAll(async () => {
    // 极简 WS 服务端：完成握手后回显每条 text 消息（加前缀）
    wsServer = net.createServer((sock) => {
      wsClients.add(sock)
      sock.on('close', () => wsClients.delete(sock))
      sock.on('error', () => sock.destroy())
      let buf = Buffer.alloc(0)
      let established = false
      let carry: Buffer = Buffer.alloc(0)
      sock.on('data', (chunk: Buffer) => {
        if (!established) {
          buf = Buffer.concat([buf, chunk])
          const idx = buf.indexOf('\r\n\r\n')
          if (idx < 0) return
          const head = buf.subarray(0, idx).toString()
          const rest = buf.subarray(idx + 4)
          const key = /sec-websocket-key: (.+)/i.exec(head)?.[1]?.trim()
          if (!key) {
            sock.destroy()
            return
          }
          const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
          sock.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
              'Upgrade: websocket\r\n' +
              'Connection: Upgrade\r\n' +
              `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
          )
          established = true
          if (rest.length > 0) handleFrames(rest)
          return
        }
        handleFrames(chunk)
      })

      function handleFrames(data: Buffer): void {
        carry = Buffer.concat([carry, data])
        for (;;) {
          const frame = parseFrame(carry)
          if (!frame) return
          carry = carry.subarray(frame.consumed)
          if (frame.opcode === 1) {
            const text = frame.payload.toString('utf8')
            wsReceived.push(text)
            sock.write(encodeFrame(Buffer.from(`echo:${text}`), 1))
          } else if (frame.opcode === 8) {
            sock.write(encodeFrame(Buffer.alloc(0), 8))
            sock.end()
          }
        }
      }
    })
    await new Promise<void>((resolve) => {
      wsServer.listen(0, '127.0.0.1', () => {
        wsPort = (wsServer.address() as { port: number }).port
        resolve()
      })
    })
  })

  afterAll(() => {
    for (const c of wsClients) c.destroy()
    wsServer.close()
  })

  /** 极简 WS 客户端：走代理发握手 + 发送掩码帧，收集服务端消息 */
  function rawWsClientViaProxy(
    path: string,
    messages: string[],
    onMessage: (text: string) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proxyPort = core.info().proxyPort
      const sock = net.connect(proxyPort, '127.0.0.1', () => {
        const key = randomUUID().replace(/-/g, '') + '=='
        sock.write(
          `GET http://127.0.0.1:${wsPort}${path} HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${wsPort}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\n` +
            'Sec-WebSocket-Version: 13\r\n\r\n'
        )
      })
      let buf = Buffer.alloc(0)
      let established = false
      let sent = 0
      let echoGot = 0
      const timer = setTimeout(() => reject(new Error('ws client timeout')), 8000)
      sock.on('data', (chunk: Buffer) => {
        if (!established) {
          buf = Buffer.concat([buf, chunk])
          const idx = buf.indexOf('\r\n\r\n')
          if (idx < 0) return
          const head = buf.subarray(0, idx).toString()
          if (!/101/.test(head)) {
            clearTimeout(timer)
            reject(new Error('handshake failed: ' + head.split('\r\n')[0]))
            return
          }
          established = true
          // 发第一条
          sock.write(encodeFrame(Buffer.from(messages[sent]), 1, true))
          sent++
          return
        }
        // 服务端帧
        let carry = chunk
        for (;;) {
          const frame = parseFrame(carry)
          if (!frame) return
          carry = carry.subarray(frame.consumed)
          if (frame.opcode === 1) {
            onMessage(frame.payload.toString('utf8'))
            echoGot++
            if (sent < messages.length) {
              sock.write(encodeFrame(Buffer.from(messages[sent]), 1, true))
              sent++
            } else if (echoGot >= messages.length) {
              // 关闭
              sock.write(encodeFrame(Buffer.alloc(0), 8, true))
              clearTimeout(timer)
              resolve()
            }
          }
        }
      })
      sock.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  it('captures a websocket flow with message timeline', async () => {
    const got: string[] = []
    await rawWsClientViaProxy('/ws-test', ['hello-ws', 'second-msg'], (m) => got.push(m))
    expect(got).toEqual(['echo:hello-ws', 'echo:second-msg'])
    expect(wsReceived).toContain('hello-ws')

    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/ws-test type:ws' })
    expect(flows.length).toBe(1)
    expect(flows[0].kind).toBe('ws')
    expect(flows[0].status).toBe(101)
    expect(flows[0].flags).toContain('ws')
    expect(flows[0].reqSize).toBe(Buffer.byteLength('hello-ws') + Buffer.byteLength('second-msg'))
    expect(flows[0].respSize).toBe(Buffer.byteLength('echo:hello-ws') + Buffer.byteLength('echo:second-msg'))

    const { messages } = core.getWsMessages(flows[0].id)
    // 2 text c2s + 2 text s2c + 1 close c2s（客户端发的 close）
    expect(messages.filter((m) => m.dir === 'c2s' && m.opcode === 1).map((m) => m.text)).toEqual([
      'hello-ws',
      'second-msg'
    ])
    expect(messages.filter((m) => m.dir === 's2c' && m.opcode === 1).map((m) => m.text)).toEqual([
      'echo:hello-ws',
      'echo:second-msg'
    ])
  })
})

describe('Retention', () => {
  it('deletes the oldest flows when maxFlows is exceeded', async () => {
    await fetchViaProxy(`http://127.0.0.1:${httpPort}/ret-old`)
    await fetchViaProxy(`http://127.0.0.1:${httpPort}/ret-new`)
    await waitRepoFlush()

    const before = core.listFlows({ limit: 5000 }).flows
    expect(before.some((f) => f.path === '/ret-old')).toBe(true)
    expect(before.some((f) => f.path === '/ret-new')).toBe(true)
    const oldest = before.reduce((a, b) => (a.seq < b.seq ? a : b))
    const total = before.length

    const s = core.getSettings()
    core.setSettings({ retention: { ...s.retention, days: 0, maxFlows: total - 1, maxDiskGB: 0 } })

    const after = core.listFlows({ limit: 5000 }).flows
    expect(after.length).toBe(total - 1)
    expect(after.every((f) => f.seq !== oldest.seq)).toBe(true)
    expect(after.some((f) => f.path === '/ret-new')).toBe(true)
  })

  it('deletes flows older than the retention window', async () => {
    expect(core.listFlows({ limit: 5000 }).flows.length).toBeGreaterThan(0)
    // 用第二个连接把所有 flow 的 created_at 回拨 40 天（WAL 支持多连接）
    const db = new DatabaseSync(join(dataDir, 'data', 'proxy.db'))
    db.prepare('UPDATE flows SET created_at = created_at - ?').run(40 * 86_400_000)
    db.close()
    const s = core.getSettings()
    core.setSettings({ retention: { ...s.retention, days: 30, maxFlows: 0, maxDiskGB: 0 } })
    expect(core.listFlows({ limit: 5000 }).flows.length).toBe(0)
    // 恢复默认，避免影响后续运行
    core.setSettings({ retention: { days: 30, maxFlows: 200000, maxDiskGB: 10 } })
    await fetchViaProxy(`http://127.0.0.1:${httpPort}/ret-after`)
    await waitRepoFlush()
    expect(core.listFlows({ filter: 'path:/ret-after' }).flows.length).toBe(1)
  })
})

describe('SOCKS5 inbound', () => {
  let rawPort = 0
  let rawServer: net.Server
  const rawClients = new Set<net.Socket>()

  beforeAll(async () => {
    // 原始 TCP 回显服务端（非 HTTP，用于盲隧道场景）
    rawServer = net.createServer((s) => {
      rawClients.add(s)
      s.on('close', () => rawClients.delete(s))
      s.on('error', () => s.destroy())
      s.pipe(s)
    })
    await new Promise<void>((resolve) => {
      rawServer.listen(0, '127.0.0.1', () => {
        rawPort = (rawServer.address() as { port: number }).port
        resolve()
      })
    })
  })

  afterAll(() => {
    for (const c of rawClients) c.destroy()
    rawServer.close()
  })

  function readN(sock: net.Socket, n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0)
      const onData = (c: Buffer) => {
        buf = Buffer.concat([buf, c])
        if (buf.length >= n) {
          cleanup()
          resolve(buf.subarray(0, n))
        }
      }
      const onErr = (err: Error) => {
        cleanup()
        reject(err)
      }
      const cleanup = () => {
        sock.removeListener('data', onData)
        sock.removeListener('error', onErr)
      }
      sock.on('data', onData)
      sock.on('error', onErr)
    })
  }

  /** SOCKS5 握手（无鉴权 + CONNECT），完成后返回处于透传态的 socket */
  async function socksDial(host: string, port: number, useDomain: boolean): Promise<net.Socket> {
    const socksPort = core.getSettings().proxy.socksPort
    const sock = net.connect(socksPort, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', resolve)
      sock.once('error', reject)
    })
    sock.write(Buffer.from([0x05, 0x01, 0x00]))
    const rep1 = await readN(sock, 2)
    expect([...rep1]).toEqual([0x05, 0x00])
    const parts: Buffer[] = [Buffer.from([0x05, 0x01, 0x00, useDomain ? 0x03 : 0x01])]
    if (useDomain) {
      const hb = Buffer.from(host, 'ascii')
      parts.push(Buffer.from([hb.length]), hb)
    } else {
      parts.push(Buffer.from(host.split('.').map(Number)))
    }
    const p = Buffer.alloc(2)
    p.writeUInt16BE(port)
    parts.push(p)
    sock.write(Buffer.concat(parts))
    const rep2 = await readN(sock, 10)
    expect(rep2[0]).toBe(0x05)
    expect(rep2[1]).toBe(0x00)
    return sock
  }

  it('captures plain HTTP over SOCKS5 as an http flow (domain ATYP)', async () => {
    const sock = await socksDial('localhost', httpPort, true)
    const resp = new Promise<string>((resolve, reject) => {
      let buf = ''
      sock.on('data', (c: Buffer) => (buf += c.toString()))
      sock.on('end', () => resolve(buf))
      sock.on('error', reject)
    })
    sock.write(`GET /socks-http HTTP/1.1\r\nHost: localhost:${httpPort}\r\nConnection: close\r\n\r\n`)
    const text = await resp
    expect(text).toContain('200')
    expect(text).toContain('"/socks-http"')
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/socks-http' })
    expect(flows.length).toBe(1)
    expect(flows[0].kind).toBe('http')
    expect(flows[0].method).toBe('GET')
    expect(flows[0].status).toBe(200)
  })

  it('tunnels non-HTTP TCP over SOCKS5 as a tunnel flow (IPv4 ATYP)', async () => {
    const sock = await socksDial('127.0.0.1', rawPort, false)
    const echoed = new Promise<string>((resolve, reject) => {
      let buf = ''
      sock.on('data', (c: Buffer) => (buf += c.toString()))
      sock.on('error', reject)
      setTimeout(() => resolve(buf), 500)
    })
    sock.write('RAW tunnel hello\n')
    expect(await echoed).toContain('RAW tunnel hello')
    sock.destroy()
    await waitRepoFlush()
    // 用 port 精确定位本测试的隧道（其他用例的隧道 flow 可能因 keep-alive 延迟落库）
    const tunnels = core.listFlows({ filter: 'type:tunnel', limit: 5000 }).flows
    const mine = tunnels.filter((f) => core.getFlow(f.id).flow?.port === rawPort)
    expect(mine.length).toBe(1)
    expect(mine[0].state).toBe('done')
  })

  it('rejects unsupported SOCKS commands with REP 0x07', async () => {
    const socksPort = core.getSettings().proxy.socksPort
    const sock = net.connect(socksPort, '127.0.0.1')
    await new Promise<void>((resolve) => sock.once('connect', resolve))
    sock.write(Buffer.from([0x05, 0x01, 0x00]))
    await readN(sock, 2)
    // BIND (0x02) → 拒绝
    sock.write(Buffer.from([0x05, 0x02, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50]))
    const rep = await readN(sock, 10)
    expect(rep[1]).toBe(0x07)
    sock.destroy()
  })

  it('RFC1929 username carries clientApp into the flow', async () => {
    const socksPort = core.getSettings().proxy.socksPort
    const sock = net.connect(socksPort, '127.0.0.1')
    await new Promise<void>((resolve) => sock.once('connect', resolve))
    // 提供 NONE + USER/PASS → 服务端选 0x02
    sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]))
    const rep1 = await readN(sock, 2)
    expect([...rep1]).toEqual([0x05, 0x02])
    const label = '百度地图'
    const ub = Buffer.from(label, 'utf8')
    const pb = Buffer.from('1', 'ascii')
    sock.write(Buffer.concat([Buffer.from([0x01, ub.length]), ub, Buffer.from([pb.length]), pb]))
    const rep2 = await readN(sock, 2)
    expect([...rep2]).toEqual([0x01, 0x00])
    // CONNECT 到原始回显服务端
    const p = Buffer.alloc(2)
    p.writeUInt16BE(rawPort)
    sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1]), p]))
    const rep3 = await readN(sock, 10)
    expect(rep3[1]).toBe(0x00)
    sock.write('auth tunnel hello\n')
    const echoed = new Promise<string>((resolve, reject) => {
      let buf = ''
      sock.on('data', (c: Buffer) => (buf += c.toString()))
      sock.on('error', reject)
      setTimeout(() => resolve(buf), 500)
    })
    expect(await echoed).toContain('auth tunnel hello')
    sock.destroy()
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: `app:${label}` })
    expect(flows.length).toBe(1)
    expect(flows[0].clientApp).toBe(label)
  })

  it('falls back to NO AUTH when client offers only 0x00', async () => {
    const socksPort = core.getSettings().proxy.socksPort
    const sock = net.connect(socksPort, '127.0.0.1')
    await new Promise<void>((resolve) => sock.once('connect', resolve))
    sock.write(Buffer.from([0x05, 0x01, 0x00]))
    const rep = await readN(sock, 2)
    expect([...rep]).toEqual([0x05, 0x00])
    sock.destroy()
  })
})

function parseFrame(buf: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    len = Number(buf.readBigUInt64BE(2))
    offset = 10
  }
  let mask: Buffer | null = null
  if (masked) {
    if (buf.length < offset + 4) return null
    mask = buf.subarray(offset, offset + 4)
    offset += 4
  }
  if (buf.length < offset + len) return null
  let payload = buf.subarray(offset, offset + len)
  if (mask) {
    const out = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]
    payload = out
  }
  return { opcode, payload, consumed: offset + len }
}

function encodeFrame(payload: Buffer, opcode: number, mask = false): Buffer {
  const maskBuf = mask ? randomBytes(4) : null
  const data = maskBuf
    ? Buffer.from(payload.map((b, i) => b ^ maskBuf[i & 3]))
    : payload
  let header: Buffer
  const maskBit = mask ? 0x80 : 0
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, maskBit | payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = maskBit | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = maskBit | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return maskBuf ? Buffer.concat([header, maskBuf, data]) : Buffer.concat([header, data])
}

async function waitForHit(path: string, phase: 'request' | 'response', timeoutMs = 5000): Promise<import('@proxy/shared').BreakpointHit> {
  const start = Date.now()
  for (;;) {
    const { hits } = core.listBreakpoints()
    const hit = hits.find((h) => h.url?.includes(path) && h.phase === phase)
    if (hit) return hit
    if (Date.now() - start > timeoutMs) throw new Error(`no breakpoint hit for ${path} ${phase}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

function fetchViaProxy(url: string, init?: RequestInit, mitm = false): Promise<Response> {
  const proxyPort = core.info().proxyPort
  const ca = readFileSync(join(dataDir, 'certs', 'ca.pem'), 'utf8')
  const agent = new ProxyAgent(
    mitm
      ? {
          uri: `http://127.0.0.1:${proxyPort}`,
          requestTls: { rejectUnauthorized: false, ca }
        }
      : {
          uri: `http://127.0.0.1:${proxyPort}`,
          proxyTunnel: false
        }
  )
  return undiciFetch(url, {
    ...init,
    dispatcher: agent
  }) as unknown as Promise<Response>
}

async function waitRepoFlush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 400))
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('waitFor timeout')
}

describe('Upstream proxy (二级代理)', () => {
  let httpProxySrv: net.Server
  let httpProxyPort = 0
  let socksSrv: net.Server
  let socksUpPort = 0
  const httpProxySeen: string[] = []
  const socksSeen: string[] = []

  beforeAll(async () => {
    // 本地 HTTP 上游代理：CONNECT 建隧道；明文请求按绝对 URI 透传
    httpProxySrv = net.createServer((socket) => {
      let buf = Buffer.alloc(0)
      let handled = false
      socket.on('data', (d: Buffer) => {
        if (handled) return
        buf = Buffer.concat([buf, d])
        const idx = buf.indexOf('\r\n\r\n')
        if (idx < 0) return
        handled = true
        socket.pause()
        const head = buf.slice(0, idx).toString('latin1')
        const rest = buf.slice(idx + 4)
        const cm = /^CONNECT (\S+):(\d+) HTTP\/1\.1/.exec(head)
        if (cm) {
          httpProxySeen.push(`CONNECT ${cm[1]}:${cm[2]}`)
          const target = net.connect({ host: cm[1], port: Number(cm[2]) }, () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            if (rest.length > 0) target.write(rest)
            socket.pipe(target)
            target.pipe(socket)
            socket.resume()
          })
          target.on('error', () => socket.destroy())
          socket.on('error', () => target.destroy())
          return
        }
        const rm = /^(\S+) (\S+) HTTP\/1\.1/.exec(head)
        if (!rm) {
          socket.destroy()
          return
        }
        httpProxySeen.push(`${rm[1]} ${rm[2]}`)
        let target: net.Socket
        try {
          const u = new URL(rm[2])
          target = net.connect({ host: u.hostname, port: Number(u.port || 80) })
        } catch {
          socket.destroy()
          return
        }
        target.on('connect', () => {
          target.write(buf) // 原始请求（含绝对 URI 请求行）原样转发
          socket.pipe(target)
          target.pipe(socket)
          socket.resume()
        })
        target.on('error', () => socket.destroy())
        socket.on('error', () => target.destroy())
      })
    })
    await new Promise<void>((resolve) => {
      httpProxySrv.listen(0, '127.0.0.1', () => {
        httpProxyPort = (httpProxySrv.address() as { port: number }).port
        resolve()
      })
    })

    // 本地 SOCKS5 无认证上游代理
    socksSrv = net.createServer((socket) => {
      let stage: 'greeting' | 'connect' = 'greeting'
      let buf = Buffer.alloc(0)
      socket.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d])
        if (stage === 'greeting') {
          if (buf.length < 3) return
          stage = 'connect'
          buf = buf.slice(3)
          socket.write(Buffer.from([0x05, 0x00]))
          if (buf.length === 0) return
        }
        if (buf.length < 7) return
        const atyp = buf[3]
        const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? 1 + buf[4] : -1
        if (addrLen < 0 || buf.length < 4 + addrLen + 2) return
        const host =
          atyp === 0x01
            ? `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
            : buf.slice(5, 4 + addrLen).toString('utf8')
        const port = buf.readUInt16BE(4 + addrLen)
        const rest = buf.slice(4 + addrLen + 2)
        buf = Buffer.alloc(0)
        socksSeen.push(`${host}:${port}`)
        socket.pause()
        const target = net.connect({ host, port }, () => {
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          if (rest.length > 0) target.write(rest)
          socket.pipe(target)
          target.pipe(socket)
          socket.resume()
        })
        target.on('error', () => socket.destroy())
        socket.on('error', () => target.destroy())
      })
    })
    await new Promise<void>((resolve) => {
      socksSrv.listen(0, '127.0.0.1', () => {
        socksUpPort = (socksSrv.address() as { port: number }).port
        resolve()
      })
    })
  })

  afterAll(() => {
    core.setSettings({
      proxy: { upstream: { enabled: false, protocol: 'http', host: '127.0.0.1', port: 7890 } }
    } as never)
    httpProxySrv.close()
    socksSrv.close()
  })

  it('HTTP 上游：明文请求以绝对 URI 经代理转发', async () => {
    core.setSettings({
      proxy: { upstream: { enabled: true, protocol: 'http', host: '127.0.0.1', port: httpProxyPort } }
    } as never)
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/up-plain`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean }
    expect(json.ok).toBe(true)
    await waitRepoFlush()
    expect(httpProxySeen).toContain(`GET http://127.0.0.1:${httpPort}/up-plain`)
    const { flows } = core.listFlows({ filter: 'path:/up-plain' })
    expect(flows.length).toBeGreaterThan(0)
    expect(flows[0].flags).toContain('upstream')
  })

  it('HTTP 上游：HTTPS MITM 经 CONNECT 隧道', async () => {
    const res = await fetchViaProxy(`https://127.0.0.1:${httpsPort}/up-tls`, undefined, true)
    expect(res.status).toBe(200)
    expect(httpProxySeen).toContain(`CONNECT 127.0.0.1:${httpsPort}`)
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/up-tls' })
    expect(flows.length).toBeGreaterThan(0)
    expect(flows[0].flags).toContain('upstream')
  })

  it('HTTP 上游：CONNECT 盲隧道经代理转发', async () => {
    core.setSettings({ tls: { bypassHosts: ['127.0.0.1'] } } as never)
    try {
      const proxyPort = core.info().proxyPort
      const sock = net.connect({ host: '127.0.0.1', port: proxyPort })
      const hello = await new Promise<string>((resolve, reject) => {
        sock.once('error', reject)
        sock.once('data', (d: Buffer) => resolve(d.toString('latin1')))
        sock.write(`CONNECT 127.0.0.1:${httpPort} HTTP/1.1\r\nHost: 127.0.0.1:${httpPort}\r\n\r\n`)
      })
      expect(hello).toContain('200')
      const body = await new Promise<string>((resolve, reject) => {
        let acc = ''
        sock.on('data', (d: Buffer) => {
          acc += d.toString()
          if (acc.includes('"ok":true')) resolve(acc)
        })
        sock.once('error', reject)
        sock.write(`GET /up-blind HTTP/1.1\r\nHost: 127.0.0.1:${httpPort}\r\nConnection: close\r\n\r\n`)
      })
      expect(body).toContain('HTTP/1.1 200')
      sock.destroy()
      expect(httpProxySeen).toContain(`CONNECT 127.0.0.1:${httpPort}`)
    } finally {
      core.setSettings({ tls: { bypassHosts: [] } } as never)
    }
  })

  it('SOCKS5 上游：明文请求经 SOCKS5 转发', async () => {
    core.setSettings({
      proxy: { upstream: { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: socksUpPort } }
    } as never)
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/up-socks-plain`)
    expect(res.status).toBe(200)
    expect(socksSeen).toContain(`127.0.0.1:${httpPort}`)
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/up-socks-plain' })
    expect(flows.length).toBeGreaterThan(0)
    expect(flows[0].flags).toContain('upstream')
  })

  it('SOCKS5 上游：HTTPS MITM 经 SOCKS5 隧道', async () => {
    const res = await fetchViaProxy(`https://127.0.0.1:${httpsPort}/up-socks-tls`, undefined, true)
    expect(res.status).toBe(200)
    expect(socksSeen).toContain(`127.0.0.1:${httpsPort}`)
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/up-socks-tls' })
    expect(flows.length).toBeGreaterThan(0)
    expect(flows[0].flags).toContain('upstream')
  })
})

describe('Reverse proxy (反向代理)', () => {
  let rpPort: number

  it('本地端口透明转发到目标并落库（Host 改写）', async () => {
    rpPort = await getFreePort()
    core.setSettings({
      reverse: {
        rules: [{
          id: 'rp-test-1',
          enabled: true,
          name: '本地测试服务',
          listenPort: rpPort,
          targetHost: '127.0.0.1',
          targetPort: httpPort,
          targetTls: false
        }]
      }
    })
    // 监听器异步起，等端口就绪
    await waitFor(async () => {
      try {
        await fetch(`http://127.0.0.1:${rpPort}/rp-hello?k=v`)
        return true
      } catch {
        return false
      }
    })

    // 客户端 Host 是 127.0.0.1:rpPort，转发到目标时必须改写
    const res = await fetch(`http://127.0.0.1:${rpPort}/rp-hello?k=v`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'rp-body'
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; url: string }
    expect(json.ok).toBe(true)
    expect(json.url).toBe('/rp-hello?k=v')

    const seen = upstreamFlows.filter((f) => f.url === '/rp-hello?k=v')
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1].headers['host']).toBe(`127.0.0.1:${httpPort}`)
    expect(seen[seen.length - 1].body).toBe('rp-body')

    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/rp-hello' })
    expect(flows.length).toBeGreaterThan(0)
    const post = flows.find((f) => f.method === 'POST')!
    expect(post.host).toBe('127.0.0.1')
    expect(post.url).toBe(`http://127.0.0.1:${httpPort}/rp-hello?k=v`)
    expect(post.status).toBe(200)
    expect(post.mitm).toBe(false)
  })

  it('规则引擎对反向代理流量生效（mock 短路）', async () => {
    const rules = core.listRules().rules
    core.setRules([{
      id: 'rp-mock',
      name: 'rp-mock',
      enabled: true,
      match: { host: '127.0.0.1', path: '/rp-mock-me', method: '' },
      action: { type: 'mock', status: 299, headers: [], bodyBase64: Buffer.from('rp-mocked').toString('base64') }
    }])
    try {
      const res = await fetch(`http://127.0.0.1:${rpPort}/rp-mock-me`)
      expect(res.status).toBe(299)
      expect(await res.text()).toBe('rp-mocked')
      await waitRepoFlush()
      const { flows } = core.listFlows({ filter: 'path:/rp-mock-me' })
      expect(flows.length).toBeGreaterThan(0)
      expect(flows[0].flags).toContain('mock')
    } finally {
      core.setRules(rules)
    }
  })

  it('禁用规则后端口关闭', async () => {
    core.setSettings({
      reverse: {
        rules: [{
          id: 'rp-test-1',
          enabled: false,
          name: '本地测试服务',
          listenPort: rpPort,
          targetHost: '127.0.0.1',
          targetPort: httpPort,
          targetTls: false
        }]
      }
    })
    await waitFor(async () => {
      try {
        await fetch(`http://127.0.0.1:${rpPort}/x`)
        return false
      } catch {
        return true
      }
    })
    core.setSettings({ reverse: { rules: [] } })
  })
})

describe('Mirror (域名镜像)', () => {
  it('明文代理请求 host 改道到镜像目标（含端口映射）', async () => {
    core.setSettings({
      mirror: {
        rules: [{
          id: 'm1',
          enabled: true,
          name: '测试镜像',
          fromHost: 'mirror-from.test',
          mirrorHost: '127.0.0.1',
          mirrorPort: httpPort
        }]
      }
    })
    try {
      // 客户端请求 mirror-from.test（任意端口都会被 mirrorPort 覆盖）
      const res = await fetchViaProxy('http://mirror-from.test:9999/mirror-path?q=1')
      expect(res.status).toBe(200)
      const json = (await res.json()) as { ok: boolean; url: string }
      expect(json.url).toBe('/mirror-path?q=1')
      // 上游收到的是目标主机（Host 头按连接地址生成）
      const seen = upstreamFlows.filter((f) => f.url === '/mirror-path?q=1')
      expect(seen.length).toBeGreaterThan(0)
      // 落库显示镜像后的 host
      await waitRepoFlush()
      const { flows } = core.listFlows({ filter: 'path:/mirror-path' })
      expect(flows.length).toBeGreaterThan(0)
      expect(flows[0].host).toBe('127.0.0.1')
    } finally {
      core.setSettings({ mirror: { rules: [] } })
    }
  })

  it('CONNECT (MITM) 路径 host 改道', async () => {
    core.setSettings({
      mirror: {
        rules: [{
          id: 'm2',
          enabled: true,
          name: 'TLS 镜像',
          fromHost: 'tls-mirror.test',
          mirrorHost: '127.0.0.1',
          mirrorPort: 0
        }]
      }
    })
    try {
      // https 默认端口 443 → 镜像保持原端口会失败；显式 CONNECT 端口形式验证改道逻辑：
      // 请求 https://tls-mirror.test:HTTPS_PORT/，mirrorPort=0 保持端口
      const res = await fetchViaProxy(`https://tls-mirror.test:${httpsPort}/tls-mirror-sec`, undefined, true)
      expect(res.status).toBe(200)
      const json = (await res.json()) as { ok: boolean }
      expect(json.ok).toBe(true)
      await waitRepoFlush()
      const { flows } = core.listFlows({ filter: 'path:/tls-mirror-sec' })
      expect(flows.length).toBeGreaterThan(0)
      expect(flows[0].host).toBe('127.0.0.1')
      expect(flows[0].mitm).toBe(true)
    } finally {
      core.setSettings({ mirror: { rules: [] } })
    }
  })
})

describe('Workbench tree (收藏/书签)', () => {
  it('creates folders/bookmarks, renames, moves (含防环) and cascades delete', async () => {
    // 建树：favorite 文件夹 F1；bookmark 文件夹 B1 > B1-1 > 书签 BM
    const { nodes: n1 } = core.createWbFolder('favorite', '手机调试')
    const favFolder = n1.find((n) => n.name === '手机调试')!
    expect(favFolder.kind).toBe('folder')
    expect(favFolder.scope).toBe('favorite')
    expect(favFolder.parentId).toBeNull()

    const { nodes: n2 } = core.createWbFolder('bookmark', '调试')
    const bmFolder = n2.find((n) => n.name === '调试')!
    const { nodes: n3 } = core.createWbFolder('bookmark', '子层', bmFolder.id)
    const subFolder = n3.find((n) => n.name === '子层')!
    expect(subFolder.parentId).toBe(bmFolder.id)

    const { nodes: n4 } = core.createWbBookmark('百度地图', 'app:百度地图', subFolder.id)
    const bm = n4.find((n) => n.name === '百度地图')!
    expect(bm.kind).toBe('bookmark')
    expect(bm.filter).toBe('app:百度地图')
    expect(bm.parentId).toBe(subFolder.id)

    // 重命名
    const { nodes: n5 } = core.renameWbNode(bm.id, '地图流量')
    expect(n5.find((n) => n.id === bm.id)!.name).toBe('地图流量')

    // 防环：把父文件夹移进自己的后代 → 报错
    expect(() => core.moveWbNode(bmFolder.id, subFolder.id)).toThrow()
    // 合法移动：书签移到根
    const { nodes: n6 } = core.moveWbNode(bm.id, null)
    expect(n6.find((n) => n.id === bm.id)!.parentId).toBeNull()

    // 收藏条目入文件夹 + 移动 + 级联删除回根级
    await fetchViaProxy(`http://127.0.0.1:${httpPort}/wb-collect`)
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/wb-collect' })
    const { items } = core.addFlowToCollection(flows[0].id, 'wb 快照', '', favFolder.id)
    expect(items[0].folderId).toBe(favFolder.id)

    const { items: moved } = core.setCollectionFolder(items[0].id, null)
    expect(moved[0].folderId).toBeNull()
    core.setCollectionFolder(items[0].id, favFolder.id)

    // 级联删除：bookmark 文件夹整支消失（书签已先移到根级故仍在）
    const { nodes: n7 } = core.removeWbNode(bmFolder.id)
    const ids = new Set(n7.map((n) => n.id))
    expect(ids.has(bmFolder.id)).toBe(false)
    expect(ids.has(subFolder.id)).toBe(false)
    expect(ids.has(bm.id)).toBe(true)
    expect(ids.has(favFolder.id)).toBe(true)

    // favorite 文件夹删除后其中的条目移回根级（快照不丢）
    core.removeWbNode(favFolder.id)
    const afterDel = core.listCollections().items
    expect(afterDel[0].folderId).toBeNull()
    expect(core.listWorkbench().nodes.length).toBe(1)
    core.removeWbNode(bm.id)
    expect(core.listWorkbench().nodes.length).toBe(0)
    core.removeCollection(afterDel[0].id)
  })

  it('filters flows by client ip via ip: token', async () => {
    await fetchViaProxy(`http://127.0.0.1:${httpPort}/wb-ip-filter`)
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'ip:127.0.0.1 path:/wb-ip-filter' })
    expect(flows.length).toBeGreaterThan(0)
    expect(flows[0].clientIp).toContain('127.0.0.1')
    const { flows: none } = core.listFlows({ filter: 'ip:10.99.99.99 path:/wb-ip-filter' })
    expect(none.length).toBe(0)
  })

  it('filters MITM flows by sni: token (SQL 与 matchSummary 双侧)', async () => {
    const res = await fetchViaProxy(`https://localhost:${httpsPort}/secure?token=sni`, undefined, true)
    expect(res.status).toBe(200)
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'sni:localhost path:/secure' })
    expect(flows.length).toBeGreaterThan(0)
    expect(flows[0].mitm).toBe(true)
    expect(flows[0].sni).toBe('localhost')
    const { flows: none } = core.listFlows({ filter: 'sni:no-such-sni host:localhost' })
    expect(none.length).toBe(0)
    // 客户端实时过滤路径（matchSummary）与 SQL 侧语义一致
    const { matchSummary, parseFilter } = await import('@proxy/shared')
    const summary = flows[0]
    expect(matchSummary(summary, parseFilter('sni:localhost'))).toBe(true)
    expect(matchSummary(summary, parseFilter('sni:no-such-sni'))).toBe(false)
  })

  it('filters flows by body content via body: token (DB 侧)', async () => {
    const res = await fetchViaProxy(`http://127.0.0.1:${httpPort}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'uniq-body-marker-42'
    })
    expect(await res.text()).toBe('echo:uniq-body-marker-42')
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'body:uniq-body-marker-42' })
    expect(flows.length).toBeGreaterThan(0)
    expect(flows[0].path).toBe('/echo')
    const { flows: none } = core.listFlows({ filter: 'body:no-such-body-marker' })
    expect(none.length).toBe(0)
  })
})

describe('Postman import', () => {
  it('imports a v2.1 collection into favorite folders and items', () => {
    const collection = {
      info: { name: '测试集合', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [
        {
          name: '用户模块',
          item: [
            {
              name: '登录',
              request: {
                method: 'POST',
                header: [
                  { key: 'Accept', value: 'application/json' },
                  { key: 'X-Debug', value: '1', disabled: true }
                ],
                url: { raw: 'https://api.example.com/login?from=postman', host: ['api', 'example', 'com'], path: ['login'], query: [{ key: 'from', value: 'postman' }] },
                body: { mode: 'urlencoded', urlencoded: [{ key: 'user', value: 'tom' }, { key: 'pwd', value: 'a b' }] }
              }
            },
            {
              name: '资料',
              request: {
                method: 'GET',
                url: 'https://api.example.com/me',
                body: { mode: 'raw', raw: '{"a":1}' }
              }
            }
          ]
        },
        {
          name: '裸请求',
          request: { method: 'GET', url: 'https://api.example.com/ping' }
        },
        { name: '坏条目（无 url）', request: { method: 'GET' } }
      ]
    }
    const r = core.importPostmanCollection(collection)
    expect(r.imported).toBe(3)
    expect(r.folders).toBe(2) // 集合根 + 用户模块

    const { nodes } = core.listWorkbench()
    const root = nodes.find((n) => n.name === '测试集合')
    expect(root).toBeDefined()
    expect(root!.parentId).toBeNull()
    const sub = nodes.find((n) => n.name === '用户模块')
    expect(sub!.parentId).toBe(root!.id)

    const { items } = core.listCollections()
    const login = items.find((i) => i.name === '登录')!
    expect(login.folderId).toBe(sub!.id)
    expect(login.request.method).toBe('POST')
    expect(login.request.url).toBe('https://api.example.com/login?from=postman')
    expect(login.request.headers).toContainEqual({ name: 'Accept', value: 'application/json' })
    expect(login.request.headers.some((h) => h.name === 'X-Debug')).toBe(false)
    expect(login.request.headers).toContainEqual({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' })
    expect(Buffer.from(login.request.bodyBase64, 'base64').toString()).toBe('user=tom&pwd=a%20b')
    const bare = items.find((i) => i.name === '裸请求')!
    expect(bare.folderId).toBe(root!.id)

    // 清理：删根文件夹级联 + 清 items（其中两个挂在 root/sub 下，删除后回根级）
    core.removeWbNode(root!.id)
    const after = core.listCollections().items
    expect(after.length).toBe(3)
    for (const it of after) core.removeCollection(it.id)
    expect(core.listCollections().items.length).toBe(0)
    expect(core.listWorkbench().nodes.length).toBe(0)
  })

  it('rejects non-Postman JSON and empty collections', () => {
    expect(() => core.importPostmanCollection({ foo: 1 })).toThrow(/missing item/)
    expect(() => core.importPostmanCollection({ info: { schema: 'v1.0.0' }, item: [] })).toThrow(/schema/)
    expect(() =>
      core.importPostmanCollection({
        info: { name: '空', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: []
      })
    ).toThrow(/no requests/)
    expect(core.listWorkbench().nodes.length).toBe(0)
  })
})

describe('OpenAPI import', () => {
  it('imports paths with tags → folders, params → query, requestBody example → body', () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 'Demo API' },
      servers: [{ url: 'https://api.demo.com/' }],
      paths: {
        '/pets': {
          get: {
            summary: '列出宠物',
            tags: ['宠物'],
            parameters: [
              { name: 'limit', in: 'query' },
              { name: 'X-Token', in: 'header' }
            ]
          },
          post: {
            summary: '新建宠物',
            tags: ['宠物'],
            requestBody: { content: { 'application/json': { example: { name: 'kitty' } } } }
          }
        },
        '/ping': { get: { operationId: 'pingOp' } }
      }
    }
    const r = core.importOpenApiCollection(doc)
    expect(r.imported).toBe(3)
    expect(r.folders).toBe(2) // 根 + 宠物 tag

    const { nodes } = core.listWorkbench()
    const root = nodes.find((n) => n.name === 'Demo API')!
    const tagFolder = nodes.find((n) => n.name === '宠物')!
    expect(tagFolder.parentId).toBe(root.id)

    const { items } = core.listCollections()
    const list = items.find((i) => i.name === '列出宠物')!
    expect(list.request.url).toBe('https://api.demo.com/pets?limit=')
    expect(list.request.headers).toContainEqual({ name: 'X-Token', value: '' })
    expect(list.folderId).toBe(tagFolder.id)

    const create = items.find((i) => i.name === '新建宠物')!
    expect(Buffer.from(create.request.bodyBase64, 'base64').toString()).toBe('{\n  "name": "kitty"\n}')
    expect(create.request.headers).toContainEqual({ name: 'Content-Type', value: 'application/json' })

    const ping = items.find((i) => i.name === 'pingOp')!
    expect(ping.request.url).toBe('https://api.demo.com/ping')
    expect(ping.folderId).toBe(root.id)

    // 清理
    core.removeWbNode(root.id)
    for (const it of core.listCollections().items) core.removeCollection(it.id)
    expect(core.listCollections().items.length).toBe(0)
  })

  it('rejects non-OpenAPI docs and empty paths', () => {
    expect(() => core.importOpenApiCollection({ foo: 1 })).toThrow(/openapi\/swagger/)
    expect(() => core.importOpenApiCollection({ openapi: '3.0.0' })).toThrow(/no paths/)
    expect(() => core.importOpenApiCollection({ openapi: '3.0.0', paths: {} })).toThrow(/no operations/)
  })
})

describe('Hoppscotch import', () => {
  it('imports collections with nested folders, params and headers', () => {
    const data = [
      {
        v: 1,
        name: '我的集合',
        folders: [{ v: 1, name: '鉴权', requests: [{ v: 1, name: '登录', method: 'POST', url: 'https://api.demo.com/login', params: [{ key: 'src', value: 'hs' }], headers: [{ key: 'Accept', value: 'application/json' }], body: '{"user":"tom"}' }] }],
        requests: [{ v: 1, name: 'Ping', method: 'GET', url: 'https://api.demo.com/ping' }]
      }
    ]
    const r = core.importHoppscotchCollection(data)
    expect(r.imported).toBe(2)
    expect(r.folders).toBe(2)

    const { nodes } = core.listWorkbench()
    const root = nodes.find((n) => n.name === '我的集合')!
    const sub = nodes.find((n) => n.name === '鉴权')!
    expect(sub.parentId).toBe(root.id)

    const { items } = core.listCollections()
    const login = items.find((i) => i.name === '登录')!
    expect(login.folderId).toBe(sub.id)
    expect(login.request.url).toBe('https://api.demo.com/login?src=hs')
    expect(login.request.headers).toContainEqual({ name: 'Accept', value: 'application/json' })
    expect(login.request.headers).toContainEqual({ name: 'Content-Type', value: 'application/json' })
    expect(Buffer.from(login.request.bodyBase64, 'base64').toString()).toBe('{"user":"tom"}')

    const ping = items.find((i) => i.name === 'Ping')!
    expect(ping.folderId).toBe(root.id)

    core.removeWbNode(root.id)
    for (const it of core.listCollections().items) core.removeCollection(it.id)
    expect(core.listCollections().items.length).toBe(0)
  })

  it('rejects invalid exports', () => {
    expect(() => core.importHoppscotchCollection({ foo: 1 })).toThrow(/Hoppscotch/)
    expect(() => core.importHoppscotchCollection([{ name: '空' }])).toThrow(/no requests/)
  })
})

describe('Headless CLI', () => {
  it('runs the core standalone as a subprocess and persists flows to its data dir', async () => {
    const cliDataDir = mkdtempSync(join(tmpdir(), 'proxy-cli-test-'))
    const port = await getFreePort()
    const root = process.cwd()
    const proc: ChildProcess = spawn(
      process.execPath,
      [
        join(root, 'node_modules/tsx/dist/cli.mjs'),
        '--tsconfig', 'tsconfig.base.json',
        'packages/core/src/cli.ts',
        '--data-dir', cliDataDir,
        '--port', String(port),
        '--socks-port', '0'
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = ''
    let stderr = ''
    let exitCode: number | null = null
    proc.stdout!.on('data', (c: Buffer) => (stdout += c))
    proc.stderr!.on('data', (c: Buffer) => (stderr += c))
    const exited = new Promise<number | null>((resolve) => {
      proc.once('exit', (code) => {
        exitCode = code
        resolve(code)
      })
    })

    try {
      const start = Date.now()
      while (!stderr.includes('proxy listening on')) {
        if (exitCode !== null) throw new Error(`cli exited early (${exitCode}), stderr:\n${stderr}`)
        if (Date.now() - start > 30000) throw new Error(`cli not ready, stderr:\n${stderr}`)
        await new Promise((r) => setTimeout(r, 100))
      }

      const agent = new ProxyAgent({ uri: `http://127.0.0.1:${port}`, proxyTunnel: false })
      const res = await undiciFetch(`http://127.0.0.1:${httpPort}/cli-standalone`, { dispatcher: agent })
      expect(res.status).toBe(200)
      await res.text()

      const summary = /GET 200 127\.0\.0\.1:\d+\/cli-standalone/
      const startedAt = Date.now()
      while (!summary.test(stdout)) {
        if (exitCode !== null) throw new Error(`cli exited early (${exitCode}), stdout:\n${stdout}`)
        if (Date.now() - startedAt > 10000) throw new Error(`no flow summary line, stdout:\n${stdout}`)
        await new Promise((r) => setTimeout(r, 100))
      }

      proc.kill('SIGINT')
      const code = await Promise.race([
        exited,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`cli did not exit after SIGINT, stderr:\n${stderr}`)), 10000)
        )
      ])
      expect(code).toBe(0)

      expect(existsSync(join(cliDataDir, 'certs', 'ca.pem'))).toBe(true)
      const db = new DatabaseSync(join(cliDataDir, 'data', 'proxy.db'), { readOnly: true })
      const rows = db
        .prepare("SELECT host, path, status FROM flows WHERE path LIKE '/cli-standalone%'")
        .all() as { host: string; path: string; status: number }[]
      db.close()
      expect(rows.length).toBeGreaterThan(0)
      expect(rows[0].host).toBe('127.0.0.1')
      expect(rows[0].status).toBe(200)
    } finally {
      if (exitCode === null) proc.kill('SIGKILL')
      rmSync(cliDataDir, { recursive: true, force: true })
    }
  }, 60000)
})

describe('gRPC capture', () => {
  let grpcH2cPort = 0
  let grpcTlsPort = 0
  let grpcH2cServer: http2.Http2Server
  let grpcTlsServer: http2.Http2SecureServer
  const grpcUpstreamRequests: { path: string; contentType: string; body: Buffer }[] = []

  /** 最小 proto 编码：fieldNo 为 wire type 2（length-delimited）字符串字段 */
  function protoStr(fieldNo: number, s: string): Buffer {
    const val = Buffer.from(s, 'utf8')
    return Buffer.concat([Buffer.from([(fieldNo << 3) | 2, val.length]), val])
  }

  function grpcFrame(payload: Buffer): Buffer {
    const head = Buffer.alloc(5)
    head.writeUInt32BE(payload.length, 1)
    return Buffer.concat([head, payload])
  }

  function grpcHandler(req: http2.Http2ServerRequest, res: http2.Http2ServerResponse): void {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      grpcUpstreamRequests.push({
        path: req.url ?? '',
        contentType: String(req.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks)
      })
      res.writeHead(200, { 'content-type': 'application/grpc' })
      if (req.url?.includes('StreamHello')) {
        res.write(grpcFrame(protoStr(1, 'msg-one')))
        res.write(grpcFrame(protoStr(1, 'msg-two')))
      } else {
        res.write(grpcFrame(protoStr(1, 'Hello grpc')))
      }
      res.addTrailers({ 'grpc-status': '0' })
      res.end()
    })
  }

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      grpcH2cServer = http2.createServer(grpcHandler)
      grpcH2cServer.listen(0, '127.0.0.1', () => {
        grpcH2cPort = (grpcH2cServer.address() as { port: number }).port
        resolve()
      })
    })
    await new Promise<void>((resolve) => {
      grpcTlsServer = http2.createSecureServer(
        { key: upstreamTlsKeyPem, cert: upstreamTlsCertPem },
        grpcHandler
      )
      grpcTlsServer.listen(0, '127.0.0.1', () => {
        grpcTlsPort = (grpcTlsServer.address() as { port: number }).port
        resolve()
      })
    })
  })

  afterAll(() => {
    grpcH2cServer.close()
    grpcTlsServer.close()
  })

  it('captures a unary gRPC call with h2c upstream, protobuf decode and trailers', async () => {
    const proxyPort = core.info().proxyPort
    const reqBody = grpcFrame(protoStr(1, 'grpc'))
    const agent = new ProxyAgent({ uri: `http://127.0.0.1:${proxyPort}`, proxyTunnel: false })
    const res = await undiciFetch(`http://127.0.0.1:${grpcH2cPort}/helloworld.Greeter/SayHello`, {
      method: 'POST',
      headers: { 'content-type': 'application/grpc' },
      body: reqBody,
      dispatcher: agent
    })
    expect(res.status).toBe(200)
    const respBuf = Buffer.from(await res.arrayBuffer())
    expect(respBuf.readUInt32BE(1)).toBe(protoStr(1, 'Hello grpc').length)
    expect(respBuf.toString('utf8')).toContain('Hello grpc')

    // 上游收到的帧完全一致
    const upstreamReq = grpcUpstreamRequests.find((r) => r.path === '/helloworld.Greeter/SayHello')
    expect(upstreamReq?.contentType).toBe('application/grpc')
    expect(upstreamReq?.body.equals(reqBody)).toBe(true)

    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/helloworld.Greeter/SayHello flag:grpc' })
    expect(flows.length).toBe(1)
    const full = core.getFlow(flows[0].id).flow!
    expect(full.flags).toContain('grpc')
    expect(full.response!.httpVersion).toBe('2.0')
    expect(full.response!.trailers?.some((t) => t.name === 'grpc-status' && t.value === '0')).toBe(true)

    const { messages } = core.getWsMessages(flows[0].id)
    expect(messages.length).toBe(2)
    expect(messages[0].dir).toBe('c2s')
    expect(messages[0].opcode).toBe(0)
    expect(messages[0].text).toContain('1: "grpc"')
    expect(messages[1].dir).toBe('s2c')
    expect(messages[1].text).toContain('1: "Hello grpc"')
  })

  it('captures server-streaming gRPC over the MITM h2 path with trailers passed through', async () => {
    const proxyPort = core.info().proxyPort
    const ca = readFileSync(join(dataDir, 'certs', 'ca.pem'), 'utf8')
    const sock = net.connect(proxyPort, '127.0.0.1')
    await new Promise<void>((resolve) => sock.once('connect', resolve))
    sock.write(`CONNECT localhost:${grpcTlsPort} HTTP/1.1\r\nHost: localhost:${grpcTlsPort}\r\n\r\n`)
    let connectHeader = ''
    while (!connectHeader.endsWith('\r\n\r\n')) {
      const chunk = await new Promise<Buffer>((resolve, reject) => {
        sock.once('data', (d: Buffer) => resolve(d))
        sock.once('error', reject)
      })
      connectHeader += chunk.toString('latin1')
    }
    expect(connectHeader).toContain('200')

    const tlsSock = tls.connect({
      socket: sock,
      servername: 'localhost',
      ALPNProtocols: ['h2'],
      ca,
      rejectUnauthorized: true
    })
    await new Promise<void>((resolve, reject) => {
      tlsSock.once('secureConnect', resolve)
      tlsSock.once('error', reject)
    })
    expect(tlsSock.alpnProtocol).toBe('h2')

    const session = http2.connect(`https://localhost:${grpcTlsPort}`, { createConnection: () => tlsSock })
    session.on('error', () => {})
    const req = session.request({
      ':method': 'POST',
      ':path': '/helloworld.Greeter/StreamHello',
      'content-type': 'application/grpc'
    })
    req.end(grpcFrame(protoStr(1, 'stream-req')))
    const respHeaders = await new Promise<http2.IncomingHttpHeaders>((resolve, reject) => {
      req.once('response', (h) => resolve(h))
      req.once('error', reject)
    })
    let trailers: http2.IncomingHttpHeaders = {}
    req.on('trailers', (t) => {
      trailers = t
    })
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    session.close()

    expect(respHeaders[':status']).toBe(200)
    expect(String(respHeaders['content-type'])).toBe('application/grpc')
    const body = Buffer.concat(chunks)
    expect(body.toString('utf8')).toContain('msg-one')
    expect(body.toString('utf8')).toContain('msg-two')
    expect(trailers['grpc-status']).toBe('0')

    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/helloworld.Greeter/StreamHello' })
    expect(flows.length).toBe(1)
    const full = core.getFlow(flows[0].id).flow!
    expect(full.mitm).toBe(true)
    expect(full.request!.httpVersion).toBe('2.0')
    expect(full.flags).toContain('grpc')
    expect(full.response!.httpVersion).toBe('2.0')
    expect(full.response!.trailers?.some((t) => t.name === 'grpc-status' && t.value === '0')).toBe(true)

    const { messages } = core.getWsMessages(flows[0].id)
    expect(messages.length).toBe(3)
    const c2s = messages.filter((m) => m.dir === 'c2s')
    expect(c2s.length).toBe(1)
    expect(c2s[0].text).toContain('1: "stream-req"')
    const s2c = messages.filter((m) => m.dir === 's2c')
    expect(s2c.length).toBe(2)
    expect(s2c[0].text).toContain('1: "msg-one"')
    expect(s2c[1].text).toContain('1: "msg-two"')
  })
})

describe('Access control (访问控制)', () => {
  it('allowlist rejects unlisted clients and admits listed ones at TCP layer', async () => {
    const s = core.getSettings()
    // 白名单不含本机 → 连接被 destroy
    core.setSettings({ accessControl: { mode: 'allowlist', ips: ['192.168.100.104'] } })
    await expect(fetchViaProxy(`http://127.0.0.1:${httpPort}/hello`)).rejects.toThrow()
    // 加入本机 → 放行（::ffff: 映射归一化）
    core.setSettings({ accessControl: { mode: 'allowlist', ips: ['::ffff:127.0.0.1'] } })
    const ok = await fetchViaProxy(`http://127.0.0.1:${httpPort}/hello`)
    expect(ok.status).toBe(200)
    // blocklist：命中即拒
    core.setSettings({ accessControl: { mode: 'blocklist', ips: ['127.0.0.1'] } })
    await expect(fetchViaProxy(`http://127.0.0.1:${httpPort}/hello`)).rejects.toThrow()
    // 还原
    core.setSettings({ accessControl: { mode: 'off', ips: [] } })
    const back = await fetchViaProxy(`http://127.0.0.1:${httpPort}/hello`)
    expect(back.status).toBe(200)
  })
})

describe('无痕模式（capture.paused 引擎级不落库）', () => {
  it('paused 时流量照常转发但 DB 零新增，恢复后正常记录', async () => {
    const cap = core.getSettings().capture
    core.setSettings({ capture: { ...cap, paused: true } })
    const r = await fetchViaProxy(`http://127.0.0.1:${httpPort}/incognito-flow`)
    expect(r.status).toBe(200)
    await waitRepoFlush()
    expect(core.listFlows({ filter: 'path:/incognito-flow' }).flows.length).toBe(0)

    // 无孤儿 ws_messages 行（paused 期间 WS/gRPC 消息也不落库）
    const db = new DatabaseSync(join(dataDir, 'data', 'proxy.db'))
    const orphans = db
      .prepare('SELECT COUNT(*) AS n FROM ws_messages WHERE flow_id NOT IN (SELECT id FROM flows)')
      .get() as { n: number }
    db.close()
    expect(orphans.n).toBe(0)

    core.setSettings({ capture: { ...cap, paused: false } })
    const r2 = await fetchViaProxy(`http://127.0.0.1:${httpPort}/incognito-flow`)
    expect(r2.status).toBe(200)
    await waitRepoFlush()
    expect(core.listFlows({ filter: 'path:/incognito-flow' }).flows.length).toBe(1)
  })
})

describe('时序瀑布（timing 里程碑）', () => {
  it('上游连接里程碑已填充且时间单调', async () => {
    await fetchViaProxy(`http://127.0.0.1:${httpPort}/timing-probe`)
    await waitRepoFlush()
    const { flows } = core.listFlows({ filter: 'path:/timing-probe' })
    expect(flows.length).toBe(1)
    const full = core.getFlow(flows[0].id).flow!
    const t = full.timing
    expect(t.requestSent).toBeDefined()
    expect(t.firstByte).toBeDefined()
    expect(t.end).toBeDefined()
    // connect 恒有：新连接记 connect 事件，复用热连接记当前时刻
    expect(t.connect).toBeDefined()
    expect(t.connect!).toBeGreaterThanOrEqual(t.requestSent ?? t.start)
    expect(t.connect!).toBeLessThanOrEqual(t.firstByte!)
    if (t.dns !== undefined) {
      expect(t.dns).toBeGreaterThanOrEqual(t.requestSent ?? t.start)
      expect(t.dns).toBeLessThanOrEqual(t.connect!)
    }
    if (t.tls !== undefined) {
      expect(t.tls).toBeGreaterThanOrEqual(t.connect!)
      expect(t.tls).toBeLessThanOrEqual(t.firstByte!)
    }
    expect(t.start).toBeLessThanOrEqual(t.requestSent ?? t.start)
    expect(t.firstByte!).toBeLessThanOrEqual(t.end!)
  })
})

describe('请求跟踪（X-Trace-Id 注入）', () => {
  it('开启后注入 trace 头并支持 trace: 过滤，关闭后不注入', async () => {
    const s = core.getSettings()
    core.setSettings({ trace: { enabled: true, header: 'X-Trace-Id' } })
    await fetchViaProxy(`http://127.0.0.1:${httpPort}/trace-probe`)
    await waitRepoFlush()

    const up = upstreamFlows[upstreamFlows.length - 1]
    const sentId = up.headers['x-trace-id']
    expect(typeof sentId).toBe('string')
    expect(sentId).toMatch(/^[0-9a-f-]{36}$/)

    const { flows } = core.listFlows({ filter: `trace:"${sentId}"` })
    expect(flows.length).toBe(1)
    expect(flows[0].traceId).toBe(sentId)
    const full = core.getFlow(flows[0].id).flow!
    expect(full.traceId).toBe(sentId)
    expect(full.request!.headers.some((h) => h.name === 'X-Trace-Id' && h.value === sentId)).toBe(true)

    core.setSettings({ trace: { enabled: false, header: 'X-Trace-Id' } })
    await fetchViaProxy(`http://127.0.0.1:${httpPort}/trace-off`)
    await waitRepoFlush()
    const up2 = upstreamFlows[upstreamFlows.length - 1]
    expect(up2.headers['x-trace-id']).toBeUndefined()
  })
})

describe('MCP 服务器', () => {
  let mcpPort = 0
  const rpc = async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    })
    expect(res.status).toBe(200)
    return (await res.json()) as Record<string, unknown>
  }

  it('initialize / tools/list / tools/call 全链路', async () => {
    mcpPort = await getFreePort()
    core.setSettings({ mcp: { enabled: true, port: mcpPort } })
    await new Promise((r) => setTimeout(r, 300))
    expect(core.getMcpInfo().listening).toBe(true)

    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })
    const serverInfo = init.result as { serverInfo: { name: string }; protocolVersion: string }
    expect(serverInfo.serverInfo.name).toBe('prism')
    expect(serverInfo.protocolVersion).toBe('2025-06-18')

    const tools = (await rpc('tools/list')) as { result: { tools: Array<{ name: string }> } }
    expect(tools.result.tools.map((t) => t.name).sort()).toEqual(['get_flow', 'get_flow_body', 'list_flows'])

    await fetchViaProxy(`http://127.0.0.1:${httpPort}/mcp-probe`)
    await waitRepoFlush()

    const listed = (await rpc('tools/call', {
      name: 'list_flows',
      arguments: { filter: 'path:/mcp-probe', limit: 5 }
    })) as { result: { content: Array<{ text: string }> } }
    const listText = listed.result.content[0].text
    expect(listText).toContain('/mcp-probe')

    const seqMatch = /#(\d+) /.exec(listText)
    expect(seqMatch).toBeTruthy()
    const flow = (await rpc('tools/call', { name: 'get_flow', arguments: { seq: Number(seqMatch![1]) } })) as {
      result: { content: Array<{ text: string }> }
    }
    const flowObj = JSON.parse(flow.result.content[0].text) as { request?: { url: string } }
    expect(flowObj.request?.url).toContain('/mcp-probe')

    const body = (await rpc('tools/call', { name: 'get_flow_body', arguments: { seq: Number(seqMatch![1]) } })) as {
      result: { content: Array<{ text: string }> }
    }
    expect(body.result.content[0].text).toContain('"ok":true')

    const pong = (await rpc('ping')) as { result: Record<string, unknown> }
    expect(pong.result).toEqual({})

    core.setSettings({ mcp: { enabled: false, port: mcpPort } })
    await new Promise((r) => setTimeout(r, 300))
    expect(core.getMcpInfo().listening).toBe(false)
    await expect(fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: 'POST' })).rejects.toThrow()
  })
})

describe('极速模式（capture.turbo 内存展示不落盘）', () => {
  it('turbo 时 flow 照常推送 UI 但 DB 零新增，关闭后恢复落库', async () => {
    const emitted: string[] = []
    const off = core.onFlow((flows) => {
      for (const f of flows) if (f.request?.url.includes('/turbo-flow')) emitted.push(f.id)
    })
    try {
      const cap = core.getSettings().capture
      core.setSettings({ capture: { ...cap, turbo: true } })
      const r = await fetchViaProxy(`http://127.0.0.1:${httpPort}/turbo-flow`)
      expect(r.status).toBe(200)
      await waitRepoFlush()
      expect(emitted.length).toBeGreaterThan(0)
      expect(core.listFlows({ filter: 'path:/turbo-flow' }).flows.length).toBe(0)

      core.setSettings({ capture: { ...cap, turbo: false } })
      const r2 = await fetchViaProxy(`http://127.0.0.1:${httpPort}/turbo-flow-on`)
      expect(r2.status).toBe(200)
      await waitRepoFlush()
      expect(core.listFlows({ filter: 'path:/turbo-flow-on' }).flows.length).toBe(1)
    } finally {
      off()
    }
  })
})
