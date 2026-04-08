import http from 'node:http'
import type { RelayRuntime } from './relay-runtime.js'
import { logRelayBanner, startRelayRuntime } from './relay-runtime.js'
import type { PrivateKey } from '@libp2p/interface'
import type { RelayListenOverrides } from './libp2p-server-config.js'

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

function parseRunPath(pathname: string): { kind: 'tcp' | 'ws' | 'quic'; port: number } | null {
  const m = pathname.match(/^\/run\/(tcp|ws|quic)\/(\d{1,5})\/?$/)
  if (!m) return null
  const port = Number(m[2])
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null
  return { kind: m[1] as 'tcp' | 'ws' | 'quic', port }
}

export type ControlHttpServer = {
  close: () => Promise<void>
}

/**
 * HTTP control plane (e.g. Nym-friendly port like 8008) to restart libp2p listeners without changing PeerId.
 * POST /run/tcp/81 — rebind TCP (requires root or CAP_NET_BIND_SERVICE for ports &lt; 1024).
 * POST /run/ws/8080 — rebind WebSocket listener port.
 * POST /run/quic/5000 — rebind QUIC (UDP) listener port.
 */
export function startControlHttpServer(opts: {
  privateKey: PrivateKey
  getRuntime: () => RelayRuntime
  setRuntime: (r: RelayRuntime) => void
  getOverrides: () => RelayListenOverrides
  setOverrides: (o: RelayListenOverrides) => void
}): ControlHttpServer {
  const cfg = readControlConfig()
  if (!cfg.enabled) {
    return { close: async () => {} }
  }
  if (!cfg.token) {
    console.warn(
      'RELAY_CONTROL_HTTP_PORT is set but RELAY_CONTROL_TOKEN is empty — control API disabled (set a strong token).'
    )
    return { close: async () => {} }
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

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { status: 'ok', control: true })
      return
    }

    const authed = authorize(req, cfg.token)

    if (req.method === 'GET' && pathname === '/status') {
      if (!authed) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' })
        return
      }
      const rt = opts.getRuntime()
      sendJson(res, 200, {
        ok: true,
        peerId: rt.libp2p.peerId.toString(),
        listenOverrides: opts.getOverrides(),
        multiaddrs: rt.libp2p.getMultiaddrs().map((ma) => ma.toString()),
      })
      return
    }

    if (!authed) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized' })
      return
    }

    if (req.method === 'POST') {
      const run = parseRunPath(pathname)
      if (run) {
        const prev = opts.getOverrides()
        const next: RelayListenOverrides = {
          ...prev,
          ...(run.kind === 'tcp' ? { tcpPort: run.port } : run.kind === 'ws' ? { wsPort: run.port } : { quicPort: run.port }),
        }

        try {
          await runSerial(async () => {
            const old = opts.getRuntime()
            await old.stop()
            opts.setOverrides(next)
            const created = await startRelayRuntime(opts.privateKey, next)
            opts.setRuntime(created)
            console.log(`[control] restarted libp2p ${run.kind} listener on port ${run.port}`)
            logRelayBanner(created.libp2p)
          })
          const rt = opts.getRuntime()
          sendJson(res, 200, {
            ok: true,
            peerId: rt.libp2p.peerId.toString(),
            listenOverrides: opts.getOverrides(),
            multiaddrs: rt.libp2p.getMultiaddrs().map((ma) => ma.toString()),
          })
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: e?.message || String(e) })
        }
        return
      }
    }

    sendJson(res, 404, { ok: false, error: 'Not found' })
  })

  server.listen(cfg.port, cfg.host, () => {
    console.log(`Control HTTP listening on http://${cfg.host}:${cfg.port}`)
    console.log(
      '  POST /run/tcp/<port>  POST /run/ws/<port>  POST /run/quic/<udp-port>  (Authorization: Bearer <RELAY_CONTROL_TOKEN>)'
    )
    console.log('  GET /health  GET /status (auth)')
  })

  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

export { readControlConfig }
