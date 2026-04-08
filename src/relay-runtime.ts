import { createLibp2p } from 'libp2p'
import type { Libp2p } from 'libp2p'
import type { PrivateKey } from '@libp2p/interface'
import { MemoryBlockstore } from 'blockstore-core'
import { MemoryDatastore } from 'datastore-core'
import { createHelia, type HeliaLibp2p } from 'helia'
import { createServerLibp2pOptions, type RelayListenOverrides } from './libp2p-server-config.js'
import { attachLibp2pConnectionLogging, libp2pConnLogEnabledForRelay } from './libp2p-connection-log.js'
import { BULK_MAX_CHUNK_BYTES } from './bulk-constants.js'
import { CONNECTIVITY_BULK_PROTOCOL, CONNECTIVITY_ECHO_PROTOCOL } from './protocol.js'
import { ByteStreamReader, encodeFrame, readFramedChunk } from './stream-binary.js'
import { readLine, writeLine } from './stream-line.js'

export type RelayHelia = HeliaLibp2p<Libp2p>

export type RelayRuntime = {
  libp2p: Libp2p
  helia: RelayHelia
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
  const libp2pOptions = {
    ...(createServerLibp2pOptions(privateKey, overrides) as Record<string, unknown>),
    start: false,
  } as Parameters<typeof createLibp2p>[0]

  const libp2p = await createLibp2p(libp2pOptions)
  if (libp2pConnLogEnabledForRelay()) {
    attachLibp2pConnectionLogging(libp2p, '[relay libp2p]')
    console.log('[relay libp2p] connection logging on (LIBP2P_CONN_LOG or RELAY_LIBP2P_CONN_LOG)')
  }
  attachEchoHandler(libp2p)
  attachBulkHandler(libp2p)

  const helia = await createHelia<typeof libp2p>({
    libp2p,
    blockstore: new MemoryBlockstore(),
    datastore: new MemoryDatastore(),
    start: false,
  })
  await helia.start()

  return {
    libp2p,
    helia,
    listenOverrides: overrides ?? {},
    stop: async () => {
      try {
        await helia.stop()
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
  console.log(
    'Helia: bitswap + unixfs on the same libp2p node (GET /ipfs/<cid> when RELAY_IPFS_GATEWAY=1 on control HTTP, or standalone RELAY_IPFS_HTTP_PORT).'
  )
}
