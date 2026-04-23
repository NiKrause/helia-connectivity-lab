export type RelayStatus = {
  ok: boolean
  peerId: string
  multiaddrs: string[]
  /** Omitted on older relay builds before pubsub discovery. */
  pubsubDiscoveryTopic?: string
  listenOverrides?: Record<string, unknown>
}

export type RelayPinningStats = {
  totalPinned: number
  syncOperations: number
  failedSyncs: number
  pinnedMediaCids: string[]
  timestamp: string
}

export type RelayPinnedDatabase = {
  address: string
  lastSyncedAt: string
}

export type RelayPinningSync = {
  ok: true
  dbAddress: string
  receivedUpdate: boolean
  fallbackScanUsed: boolean
  extractedMediaCids: string[]
  coalesced?: boolean
}

export type RelayRestartRun = {
  ok: true
  accepted: true
  restart: 'pending'
  peerId: string
  listenOverrides: Record<string, unknown>
  multiaddrsBeforeRestart: string[]
  hint: string
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T
  } catch {
    throw new Error(`HTTP ${response.status} (non-JSON body)`)
  }
}

export function relayBase(): string {
  const b = import.meta.env.VITE_RELAY_HTTP_BASE?.trim() || 'http://libp2p.le-space.de:88'
  return b.replace(/\/$/, '')
}

