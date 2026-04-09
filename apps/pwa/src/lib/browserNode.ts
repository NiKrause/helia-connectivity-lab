import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { webRTC } from '@libp2p/webrtc'
import { webSockets } from '@libp2p/websockets'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { dcutr } from '@libp2p/dcutr'
import { identify } from '@libp2p/identify'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { MemoryBlockstore } from 'blockstore-core'
import { MemoryDatastore } from 'datastore-core'
import { createHelia, type HeliaLibp2p } from 'helia'
import { unixfs } from '@helia/unixfs'
import { createLibp2p, type Libp2p } from 'libp2p'
import {
  BULK_MAX_CHUNK_BYTES,
  CONNECTIVITY_BULK_PROTOCOL,
  CONNECTIVITY_ECHO_PROTOCOL,
  DEFAULT_PUBSUB_PEER_DISCOVERY_TOPIC,
} from './protocol.js'
import { readLine, writeLine } from './streamLine.js'
import { ByteStreamReader, encodeFrame, readFramedChunk } from './streamBinary.js'
import { multiaddrsIncludeWebRTC } from './webrtcAddrs.js'

export type DiscoveryRow = {
  peerId: string
  webrtcCapable: boolean
  autoDial: 'skipped' | 'pending' | 'ok' | 'error'
  detail?: string
}

export type DiscoveryListener = (rows: DiscoveryRow[]) => void

function randomPayload(minLen: number, maxLen: number): Uint8Array {
  const len = Math.floor(Math.random() * (maxLen - minLen + 1)) + minLen
  const buf = new Uint8Array(len)
  crypto.getRandomValues(buf)
  return buf
}

export class ConnectivityBrowserNode {
  libp2p: Libp2p | null = null
  helia: HeliaLibp2p<Libp2p> | null = null
  private topic: string
  private readonly onDiscovery: DiscoveryListener
  private readonly discoveryMap = new Map<string, DiscoveryRow>()
  private readonly dialing = new Set<string>()
  private discoveryNotifyTimer: ReturnType<typeof setTimeout> | null = null

  constructor(topic: string, onDiscovery: DiscoveryListener) {
    this.topic = topic.trim() || DEFAULT_PUBSUB_PEER_DISCOVERY_TOPIC
    this.onDiscovery = onDiscovery
  }

  getTopic(): string {
    return this.topic
  }

  setTopic(next: string): void {
    this.topic = next.trim() || DEFAULT_PUBSUB_PEER_DISCOVERY_TOPIC
  }

  private scheduleDiscoveryNotify(): void {
    if (this.discoveryNotifyTimer != null) return
    this.discoveryNotifyTimer = setTimeout(() => {
      this.discoveryNotifyTimer = null
      this.onDiscovery([...this.discoveryMap.values()])
    }, 50)
  }

  async start(): Promise<void> {
    if (this.libp2p != null) return

    const privateKey = await generateKeyPair('Ed25519')
    const topic = this.topic

    const libp2p = await createLibp2p({
      privateKey,
      addresses: {
        listen: ['/p2p-circuit', '/webrtc'],
      },
      transports: [webSockets(), webRTC(), circuitRelayTransport()],
      peerDiscovery: [
        pubsubPeerDiscovery({
          interval: 10_000,
          topics: [topic],
        }),
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
        dcutr: dcutr(),
      },
      connectionGater: {
        denyDialMultiaddr: async () => false,
      },
      start: false,
    } as unknown as Parameters<typeof createLibp2p>[0])

    libp2p.addEventListener('peer:discovery', (evt) => {
      void this.onPeerDiscovered(libp2p, evt.detail.id.toString(), evt.detail.multiaddrs.map((m) => m.toString()))
    })

    await libp2p.start()

    const helia = await createHelia({
      libp2p,
      blockstore: new MemoryBlockstore(),
      datastore: new MemoryDatastore(),
      start: false,
    })
    await helia.start()

    this.libp2p = libp2p
    this.helia = helia
  }

