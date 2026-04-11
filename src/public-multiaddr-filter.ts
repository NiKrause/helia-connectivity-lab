/**
 * Filter relay listen multiaddrs for public GET /status (no RFC1918 / loopback / link-local).
 */

function isPublicIPv4(host: string): boolean {
  const parts = host.split('.').map((x) => Number(x))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return true
  }
  const [a, b] = parts
  if (a === 10) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 127) return false
  if (a === 169 && b === 254) return false
  if (a === 0) return false
  return true
}

/** True if this multiaddr string should appear in public /status. */
export function isPublicStatusMultiaddr(maStr: string): boolean {
  const s = maStr.trim()
  if (s.length === 0) return false

  const ip4Blocks = s.matchAll(/\/ip4\/([^/]+)/g)
  for (const m of ip4Blocks) {
    if (!isPublicIPv4(m[1])) return false
  }

  if (s.includes('/ip6/::1')) return false
  if (s.includes('/ip6/::ffff:127.')) return false
  if (s.includes('/ip6/fe80:')) return false
  if (s.includes('/ip6/fe80::')) return false
  if (s.includes('/ip6/fc')) return false
  if (s.includes('/ip6/fd')) return false

  return true
}

export function filterMultiaddrsForPublicStatus(addrs: string[]): string[] {
  return addrs.filter(isPublicStatusMultiaddr)
}

function isLoopbackRequester(remoteAddress: string | undefined): boolean {
  const value = remoteAddress?.trim() || ''
  return (
    value === '127.0.0.1' ||
    value === '::1' ||
    value === '::ffff:127.0.0.1' ||
    value.startsWith('::ffff:127.')
  )
}

/**
 * Local callers need loopback/private relay addrs so the browser can dial the local dev relay.
 * Remote callers still get the public-only projection.
 */
export function filterMultiaddrsForStatusRequest(addrs: string[], remoteAddress: string | undefined): string[] {
  return isLoopbackRequester(remoteAddress) ? addrs : filterMultiaddrsForPublicStatus(addrs)
}