function isPrivateOrLoopbackIp4(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false
  const [a, b] = parts
  if (a === 127 || a === 10 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

function isLoopbackMultiaddr(ma: string): boolean {
  return ma.includes('/ip4/127.') || ma.includes('/ip6/::1') || ma.includes('/dns4/localhost/') || ma.includes('/dns6/localhost/')
}

function normalizeLocalRelayMultiaddr(ma: string): string {
  let out = ma
  out = out.replace(/\/ip4\/0\.0\.0\.0\//g, '/ip4/127.0.0.1/')
  out = out.replace(/\/ip6\/::\//g, '/ip6/::1/')
  out = out.replace(/\/ip6\/fe80:[^/]*\//g, '/ip6/::1/')
  out = out.replace(/\/ip6\/fc[^/]*\//g, '/ip6/::1/')
  out = out.replace(/\/ip6\/fd[^/]*\//g, '/ip6/::1/')
  return out.replace(/\/ip4\/(\d+\.\d+\.\d+\.\d+)\//g, (match, host: string) => {
    return isPrivateOrLoopbackIp4(host) ? '/ip4/127.0.0.1/' : match
  })
}

function peerIdFromMultiaddr(ma: string): string {
  const match = ma.trim().match(/\/p2p\/([^/]+)$/)
  return match?.[1] ?? ''
}

function normalizeRelayMultiaddrs(base: string, addrs: string[]): string[] {
  const normalized = isLocalRelayHttpBase(base) ? addrs.map(normalizeLocalRelayMultiaddr) : addrs
  return [...new Set(normalized)]
}

function synthesizeStatusFromMultiaddrs(base: string, addrs: string[]): RelayStatus | null {
  const peerId = addrs.map(peerIdFromMultiaddr).find((candidate) => candidate !== '')
  if (peerId == null || peerId === '') return null
  return {
    ok: true,
    peerId,
    multiaddrs: normalizeRelayMultiaddrs(base, addrs),
  }
}

type RelayMultiaddrsResponse = {
  multiaddrs?: string[]
  all?: string[]
  peerId?: string | null
  error?: string
}

function multiaddrsFromFallbackJson(payload: RelayMultiaddrsResponse): string[] {
  if (Array.isArray(payload.multiaddrs)) return payload.multiaddrs
  if (Array.isArray(payload.all)) return payload.all
  return []
}

function synthesizeStatusFromFallback(base: string, payload: RelayMultiaddrsResponse): RelayStatus | null {
  const addrs = multiaddrsFromFallbackJson(payload)
  if (addrs.length === 0) return null
  const synthesized = synthesizeStatusFromMultiaddrs(base, addrs)
  if (synthesized != null) return synthesized
  const peerId = typeof payload.peerId === 'string' ? payload.peerId.trim() : ''
  if (!peerId) return null
  return {
    ok: true,
    peerId,
    multiaddrs: normalizeRelayMultiaddrs(base, addrs),
  }
}

export function isLocalRelayHttpBase(base: string): boolean {
  const trimmed = base.trim()
  if (trimmed.startsWith('/')) return true
  try {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
    const url = new URL(trimmed, origin)
    const host = url.hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || isPrivateOrLoopbackIp4(host)
  } catch {
    return false
  }
}

/** Optional relay control auth (same secret as RELAY_CONTROL_TOKEN on the server, or proxy basic/Bearer in front). */
export function relayAuthHeaders(bearerToken: string | undefined | null): HeadersInit {
  const t = bearerToken?.trim()
  if (!t) return {}
  return {
    Authorization: `Bearer ${t}`,
    'X-Control-Token': t,
  }
}

export async function fetchHealth(
  base: string,
  bearerToken?: string | null
): Promise<{ ok: boolean; raw?: unknown; error?: string }> {
  try {
    const r = await fetch(`${base}/health`, { headers: relayAuthHeaders(bearerToken) })
    const j = (await r.json()) as Record<string, unknown>
    return { ok: r.ok && j.status === 'ok', raw: j }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function fetchStatus(
  base: string,
  bearerToken?: string | null
): Promise<{ ok: true; data: RelayStatus } | { ok: false; error: string }> {
  const headers = relayAuthHeaders(bearerToken)
  try {
    const r = await fetch(`${base}/status`, { headers })
    let data: RelayStatus & { error?: string }
    try {
      data = (await r.json()) as RelayStatus & { error?: string }
    } catch {
      data = { ok: false, peerId: '', multiaddrs: [], error: `HTTP ${r.status} (non-JSON body)` }
    }
    if (r.status === 401) {
      return {
        ok: false,
        error:
          'HTTP 401 — set Control token below (same as RELAY_CONTROL_TOKEN) if your relay or proxy requires auth, or deploy a build where GET /status is public.',
      }
    }
    if (r.ok && data.ok) {
      return {
        ok: true,
        data: {
          ...data,
          multiaddrs: normalizeRelayMultiaddrs(base, data.multiaddrs ?? []),
        },
      }
    }

    const hint = data.error ? String(data.error) : ''
    const statusError = hint ? `HTTP ${r.status}: ${hint}` : `HTTP ${r.status}`

    try {
      const fallback = await fetch(`${base}/multiaddrs`, { headers })
      const fallbackJson = (await fallback.json()) as RelayMultiaddrsResponse
      if (fallback.status === 401) {
        return {
          ok: false,
          error:
            'HTTP 401 — set Control token below (same as RELAY_CONTROL_TOKEN) if your relay or proxy requires auth, or deploy a build where GET /status is public.',
        }
      }
      if (fallback.ok) {
        const synthesized = synthesizeStatusFromFallback(base, fallbackJson)
        if (synthesized != null) {
          return { ok: true, data: synthesized }
        }
      }
      const fallbackHint = fallbackJson?.error ? String(fallbackJson.error) : ''
      return { ok: false, error: fallbackHint ? `${statusError}; /multiaddrs: ${fallbackHint}` : statusError }
    } catch {
      return { ok: false, error: statusError }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function fetchPinningStats(
  base: string,
  bearerToken?: string | null
): Promise<{ ok: true; data: RelayPinningStats } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${base}/pinning/stats`, {
      headers: relayAuthHeaders(bearerToken),
    })
    const data = await parseJsonOrThrow<RelayPinningStats & { error?: string }>(response)
    if (!response.ok) {
      return { ok: false, error: data.error ? String(data.error) : `HTTP ${response.status}` }
    }
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function fetchPinnedDatabase(
  base: string,
  dbAddress: string,
  bearerToken?: string | null
): Promise<
  | { ok: true; data: RelayPinnedDatabase | null }
  | { ok: false; error: string; notFound?: boolean }
> {
  try {
    const url = new URL(`${base}/pinning/databases`)
    url.searchParams.set('address', dbAddress)
    const response = await fetch(url.toString(), {
      headers: relayAuthHeaders(bearerToken),
    })
    const data = await parseJsonOrThrow<{ databases?: RelayPinnedDatabase[]; error?: string }>(response)
    if (response.status === 404) {
      return { ok: false, error: data.error ? String(data.error) : 'Database address not found in relay sync history', notFound: true }
    }
    if (!response.ok) {
      return { ok: false, error: data.error ? String(data.error) : `HTTP ${response.status}` }
    }
    return { ok: true, data: Array.isArray(data.databases) ? (data.databases[0] ?? null) : null }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function triggerPinningSync(
  base: string,
  dbAddress: string,
  bearerToken?: string | null
): Promise<{ ok: true; data: RelayPinningSync } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${base}/pinning/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...relayAuthHeaders(bearerToken),
      },
      body: JSON.stringify({ dbAddress }),
    })
    const data = await parseJsonOrThrow<{
      ok?: boolean
      error?: string
      dbAddress: string
      receivedUpdate?: boolean
      fallbackScanUsed?: boolean
      extractedMediaCids?: string[]
      coalesced?: boolean
    }>(response)
    if (!response.ok || data.ok === false) {
      return { ok: false, error: data.error ? String(data.error) : `HTTP ${response.status}` }
    }
    return {
      ok: true,
      data: {
        ok: true,
        dbAddress: data.dbAddress,
        receivedUpdate: Boolean(data.receivedUpdate),
        fallbackScanUsed: Boolean(data.fallbackScanUsed),
        extractedMediaCids: Array.isArray(data.extractedMediaCids) ? data.extractedMediaCids : [],
        ...(data.coalesced ? { coalesced: true } : {}),
      },
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function restartRelayRuntime(
  base: string,
  bearerToken?: string | null
): Promise<{ ok: true; data: RelayRestartRun } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${base}/run/restart`, {
      method: 'POST',
      headers: relayAuthHeaders(bearerToken),
    })
    const data = await parseJsonOrThrow<RelayRestartRun & { ok?: boolean; error?: string }>(response)
    if (!response.ok) {
      return { ok: false, error: data.error ? String(data.error) : `HTTP ${response.status}` }
    }
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function pickBrowserDialMultiaddr(addrs: string[]): string | null {
  const loopbackTlsWs = addrs.find((a) => a.includes('/ws') && a.includes('/tls/') && isLoopbackMultiaddr(a))
  if (loopbackTlsWs) return loopbackTlsWs
  const loopbackWs = addrs.find((a) => a.includes('/ws') && isLoopbackMultiaddr(a))
  if (loopbackWs) return loopbackWs
  const tlsWs = addrs.find((a) => a.includes('/ws') && a.includes('/tls/'))
  if (tlsWs) return tlsWs
  const ws = addrs.find((a) => a.includes('/ws') && !a.includes('/ip4/127.') && !a.includes('/ip6/::1'))
  if (ws) return ws
  const anyWs = addrs.find((a) => a.includes('/ws'))
  return anyWs ?? null
}

/**
 * Short UI label for a dial multiaddr (browser-relevant layers first).
 * Note: `/ws` without `/tls/` becomes `ws://` in the stack; `/tls/.../ws` becomes `wss://`.
 */
export function transportLabel(ma: string): string {
  if (ma.includes('/webtransport')) return 'WebTransport'
  if (ma.includes('/webrtc') || ma.includes('/certhash')) return 'WebRTC'

  const hasWs = ma.includes('/ws') || ma.includes('/wss')
  if (hasWs) {
    const tls = ma.includes('/tls/')
    const sni = ma.includes('/sni/')
    if (tls && sni) return 'WSS · TLS+SNI'
    if (tls) return 'WSS · TLS'
    return 'WS · cleartext'
  }

  if (ma.includes('/quic-v1')) return 'QUIC (Node)'
  if (ma.includes('/tcp/')) return 'TCP (Node)'
  return 'other'
}

/**
 * True if this PWA’s libp2p stack can dial the multiaddr: WebSocket and WebRTC
 * (`/webrtc-direct`, `/webrtc/…`, circuit `/p2p-circuit/…/webrtc/…`, etc.).
 * Raw TCP and QUIC are node-only here.
 */
export function canBrowserDialMultiaddr(ma: string): boolean {
  const s = ma.trim()
  if (s.includes('/ws') || s.includes('/wss')) return true
  // `/webrtc-direct` contains the substring `/webrtc`; covers standard libp2p WebRTC multiaddr segments.
  if (s.includes('/webrtc')) return true
  return false
}