  private async onPeerDiscovered(libp2p: Libp2p, peerIdStr: string, multiaddrs: string[]): Promise<void> {
    if (peerIdStr === libp2p.peerId.toString()) return

    const webrtcCapable = multiaddrsIncludeWebRTC(multiaddrs)
    const row: DiscoveryRow = {
      peerId: peerIdStr,
      webrtcCapable,
      autoDial: webrtcCapable ? 'pending' : 'skipped',
      detail: webrtcCapable ? undefined : 'no WebRTC in advertised addrs',
    }
    this.discoveryMap.set(peerIdStr, row)
    this.scheduleDiscoveryNotify()

    if (!webrtcCapable) return
    if (this.dialing.has(peerIdStr)) return
    this.dialing.add(peerIdStr)

    try {
      const remote = peerIdFromString(peerIdStr)
      await libp2p.dial(remote)
      const cur = this.discoveryMap.get(peerIdStr)
      if (cur) {
        cur.autoDial = 'ok'
        cur.detail = undefined
      }
    } catch (e) {
      const cur = this.discoveryMap.get(peerIdStr)
      if (cur) {
        cur.autoDial = 'error'
        cur.detail = e instanceof Error ? e.message : String(e)
      }
    } finally {
      this.dialing.delete(peerIdStr)
      this.scheduleDiscoveryNotify()
    }
  }

  peerCount(): number {
    return this.libp2p?.getPeers().length ?? 0
  }

  async dialRelay(maStr: string): Promise<void> {
    const node = this.libp2p
    if (!node) throw new Error('node not started')
    await node.dial(multiaddr(maStr))
  }

  async runEcho(maStr: string, message: string): Promise<{ reply: string; ms: number }> {
    const node = this.libp2p
    if (!node) throw new Error('node not started')
    const ma = multiaddr(maStr)
    const t0 = performance.now()
    await node.dial(ma)
    const stream = await node.dialProtocol(ma, CONNECTIVITY_ECHO_PROTOCOL)
    try {
      await writeLine(stream, message)
      const reply = await readLine(stream)
      return { reply, ms: Math.round(performance.now() - t0) }
    } finally {
      try {
        await stream.close()
      } catch {
        // ignore
      }
    }
  }

  async runBulk(
    maStr: string,
    durationMs: number,
    opts: { minChunk?: number; maxChunk?: number; signal?: AbortSignal }
  ): Promise<{ rounds: number; bytesSent: number; bytesRecv: number; error?: string }> {
    const node = this.libp2p
    if (!node) throw new Error('node not started')
    const minChunk = opts.minChunk ?? 512
    const maxChunk = Math.min(opts.maxChunk ?? 32 * 1024, BULK_MAX_CHUNK_BYTES)
    let rounds = 0
    let bytesSent = 0
    let bytesRecv = 0

    const ma = multiaddr(maStr)
    try {
      await node.dial(ma)
      const stream = await node.dialProtocol(ma, CONNECTIVITY_BULK_PROTOCOL)
      const reader = new ByteStreamReader(stream)
      try {
        const end = Date.now() + durationMs
        await stream.sink(
          (async function* () {
            while (Date.now() < end) {
              opts.signal?.throwIfAborted()
              const payload = randomPayload(minChunk, maxChunk)
              yield encodeFrame(payload)
              bytesSent += 4 + payload.length
              const echo = await readFramedChunk(reader, BULK_MAX_CHUNK_BYTES)
              bytesRecv += 4 + echo.length
              rounds++
            }
          })()
        )
      } finally {
        try {
          await stream.close()
        } catch {
          // ignore
        }
      }
      return { rounds, bytesSent, bytesRecv }
    } catch (e) {
      return {
        rounds,
        bytesSent,
        bytesRecv,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  }

  async addFileToHelia(file: File): Promise<{ cid: string }> {
    const h = this.helia
    if (!h) throw new Error('helia not started')
    const fs = unixfs(h)
    const buf = new Uint8Array(await file.arrayBuffer())
    const cid = await fs.addBytes(buf)
    return { cid: cid.toString() }
  }

  async stop(): Promise<void> {
    if (this.helia) {
      try {
        await this.helia.stop()
      } catch {
        // ignore
      }
      this.helia = null
    }
    if (this.libp2p) {
      try {
        await this.libp2p.stop()
      } catch {
        // ignore
      }
      this.libp2p = null
    }
    this.discoveryMap.clear()
    this.dialing.clear()
    this.onDiscovery([])
  }
}
