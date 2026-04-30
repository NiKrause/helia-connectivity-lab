import http from 'node:http'
import { createPinningHttpRequestHandler, isManagedPinningHttpPath } from 'orbitdb-relay-pinner'
import type { RelayRuntime } from './relay-runtime.js'
import { logRelayBanner, startRelayRuntime } from './relay-runtime.js'
import type { PrivateKey } from '@libp2p/interface'
import {
  resolvePubsubDiscoveryTopic,
  type RelayListenOverrides,
} from './libp2p-server-config.js'
import { filterMultiaddrsForStatusRequest } from './public-multiaddr-filter.js'
import { readIpfsGatewayFeatureConfig } from './ipfs-http-gateway.js'
import { localHttpOrigins, primaryHttpOrigin } from './http-listen-urls.js'

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

function forwardedForAddress(req: http.IncomingMessage): string | undefined {
  const forwardedFor = req.headers['x-forwarded-for']
  const first =
    typeof forwardedFor === 'string'
      ? forwardedFor
      : Array.isArray(forwardedFor)
        ? forwardedFor[0]
        : ''
  const candidate = first
    .split(',')
    .map((part) => part.trim())
    .find((part) => part !== '')
  return candidate || undefined
}

function requesterAddress(req: http.IncomingMessage): string | undefined {
  return forwardedForAddress(req) || req.socket.remoteAddress
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
 * POST /run/tcp/8443 — rebind TCP on a Nym-friendly public port.
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
  const corsOriginRaw = process.env.RELAY_CONTROL_CORS_ORIGIN?.trim() || '*'
  const sharedPinningHandler = createPinningHttpRequestHandler({
    getLibp2p: () => opts.getRuntime().libp2p as never,
    pinning: opts.getRuntime().pinning ?? undefined,
    getHelia: () => opts.getRuntime().helia,
    ipfsGateway: {
      enabled: ipfsFeature.enabled,
      fallbackMode: 'pinned-first-network-fallback',
      catTimeoutMs: ipfsFeature.catTimeoutMs,
    },
    cors: {
      origin: corsOriginRaw === '*' ? '*' : corsOriginRaw.split(',').map((value) => value.trim()).filter(Boolean),
      allowHeaders: ['Authorization', 'Content-Type', 'X-Control-Token'],
      maxAgeSeconds: 600,
    },
  })

  let serialQueue: Promise<unknown> = Promise.resolve()
  function runSerial<T>(fn: () => Promise<T>): Promise<T> {
    const result = serialQueue.then(() => fn())
    serialQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  function scheduleRestart(
    nextOverrides: RelayListenOverrides,
    logStart: string,
    logDone: string
  ): void {
    setImmediate(() => {
      void runSerial(async () => {
        try {
          console.log(logStart)
          const old = opts.getRuntime()
          await old.stop()
          opts.setOverrides(nextOverrides)
          const created = await startRelayRuntime(opts.privateKey, nextOverrides)
          opts.setRuntime(created)
          console.log(logDone)
          logRelayBanner(created.libp2p)
        } catch (e) {
          console.error('[control] libp2p restart failed:', e)
        }
      }).catch(() => {})
    })
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

    if (isManagedPinningHttpPath(pathname)) {
      await sharedPinningHandler(req, res)
      return
    }

    if (req.method === 'GET' && pathname === '/status') {
      const rt = opts.getRuntime()
      const allAddrs = rt.libp2p.getMultiaddrs().map((ma) => ma.toString())
      sendJson(res, 200, {
        ok: true,
        peerId: rt.libp2p.peerId.toString(),
        listenOverrides: opts.getOverrides(),
        multiaddrs: filterMultiaddrsForStatusRequest(allAddrs, requesterAddress(req)),
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
      if (pathname === '/run/restart' || pathname === '/run/restart/') {
        req.resume()
        const rtBefore = opts.getRuntime()
        const next = opts.getOverrides()
        res.setHeader('Connection', 'close')
        sendJson(res, 202, {
          ok: true,
          accepted: true,
          restart: 'pending',
          peerId: rtBefore.libp2p.peerId.toString(),
          listenOverrides: next,
          multiaddrsBeforeRestart: rtBefore.libp2p.getMultiaddrs().map((ma) => ma.toString()),
          hint: 'Libp2p restart is scheduled right after this response. Poll GET /status in ~1s.',
        })

        scheduleRestart(
          next,
          '[control] restart starting: requested full runtime restart',
          '[control] restarted libp2p runtime'
        )
        return
      }

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

        scheduleRestart(
          next,
          `[control] restart starting: pubsub-discovery topic -> ${topic.slice(0, 80)}`,
          '[control] restarted libp2p with new pubsub discovery topic'
        )
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

        scheduleRestart(
          next,
          `[control] restart starting: ${run.kind === 'webrtc' ? 'webrtc-direct' : run.kind} -> port ${run.port}`,
          `[control] restarted libp2p ${run.kind === 'webrtc' ? 'webrtc-direct' : run.kind} listener on port ${run.port}`
        )
        return
      }
    }

    sendJson(res, 404, { ok: false, error: 'Not found' })
  })

  server.listen(cfg.port, cfg.host, () => {
    const origin = primaryHttpOrigin(cfg.host, cfg.port, 'http')
    const localOrigins = localHttpOrigins(cfg.host, cfg.port, 'http')
    console.log(`Control HTTP listening on ${origin}`)
    if (localOrigins.length > 0) {
      console.log('  Health:')
      for (const url of localOrigins) {
        console.log(`   ${url}/health`)
      }
      console.log('  Status:')
      for (const url of localOrigins) {
        console.log(`   ${url}/status`)
      }
    }
    console.log(
      '  POST /run/tcp|ws|quic|webrtc|webrtc-direct/<port>  (Authorization: Bearer <RELAY_CONTROL_TOKEN>)'
    )
    console.log('  POST /run/restart  (Authorization: Bearer <RELAY_CONTROL_TOKEN>)')
    console.log('  GET /health  GET /status (public)')
    console.log('  GET /pinning/stats  GET /pinning/databases  POST /pinning/sync')
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
