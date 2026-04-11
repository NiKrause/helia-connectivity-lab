import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

export type RelayPinningSyncResult = {
  ok: boolean
  error?: string
  receivedUpdate?: boolean
  fallbackScanUsed?: boolean
  extractedMediaCids?: string[]
  coalesced?: boolean
}

export type RelayPinnedCidResult =
  | {
      ok: true
      contentType?: string
      chunks: AsyncIterable<Uint8Array>
    }
  | {
      ok: false
      status: number
      error: string
    }

export type RelayPinningHandlers = {
  getStats: () => Record<string, unknown>
  getDatabases: (opts?: { address?: string }) => { databases: Array<Record<string, unknown>>; total: number }
  syncDatabase: (dbAddress: string) => Promise<RelayPinningSyncResult>
  streamPinnedCid?: (cidStr: string, pathWithin?: string) => Promise<RelayPinnedCidResult>
}

export type ParsedIpfsRequest =
  | {
      handled: false
    }
  | {
      handled: true
      ok: true
      cidStr: string
      pathWithin?: string
    }
  | {
      handled: true
      ok: false
      status: number
      error: string
    }

const MAX_JSON_BODY_BYTES = 16_384
const SYNC_RETRY_ATTEMPTS = 3
const SYNC_RETRY_DELAY_MS = 2_000

function sendJson(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'private, no-store')
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_JSON_BODY_BYTES) {
      throw new Error('body too large')
    }
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function firstSearchParam(reqUrl: string | undefined, names: string[]): string {
  const url = new URL(reqUrl || '/', 'http://relay.local')
  for (const name of names) {
    const value = url.searchParams.get(name)
    if (value != null && value.trim() !== '') {
      return value.trim()
    }
  }
  return ''
}

export function parseIpfsRequest(req: Pick<http.IncomingMessage, 'method' | 'url'>): ParsedIpfsRequest {
  if (req.method !== 'GET') return { handled: false }
  const pathname = (req.url ?? '/').split('?')[0] || '/'
  if (!pathname.startsWith('/ipfs/')) return { handled: false }

  let parts: string[]
  try {
    parts = pathname
      .slice('/ipfs/'.length)
      .split('/')
      .filter((part) => part.length > 0)
      .map((part) => decodeURIComponent(part))
  } catch {
    return { handled: true, ok: false, status: 400, error: 'Invalid path encoding' }
  }

  if (parts.length === 0) {
    return { handled: true, ok: false, status: 400, error: 'Missing CID' }
  }

  return {
    handled: true,
    ok: true,
    cidStr: parts[0],
    pathWithin: parts.length > 1 ? parts.slice(1).join('/') : undefined,
  }
}

export async function tryServePinningHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pinning: RelayPinningHandlers | null
): Promise<boolean> {
  if (pinning == null) return false
  const pathname = (req.url ?? '/').split('?')[0] || '/'

  if (req.method === 'GET' && pathname === '/pinning/stats') {
    sendJson(res, 200, pinning.getStats())
    return true
  }

  if (req.method === 'GET' && pathname === '/pinning/databases') {
    const filterRaw = firstSearchParam(req.url, ['address', 'dbAddress'])
    const payload = pinning.getDatabases(filterRaw ? { address: filterRaw } : undefined)
    if (filterRaw && payload.total === 0) {
      sendJson(res, 404, {
        ok: false,
        error: 'Database address not found in relay sync history',
      })
      return true
    }
    sendJson(res, 200, payload)
    return true
  }

  if (req.method === 'POST' && pathname === '/pinning/sync') {
    try {
      const body = (await readJsonBody(req)) as { dbAddress?: string }
      const dbAddress = (typeof body?.dbAddress === 'string' ? body.dbAddress.trim() : '') || firstSearchParam(req.url, ['dbAddress', 'address'])
      if (!dbAddress) {
        sendJson(res, 400, { ok: false, error: 'Missing or invalid dbAddress' })
        return true
      }

      let result = await pinning.syncDatabase(dbAddress)
      let attempts = 1
      while (
        attempts < SYNC_RETRY_ATTEMPTS &&
        result.ok &&
        ((result.coalesced ?? false) ||
          (!(result.receivedUpdate ?? false) && (result.extractedMediaCids?.length ?? 0) === 0))
      ) {
        await delay(SYNC_RETRY_DELAY_MS)
        attempts += 1
        result = await pinning.syncDatabase(dbAddress)
      }
      if (!result.ok) {
        sendJson(res, 500, { ok: false, error: result.error || 'sync failed' })
        return true
      }

      sendJson(res, 200, {
        ok: true,
        dbAddress,
        receivedUpdate: result.receivedUpdate ?? false,
        fallbackScanUsed: result.fallbackScanUsed ?? false,
        extractedMediaCids: result.extractedMediaCids ?? [],
        attempts,
        ...(result.coalesced ? { coalesced: true } : {}),
      })
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
    }
    return true
  }

  return false
}

export async function tryServePinnedCidHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pinning: RelayPinningHandlers | null
): Promise<boolean> {
  if (pinning?.streamPinnedCid == null) return false
  const parsed = parseIpfsRequest(req)
  if (!parsed.handled) return false
  if (!parsed.ok) {
    sendJson(res, parsed.status, { error: parsed.error })
    return true
  }

  const { cidStr, pathWithin } = parsed
  const out = await pinning.streamPinnedCid(cidStr, pathWithin)
  if (!out.ok) {
    sendJson(res, out.status, { error: out.error })
    return true
  }

  res.statusCode = 200
  res.setHeader('Content-Type', out.contentType || 'application/octet-stream')
  res.setHeader('Cache-Control', 'private, no-store')
  for await (const chunk of out.chunks) {
    if (!res.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        res.once('drain', resolve)
        res.once('error', reject)
      })
    }
  }
  res.end()
  return true
}
