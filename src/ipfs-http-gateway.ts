import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { unixfs } from '@helia/unixfs'
import { CID } from 'multiformats/cid'
import type { RelayRuntime } from './relay-runtime.js'

/** Shared handler options (timeout, logging). */
export type IpfsGatewayHandlerConfig = {
  catTimeoutMs: number
  log: boolean
  logProgressBytes: number
}

export type IpfsGatewayFeatureConfig = IpfsGatewayHandlerConfig & {
  /** User wants the gateway (RELAY_IPFS_GATEWAY or legacy RELAY_IPFS_HTTP_PORT). */
  enabled: boolean
  /** Bind a dedicated HTTP(S) server only when control HTTP is not running. */
  standalonePort: number
  host: string
  tls: { certPath: string; keyPath: string } | null
}

export function readIpfsGatewayFeatureConfig(): IpfsGatewayFeatureConfig {
  const port = Number(process.env.RELAY_IPFS_HTTP_PORT || process.env.IPFS_HTTP_PORT || '')
  const host = process.env.RELAY_IPFS_HTTP_HOST || process.env.IPFS_HTTP_HOST || '0.0.0.0'
  const certPath = process.env.RELAY_IPFS_TLS_CERT?.trim()
  const keyPath = process.env.RELAY_IPFS_TLS_KEY?.trim()
  const catTimeoutMs = Number(process.env.RELAY_IPFS_CAT_TIMEOUT_MS || 120_000)
  const log =
    process.env.RELAY_IPFS_GATEWAY_LOG === '1' || process.env.RELAY_IPFS_GATEWAY_LOG === 'true'
  const progressRaw = process.env.RELAY_IPFS_GATEWAY_LOG_PROGRESS_BYTES
  const progressBytes =
    progressRaw === undefined || progressRaw === ''
      ? 262_144
      : Number(progressRaw)
  const gateFlag =
    process.env.RELAY_IPFS_GATEWAY === '1' || process.env.RELAY_IPFS_GATEWAY === 'true'
  const portOk = Number.isFinite(port) && port > 0 && port <= 65535
  const enabled = gateFlag || portOk

  return {
    enabled,
    standalonePort: portOk ? port : 0,
    host,
    tls:
      certPath && keyPath
        ? { certPath, keyPath }
        : null,
    catTimeoutMs: Number.isFinite(catTimeoutMs) && catTimeoutMs > 0 ? catTimeoutMs : 120_000,
    log,
    logProgressBytes: Number.isFinite(progressBytes) && progressBytes >= 0 ? progressBytes : 262_144,
  }
}

function handlerConfigFromFeature(f: IpfsGatewayFeatureConfig): IpfsGatewayHandlerConfig {
  return {
    catTimeoutMs: f.catTimeoutMs,
    log: f.log,
    logProgressBytes: f.logProgressBytes,
  }
}

export function clientLabel(req: http.IncomingMessage): string {
  const s = req.socket
  const a = s.remoteAddress ?? ''
  const p = s.remotePort
  return p ? `${a}:${p}` : a || '(unknown)'
}

/**
 * GET /ipfs/<cid> only. Returns true if the request was handled (caller should stop routing).
 */
