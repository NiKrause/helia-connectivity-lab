import { createLibp2p } from 'libp2p'
import type { Libp2p } from 'libp2p'
import type { PrivateKey } from '@libp2p/interface'
import { createServerLibp2pOptions, type RelayListenOverrides } from './libp2p-server-config.js'
import { BULK_MAX_CHUNK_BYTES } from './bulk-constants.js'
import { CONNECTIVITY_BULK_PROTOCOL, CONNECTIVITY_ECHO_PROTOCOL } from './protocol.js'
import { ByteStreamReader, encodeFrame, readFramedChunk } from './stream-binary.js'
import { readLine, writeLine } from './stream-line.js'

export type RelayRuntime = {
  libp2p: Libp2p
  listenOverrides: RelayListenOverrides
  stop: () => Promise<void>
}

function attachBulkHandler(libp2p: Libp2p): void {
  libp2p.handle(CONNECTIVITY_BULK_PROTOCOL, async ({ stream }) => {
    try {
      const reader = new ByteStreamReader(stream)
      await stream.sink(
        (async function* () {
          for (;;) {
            let payload: Uint8Array
            try {
              payload = await readFramedChunk(reader, BULK_MAX_CHUNK_BYTES)
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e)
              if (msg.includes('stream ended')) return
              throw e
            }
            if (payload.length === 0) return
            yield encodeFrame(payload)
          }
        })()
      )
    } catch (err) {
      console.error('connectivity-bulk handler error:', err)
    } finally {
      try {
        await stream.close()
      } catch {
        // ignore
      }
    }
  })
}

function attachEchoHandler(libp2p: Libp2p): void {
  libp2p.handle(CONNECTIVITY_ECHO_PROTOCOL, async ({ stream }) => {
    try {
      const line = await readLine(stream)
      const reply = line.length > 0 ? `echo:${line}` : 'echo:(empty)'
      await writeLine(stream, reply)
    } catch (err) {
      console.error('connectivity-echo handler error:', err)
    } finally {
      try {
        await stream.close()
      } catch {
        // ignore
      }
    }
  })
}

export async function startRelayRuntime(privateKey: PrivateKey, overrides?: RelayListenOverrides): Promise<RelayRuntime> {
  const libp2p = await createLibp2p(
    createServerLibp2pOptions(privateKey, overrides) as Parameters<typeof createLibp2p>[0]
  )
  attachEchoHandler(libp2p)
  attachBulkHandler(libp2p)
  await libp2p.start()

  return {
    libp2p,
    listenOverrides: overrides ?? {},
    stop: async () => {
      try {
        await libp2p.stop()
      } catch {
        // ignore
      }
    },
  }
}

export function logRelayBanner(libp2p: Libp2p): void {
  console.log('Relay + echo server peerId:', libp2p.peerId.toString())
  console.log('Listen addresses:')
  for (const ma of libp2p.getMultiaddrs()) {
    console.log(' ', ma.toString())
  }
  console.log('')
  console.log(
    'Dial one of the above from the client (include /p2p/<peerId> for remote hosts). Transports: TCP, WebSocket (cleartext WS + Noise; not WSS/AutoTLS), QUIC (/quic-v1 UDP), WebRTC-Direct (/webrtc-direct + certhash).'
  )
  console.log('Protocols:', CONNECTIVITY_ECHO_PROTOCOL, CONNECTIVITY_BULK_PROTOCOL)
}
