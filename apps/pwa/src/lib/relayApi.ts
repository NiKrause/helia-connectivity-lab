export type RelayStatus = {
  ok: boolean
  peerId: string
  multiaddrs: string[]
  /** Omitted on older relay builds before pubsub discovery. */
  pubsubDiscoveryTopic?: string
  listenOverrides?: Record<string, unknown>
}

export function relayBase(): string {
  const b = import.meta.env.VITE_RELAY_HTTP_BASE?.trim() || 'http://libp2p.le-space.de:8443'
  return b.replace(/\/$/, '')
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
  try {
    const r = await fetch(`${base}/status`, { headers: relayAuthHeaders(bearerToken) })
    let data: RelayStatus & { error?: string }
    try {
      data = (await r.json()) as RelayStatus & { error?: string }
    } catch {
      return { ok: false, error: `HTTP ${r.status} (non-JSON body)` }
    }
    if (r.status === 401) {
      return {
        ok: false,
        error:
          'HTTP 401 — set Control token below (same as RELAY_CONTROL_TOKEN) if your relay or proxy requires auth, or deploy a build where GET /status is public.',
      }
    }
    if (!r.ok || !data.ok) {
      const hint = data.error ? String(data.error) : ''
      return { ok: false, error: hint ? `HTTP ${r.status}: ${hint}` : `HTTP ${r.status}` }
    }
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function pickBrowserDialMultiaddr(addrs: string[]): string | null {
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
