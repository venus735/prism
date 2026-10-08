export interface WsFrame {
  fin: boolean
  opcode: number
  payload: Buffer
}

/** 被动解析 RFC6455 帧的增量解析器（透传原始字节，不参与协议） */
export class WsFrameParser {
  private buffer: Buffer = Buffer.alloc(0)
  private fragments: { opcode: number; parts: Buffer[] } | null = null
  private onFrame: (frame: WsFrame) => void

  constructor(onFrame: (frame: WsFrame) => void) {
    this.onFrame = onFrame
  }

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      const frame = this.tryParseFrame()
      if (!frame) return
      if (frame.opcode === 0) {
        // continuation
        if (this.fragments) {
          this.fragments.parts.push(frame.payload)
          if (frame.fin) {
            const { opcode, parts } = this.fragments
            this.fragments = null
            this.onFrame({ fin: true, opcode, payload: Buffer.concat(parts) })
          }
        }
      } else if (frame.opcode >= 0x8) {
        // control frames may interleave fragmentation
        this.onFrame(frame)
      } else {
        if (frame.fin) {
          this.onFrame(frame)
        } else {
          this.fragments = { opcode: frame.opcode, parts: [frame.payload] }
        }
      }
    }
  }

  private tryParseFrame(): WsFrame | null {
    const buf = this.buffer
    if (buf.length < 2) return null
    const b0 = buf[0]
    const b1 = buf[1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let offset = 2
    if (len === 126) {
      if (buf.length < offset + 2) return null
      len = buf.readUInt16BE(offset)
      offset += 2
    } else if (len === 127) {
      if (buf.length < offset + 8) return null
      const big = buf.readBigUInt64BE(offset)
      offset += 8
      len = Number(big)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        // 超大帧：放弃解析，避免内存爆炸
        return null
      }
    }
    const maskKey = masked ? buf.subarray(offset, offset + 4) : null
    if (masked) offset += 4
    if (buf.length < offset + len) return null
    let payload = buf.subarray(offset, offset + len)
    if (maskKey) {
      const unmasked = Buffer.allocUnsafe(len)
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i & 3]
      payload = unmasked
    }
    this.buffer = buf.subarray(offset + len)
    return { fin, opcode, payload }
  }
}
