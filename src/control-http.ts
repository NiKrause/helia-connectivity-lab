import http from 'node:http'
import type { RelayRuntime } from './relay-runtime.js'
import { logRelayBanner, startRelayRuntime } from './relay-runtime.js'
import type { PrivateKey } from '@libp2p/interface'
import {
  resolvePubsubDiscoveryTopic,
  type RelayListenOverrides,
} from './libp2p-server-config.js'
import { filterMultiaddrsForPublicStatus } from './public-multiaddr-filter.js'
import {
  clientLabel,
  readIpfsGatewayFeatureConfig,
  tryServeIpfsCat,
} from './ipfs-http-gateway.js'

const PAIR_ROOM_TTL_MS = 120_000
const pairRooms = new Map<string, { payload: Record<string, unknown>; exp: number }>()

function prunePairRooms(): void {
  const now = Date.now()
  for (const [k, v] of pairRooms) {
    if (v.exp < now) {
      pairRooms.delete(k)
    }
  }
}

function readControlConfig() {
  const port = Number(process.env.RELAY_CONTROL_HTTP_PORT || process.env.CONTROL_HTTP_PORT || '')
  const host = process.env.RELAY_CONTROL_HTTP_HOST || process.env.CONTROL_HTTP_HOST || '0.0.0.0'
  const token = (process.env.RELAY_CONTROL_TOKEN || process.env.CONTROL_TOKEN || '').trim()
  return {
    enabled: Number.isFinite(port) && port > 0 && port <= 65535,
    port: Number.isFinite(port) && port > 0 ? port : 0,
    host,
    token,
  }
}

function sendJson(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'private, no-store')
  res.end(JSON.stringify(body))
}

function corsHeaders(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers.origin
  const allow = process.env.RELAY_CONTROL_CORS_ORIGIN?.trim() || '*'
  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Control-Token',
    'Access-Control-Max-Age': '600',
  }
  if (allow === '*' && origin) {
    h['Access-Control-Allow-Origin'] = origin
  } else {
    h['Access-Control-Allow-Origin'] = allow
  }
  return h
}

function authorize(req: http.IncomingMessage, token: string): boolean {
  if (!token) return false
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) {
    return auth.slice(7).trim() === token
  }
  const xt = (req.headers['x-control-token'] as string | undefined)?.trim()
  if (xt === token) return true
  return false
}

const MAX_JSON_BODY_BYTES = 16_384

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const b = chunk as Buffer
    total += b.length
    if (total > MAX_JSON_BODY_BYTES) {
      throw new Error('body too large')
    }
    chunks.push(b)
  }
  if (chunks.length === 0) return null
  const raw = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(raw) as unknown
}

function parseRunPath(pathname: string): { kind: 'tcp' | 'ws' | 'quic' | 'webrtc'; port: number } | null {
  const m = pathname.match(/^\/run\/(tcp|ws|quic|webrtc|webrtc-direct)\/(\d{1,5})\/?$/)
  if (!m) return null
  const port = Number(m[2])
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null
  const seg = m[1]
  const kind: 'tcp' | 'ws' | 'quic' | 'webrtc' =
    seg === 'webrtc' || seg === 'webrtc-direct' ? 'webrtc' : (seg as 'tcp' | 'ws' | 'quic')
  return { kind, port }
}

export type ControlHttpServer = {
  close: () => Promise<void>
  /** False when RELAY_CONTROL_HTTP_PORT unset, invalid, or RELAY_CONTROL_TOKEN empty. */
  started: boolean
}

/**
 * HTTP control plane (e.g. Nym-friendly port like 8008) to restart libp2p listeners without changing PeerId.
 * POST /run/tcp/81 — rebind TCP (requires root or CAP_NET_BIND_SERVICE for ports &lt; 1024).
 * POST /run/ws/8080 — rebind WebSocket listener port.
 * POST /run/quic/5000 — rebind QUIC (UDP) listener port.
 * POST /run/webrtc/3478 — rebind WebRTC-Direct (UDP) listener port (alias: POST /run/webrtc-direct/&lt;port&gt;).
 *
 * Returns HTTP 202 with JSON, then restarts libp2p on the next event-loop turn (setImmediate).
 * We do not wait for res "finish" before scheduling: in some clients or proxies, finish never
 * fired and the restart never ran. Connection: close on this response avoids sticky keep-alive edge cases.
 * Poll GET /status for new multiaddrs (public — no auth).
 */