export async function tryServeIpfsCat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  getRuntime: () => RelayRuntime,
  cfg: IpfsGatewayHandlerConfig
): Promise<boolean> {
  if (req.method !== 'GET') {
    return false
  }
  const pathname = (req.url ?? '/').split('?')[0] || '/'
  const m = pathname.match(/^\/ipfs\/([^/]+)\/?$/)
  if (!m) {
    return false
  }

  let cid: CID
  try {
    cid = CID.parse(m[1])
  } catch {
    if (cfg.log) {
      console.log(`[ipfs-gateway] invalid CID path segment  client=${clientLabel(req)}  raw=${m[1]?.slice(0, 80)}`)
    }
    res.statusCode = 400
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end('Invalid CID')
    return true
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), cfg.catTimeoutMs)
  req.on('close', () => {
    if (!req.complete) controller.abort()
  })

  const t0 = Date.now()
  let sent = 0
  let nextProgressAt = cfg.logProgressBytes

  try {
    if (cfg.log) {
      console.log(
        `[ipfs-gateway] cat start  cid=${cid.toString()}  client=${clientLabel(req)}  timeoutMs=${cfg.catTimeoutMs}`
      )
    }

    const helia = getRuntime().helia
    const fsapi = unixfs(helia)
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Cid', cid.toString())

    for await (const chunk of fsapi.cat(cid, { signal: controller.signal })) {
      if (!res.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          res.once('drain', resolve)
          res.once('error', reject)
        })
      }
      sent += chunk.length
      if (cfg.log && cfg.logProgressBytes > 0 && sent >= nextProgressAt) {
        console.log(
          `[ipfs-gateway] cat progress  cid=${cid.toString()}  bytes=${sent}  elapsedMs=${Date.now() - t0}`
        )
        while (nextProgressAt <= sent) {
          nextProgressAt += cfg.logProgressBytes
        }
      }
    }
    res.end()
    if (cfg.log) {
      console.log(`[ipfs-gateway] cat done  cid=${cid.toString()}  bytes=${sent}  totalMs=${Date.now() - t0}`)
    }
  } catch (e: unknown) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    if (cfg.log) {
      const msg = aborted ? 'aborted (timeout or client closed)' : e instanceof Error ? e.message : String(e)
      console.log(
        `[ipfs-gateway] cat error  cid=${cid.toString()}  bytesSent=${sent}  elapsedMs=${Date.now() - t0}  ${msg}`
      )
    }
    if (!res.headersSent) {
      res.statusCode = aborted ? 504 : 500
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end(aborted ? 'Timeout or client closed' : (e instanceof Error ? e.message : String(e)))
    } else {
      try {
        res.destroy()
      } catch {
        // ignore
      }
    }
  } finally {
    clearTimeout(timeout)
  }

  return true
}

export type IpfsHttpGateway = {
  close: () => Promise<void>
}

/**
 * Dedicated HTTP(S) listener only when the IPFS gateway is enabled **and** the control HTTP server
 * is not running (no shared port). Otherwise routes live on the control server (same port as /status).
 */
export function startIpfsHttpGateway(
  getRuntime: () => RelayRuntime,
  opts: { mountOnControl: boolean }
): IpfsHttpGateway {
  const feature = readIpfsGatewayFeatureConfig()
  const cfg = handlerConfigFromFeature(feature)

  if (!feature.enabled) {
    return { close: async () => {} }
  }

  if (opts.mountOnControl) {
    return { close: async () => {} }
  }

  const portOk = feature.standalonePort > 0
  if (!portOk) {
    console.warn(
      '[ipfs-gateway] RELAY_IPFS_GATEWAY is set but control HTTP is disabled — set RELAY_IPFS_HTTP_PORT for a standalone gateway, or enable RELAY_CONTROL_HTTP_PORT + RELAY_CONTROL_TOKEN to share port 88.'
    )
    return { close: async () => {} }
  }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const pathname = (req.url ?? '/').split('?')[0] || '/'

    if (req.method === 'GET' && pathname === '/health') {
      if (cfg.log) {
        console.log(`[ipfs-gateway] GET /health  client=${clientLabel(req)}`)
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ status: 'ok', ipfsGateway: true }))
      return
    }

    if (await tryServeIpfsCat(req, res, getRuntime, cfg)) {
      return
    }

    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method not allowed')
      return
    }

    res.statusCode = 404
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end('Use GET /ipfs/<cid> or GET /health')
  }

  const server = feature.tls
    ? https.createServer(
        {
          cert: fs.readFileSync(feature.tls.certPath),
          key: fs.readFileSync(feature.tls.keyPath),
        },
        (req, res) => {
          void handler(req, res)
        }
      )
    : http.createServer((req, res) => {
        void handler(req, res)
      })

  server.listen(feature.standalonePort, feature.host, () => {
    const scheme = feature.tls ? 'https' : 'http'
    console.log(
      `IPFS HTTP gateway (standalone) on ${scheme}://${feature.host}:${feature.standalonePort} — same as control when possible; this is fallback only.`
    )
    console.log(`  GET /ipfs/<cid>  (streams unixfs.cat over libp2p / bitswap)`)
    console.log('  GET /health')
    if (cfg.log) {
      console.log(
        '[ipfs-gateway] RELAY_IPFS_GATEWAY_LOG is on — per-request lines in journal (journalctl -u helia-connectivity-lab -f)'
      )
    }
  })

  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
