import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { quic } from '@chainsafe/libp2p-quic'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { webRTCDirect } from '@libp2p/webrtc'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import type { PrivateKey } from '@libp2p/interface'

function readClientEnv() {
  const disableWebRtc =
    process.env.CLIENT_DISABLE_WEBRTC === 'true' ||
    process.env.CLIENT_DISABLE_WEBRTC === '1' ||
    process.env.CLIENT_DISABLE_WEBRTC_DIRECT === 'true'
  const disableQuic = process.env.CLIENT_DISABLE_QUIC === 'true' || process.env.CLIENT_DISABLE_QUIC === '1'
  return { disableWebRtc, disableQuic }
}

export function createClientLibp2pOptions(privateKey: PrivateKey): Record<string, unknown> {
  const e = readClientEnv()

  const transports = [
    circuitRelayTransport(),
    tcp(),
    webSockets(),
    ...(!e.disableQuic ? [quic()] : []),
    ...(!e.disableWebRtc ? [webRTCDirect()] : []),
  ]

  const listen = ['/ip4/127.0.0.1/tcp/0', '/ip4/127.0.0.1/tcp/0/ws']
  if (!e.disableQuic) {
    listen.push('/ip4/127.0.0.1/udp/0/quic-v1')
  }

  return {
    privateKey,
    addresses: { listen },
    transports,
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
    },
    connectionGater: {
      denyDialMultiaddr: async () => false,
    },
  } as Record<string, unknown>
}
