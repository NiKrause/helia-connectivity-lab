import { randomFillSync, randomInt } from 'node:crypto'
import { createLibp2p } from 'libp2p'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { multiaddr } from '@multiformats/multiaddr'
import { equals } from 'uint8arrays/equals'
import { assertDialablePeerMultiaddr } from './peer-multiaddr-validate.js'
import { createClientLibp2pOptions } from './libp2p-client-config.js'
import {
  BULK_DEFAULT_MAX_CHUNK,
  BULK_DEFAULT_MIN_CHUNK,
  BULK_MAX_CHUNK_BYTES,
} from './bulk-constants.js'
import { CONNECTIVITY_BULK_PROTOCOL } from './protocol.js'
import { ByteStreamReader, encodeFrame, readFramedChunk } from './stream-binary.js'

export type BulkTransferResult = {
  ok: boolean
  durationMs: number
  rounds: number
  bytesSent: number
  bytesRecv: number
  error?: string
}

export type BulkDialOptions = {
  minChunk?: number
  maxChunk?: number
  /** Extra wall-clock time allowed after `durationMs` for in-flight reads (default 120s). */
  graceMs?: number
}

function randomPayload(minLen: number, maxLen: number): Uint8Array {
  const len = randomInt(minLen, maxLen + 1)
  const buf = new Uint8Array(len)
  randomFillSync(buf)
  return buf
}

/**
 * Opens one libp2p connection, dials bulk protocol, sends random framed chunks until `durationMs`
 * elapses; server echoes each frame. Verifies every echo matches.
 *
 * Uses a single `stream.sink` async generator (yield frame, await echo) so the writable half is
 * only sunk once — multiple sequential `sink()` calls are not reliable on libp2p streams.
 */
export async function dialBulkTransfer(
  multiaddrStr: string,
  durationMs: number,
  opts?: BulkDialOptions
): Promise<BulkTransferResult> {
  const minChunk = opts?.minChunk ?? BULK_DEFAULT_MIN_CHUNK
  const maxChunk = Math.min(opts?.maxChunk ?? BULK_DEFAULT_MAX_CHUNK, BULK_MAX_CHUNK_BYTES)
  const graceMs = opts?.graceMs ?? 120_000

  if (minChunk < 1 || maxChunk < minChunk) {
    return {
      ok: false,
      durationMs: 0,
      rounds: 0,
      bytesSent: 0,
      bytesRecv: 0,
      error: 'invalid minChunk/maxChunk',
    }
  }

  const privateKey = await generateKeyPair('Ed25519')
  const libp2p = await createLibp2p(createClientLibp2pOptions(privateKey) as Parameters<typeof createLibp2p>[0])
  await libp2p.start()
  const relayMa = multiaddr(multiaddrStr)
  assertDialablePeerMultiaddr(relayMa)

  const started = Date.now()
  const hardDeadline = started + durationMs + graceMs
  let rounds = 0
  let bytesSent = 0
  let bytesRecv = 0

  try {
    await libp2p.dial(relayMa)
    const stream = await libp2p.dialProtocol(relayMa, CONNECTIVITY_BULK_PROTOCOL)
    const reader = new ByteStreamReader(stream)
    try {
      const transferEnd = started + durationMs
      await stream.sink(
        (async function* () {
          while (Date.now() < transferEnd) {
            if (Date.now() > hardDeadline) {
              throw new Error('hard deadline exceeded')
            }
            const payload = randomPayload(minChunk, maxChunk)
            yield encodeFrame(payload)
            bytesSent += 4 + payload.length

            const echoed = await readFramedChunk(reader, BULK_MAX_CHUNK_BYTES)
            bytesRecv += 4 + echoed.length

            if (!equals(payload, echoed)) {
              throw new Error('echo payload mismatch')
            }
            rounds++
          }
        })()
      )
      return {
        ok: true,
        durationMs: Date.now() - started,
        rounds,
        bytesSent,
        bytesRecv,
      }
    } finally {
      try {
        await stream.close()
      } catch {
        // ignore
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      durationMs: Date.now() - started,
      rounds,
      bytesSent,
      bytesRecv,
      error: msg.replace(/\s+/g, ' ').slice(0, 240),
    }
  } finally {
    await libp2p.stop()
  }
}
