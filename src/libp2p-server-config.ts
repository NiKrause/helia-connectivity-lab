import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { identify, identifyPush } from '@libp2p/identify'
import { webRTCDirect } from '@libp2p/webrtc'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import type { PrivateKey } from '@libp2p/interface'

export type RelayListenEnv = {
  tcpPort: number
  wsPort: number
  webrtcPort: number
  listenIpv4: string
  disableIpv6: boolean
  disableWebRtc: boolean
}

export type RelayListenOverrides = Partial<RelayListenEnv>

export function readListenEnv(): RelayListenEnv {
  const tcpPort = Number(process.env.RELAY_TCP_PORT || 9091)
  const wsPort = Number(process.env.RELAY_WS_PORT || 9092)
  const webrtcPort = Number(process.env.RELAY_WEBRTC_PORT || 9093)
  const listenIpv4 = process.env.RELAY_LISTEN_IPV4 || '0.0.0.0'
  const disableIpv6 = process.env.RELAY_DISABLE_IPV6 === 'true' || process.env.RELAY_DISABLE_IPV6 === '1'
  const disableWebRtc =
    process.env.RELAY_DISABLE_WEBRTC === 'true' ||
    process.env.RELAY_DISABLE_WEBRTC === '1' ||
    process.env.RELAY_DISABLE_WEBRTC_DIRECT === 'true'
  return { tcpPort, wsPort, webrtcPort, listenIpv4, disableIpv6, disableWebRtc }
}

export function createServerLibp2pOptions(privateKey: PrivateKey, overrides?: RelayListenOverrides): Record<string, unknown> {
  const e = { ...readListenEnv(), ...overrides }

  const listen: string[] = [
    `/ip4/${e.listenIpv4}/tcp/${e.tcpPort}`,
    `/ip4/${e.listenIpv4}/tcp/${e.wsPort}/ws`,
  ]
  if (!e.disableWebRtc) {
    listen.push(`/ip4/${e.listenIpv4}/udp/${e.webrtcPort}/webrtc-direct`)
  }
  if (!e.disableIpv6) {
    listen.push(`/ip6/::/tcp/${e.tcpPort}`, `/ip6/::/tcp/${e.wsPort}/ws`)
    if (!e.disableWebRtc) {
      listen.push(`/ip6/::/udp/${e.webrtcPort}/webrtc-direct`)
    }
  }

  const transports = [
    circuitRelayTransport(),
    tcp(),
    webSockets(),
    ...(!e.disableWebRtc ? [webRTCDirect()] : []),
  ]

  return {
    privateKey,
    addresses: { listen },
    transports,
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      identifyPush: identifyPush(),
      relay: circuitRelayServer({
        hopTimeout: 30_000,
        reservations: {
          maxReservations: 15,
          reservationTtl: 60 * 60 * 1000,
          defaultDataLimit: BigInt(1 << 20),
          defaultDurationLimit: 120_000,
        },
      }),
    },
    connectionGater: {
      denyDialMultiaddr: async () => false,
    },
  } as Record<string, unknown>
}
