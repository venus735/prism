/**
 * gRPC 被动解析：
 * - GrpcFrameParser：增量解析 gRPC / gRPC-Web 的 5 字节长度前缀帧（1 flags + 4 BE length）
 * - decodeProtobufToText：无 schema 的 protobuf wire-format 解码（字段号/wire type/varint/嵌套），用于消息时间线展示
 */

export interface GrpcFrame {
  flags: number
  payload: Buffer
}

/** 单帧上限：超过视为流损坏（正常 gRPC 消息不会超过此值），丢弃缓冲防止内存膨胀 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024

export function isGrpcContentType(contentType: string | undefined): boolean {
  if (!contentType) return false
  const ct = contentType.trim().toLowerCase()
  return ct === 'application/grpc' || ct.startsWith('application/grpc+') || ct.startsWith('application/grpc-web')
}

/** grpc（非 grpc-web）要求 HTTP/2 上游；grpc-web 面向浏览器，普通 HTTP/1.1 即可 */
export function needsH2Upstream(contentType: string | undefined): boolean {
  if (!contentType) return false
  const ct = contentType.trim().toLowerCase()
  return ct === 'application/grpc' || ct.startsWith('application/grpc+')
}

/** +json/+text 子类型的帧负载是文本而非 protobuf */
export function grpcBodyIsText(contentType: string | undefined): boolean {
  const ct = (contentType ?? '').trim().toLowerCase()
  return ct.includes('+json') || ct.includes('+text')
}

export class GrpcFrameParser {
  private buf: Buffer = Buffer.alloc(0)

  constructor(private onFrame: (frame: GrpcFrame) => void) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    for (;;) {
      if (this.buf.length < 5) return
      const len = this.buf.readUInt32BE(1)
      if (len > MAX_FRAME_BYTES) {
        this.buf = Buffer.alloc(0)
        return
      }
      if (this.buf.length < 5 + len) return
      const flags = this.buf[0]
      const payload = this.buf.subarray(5, 5 + len)
      this.buf = this.buf.subarray(5 + len)
      this.onFrame({ flags, payload })
    }
  }
}

// ---------------------------------------------------------------------------
// protobuf wire-format 解码（无 schema）
// ---------------------------------------------------------------------------

const MAX_DEPTH = 8
const HEX_PREVIEW_BYTES = 256

export function decodeProtobufToText(buf: Buffer): string {
  try {
    return decodeMessage(buf, 0).join('\n')
  } catch {
    return hexPreview(buf)
  }
}

function decodeMessage(buf: Buffer, depth: number): string[] {
  const lines: string[] = []
  let pos = 0
  while (pos < buf.length) {
    const tag = readVarint(buf, pos)
    pos = tag.next
    const fieldNo = Number(tag.value >> 3n)
    const wireType = Number(tag.value & 7n)
    if (fieldNo === 0) throw new Error('field 0')
    switch (wireType) {
      case 0: {
        const v = readVarint(buf, pos)
        pos = v.next
        lines.push(`${fieldNo}: ${varintText(v.value)}`)
        break
      }
      case 1: {
        if (pos + 8 > buf.length) throw new Error('short i64')
        lines.push(`${fieldNo}: ${buf.readBigUInt64BE(pos)}`)
        pos += 8
        break
      }
      case 2: {
        const len = readVarint(buf, pos)
        pos = len.next
        const size = Number(len.value)
        if (size < 0 || pos + size > buf.length) throw new Error('short len')
        const inner = buf.subarray(pos, pos + size)
        pos += size
        lines.push(...decodeLenDelimited(fieldNo, inner, depth))
        break
      }
      case 5: {
        if (pos + 4 > buf.length) throw new Error('short i32')
        lines.push(`${fieldNo}: ${buf.readUInt32BE(pos)}`)
        pos += 4
        break
      }
      default:
        throw new Error(`wire type ${wireType}`)
    }
  }
  return lines
}

function decodeLenDelimited(fieldNo: number, inner: Buffer, depth: number): string[] {
  if (inner.length === 0) return [`${fieldNo}: ""`]
  // 先尝试嵌套 message：能完整消费且结构合法才算
  if (depth < MAX_DEPTH) {
    try {
      const nested = decodeMessage(inner, depth + 1)
      if (nested.length > 0) {
        const indent = nested.map((l) => `  ${l}`)
        return [`${fieldNo}: {`, ...indent, `}`]
      }
    } catch {
      /* 不是合法嵌套 message，继续尝试文本 */
    }
  }
  if (isPrintable(inner)) {
    return [`${fieldNo}: "${inner.toString('utf8')}"`]
  }
  return [`${fieldNo}: ${hexPreview(inner)}`]
}

function readVarint(buf: Buffer, pos: number): { value: bigint; next: number } {
  let value = 0n
  let shift = 0n
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new Error('short varint')
    const b = buf[pos++]
    value |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) return { value, next: pos }
    shift += 7n
  }
  throw new Error('varint too long')
}

function varintText(value: bigint): string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? String(value) : `${value} (0x${value.toString(16)})`
}

function isPrintable(buf: Buffer): boolean {
  for (const b of buf) {
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return false
    if (b >= 0x7f) return false
  }
  return true
}

function hexPreview(buf: Buffer): string {
  const slice = buf.subarray(0, HEX_PREVIEW_BYTES)
  const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ')
  return `hex(${buf.length}B)${buf.length > HEX_PREVIEW_BYTES ? ' …' : ''}: ${hex}`
}
