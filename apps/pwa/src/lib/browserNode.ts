import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { webRTC, webRTCDirect } from '@libp2p/webrtc'
import { bootstrap } from '@libp2p/bootstrap'
import { webSockets } from '@libp2p/websockets'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { dcutr } from '@libp2p/dcutr'
import { identify, identifyPush } from '@libp2p/identify'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { MemoryBlockstore } from 'blockstore-core'
import { MemoryDatastore } from 'datastore-core'
import { createHelia, type HeliaLibp2p } from 'helia'
import { unixfs } from '@helia/unixfs'
import { createLibp2p, type Libp2p } from 'libp2p'
import type { Message as PubsubMessage } from '@libp2p/interface'
import {
  BULK_MAX_CHUNK_BYTES,
  CONNECTIVITY_BULK_PROTOCOL,
  CONNECTIVITY_ECHO_PROTOCOL,
  DEFAULT_PUBSUB_PEER_DISCOVERY_TOPIC,
} from './protocol.js'
import { readLine, writeLine } from './streamLine.js'
import { ByteStreamReader, encodeFrame, readFramedChunk } from './streamBinary.js'
import { discoveryAutoDialDetail } from './webrtcAddrs.js'

/** How long the PWA shows the green flashing LED after each `peer:discovery` (ms). */
export const PEER_DISCOVERY_FLASH_MS = 1200

export type DiscoveryRow = {
  peerId: string
  /** Multiaddrs from the latest `peer:discovery` event payload (for UI tooltip). */
  discoveryAddrs: string[]
  /** `Date.now()` value until which the UI shows the flash (exclusive of LED after this). */
  discoveryFlashUntilMs: number
  /** True when we try auto dial(peerId): public WebRTC-Direct and/or `/p2p-circuit/p2p/…` in the advert. */
  autoDialEligible: boolean
  autoDial: 'skipped' | 'pending' | 'ok' | 'error'
  detail?: string
}

export type DiscoveryListener = (rows: DiscoveryRow[]) => void

/** Circuit relay v2 client: reservation denied or other reserve failure on a relay peer. */
export type RelayReservationUiEvent =
  | { type: 'error'; relayPeerId: string; message: string; at: number }
  | { type: 'reserved'; relayPeerId: string; at: number }

export type RelayReservationUiListener = (ev: RelayReservationUiEvent) => void

/** Optional UI hooks for pubsub peer-discovery visibility (e.g. LEDs in the PWA). */
export type PubsubDiscoveryUiHooks = {
  /** Fires after gossipsub successfully publishes on the discovery topic (our periodic advertisement). */
  onDiscoveryAdvertPublished?: () => void
  /**
   * Fires for each **inbound** gossipsub `message` on the discovery topic from another peer (signed msgs only).
   * `fromPeerId` is the libp2p peer that signed the message (compare to `GET /status` `peerId` to spot the relay).
   */
  onRemoteDiscoveryAdvertReceived?: (info: { fromPeerId: string }) => void
}

export type BrowserNodeDebugEvent = {
  type: string
  at: number
  peerId?: string
  addr?: string | null
  topic?: string
  detail?: string
}

export type BrowserNodeDebugSnapshot = {
  topic: string
  localPeerId: string | null
  ownMultiaddrs: string[]
  peerCount: number
  discoveryRows: DiscoveryRow[]
  connections: Array<{ peerId: string; addr: string }>
  topicSubscribers: string[]
  events: BrowserNodeDebugEvent[]
}

type ReservationStoreInternals = {
  addRelay: (peerId: { toString: () => string }, type: string) => Promise<unknown>
  addEventListener: (name: 'relay:created-reservation', fn: (evt: CustomEvent<{ relay: { toString: () => string } }>) => void) => void
  removeEventListener: (name: 'relay:created-reservation', fn: (evt: CustomEvent<{ relay: { toString: () => string } }>) => void) => void
}

/** `components` exists at runtime; omitted from public `Libp2p` typings in some versions. */
type Libp2pInternals = Libp2p & {
  components: { transportManager: { getTransports: () => unknown[] } }
}

