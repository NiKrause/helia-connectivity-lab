import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { unixfs } from '@helia/unixfs'
import { CID } from 'multiformats/cid'
import type { RelayRuntime } from './relay-runtime.js'
import { localHttpOrigins, primaryHttpOrigin } from './http-listen-urls.js'
import { parseIpfsRequest, tryServePinnedCidHttp } from './pinning-http.js'

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

function sendGatewayError(res: http.ServerResponse, status: number, error: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'private, no-store')
  res.end(JSON.stringify({ error }))
}

function gatewayErrorStatus(error: unknown): { status: number; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  if (message.toLowerCase().includes('abort')) {
    return { status: 504, message: 'Timed out while fetching CID over libp2p' }
  }
  if (
    message.includes('ERR_NOT_FOUND') ||
    message.toLowerCase().includes('not found') ||
    message.toLowerCase().includes('missing block') ||
    message.toLowerCase().includes('no links named')
  ) {
    return { status: 404, message: 'Content not found on relay or network' }
  }
  return { status: 502, message }
}

async function tryServeRuntimeUnixfsCat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: RelayRuntime,
  cfg: IpfsGatewayHandlerConfig
): Promise<boolean> {
  const parsed = parseIpfsRequest(req)
  if (!parsed.handled) return false
  if (!parsed.ok) {
    sendGatewayError(res, parsed.status, parsed.error)
    return true
  }
  if (runtime.helia == null) {
    sendGatewayError(res, 503, 'Helia gateway is not available')
    return true
  }

  let cid: CID
  try {
    cid = CID.parse(parsed.cidStr)
  } catch {
    sendGatewayError(res, 400, 'Invalid CID')
    return true
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('gateway timeout')), cfg.catTimeoutMs)
  const fsApi = unixfs(runtime.helia)
  const unixfsOpts = {
    signal: controller.signal,
    ...(parsed.pathWithin ? { path: parsed.pathWithin } : {}),
  }

  try {
    const stat = await fsApi.stat(cid, unixfsOpts)
    if (stat.type === 'directory') {
      sendGatewayError(
        res,
        400,
        'Directory download is not supported; specify a file path under the CID'
      )
      return true
    }

    res.statusCode = 200
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Cache-Control', 'private, no-store')

    for await (const chunk of fsApi.cat(cid, unixfsOpts)) {
      if (!res.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          res.once('drain', resolve)
          res.once('error', reject)
        })
      }
    }
    res.end()
    return true
  } catch (error) {
    const mapped = gatewayErrorStatus(error)
    if (!res.headersSent) {
      sendGatewayError(res, mapped.status, mapped.message)
    } else {
      try {
        res.destroy(error instanceof Error ? error : undefined)
      } catch {
        // ignore
      }
    }
    return true
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * GET /ipfs/<cid> or /ipfs/<cid>/<path...>. Returns true if the request was handled.
 */
export async function tryServeIpfsCat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  getRuntime: () => RelayRuntime,
  cfg: IpfsGatewayHandlerConfig
): Promise<boolean> {
  const pathname = (req.url ?? '/').split('?')[0] || '/'
  if (!pathname.startsWith('/ipfs/')) return false
  const t0 = Date.now()
  const rawTarget = pathname.slice('/ipfs/'.length).split('/')[0] || '(missing)'
  let sent = 0
  let nextProgressAt = cfg.logProgressBytes
  const origWrite = res.write.bind(res)

  try {
    if (cfg.log) {
      console.log(
        `[ipfs-gateway] cat start  target=${rawTarget.slice(0, 120)}  client=${clientLabel(req)}`
      )
    }
    res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      let len = 0
      if (chunk instanceof Uint8Array || Buffer.isBuffer(chunk)) {
        len = chunk.length
      } else if (typeof chunk === 'string') {
        len = Buffer.byteLength(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined)
      }
      sent += len
      if (cfg.log && cfg.logProgressBytes > 0 && sent >= nextProgressAt) {
        console.log(
          `[ipfs-gateway] cat progress  target=${rawTarget.slice(0, 120)}  bytes=${sent}  elapsedMs=${Date.now() - t0}`
        )
        while (nextProgressAt <= sent) {
          nextProgressAt += cfg.logProgressBytes
        }
      }
      return (origWrite as (...args: unknown[]) => boolean)(chunk, encoding, cb)
    }) as typeof res.write

    const runtime = getRuntime()
    const parsed = parseIpfsRequest(req)
    if (!parsed.handled) {
      return false
    }
    if (!parsed.ok) {
      sendGatewayError(res, parsed.status, parsed.error)
      return true
    }

    const pinnedResult =
      runtime.pinning?.streamPinnedCid == null
        ? null
        : await runtime.pinning.streamPinnedCid(parsed.cidStr, parsed.pathWithin)
    if (pinnedResult?.ok) {
      res.statusCode = 200
      res.setHeader('Content-Type', pinnedResult.contentType || 'application/octet-stream')
      res.setHeader('Cache-Control', 'private, no-store')
      for await (const chunk of pinnedResult.chunks) {
        if (!res.write(chunk)) {
          await new Promise<void>((resolve, reject) => {
            res.once('drain', resolve)
            res.once('error', reject)
          })
        }
      }
      res.end()
    } else if (pinnedResult == null || pinnedResult.status === 404) {
      await tryServeRuntimeUnixfsCat(req, res, runtime, cfg)
    } else {
      sendGatewayError(res, pinnedResult.status, pinnedResult.error)
    }
    if (cfg.log) {
      console.log(`[ipfs-gateway] cat done  target=${rawTarget.slice(0, 120)}  bytes=${sent}  totalMs=${Date.now() - t0}`)
    }
  } catch (e: unknown) {
    if (cfg.log) {
      const msg = e instanceof Error ? e.message : String(e)
      console.log(
        `[ipfs-gateway] cat error  target=${rawTarget.slice(0, 120)}  bytesSent=${sent}  elapsedMs=${Date.now() - t0}  ${msg}`
      )
    }
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end(e instanceof Error ? e.message : String(e))
    } else {
      try {
        res.destroy()
      } catch {
        // ignore
      }
    }
  } finally {
    res.write = origWrite
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
      '[ipfs-gateway] RELAY_IPFS_GATEWAY is set but control HTTP is disabled — set RELAY_IPFS_HTTP_PORT for a standalone gateway, or enable RELAY_CONTROL_HTTP_PORT + RELAY_CONTROL_TOKEN to share the control HTTP port.'
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
    const origin = primaryHttpOrigin(feature.host, feature.standalonePort, scheme)
    const localOrigins = localHttpOrigins(feature.host, feature.standalonePort, scheme)
    console.log(
      `IPFS HTTP gateway (standalone) on ${origin} — same as control when possible; this is fallback only.`
    )
    if (localOrigins.length > 0) {
      console.log('  Health:')
      for (const url of localOrigins) {
        console.log(`   ${url}/health`)
      }
    }
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
