import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes, generateKeyPairSync } from 'node:crypto'
import { isIP } from 'node:net'
import { createSecureContext, type SecureContext } from 'node:tls'
import forge from 'node-forge'
import type { CaHandle } from './ca'

const MEM_CACHE_MAX = 2000
const DISK_CACHE_MAX = 10000

export class LeafCertFactory {
  private cache = new Map<string, SecureContext>()
  private leafKeyPem: string
  private leafPublicKey: forge.pki.PublicKey

  constructor(
    private ca: CaHandle,
    private cacheDir: string
  ) {
    mkdirSync(cacheDir, { recursive: true })
    const keyPath = join(cacheDir, '..', 'leaf.key')
    const pubPath = join(cacheDir, '..', 'leaf.pub')
    if (existsSync(keyPath) && existsSync(pubPath)) {
      this.leafKeyPem = readFileSync(keyPath, 'utf8')
      this.leafPublicKey = forge.pki.publicKeyFromPem(readFileSync(pubPath, 'utf8'))
    } else {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
      })
      this.leafKeyPem = privateKey
      this.leafPublicKey = forge.pki.publicKeyFromPem(publicKey)
      writeFileSync(keyPath, this.leafKeyPem, { mode: 0o600 })
      writeFileSync(pubPath, publicKey)
    }
    this.pruneDiskCache()
  }

  secureContextFor(hostname: string): SecureContext {
    const host = normalizeHost(hostname)
    const hit = this.cache.get(host)
    if (hit) {
      this.cache.delete(host)
      this.cache.set(host, hit)
      return hit
    }
    let certPem = this.readDisk(host)
    if (!certPem) {
      certPem = this.createCertPem(host)
      this.writeDisk(host, certPem)
    }
    const ctx = createSecureContext({ key: this.leafKeyPem, cert: certPem })
    this.cache.set(host, ctx)
    if (this.cache.size > MEM_CACHE_MAX) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    return ctx
  }

  /** MITM TLS 服务端的默认证书材料（无 SNI 客户端的 fallback） */
  defaultKeyAndCert(): { key: string; cert: string } {
    const host = 'localhost'
    let certPem = this.readDisk(host)
    if (!certPem) {
      certPem = this.createCertPem(host)
      this.writeDisk(host, certPem)
    }
    return { key: this.leafKeyPem, cert: certPem }
  }

  private createCertPem(host: string): string {
    const cert = forge.pki.createCertificate()
    cert.publicKey = this.leafPublicKey
    cert.serialNumber = randomBytes(16).toString('hex')
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000)
    cert.validity.notAfter = new Date(Date.now() + 825 * 24 * 3600 * 1000)
    cert.setSubject([{ shortName: 'CN', value: host }])
    cert.setIssuer(this.ca.cert.subject.attributes)
    const altNames: Array<{ type: number; value?: string; ip?: string }> = []
    if (isIP(host)) {
      altNames.push({ type: 7, ip: host })
    } else {
      altNames.push({ type: 2, value: host })
      if (host.includes('.')) {
        altNames.push({ type: 2, value: `*.${host}` })
      }
    }
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames }
    ])
    cert.sign(this.ca.key as forge.pki.rsa.PrivateKey, forge.md.sha256.create())
    return forge.pki.certificateToPem(cert)
  }

  private diskPath(host: string): string {
    const hash = createHash('sha1').update(host).digest('hex')
    return join(this.cacheDir, `${hash}.pem`)
  }

  private readDisk(host: string): string | null {
    try {
      const p = this.diskPath(host)
      if (existsSync(p)) return readFileSync(p, 'utf8')
    } catch {
      /* ignore */
    }
    return null
  }

  private writeDisk(host: string, pem: string): void {
    try {
      writeFileSync(this.diskPath(host), pem)
    } catch {
      /* ignore */
    }
  }

  private pruneDiskCache(): void {
    try {
      const files = readdirSync(this.cacheDir)
        .filter((f) => f.endsWith('.pem'))
        .map((f) => ({ f, mtime: statSync(join(this.cacheDir, f)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime)
      for (let i = 0; i < files.length - DISK_CACHE_MAX; i++) {
        rmSync(join(this.cacheDir, files[i].f))
      }
    } catch {
      /* ignore */
    }
  }

  clearCache(): void {
    this.cache.clear()
    try {
      rmSync(this.cacheDir, { recursive: true, force: true })
      mkdirSync(this.cacheDir, { recursive: true })
    } catch {
      /* ignore */
    }
  }
}

function normalizeHost(hostname: string): string {
  let h = hostname.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (h.endsWith('.')) h = h.slice(0, -1)
  return h || 'localhost'
}