function findCircuitReservationStore(libp2p: Libp2p): ReservationStoreInternals | null {
  const transports = (libp2p as Libp2pInternals).components.transportManager.getTransports()
  for (const t of transports) {
    if (t != null && typeof t === 'object' && 'reservationStore' in t) {
      return (t as { reservationStore: ReservationStoreInternals }).reservationStore
    }
  }
  return null
}

function randomPayload(minLen: number, maxLen: number): Uint8Array {
  const len = Math.floor(Math.random() * (maxLen - minLen + 1)) + minLen
  const buf = new Uint8Array(len)
  crypto.getRandomValues(buf)
  return buf
}

function scoreDialMultiaddr(ma: string): number {
  let score = 0
  if (ma.includes('/webrtc')) score += 100
  if (ma.includes('/webtransport')) score += 80
  if (ma.includes('/tls/')) score += 20
  if (ma.includes('/ws')) score += 10
  if (ma.includes('/p2p-circuit')) score -= 30
  return score
}

function isDialableDiscoveryMultiaddr(ma: string): boolean {
  return ma.includes('/webrtc') || ma.includes('/webtransport') || ma.includes('/ws') || ma.includes('/p2p-circuit')
}

const DEFAULT_RTC_CONFIGURATION = {
  iceServers: [
    {
      urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'],
    },
  ],
}

export class ConnectivityBrowserNode {
  libp2p: Libp2p | null = null
  helia: HeliaLibp2p<Libp2p> | null = null
  private topic: string
  private readonly bootstrapAddrs: string[]
  private readonly onDiscovery: DiscoveryListener
  private readonly onRelayReservationUi?: RelayReservationUiListener
  private readonly pubsubDiscoveryUi?: PubsubDiscoveryUiHooks
  private readonly discoveryMap = new Map<string, DiscoveryRow>()
  private readonly dialing = new Set<string>()
  private readonly lastAutoDialFingerprint = new Map<string, string>()
  private discoveryNotifyTimer: ReturnType<typeof setTimeout> | null = null
  private reservationStoreHooked = false
  private reservationStoreRef: ReservationStoreInternals | null = null
  private gossipsubInboundBound: ((e: CustomEvent<PubsubMessage>) => void) | null = null
  private gossipsubInboundSvc: EventTarget | null = null
  private peerUpdateEvents: EventTarget | null = null
  private peerUpdateBound: ((e: Event) => void) | null = null
  private readonly onRelayCreatedBound: (evt: CustomEvent<{ relay: { toString: () => string } }>) => void
  private connectionOpenBound: ((evt: Event) => void) | null = null
  private connectionCloseBound: ((evt: Event) => void) | null = null
  private peerIdentifyBound: ((evt: Event) => void) | null = null
  private readonly debugEvents: BrowserNodeDebugEvent[] = []

