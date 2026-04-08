/**
 * Repeatable transport test: GET /status (or --status-file), then dials
 * TCP / WebSocket / QUIC / WebRTC-Direct and appends results to a text file.
 *
 * When /status only lists 127.0.0.1, use --dial PUBLIC_IP to rewrite multiaddrs for outbound tests.
 */
import { readFile, appendFile } from 'node:fs/promises'
import { dialEchoOnce } from './echo-dial.js'

type StatusResponse = {
  ok?: boolean
  peerId?: string
  multiaddrs?: string[]
  error?: string
}

function usage(): never {
  console.error(`Usage:
  npm run test:transports -- <label> [options]

  <label>     Short name for this run (stored in the report; default echo payload).
  --out FILE  Append results here (default: transport-test-results.txt).
  --message S Echo string (default: same as <label>).
  --base URL  Control API base for GET /status (env RELAY_CONTROL_BASE).
  --token S   Bearer token for /status (env RELAY_CONTROL_TOKEN).
  --status-file PATH   Use JSON from file instead of HTTP (e.g. from SSH curl). Implies no --base/--token needed.
  --dial HOST Public IP or hostname to dial (e.g. 95.217.163.72). Rewrites /ip4/127.0.0.1/ in multiaddrs.

Examples:
  # Public control port reachable:
  RELAY_CONTROL_BASE=http://HOST:8008 RELAY_CONTROL_TOKEN=xxx npm run test:transports -- "vpn-off" --dial HOST

  # Control only on server (cloud blocks 8008): fetch status over SSH, then test locally:
  ssh root@HOST 'source /etc/default/helia-connectivity-lab; curl -sS -H "Authorization: Bearer $RELAY_CONTROL_TOKEN" http://127.0.0.1:8008/status' > /tmp/relay-status.json
  npm run test:transports -- "vpn-off" --status-file /tmp/relay-status.json --dial 95.217.163.72
`)
  process.exit(1)
}

