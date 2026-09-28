/** RFC 6455 framing helpers (see index.js header for the wire protocol). */

export function encodeFrame(opcode, payload) {
  const body = payload ?? Buffer.alloc(0)
  const len = body.length
  let header
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len < 0x10000) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, body])
}

export class FrameParser {
  constructor() {
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentOpcode = 0
  }

  /** Feed raw bytes; returns an array of complete messages { opcode, payload }. */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const out = []
    for (;;) {
      const frame = this.#readFrame()
      if (!frame) break
      const { fin, opcode, payload } = frame
      if (opcode === 0x8 || opcode === 0x9 || opcode === 0xA) {
        out.push({ opcode, payload })
        continue
      }
      if (!fin) {
        if (opcode !== 0) this.fragmentOpcode = opcode
        this.fragments.push(payload)
        continue
      }
      if (this.fragments.length > 0) {
        this.fragments.push(payload)
        out.push({ opcode: this.fragmentOpcode, payload: Buffer.concat(this.fragments) })
        this.fragments = []
        this.fragmentOpcode = 0
      } else {
        out.push({ opcode, payload })
      }
    }
    return out
  }

  #readFrame() {
    const buf = this.buffer
    if (buf.length < 2) return null
    const fin = (buf[0] & 0x80) !== 0
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let len = buf[1] & 0x7f
    let offset = 2
    if (len === 126) {
      if (buf.length < offset + 2) return null
      len = buf.readUInt16BE(offset)
      offset += 2
    } else if (len === 127) {
      if (buf.length < offset + 8) return null
      len = Number(buf.readBigUInt64BE(offset))
      offset += 8
    }
    const maskLen = masked ? 4 : 0
    if (buf.length < offset + maskLen + len) return null
    let payload = buf.subarray(offset + maskLen, offset + maskLen + len)
    if (masked) {
      const mask = buf.subarray(offset, offset + 4)
      const unmasked = Buffer.allocUnsafe(len)
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i & 3]
      payload = unmasked
    } else {
      payload = Buffer.from(payload)
    }
    this.buffer = buf.subarray(offset + maskLen + len)
    return { fin, opcode, payload }
  }
}
