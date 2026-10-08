import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes, generateKeyPairSync } from 'node:crypto'
import forge from 'node-forge'

export interface CaHandle {
  certPem: string
  keyPem: string
  cert: forge.pki.Certificate
  key: forge.pki.PrivateKey
  der: Buffer
  fingerprintSha256: string
  notBefore: number
  notAfter: number
  subject: string
  serial: string
}

function randomSerial(): string {
  return randomBytes(16).toString('hex')
}

function certToDer(cert: forge.pki.Certificate): Buffer {
  const msg = forge.asn1.toDer((forge.pki as unknown as { certificateToAsn1: (c: forge.pki.Certificate) => forge.asn1.Asn1 }).certificateToAsn1(cert))
  return Buffer.from(msg.data, 'binary')
}

export function loadOrCreateCa(certsDir: string): CaHandle {
  mkdirSync(certsDir, { recursive: true })
  const keyPath = join(certsDir, 'ca.key')
  const certPath = join(certsDir, 'ca.pem')

  if (existsSync(keyPath) && existsSync(certPath)) {
    const keyPem = readFileSync(keyPath, 'utf8')
    const certPem = readFileSync(certPath, 'utf8')
    const key = forge.pki.privateKeyFromPem(keyPem)
    const cert = forge.pki.certificateFromPem(certPem)
    return finalize(keyPem, certPem, key, cert)
  }

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })

  const key = forge.pki.privateKeyFromPem(privateKey)
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey)
  cert.serialNumber = randomSerial()
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000)
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000)
  const attrs = [
    { shortName: 'CN', value: 'Prism Root CA' },
    { shortName: 'O', value: 'Prism' }
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }
  ])
  cert.sign(key, forge.md.sha256.create())

  const keyPem = forge.pki.privateKeyToPem(key)
  const certPem = forge.pki.certificateToPem(cert)
  writeFileSync(keyPath, keyPem, { mode: 0o600 })
  chmodSync(keyPath, 0o600)
  writeFileSync(certPath, certPem)

  return finalize(keyPem, certPem, key, cert)
}

function finalize(
  keyPem: string,
  certPem: string,
  key: forge.pki.PrivateKey,
  cert: forge.pki.Certificate
): CaHandle {
  const der = certToDer(cert)
  return {
    certPem,
    keyPem,
    cert,
    key,
    der,
    fingerprintSha256: createHash('sha256').update(der).digest('hex').toUpperCase().replace(/(..)(?=.)/g, '$1:'),
    notBefore: cert.validity.notBefore.getTime(),
    notAfter: cert.validity.notAfter.getTime(),
    subject: cert.subject.attributes.map((a) => `${a.shortName}=${a.value}`).join(', '),
    serial: cert.serialNumber
  }
}
