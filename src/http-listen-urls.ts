function normalizeDisplayHost(host: string): string {
  const trimmed = host.trim()
  if (trimmed.includes(':') && !trimmed.startsWith('[')) {
    return `[${trimmed}]`
  }
  return trimmed
}

export function primaryHttpOrigin(host: string, port: number, scheme: 'http' | 'https'): string {
  return `${scheme}://${normalizeDisplayHost(host)}:${port}`
}

export function localHttpOrigins(host: string, port: number, scheme: 'http' | 'https'): string[] {
  const trimmed = host.trim()
  const urls = new Set<string>()

  if (trimmed === '0.0.0.0') {
    urls.add(`${scheme}://127.0.0.1:${port}`)
    urls.add(`${scheme}://localhost:${port}`)
  } else if (trimmed === '::' || trimmed === '[::]') {
    urls.add(`${scheme}://[::1]:${port}`)
    urls.add(`${scheme}://127.0.0.1:${port}`)
    urls.add(`${scheme}://localhost:${port}`)
  } else {
    urls.add(primaryHttpOrigin(trimmed, port, scheme))
    if (trimmed === '127.0.0.1') {
      urls.add(`${scheme}://localhost:${port}`)
    } else if (trimmed === 'localhost') {
      urls.add(`${scheme}://127.0.0.1:${port}`)
    }
  }

  return [...urls]
}