export function startControlHttpServer(opts: {
  privateKey: PrivateKey
  getRuntime: () => RelayRuntime
  setRuntime: (r: RelayRuntime) => void
  getOverrides: () => RelayListenOverrides
  setOverrides: (o: RelayListenOverrides) => void
}): ControlHttpServer {
  const noop = { close: async () => {}, started: false as const }
  const cfg = readControlConfig()
  if (!cfg.enabled) {
    return noop
  }
  if (!cfg.token) {
    console.warn(
      'RELAY_CONTROL_HTTP_PORT is set but RELAY_CONTROL_TOKEN is empty — control API disabled (set a strong token).'
    )
    return noop
  }

  const ipfsFeature = readIpfsGatewayFeatureConfig()
  const ipfsHandlerCfg = {
    catTimeoutMs: ipfsFeature.catTimeoutMs,
    log: ipfsFeature.log,
    logProgressBytes: ipfsFeature.logProgressBytes,
  }

  let serialQueue: Promise<unknown> = Promise.resolve()
  function runSerial<T>(fn: () => Promise<T>): Promise<T> {
    const result = serialQueue.then(() => fn())
    serialQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  const server = http.createServer(async (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0] || '/'

    for (const [k, v] of Object.entries(corsHeaders(req))) {
      res.setHeader(k, v)
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    const pairMatch = pathname.match(/^\/pair\/([^/]+)\/?$/)
    if (pairMatch != null && (req.method === 'GET' || req.method === 'POST')) {
      prunePairRooms()
      const room = decodeURIComponent(pairMatch[1]).slice(0, 256)
      if (room.length === 0) {
        sendJson(res, 400, { ok: false, error: 'empty room id' })
        return
      }
      if (req.method === 'GET') {
        const row = pairRooms.get(room)
        if (!row || row.exp < Date.now()) {
          sendJson(res, 404, { ok: false, error: 'not found or expired' })
          return
        }
        sendJson(res, 200, { ok: true, ...row.payload })
        return
      }
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
        return
      }
      const payload =
        body != null && typeof body === 'object' && body !== null && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {}
      pairRooms.set(room, { payload, exp: Date.now() + PAIR_ROOM_TTL_MS })
      sendJson(res, 200, { ok: true, room, expiresInMs: PAIR_ROOM_TTL_MS })
      return
    }

    if (req.method === 'GET' && pathname === '/health') {
      if (ipfsFeature.enabled && ipfsFeature.log) {
        console.log(`[ipfs-gateway] GET /health  client=${clientLabel(req)}`)
      }
      sendJson(
        res,
        200,
        ipfsFeature.enabled
          ? { status: 'ok', control: true, ipfsGateway: true }
          : { status: 'ok', control: true }
      )
      return
    }

    if (ipfsFeature.enabled && (await tryServeIpfsCat(req, res, opts.getRuntime, ipfsHandlerCfg))) {
      return
    }

    if (req.method === 'GET' && pathname === '/status') {
      const rt = opts.getRuntime()
      const allAddrs = rt.libp2p.getMultiaddrs().map((ma) => ma.toString())
      sendJson(res, 200, {
        ok: true,
        peerId: rt.libp2p.peerId.toString(),
        listenOverrides: opts.getOverrides(),
        multiaddrs: filterMultiaddrsForPublicStatus(allAddrs),
        pubsubDiscoveryTopic: resolvePubsubDiscoveryTopic(opts.getOverrides()),
      })
      return
    }

    const authed = authorize(req, cfg.token)

    if (!authed) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized' })
      return
    }

    if (req.method === 'POST') {
      if (pathname === '/run/pubsub-discovery' || pathname === '/run/pubsub-discovery/') {
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch {
          sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
          return
        }
        const topic =
          body != null && typeof body === 'object' && 'topic' in body && typeof (body as { topic: unknown }).topic === 'string'
            ? (body as { topic: string }).topic.trim()
            : ''
        if (topic.length === 0) {
          sendJson(res, 400, { ok: false, error: 'Missing or empty "topic" string' })
          return
        }

        const prev = opts.getOverrides()
        const next: RelayListenOverrides = { ...prev, pubsubDiscoveryTopic: topic }
        const rtBefore = opts.getRuntime()
        res.setHeader('Connection', 'close')
        sendJson(res, 202, {
          ok: true,
          accepted: true,
          restart: 'pending',
          peerId: rtBefore.libp2p.peerId.toString(),
          listenOverrides: next,
          pubsubDiscoveryTopic: topic,
          multiaddrsBeforeRestart: rtBefore.libp2p.getMultiaddrs().map((ma) => ma.toString()),
          hint: 'Libp2p restart is scheduled right after this response. Poll GET /status in ~1s.',
        })

        setImmediate(() => {
          void runSerial(async () => {
            try {
              console.log(`[control] restart starting: pubsub-discovery topic -> ${topic.slice(0, 80)}`)
              const old = opts.getRuntime()
              await old.stop()
              opts.setOverrides(next)
              const created = await startRelayRuntime(opts.privateKey, next)
              opts.setRuntime(created)
              console.log('[control] restarted libp2p with new pubsub discovery topic')
              logRelayBanner(created.libp2p)
            } catch (e) {
              console.error('[control] libp2p restart failed:', e)
            }
          }).catch(() => {})
        })
        return
      }

      const run = parseRunPath(pathname)
      if (run) {
        req.resume()
        const prev = opts.getOverrides()
        const next: RelayListenOverrides = {
          ...prev,
          ...(run.kind === 'tcp'
            ? { tcpPort: run.port }
            : run.kind === 'ws'
              ? { wsPort: run.port }
              : run.kind === 'quic'
                ? { quicPort: run.port }
                : { webrtcPort: run.port }),
        }

        const rtBefore = opts.getRuntime()
        const body: Record<string, unknown> = {
          ok: true,
          accepted: true,
          restart: 'pending',
          peerId: rtBefore.libp2p.peerId.toString(),
          listenOverrides: next,
          multiaddrsBeforeRestart: rtBefore.libp2p.getMultiaddrs().map((ma) => ma.toString()),
          hint: 'Libp2p restart is scheduled right after this response. Poll GET /status in ~1s.',
        }
        res.setHeader('Connection', 'close')
        sendJson(res, 202, body)

        setImmediate(() => {
          void runSerial(async () => {
            try {
              console.log(
                `[control] restart starting: ${run.kind === 'webrtc' ? 'webrtc-direct' : run.kind} -> port ${run.port}`
              )
              const old = opts.getRuntime()
              await old.stop()
              opts.setOverrides(next)
              const created = await startRelayRuntime(opts.privateKey, next)
              opts.setRuntime(created)
              console.log(
                `[control] restarted libp2p ${run.kind === 'webrtc' ? 'webrtc-direct' : run.kind} listener on port ${run.port}`
              )
              logRelayBanner(created.libp2p)
            } catch (e) {
              console.error('[control] libp2p restart failed:', e)
            }
          }).catch(() => {})
        })
        return
      }
    }

    sendJson(res, 404, { ok: false, error: 'Not found' })
  })

  server.listen(cfg.port, cfg.host, () => {
    console.log(`Control HTTP listening on http://${cfg.host}:${cfg.port}`)
    console.log(
      '  POST /run/tcp|ws|quic|webrtc|webrtc-direct/<port>  (Authorization: Bearer <RELAY_CONTROL_TOKEN>)'
    )
    console.log('  GET /health  GET /status (public)  GET|POST /pair/<roomId> (public, short TTL)')
    console.log('  POST /run/pubsub-discovery  JSON {"topic":"..."}  (auth)')
    if (ipfsFeature.enabled) {
      console.log('  GET /ipfs/<cid>  (no auth — Helia unixfs.cat / bitswap on same libp2p as relay)')
      if (ipfsFeature.log) {
        console.log(
          '[ipfs-gateway] RELAY_IPFS_GATEWAY_LOG is on — per-request lines in journal (journalctl -u helia-connectivity-lab -f)'
        )
      }
    }
  })

  return {
    started: true,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

export { readControlConfig }
