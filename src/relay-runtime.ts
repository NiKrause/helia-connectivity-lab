import { createLibp2p } from 'libp2p'
import type { Libp2p } from 'libp2p'
import type { PrivateKey } from '@libp2p/interface'
import { createServerLibp2pOptions, type RelayListenOverrides } from './libp2p-server-config.js'
import { CONNECTIVITY_ECHO_PROTOCOL } from './protocol.js'
import { readLine, writeLine } from './stream-line.js'

export type RelayRuntime = {
  libp2p: Libp2p
  listenOverrides: RelayListenOverrides
  stop: () => Promise<void>
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
    'Dial one of the above from the client (include /p2p/<peerId> for remote hosts). Transports: TCP, WebSocket (cleartext WS + Noise; not WSS/AutoTLS), WebRTC-Direct (/webrtc-direct + certhash). QUIC: optional via @chainsafe/libp2p-quic 1.1.x (see README).'
  )
  console.log('Protocol:', CONNECTIVITY_ECHO_PROTOCOL)
}
