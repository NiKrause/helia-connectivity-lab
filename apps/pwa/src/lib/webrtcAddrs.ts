/** Multiaddr contains a WebRTC(-Direct) transport segment we care about for discovery. */
function isWebRtcLike(s: string): boolean {
  return s.includes('/webrtc-direct') || (s.includes('/webrtc') && s.includes('/certhash'))
}

function firstIp4InMa(s: string): string | null {
  const m = /\/ip4\/([^/]+)\//.exec(s)
  return m?.[1] ?? null
}

/** True for IPs browsers on the public internet cannot use as a host candidate target. */
function isNonDialableFromInternetIp4(ip: string): boolean {
  if (ip === '127.0.0.1') return true
  const oct = ip.split('.').map((x) => Number(x))
  if (oct.length !== 4 || oct.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true
  const [a, b] = oct
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 0) return true
  return false
}

/** Any WebRTC-style multiaddr in the list (including loopback-only). */
export function multiaddrsIncludeWebRTC(addrs: string[]): boolean {
  return addrs.some(isWebRtcLike)
}

/**
 * True if there is a WebRTC multiaddr the browser might dial over the public internet.
 * Loopback / RFC1918 IPv4 targets are excluded; non-`/ip4/` WebRTC addrs are treated as worth trying.
 */
export function multiaddrsIncludePublicDialableWebRTC(addrs: string[]): boolean {
  for (const s of addrs) {
    if (!isWebRtcLike(s)) continue
    const ip = firstIp4InMa(s)
    if (ip == null) return true
    if (!isNonDialableFromInternetIp4(ip)) return true
  }
  return false
}

/** User-facing detail when we skip or attempt WebRTC auto-dial. */
export function webRtcDiscoveryDetail(addrs: string[]): string | undefined {
  if (multiaddrsIncludePublicDialableWebRTC(addrs)) return undefined
  if (!multiaddrsIncludeWebRTC(addrs)) return 'no WebRTC in advertised addrs'
  return (
    'WebRTC only on loopback/private IPv4 — browsers need /ip4/PUBLIC/udp/PORT/webrtc-direct/… ' +
    'in gossipsub. Copy the listen line, swap the IP for your VPS public address, and set RELAY_APPEND_ANNOUNCE (same certhash).'
  )
}
