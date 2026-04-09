import type { Stream } from '@libp2p/interface'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function chunkToUint8Array(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk
  if (chunk != null && typeof chunk === 'object' && 'subarray' in chunk) {
    return (chunk as { subarray: (start?: number, end?: number) => Uint8Array }).subarray()
  }
  throw new TypeError('Unexpected stream chunk type')
}

export async function readLine(stream: Stream): Promise<string> {
  let buf = ''
  for await (const chunk of stream.source) {
    const u8 = chunkToUint8Array(chunk)
    buf += textDecoder.decode(u8, { stream: true })
    const i = buf.indexOf('\n')
    if (i !== -1) {
      return buf.slice(0, i).trim()
    }
  }
  return buf.trim()
}

export async function writeLine(stream: Stream, line: string): Promise<void> {
  await stream.sink(
    (async function* () {
      yield textEncoder.encode(`${line}\n`)
    })()
  )
}
