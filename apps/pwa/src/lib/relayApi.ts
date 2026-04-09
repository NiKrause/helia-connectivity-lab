export type RelayStatus = {
  ok: boolean
  peerId: string
  multiaddrs: string[]
  pubsubDiscoveryTopic: string
  listenOverrides?: Record<string, unknown>
}

export function relayBase(): string {
  const b = import.meta.env.VITE_RELAY_HTTP_BASE?.trim() || 'http://libp2p.le-space.de:8443'
  return b.replace(/\/$/, '')
}

export async function fetchHealth(base: string): Promise<{ ok: boolean; raw?: unknown; error?: string }> {
  try {
    const r = await fetch(`${base}/health`)
    const j = (await r.json()) as Record<string, unknown>
    return { ok: r.ok && j.status === 'ok', raw: j }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function fetchStatus(base: string): Promise<{ ok: true; data: RelayStatus } | { ok: false; error: string }> {
  try {
    const r = await fetch(`${base}/status`)
    const data = (await r.json()) as RelayStatus
    if (!r.ok || !data.ok) {
      return { ok: false, error: `HTTP ${r.status}` }
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

export function transportLabel(ma: string): string {
  if (ma.includes('/quic-v1')) return 'QUIC (Node)'
  if (ma.includes('/ws') || ma.includes('/wss')) return ma.includes('/tls/') ? 'WSS' : 'WS'
  if (ma.includes('/webrtc') || ma.includes('/certhash')) return 'WebRTC'
  if (ma.includes('/tcp/') && !ma.includes('/ws')) return 'TCP (Node)'
  return 'other'
}

/** Browser stack dials relay over WebSocket (WSS/WS); not raw TCP/QUIC. */
export function canBrowserDialMultiaddr(ma: string): boolean {
  return ma.includes('/ws')
}
