/**
 * Same rules as relay src/public-multiaddr-filter.ts — only public dial-relevant multiaddrs.
 * Applied in the PWA so local rows never appear even if an older relay returns them.
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

export function isPublicDialMultiaddr(maStr: string): boolean {
  const s = maStr.trim()
  if (s.length === 0) return false

  for (const m of s.matchAll(/\/ip4\/([^/]+)/g)) {
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

export function filterPublicDialMultiaddrs(addrs: string[]): string[] {
  return addrs.filter(isPublicDialMultiaddr)
}
