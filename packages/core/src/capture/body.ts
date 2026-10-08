import {
  gunzipSync,
  brotliDecompressSync,
  inflateSync,
  inflateRawSync
} from 'node:zlib'
import type { BodyMeta, HeaderPair } from '@proxy/shared'

const PREVIEW_LIMIT = 64 * 1024

export interface BodyCaptureResult {
  raw: Buffer
  meta: BodyMeta
}

export function contentTypeOf(headers: HeaderPair[]): string {
  const h = headers.find((x) => x.name.toLowerCase() === 'content-type')
  return h?.value.split(';')[0].trim() ?? ''
}

export function encodingOf(headers: HeaderPair[]): string | undefined {
  const h = headers.find((x) => x.name.toLowerCase() === 'content-encoding')
  const v = h?.value.trim().toLowerCase()
  return v && v !== 'identity' ? v : undefined
}

export function charsetOf(headers: HeaderPair[]): string {
  const h = headers.find((x) => x.name.toLowerCase() === 'content-type')
  if (!h) return 'utf-8'
  const m = /charset=([^;]+)/i.exec(h.value)
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : 'utf-8'
}

export function isTextualContentType(ct: string): boolean {
  if (!ct) return true
  return /^(text\/|application\/(json|xml|javascript|x-javascript|x-www-form-urlencoded|soap|graphql))/i.test(ct)
}

export function decompress(encoding: string | undefined, data: Buffer): Buffer {
  if (!encoding || encoding === 'identity' || data.length === 0) return data
  try {
    switch (encoding) {
      case 'gzip':
      case 'x-gzip':
        return gunzipSync(data)
      case 'deflate':
        try {
          return inflateSync(data)
        } catch {
          return inflateRawSync(data)
        }
      case 'br':
        return brotliDecompressSync(data)
      default:
        return data
    }
  } catch {
    return data
  }
}

export function finalizeBodyCapture(
  raw: Buffer,
  headers: HeaderPair[],
  maxBytes: number
): BodyCaptureResult {
  const contentType = contentTypeOf(headers)
  const encoding = encodingOf(headers)
  const truncated = maxBytes > 0 && raw.length > maxBytes
  const storedRaw = truncated ? raw.subarray(0, maxBytes) : raw
  const meta: BodyMeta = {
    size: raw.length,
    contentType,
    encoding,
    stored: truncated ? 'truncated' : 'inline'
  }
  if (storedRaw.length > 0) {
    const decoded = decompress(encoding, storedRaw)
    const isText = isTextualContentType(contentType)
    if (isText) {
      meta.isText = true
      try {
        const decodedText = decodeBytes(decoded, charsetOf(headers))
        meta.preview = decodedText.slice(0, PREVIEW_LIMIT)
      } catch {
        meta.isText = false
      }
    }
  }
  return { raw: storedRaw, meta }
}

export function decodeBytes(data: Buffer, charset: string): string {
  const cs = charset.toLowerCase()
  if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii') return data.toString('utf8')
  try {
    return new TextDecoder(cs).decode(data)
  } catch {
    return data.toString('utf8')
  }
}