  constructor(
    topic: string,
    bootstrapAddrs: string[] = [],
    onDiscovery: DiscoveryListener,
    onRelayReservationUi?: RelayReservationUiListener,
    pubsubDiscoveryUi?: PubsubDiscoveryUiHooks
  ) {
    this.topic = topic.trim() || DEFAULT_PUBSUB_PEER_DISCOVERY_TOPIC
    this.bootstrapAddrs = [...bootstrapAddrs]
    this.onDiscovery = onDiscovery
    this.onRelayReservationUi = onRelayReservationUi
    this.pubsubDiscoveryUi = pubsubDiscoveryUi
    this.onRelayCreatedBound = (evt) => {
      this.pushDebugEvent({
        type: 'relay:reservation:created',
        at: Date.now(),
        peerId: evt.detail.relay.toString(),
      })
      this.onRelayReservationUi?.({
        type: 'reserved',
        relayPeerId: evt.detail.relay.toString(),
        at: Date.now(),
      })
    }
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

  private pushDebugEvent(event: BrowserNodeDebugEvent): void {
    this.debugEvents.push(event)
    if (this.debugEvents.length > 200) {
      this.debugEvents.splice(0, this.debugEvents.length - 200)
    }
  }

  async start(): Promise<void> {
    if (this.libp2p != null) return

    const privateKey = await generateKeyPair('Ed25519')
    const topic = this.topic
    const bootstrapAddrs = this.bootstrapAddrs

    const libp2p = await createLibp2p({
      privateKey,
      addresses: {
        listen: ['/p2p-circuit', '/webrtc'],
      },
      transports: [
        webSockets(),
        webRTCDirect({ rtcConfiguration: DEFAULT_RTC_CONFIGURATION }),
        webRTC({ rtcConfiguration: DEFAULT_RTC_CONFIGURATION }),
        circuitRelayTransport({
          reservationCompletionTimeout: 20_000,
        }),
      ],
      peerDiscovery: [
        pubsubPeerDiscovery(
          {
            interval: 3_000,
            emitSelf: true,
            listenOnly: false,
            topics: [topic],
          } as Parameters<typeof pubsubPeerDiscovery>[0] & { emitSelf: boolean }
        ),
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        identifyPush: identifyPush(),
        pubsub: gossipsub({
          emitSelf: false,
          allowPublishToZeroTopicPeers: true,
          /** Gossipsub skips limited connections by default; browser↔relay paths can be tagged limited in some setups. */
          runOnLimitedConnection: true,
        }),
        ...(bootstrapAddrs.length > 0
          ? {
              bootstrap: bootstrap({
                list: bootstrapAddrs,
              }),
            }
          : {}),
        dcutr: dcutr(),
      },
      connectionGater: {
        denyDialMultiaddr: async () => false,
      },
      start: false,
    } as unknown as Parameters<typeof createLibp2p>[0])

    libp2p.addEventListener('peer:discovery', (evt) => {
      this.pushDebugEvent({
        type: 'peer:discovery',
        at: Date.now(),
        peerId: evt.detail.id.toString(),
        detail: evt.detail.multiaddrs.map((m) => m.toString()).join(', '),
      })
      void this.onPeerDiscovered(libp2p, evt.detail.id.toString(), evt.detail.multiaddrs.map((m) => m.toString()))
    })

    this.hookPeerStoreUpdatesForDiscovery(libp2p)
    this.hookConnectionDebugEvents(libp2p)

    await libp2p.start()
    this.pushDebugEvent({
      type: 'node:start',
      at: Date.now(),
      peerId: libp2p.peerId.toString(),
      topic,
    })

    /**
     * After start: gossipsub has initialized `publishConfig` (required for publish), and the pubsub instance
     * is the one that will receive mesh traffic for the node’s lifetime.
     */
    this.hookGossipsubPublishForDiscoveryUi(libp2p, topic)
    this.hookGossipsubInboundDiscoveryUi(libp2p, topic)
    this.hookCircuitRelayReservationUi(libp2p)

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

  /**
   * After a successful `publish` on the discovery topic, notify UI (our pubsub-peer-discovery broadcast).
   * `@libp2p/pubsub-peer-discovery` skips publish when `getSubscribers(topic).length === 0`, so no flash until mesh has peers.
   */
  private hookGossipsubPublishForDiscoveryUi(libp2p: Libp2p, discoveryTopic: string): void {
    const cb = this.pubsubDiscoveryUi?.onDiscoveryAdvertPublished
    if (cb == null) return
    const svc = libp2p.services?.pubsub as { publish?: (t: string, d: Uint8Array, o?: unknown) => Promise<unknown> } | undefined
    const orig = svc?.publish
    if (svc == null || typeof orig !== 'function') return
    const publishBound = orig.bind(svc)

    const topicKey = discoveryTopic.trim()
    svc.publish = async (t: string, data: Uint8Array, opts?: unknown) => {
      const out = await publishBound(t, data, opts)
      if (t.trim() === topicKey) {
        this.pushDebugEvent({
          type: 'pubsub:publish',
          at: Date.now(),
          topic: t.trim(),
          detail: `subscribers=${this.getTopicSubscribers().length}`,
        })
        try {
          cb()
        } catch {
          // ignore UI callback errors
        }
      }
      return out
    }
  }

  /**
   * Violet LED / counters: libp2p `peer:discovery` only fires when a peer is **new** in the peer store.
   * Inbound gossipsub messages on the discovery topic fire for each distinct received advertisement.
   */
  private hookGossipsubInboundDiscoveryUi(libp2p: Libp2p, discoveryTopic: string): void {
    const cb = this.pubsubDiscoveryUi?.onRemoteDiscoveryAdvertReceived
    if (cb == null) return

    const svc = libp2p.services?.pubsub as
      | (EventTarget & {
          addEventListener: (type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => void
        })
      | undefined
    if (svc == null || typeof svc.addEventListener !== 'function') return

    const topicKey = discoveryTopic.trim()

    const handleMsg = (msg: PubsubMessage): void => {
      if (msg.topic.trim() !== topicKey) return
      if (msg.type !== 'signed') return
      if (msg.from.equals(libp2p.peerId)) return
      const peerIdStr = msg.from.toString()
      this.pushDebugEvent({
        type: 'pubsub:message',
        at: Date.now(),
        topic: msg.topic.trim(),
        peerId: peerIdStr,
      })
      try {
        cb({ fromPeerId: peerIdStr })
      } catch {
        // ignore
      }
      if (!this.discoveryMap.has(peerIdStr)) {
        void this.upsertDiscoveryRow(libp2p, peerIdStr, []).catch(() => {
          // ignore row bootstrap errors so LED hooks still work
        })
      }
    }

    const onMessage = (evt: Event): void => {
      const msg = (evt as CustomEvent<PubsubMessage>).detail
      if (msg == null) return
      handleMsg(msg)
    }

    this.gossipsubInboundBound = onMessage
    this.gossipsubInboundSvc = svc
    svc.addEventListener('message', onMessage)
  }

  /**
   * Gossipsub graft tags peers in the peer store **before** pubsub-peer-discovery merges multiaddrs.
   * `peer:discovery` only fires when `previous == null`, so other browsers never reached the table.
   * Sync rows from `peer:update` whenever addresses change.
   */
  private hookPeerStoreUpdatesForDiscovery(libp2p: Libp2p): void {
    const events = (libp2p as Libp2p & { components?: { events?: EventTarget } }).components?.events
    if (events == null) return

    const handler = (evt: Event): void => {
      const e = evt as CustomEvent<{
        peer: {
          id: { equals: (o: unknown) => boolean; toString: () => string }
          addresses: { multiaddr: { toString: () => string } }[]
        }
      }>
      const peer = e.detail.peer
      if (peer.id.equals(libp2p.peerId)) return
      const mas = peer.addresses.map((a) => a.multiaddr.toString())
      if (mas.length === 0) return
      this.pushDebugEvent({
        type: 'peer:update',
        at: Date.now(),
        peerId: peer.id.toString(),
        detail: mas.join(', '),
      })
      void this.upsertDiscoveryRow(libp2p, peer.id.toString(), mas)
    }

    this.peerUpdateEvents = events
    this.peerUpdateBound = handler
    events.addEventListener('peer:update', handler)
  }

  /**
   * Wrap circuit-relay transport reservation `addRelay` so reserve failures (e.g. RESERVATION_REFUSED)
   * reach the UI; listen for successful reservations to clear notices per relay.
   */
  private hookCircuitRelayReservationUi(libp2p: Libp2p): void {
    if (this.reservationStoreHooked || this.onRelayReservationUi == null) return
    const rs = findCircuitReservationStore(libp2p)
    if (rs == null) return

    const orig = rs.addRelay.bind(rs)
    rs.addRelay = async (peerId, type) => {
      try {
        return await orig(peerId, type)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('RESERVATION_REFUSED') || msg.includes('reservation failed')) {
          this.pushDebugEvent({
            type: 'relay:reservation:error',
            at: Date.now(),
            peerId: peerId.toString(),
            detail: msg,
          })
          this.onRelayReservationUi?.({
            type: 'error',
            relayPeerId: peerId.toString(),
            message: msg,
            at: Date.now(),
          })
        }
        throw err
      }
    }

    rs.addEventListener('relay:created-reservation', this.onRelayCreatedBound)
    this.reservationStoreRef = rs
    this.reservationStoreHooked = true
  }

  private hookConnectionDebugEvents(libp2p: Libp2p): void {
    const onOpen = (evt: Event): void => {
      const connection = (evt as CustomEvent<{ remotePeer: { toString: () => string }; remoteAddr: { toString: () => string } }>).detail
      const peerIdStr = connection.remotePeer.toString()
      const remoteAddr = connection.remoteAddr.toString()
      this.pushDebugEvent({
        type: 'connection:open',
        at: Date.now(),
        peerId: peerIdStr,
        addr: remoteAddr,
      })
      void this.upsertDiscoveryRow(libp2p, peerIdStr, [remoteAddr])
    }

    const onClose = (evt: Event): void => {
      const connection = (evt as CustomEvent<{ remotePeer: { toString: () => string }; remoteAddr: { toString: () => string } }>).detail
      this.pushDebugEvent({
        type: 'connection:close',
        at: Date.now(),
        peerId: connection.remotePeer.toString(),
        addr: connection.remoteAddr.toString(),
      })
    }

    const onIdentify = (evt: Event): void => {
      const detail = evt as CustomEvent<{
        peerId?: { toString: () => string }
        connection?: { remoteAddr?: { toString: () => string } }
        protocolVersion?: string
        agentVersion?: string
      }>
      this.pushDebugEvent({
        type: 'peer:identify',
        at: Date.now(),
        peerId: detail.detail.peerId?.toString(),
        addr: detail.detail.connection?.remoteAddr?.toString() ?? null,
        detail: [detail.detail.protocolVersion, detail.detail.agentVersion].filter(Boolean).join(' | '),
      })
    }

    this.connectionOpenBound = onOpen
    this.connectionCloseBound = onClose
    this.peerIdentifyBound = onIdentify
    libp2p.addEventListener('connection:open', onOpen)
    libp2p.addEventListener('connection:close', onClose)
    libp2p.addEventListener('peer:identify', onIdentify)
  }

  private async onPeerDiscovered(libp2p: Libp2p, peerIdStr: string, multiaddrs: string[]): Promise<void> {
    await this.upsertDiscoveryRow(libp2p, peerIdStr, multiaddrs)
  }

  private getConnectionMode(libp2p: Libp2p, peerIdStr: string): 'none' | 'relay-only' | 'direct' {
    const connections = libp2p.getConnections(peerIdFromString(peerIdStr))
    if (connections.length === 0) return 'none'
    const hasDirectConnection = connections.some((connection) => !connection.remoteAddr.toString().includes('/p2p-circuit'))
    return hasDirectConnection ? 'direct' : 'relay-only'
  }

  private getAutoDialUiDetail(libp2p: Libp2p, peerIdStr: string, multiaddrs: string[]): string | undefined {
    if (this.getConnectionMode(libp2p, peerIdStr) === 'direct') return undefined
    const dialableMultiaddrs = multiaddrs.filter((candidate) => isDialableDiscoveryMultiaddr(candidate))
    if (dialableMultiaddrs.length > 0) return undefined
    if (multiaddrs.length === 0) return 'dialing by peer id'
    return `${discoveryAutoDialDetail(multiaddrs) ?? 'no explicit dialable multiaddrs'}; fallback dial(peerId)`
  }

  private getAutoDialFingerprint(libp2p: Libp2p, peerIdStr: string, multiaddrs: string[]): string | null {
    const connectionMode = this.getConnectionMode(libp2p, peerIdStr)
    if (connectionMode === 'direct') return null

    const dialableMultiaddrs = [...new Set(multiaddrs.filter((candidate) => isDialableDiscoveryMultiaddr(candidate)))]
      .sort((a, b) => scoreDialMultiaddr(b) - scoreDialMultiaddr(a))
    const fingerprint = `${connectionMode}|${dialableMultiaddrs.join(',')}`
    if (this.lastAutoDialFingerprint.get(peerIdStr) === fingerprint) {
      return null
    }
    return fingerprint
  }

  private async upsertDiscoveryRow(libp2p: Libp2p, peerIdStr: string, multiaddrs: string[]): Promise<void> {
    if (peerIdStr === libp2p.peerId.toString()) return

    const existing = this.discoveryMap.get(peerIdStr)
    const autoDialFingerprint = this.getAutoDialFingerprint(libp2p, peerIdStr, multiaddrs)
    const detail = this.getAutoDialUiDetail(libp2p, peerIdStr, multiaddrs)

    if (existing != null) {
      existing.discoveryAddrs = [...multiaddrs]
      existing.discoveryFlashUntilMs = Date.now() + PEER_DISCOVERY_FLASH_MS
      existing.autoDialEligible = this.getConnectionMode(libp2p, peerIdStr) !== 'direct'
      existing.detail = detail
      if (this.getConnectionMode(libp2p, peerIdStr) === 'direct') {
        existing.autoDial = 'ok'
      } else if (autoDialFingerprint != null) {
        existing.autoDial = 'pending'
      }
      this.scheduleDiscoveryNotify()
      if (autoDialFingerprint != null && !this.dialing.has(peerIdStr)) {
        await this.runAutoDialAttempt(libp2p, peerIdStr, multiaddrs, autoDialFingerprint)
      }
      return
    }

    const row: DiscoveryRow = {
      peerId: peerIdStr,
      discoveryAddrs: [...multiaddrs],
      discoveryFlashUntilMs: Date.now() + PEER_DISCOVERY_FLASH_MS,
      autoDialEligible: this.getConnectionMode(libp2p, peerIdStr) !== 'direct',
      autoDial: autoDialFingerprint == null ? 'ok' : 'pending',
      detail,
    }
    this.discoveryMap.set(peerIdStr, row)
    this.scheduleDiscoveryNotify()

    if (autoDialFingerprint != null) {
      await this.runAutoDialAttempt(libp2p, peerIdStr, multiaddrs, autoDialFingerprint)
    }
  }

  private async runAutoDialAttempt(
    libp2p: Libp2p,
    peerIdStr: string,
    multiaddrs: string[],
    autoDialFingerprint: string
  ): Promise<void> {
    if (this.dialing.has(peerIdStr)) return
    this.dialing.add(peerIdStr)
    this.lastAutoDialFingerprint.set(peerIdStr, autoDialFingerprint)
    try {
      const dialableMultiaddrs = [...new Set(multiaddrs.filter((candidate) => isDialableDiscoveryMultiaddr(candidate)))]
        .sort((a, b) => scoreDialMultiaddr(b) - scoreDialMultiaddr(a))
      this.pushDebugEvent({
        type: 'auto:dial:start',
        at: Date.now(),
        peerId: peerIdStr,
        detail: autoDialFingerprint,
      })

      let multiaddrDialError: unknown = null
      if (dialableMultiaddrs.length > 0) {
        try {
          await libp2p.dial(dialableMultiaddrs.map((addr) => multiaddr(addr)))
        } catch (error) {
          multiaddrDialError = error
        }
      }

      const remote = peerIdFromString(peerIdStr)
      if (dialableMultiaddrs.length === 0 || multiaddrDialError != null) {
        await libp2p.dial(remote)
      }

      const cur = this.discoveryMap.get(peerIdStr)
      if (cur) {
        cur.autoDial = 'ok'
        cur.detail = undefined
      }
      this.pushDebugEvent({
        type: 'auto:dial:ok',
        at: Date.now(),
        peerId: peerIdStr,
        detail: this.getConnectionMode(libp2p, peerIdStr),
      })
    } catch (e) {
      const cur = this.discoveryMap.get(peerIdStr)
      if (cur) {
        cur.autoDial = 'error'
        cur.detail = e instanceof Error ? e.message : String(e)
      }
      this.pushDebugEvent({
        type: 'auto:dial:error',
        at: Date.now(),
        peerId: peerIdStr,
        detail: e instanceof Error ? e.message : String(e),
      })
    } finally {
      this.dialing.delete(peerIdStr)
      this.scheduleDiscoveryNotify()
    }
  }

  peerCount(): number {
    return this.libp2p?.getPeers().length ?? 0
  }

  /** Announced listen + derived addresses (WebRTC, circuit, reservations, etc.). */
  getOwnMultiaddrs(): string[] {
    const lp = this.libp2p
    if (lp == null) return []
    return lp.getMultiaddrs().map((ma) => ma.toString())
  }

  getLocalPeerId(): string | null {
    return this.libp2p?.peerId.toString() ?? null
  }

  isStarted(): boolean {
    return this.libp2p != null
  }

  getHelia(): HeliaLibp2p<Libp2p> | null {
    return this.helia
  }

  getTopicSubscribers(): string[] {
    const node = this.libp2p
    if (node == null) return []
    const pubsub = node.services?.pubsub as { getSubscribers?: (topic: string) => Array<{ toString: () => string }> } | undefined
    if (pubsub == null || typeof pubsub.getSubscribers !== 'function') return []
    return pubsub.getSubscribers(this.topic).map((peerId) => peerId.toString())
  }

  getPeerConnectionAddrs(peerIdStr: string): string[] {
    const node = this.libp2p
    if (node == null) return []
    return node
      .getConnections(peerIdFromString(peerIdStr))
      .map((connection) => connection.remoteAddr.toString())
  }

  getPreferredPeerConnectionAddr(peerIdStr: string): string | null {
    const addrs = this.getPeerConnectionAddrs(peerIdStr)
    if (addrs.length === 0) return null
    return [...addrs].sort((a, b) => scoreDialMultiaddr(b) - scoreDialMultiaddr(a))[0] ?? null
  }

  getDebugSnapshot(): BrowserNodeDebugSnapshot {
    const node = this.libp2p
    return {
      topic: this.topic,
      localPeerId: node?.peerId.toString() ?? null,
      ownMultiaddrs: this.getOwnMultiaddrs(),
      peerCount: this.peerCount(),
      discoveryRows: [...this.discoveryMap.values()].map((row) => ({ ...row, discoveryAddrs: [...row.discoveryAddrs] })),
      connections:
        node?.getConnections().map((connection) => ({
          peerId: connection.remotePeer.toString(),
          addr: connection.remoteAddr.toString(),
        })) ?? [],
      topicSubscribers: this.getTopicSubscribers(),
      events: [...this.debugEvents],
    }
  }

  async dialRelay(maStr: string): Promise<void> {
    const node = this.libp2p
    if (!node) throw new Error('node not started')
    this.pushDebugEvent({
      type: 'relay:dial:start',
      at: Date.now(),
      addr: maStr,
    })
    await node.dial(multiaddr(maStr))
    this.pushDebugEvent({
      type: 'relay:dial:ok',
      at: Date.now(),
      addr: maStr,
    })
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
    if (this.peerUpdateEvents != null && this.peerUpdateBound != null) {
      try {
        this.peerUpdateEvents.removeEventListener('peer:update', this.peerUpdateBound)
      } catch {
        // ignore
      }
      this.peerUpdateEvents = null
      this.peerUpdateBound = null
    }

    if (this.gossipsubInboundSvc != null && this.gossipsubInboundBound != null) {
      try {
        this.gossipsubInboundSvc.removeEventListener('message', this.gossipsubInboundBound as EventListener)
      } catch {
        // ignore
      }
      this.gossipsubInboundSvc = null
      this.gossipsubInboundBound = null
    }

    if (this.libp2p != null) {
      if (this.connectionOpenBound != null) {
        try {
          this.libp2p.removeEventListener('connection:open', this.connectionOpenBound)
        } catch {
          // ignore
        }
        this.connectionOpenBound = null
      }
      if (this.connectionCloseBound != null) {
        try {
          this.libp2p.removeEventListener('connection:close', this.connectionCloseBound)
        } catch {
          // ignore
        }
        this.connectionCloseBound = null
      }
      if (this.peerIdentifyBound != null) {
        try {
          this.libp2p.removeEventListener('peer:identify', this.peerIdentifyBound)
        } catch {
          // ignore
        }
        this.peerIdentifyBound = null
      }
    }

    if (this.reservationStoreRef != null) {
      try {
        this.reservationStoreRef.removeEventListener('relay:created-reservation', this.onRelayCreatedBound)
      } catch {
        // ignore
      }
      this.reservationStoreRef = null
    }
    this.reservationStoreHooked = false

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
    this.lastAutoDialFingerprint.clear()
    this.onDiscovery([])
  }
}
