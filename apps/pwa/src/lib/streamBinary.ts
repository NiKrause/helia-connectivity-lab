import type { Stream } from '@libp2p/interface'

function chunkToUint8Array(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk
  if (chunk != null && typeof chunk === 'object' && 'subarray' in chunk) {
    return (chunk as { subarray: (start?: number, end?: number) => Uint8Array }).subarray()
  }
  throw new TypeError('Unexpected stream chunk type')
}

export class ByteStreamReader {
  private carry = new Uint8Array(0)
  private readonly iter: AsyncIterator<unknown>

  constructor(private readonly stream: Stream) {
    this.iter = stream.source[Symbol.asyncIterator]()
  }

  async readExactly(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n)
    let o = 0
    while (o < n) {
      if (this.carry.length === 0) {
        const { value, done } = await this.iter.next()
        if (done) {
          throw new Error(`stream ended after ${o} of ${n} bytes`)
        }
        this.carry = new Uint8Array(chunkToUint8Array(value))
      }
      const use = Math.min(n - o, this.carry.length)
      out.set(this.carry.subarray(0, use), o)
      o += use
      this.carry = this.carry.subarray(use)
    }
    return out
  }
}

export function encodeU32be(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, false)
  return b
}

export function decodeU32be(b: Uint8Array): number {
  return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, false)
}

export function encodeFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.length)
  frame.set(encodeU32be(payload.length), 0)
  frame.set(payload, 4)
  return frame
}

export async function readFramedChunk(reader: ByteStreamReader, maxPayload: number): Promise<Uint8Array> {
  const lenBuf = await reader.readExactly(4)
  const len = decodeU32be(lenBuf)
  if (len > maxPayload) {
    throw new Error(`frame length ${len} exceeds max ${maxPayload}`)
  }
  if (len === 0) {
    return new Uint8Array(0)
  }
  return reader.readExactly(len)
}
