import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createLibp2p } from 'libp2p'
import type { Libp2p } from 'libp2p'
import type { PrivateKey } from '@libp2p/interface'
import type { Helia } from '@helia/interface'
import { LevelDatastore } from 'datastore-level'
import { LevelBlockstore } from 'blockstore-level'
import {
  orbitdbReplicationService,
  type OrbitdbReplicationServiceApi,
} from 'orbitdb-relay-pinner'
import {
  createServerLibp2pOptions,
  readRelayAutoTlsEnabled,
  type RelayListenOverrides,
} from './libp2p-server-config.js'
import { attachLibp2pConnectionLogging, libp2pConnLogEnabledForRelay } from './libp2p-connection-log.js'
import { attachRelayReservationConsoleLog } from './relay-reservation-console.js'
import { BULK_MAX_CHUNK_BYTES } from './bulk-constants.js'
import { CONNECTIVITY_BULK_PROTOCOL, CONNECTIVITY_ECHO_PROTOCOL } from './protocol.js'
import { ByteStreamReader, encodeFrame, readFramedChunk } from './stream-binary.js'
import { readLine, writeLine } from './stream-line.js'
import type { RelayPinningHandlers } from './pinning-http.js'

type Libp2pWithOrbitdbReplication = Libp2p & {
  services: Libp2p['services'] & {
    orbitdbReplication: OrbitdbReplicationServiceApi & {
      ipfs?: Helia | null
    }
  }
}

export type RelayRuntime = {
  libp2p: Libp2pWithOrbitdbReplication
  helia: Helia | null
  pinning: RelayPinningHandlers | null
  listenOverrides: RelayListenOverrides
  stop: () => Promise<void>
}

type RelayStoragePaths = {
  root: string
  datastore: string
  blockstore: string
  orbitdb: string
}

function readRelayStoragePaths(): RelayStoragePaths {
  const configuredRoot =
    process.env.RELAY_DATASTORE_PATH?.trim() ||
    process.env.DATASTORE_PATH?.trim() ||
    join(process.cwd(), 'relay-data')
  return {
    root: configuredRoot,
    datastore: join(configuredRoot, 'ipfs', 'data'),
    blockstore: join(configuredRoot, 'ipfs', 'blocks'),
    orbitdb: join(configuredRoot, 'orbitdb'),
  }
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
  const storage = readRelayStoragePaths()
  await Promise.all([
    mkdir(storage.datastore, { recursive: true }),
    mkdir(storage.blockstore, { recursive: true }),
    mkdir(storage.orbitdb, { recursive: true }),
  ])

  const levelDatastore = new LevelDatastore(storage.datastore)
  const levelBlockstore = new LevelBlockstore(storage.blockstore)
  await levelDatastore.open()
  await levelBlockstore.open()
  console.log(`[relay] persistent datastore root: ${storage.root}`)
  if (readRelayAutoTlsEnabled()) {
    console.log(`[relay] RELAY_AUTO_TLS shares datastore ${storage.datastore}`)
  }

  const baseLibp2pOptions = createServerLibp2pOptions(privateKey, overrides, levelDatastore) as Record<string, unknown>
  const libp2pOptions = {
    ...baseLibp2pOptions,
    services: {
      ...((baseLibp2pOptions.services as Record<string, unknown> | undefined) ?? {}),
      orbitdbReplication: orbitdbReplicationService({
        datastore: levelDatastore,
        blockstore: levelBlockstore,
        orbitdbDirectory: storage.orbitdb,
      }),
    },
    start: false,
  } as Parameters<typeof createLibp2p>[0]

  const libp2p = (await createLibp2p(libp2pOptions)) as Libp2pWithOrbitdbReplication
  if (libp2pConnLogEnabledForRelay()) {
    attachLibp2pConnectionLogging(libp2p, '[relay libp2p]')
    console.log('[relay libp2p] connection logging on (LIBP2P_CONN_LOG or RELAY_LIBP2P_CONN_LOG)')
  }
  attachEchoHandler(libp2p)
  attachBulkHandler(libp2p)
  await libp2p.start()
  attachRelayReservationConsoleLog(libp2p)
  const pinning = libp2p.services.orbitdbReplication.createPinningHttpHandlers()
  const helia = libp2p.services.orbitdbReplication.ipfs ?? null

  return {
    libp2p,
    helia,
    pinning,
    listenOverrides: overrides ?? {},
    stop: async () => {
      try {
        await libp2p.stop()
      } catch {
        // ignore
      }
      try {
        await levelBlockstore.close()
      } catch {
        // ignore
      }
      try {
        await levelDatastore.close()
      } catch {
        // ignore
      }
    },
  }
}

export function logRelayBanner(libp2p: Libp2p): void {
  console.log('Relay + echo server peerId:', libp2p.peerId.toString())
  console.log('Listen addresses:')
  const addrs = libp2p.getMultiaddrs().map((ma) => ma.toString())
  for (const s of addrs) {
    console.log(' ', s)
  }
  console.log('')
  const hasTlsWs = addrs.some((s) => s.includes('/tls/ws') || s.includes('/tls/wss'))
  const autoTlsOn = readRelayAutoTlsEnabled()
  console.log(
    hasTlsWs
      ? 'Dial one of the above from the client (include /p2p/<peerId> for remote hosts). Transports: TCP, cleartext WS + Noise, **TLS WebSocket (AutoTLS / WSS)** where listed, QUIC (/quic-v1 UDP), WebRTC-Direct (/webrtc-direct + certhash).'
      : autoTlsOn
        ? 'RELAY_AUTO_TLS is on — if the node is publicly reachable, watch for /tls/ws addresses (Let’s Encrypt via libp2p.direct); they can appear shortly after start.'
        : 'Dial one of the above from the client (include /p2p/<peerId> for remote hosts). Transports: TCP, WebSocket (cleartext WS + Noise), QUIC (/quic-v1 UDP), WebRTC-Direct (/webrtc-direct + certhash). Enable RELAY_AUTO_TLS=1 for WSS via @ipshipyard/libp2p-auto-tls.'
  )
  console.log('Protocols:', CONNECTIVITY_ECHO_PROTOCOL, CONNECTIVITY_BULK_PROTOCOL)
  console.log(
    'OrbitDB replication + Helia pinning are mounted on the same libp2p node (GET /ipfs/<cid> and /pinning/* when enabled on control HTTP).'
  )
}
