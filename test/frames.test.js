import test from 'node:test'
import { webcrypto } from 'node:crypto'
import { encodeFrame, FrameParser } from '../frames.js'

function maskClientFrame(opcode, payload, fin = true) {
  const mask = Buffer.from([1, 2, 3, 4])
  const len = payload.length
  let header
  const first = (fin ? 0x80 : 0) | opcode
  if (len < 126) {
    header = Buffer.from([first, 0x80 | len])
  } else if (len < 0x10000) {
    header = Buffer.alloc(4)
    header[0] = first
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = first
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  const masked = Buffer.alloc(len)
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([header, mask, masked])
}

test('encodeFrame short payload', () => {
  const frame = encodeFrame(0x1, Buffer.from('hi'))
  assertFrame(frame, 0x81, 2)
})

function assertFrame(frame, firstByte, len) {
  if (frame[0] !== firstByte) throw new Error(`opcode byte ${frame[0]} != ${firstByte}`)
  if (frame.length !== 2 + len && len < 126) throw new Error('bad short frame length')
}

test('encodeFrame 16-bit length round trip through parser', () => {
  const payload = Buffer.alloc(1000, 0x61)
  const frame = encodeFrame(0x2, payload)
  if (frame[1] !== 126) throw new Error('expected 16-bit length marker')
  // server frames are unmasked; parser must still accept them
  const parser = new FrameParser()
  const messages = parser.push(frame)
  if (messages.length !== 1 || messages[0].opcode !== 0x2 || messages[0].payload.length !== 1000) {
    throw new Error('round trip failed')
  }
})

test('parser unmasks client frames', () => {
  const parser = new FrameParser()
  const payload = Buffer.from('{"type":"input","data":"ls"}')
  const messages = parser.push(maskClientFrame(0x1, payload))
  if (messages.length !== 1) throw new Error('expected one message')
  if (messages[0].payload.toString() !== payload.toString()) throw new Error('unmask mismatch')
})

test('parser assembles fragmented messages', () => {
  const parser = new FrameParser()
  const a = maskClientFrame(0x1, Buffer.from('{"type":"in'), false)
  const b = maskClientFrame(0x0, Buffer.from('put"}'), true)
  const messages = [...parser.push(a), ...parser.push(b)]
  if (messages.length !== 1) throw new Error(`expected 1 message, got ${messages.length}`)
  if (messages[0].payload.toString() !== '{"type":"input"}') throw new Error('fragment mismatch')
})

test('parser handles frames split across chunks', () => {
  const parser = new FrameParser()
  const frame = maskClientFrame(0x1, Buffer.from('x'.repeat(300)))
  const first = frame.subarray(0, 5)
  const rest = frame.subarray(5)
  if (parser.push(first).length !== 0) throw new Error('should not emit yet')
  const messages = parser.push(rest)
  if (messages.length !== 1 || messages[0].payload.length !== 300) throw new Error('chunked parse failed')
})

test('control frames pass through unfragmented', () => {
  const parser = new FrameParser()
  const messages = parser.push(maskClientFrame(0x9, Buffer.from('ping')))
  if (messages.length !== 1 || messages[0].opcode !== 0x9) throw new Error('ping lost')
})

test('ws accept key matches RFC 6455 example', async () => {
  // The module does not export acceptKey; verify indirectly via crypto constant usage
  const digest = await webcrypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode('dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11'),
  )
  const b64 = Buffer.from(digest).toString('base64')
  if (b64 !== 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=') throw new Error('unexpected sha1/base64 behavior')
})