function parseArgs(argv: string[]) {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') usage()
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[i + 1]
      if (val === undefined || val.startsWith('--')) {
        console.error(`Missing value for --${key}`)
        usage()
      }
      flags[key] = val
      i++
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

function hostFromBase(base: string): string | undefined {
  try {
    const u = new URL(base)
    const h = u.hostname
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return h
    return undefined
  } catch {
    return undefined
  }
}

/** Replace loopback in multiaddrs so we can dial the relay from another machine. */
function rewriteLoopbackToDialHost(multiaddrs: string[], dialHost: string): string[] {
  return multiaddrs.map((ma) =>
    ma
      .replaceAll('/ip4/127.0.0.1/', `/ip4/${dialHost}/`)
      .replaceAll('/ip4/0.0.0.0/', `/ip4/${dialHost}/`)
      .replaceAll('/ip6/::1/', `/ip6/${dialHost}/`)
  )
}

function filterByDialHost(multiaddrs: string[], dialHost: string): string[] {
  const needle = `/ip4/${dialHost}/`
  const needle6 = `/ip6/${dialHost}/`
  const filtered = multiaddrs.filter((ma) => ma.includes(needle) || ma.includes(needle6))
  return filtered.length > 0 ? filtered : multiaddrs
}

/** Human-readable port / protocol summary for the report. */
export function transportDialSummary(kind: 'tcp' | 'ws' | 'quic' | 'webrtc', ma: string): string {
  if (kind === 'tcp') {
    const m = ma.match(/\/tcp\/(\d+)\/p2p\//)
    return m ? `TCP port ${m[1]}` : 'TCP (port parse failed)'
  }
  if (kind === 'ws') {
    const m = ma.match(/\/tcp\/(\d+)\/ws\//)
    return m ? `WebSocket on TCP port ${m[1]}` : 'WS (port parse failed)'
  }
  if (kind === 'quic') {
    const m = ma.match(/\/udp\/(\d+)\/quic-v1\//)
    return m ? `QUIC on UDP port ${m[1]}` : 'QUIC (port parse failed)'
  }
  const m = ma.match(/\/udp\/(\d+)\/webrtc-direct\//)
  return m ? `WebRTC-Direct on UDP port ${m[1]}` : 'WebRTC-Direct (port parse failed)'
}

function pickTransport(multiaddrs: string[], kind: 'tcp' | 'ws' | 'quic' | 'webrtc'): string | undefined {
  for (const ma of multiaddrs) {
    if (kind === 'tcp') {
      if (ma.includes('/ws') || ma.includes('/quic-v1') || ma.includes('/webrtc')) continue
      if (/\/tcp\/\d+\//.test(ma) && ma.includes('/p2p/')) return ma
    }
    if (kind === 'ws') {
      if (ma.includes('/ws/') && ma.includes('/p2p/')) return ma
    }
    if (kind === 'quic') {
      if (ma.includes('/quic-v1/') && ma.includes('/p2p/')) return ma
    }
    if (kind === 'webrtc') {
      if (ma.includes('/webrtc-direct/') && ma.includes('/p2p/')) return ma
    }
  }
  return undefined
}

async function fetchStatus(base: string, token: string): Promise<StatusResponse> {
  const url = `${base.replace(/\/$/, '')}/status`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
  const text = await res.text()
  let data: StatusResponse
  try {
    data = JSON.parse(text) as StatusResponse
  } catch {
    return { ok: false, error: `Not JSON (${res.status}): ${text.slice(0, 200)}` }
  }
  if (!res.ok) {
    return { ok: false, error: data.error || `HTTP ${res.status}: ${text.slice(0, 200)}` }
  }
  return data
}

async function readStatusFile(path: string): Promise<StatusResponse> {
  const text = await readFile(path, 'utf8')
  try {
    return JSON.parse(text) as StatusResponse
  } catch {
    return { ok: false, error: `Invalid JSON in ${path}` }
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0) usage()
  const { positional, flags } = parseArgs(argv)
  const label = positional[0]
  if (!label) usage()

  const outFile = flags.out || process.env.TRANSPORT_TEST_OUT || 'transport-test-results.txt'
  const message = flags.message || process.env.TRANSPORT_TEST_MESSAGE || label
  const statusFile =
    flags['status-file'] || process.env.RELAY_STATUS_FILE?.trim() || ''
  const base =
    flags.base ||
    process.env.RELAY_CONTROL_BASE?.trim() ||
    process.env.CONTROL_BASE?.trim() ||
    ''
  const token =
    flags.token ||
    process.env.RELAY_CONTROL_TOKEN?.trim() ||
    process.env.CONTROL_TOKEN?.trim() ||
    ''

  let dialHost =
    flags.dial ||
    process.env.RELAY_DIAL_HOST?.trim() ||
    (base ? hostFromBase(base) : '') ||
    ''

  if (!dialHost) {
    console.error('Pass --dial PUBLIC_IP (or RELAY_DIAL_HOST).')
    usage()
  }

  let status: StatusResponse
  let statusSource: string

  if (statusFile) {
    status = await readStatusFile(statusFile)
    statusSource = `file:${statusFile}`
    if (!status.ok && status.multiaddrs) {
      status.ok = true
    }
  } else {
    if (!base || !token) {
      console.error('Use --status-file, or set RELAY_CONTROL_BASE + RELAY_CONTROL_TOKEN for HTTP /status.')
      usage()
    }
    status = await fetchStatus(base, token)
    statusSource = base
  }

  if (!status.multiaddrs?.length) {
    const err = status.error || 'No multiaddrs in status'
    const block = [
      '--------------------------------------------------------------------------------',
      `Transport matrix run (FAILED to load status)`,
      `Timestamp: ${new Date().toISOString()}`,
      `Label: ${label}`,
      `Error: ${err}`,
      '--------------------------------------------------------------------------------',
      '',
    ].join('\n')
    await appendFile(outFile, block, 'utf8')
    console.error(err)
    process.exit(1)
  }

  const rewritten = rewriteLoopbackToDialHost(status.multiaddrs, dialHost)
  const addrs = filterByDialHost(rewritten, dialHost)
  const picks = {
    tcp: pickTransport(addrs, 'tcp'),
    ws: pickTransport(addrs, 'ws'),
    quic: pickTransport(addrs, 'quic'),
    webrtc: pickTransport(addrs, 'webrtc'),
  } as const

  const order = ['tcp', 'ws', 'quic', 'webrtc'] as const
  const lines: string[] = []
  lines.push('Dialed multiaddrs (exact strings used):')
  for (const kind of order) {
    const ma = picks[kind]
    if (ma) {
      lines.push(`  ${kind.padEnd(8)} ${ma}`)
    } else {
      lines.push(`  ${kind.padEnd(8)} (none — SKIP)`)
    }
  }
  lines.push('')
  lines.push('Results:')

  for (const kind of order) {
    const ma = picks[kind]
    if (!ma) {
      lines.push(`  ${kind.padEnd(8)} SKIP   (no matching multiaddr for dial host)`)
      continue
    }
    const summary = transportDialSummary(kind, ma)
    try {
      const reply = await dialEchoOnce(ma, message)
      const ok = reply === `echo:${message}` || reply.startsWith('echo:')
      lines.push(
        `  ${kind.padEnd(8)} ${ok ? 'OK    ' : 'MISMATCH'} ${reply}  |  ${summary}`
      )
    } catch (e: any) {
      const msg = (e?.message || String(e)).replace(/\s+/g, ' ').slice(0, 200)
      lines.push(`  ${kind.padEnd(8)} FAIL   ${msg}  |  ${summary}`)
    }
  }

  const header = [
    '--------------------------------------------------------------------------------',
    'Transport matrix run',
    `Timestamp: ${new Date().toISOString()}`,
    `Label: ${label}`,
    `Echo message: ${message}`,
    `Status source: ${statusSource}`,
    `Dial host: ${dialHost}`,
    `PeerId: ${status.peerId || '(unknown)'}`,
    '',
  ].join('\n')

  const block = `${header}${lines.join('\n')}
--------------------------------------------------------------------------------

`
  await appendFile(outFile, block, 'utf8')
  console.log(block)
  console.log(`Appended to ${outFile}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
