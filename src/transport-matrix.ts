/**
 * Repeatable transport test: fetches multiaddrs from control GET /status, then dials
 * TCP / WebSocket / QUIC / WebRTC-Direct and records results to a text file.
 *
 * Usage:
 *   RELAY_CONTROL_BASE=http://HOST:8008 RELAY_CONTROL_TOKEN=secret npm run test:transports -- "vpn-off"
 *   npm run test:transports -- "vpn-on" --out ./my-runs.txt --message "probe-1"
 */
import { appendFile } from 'node:fs/promises'
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
  --base URL  Control API base (default: env RELAY_CONTROL_BASE or CONTROL_BASE).
  --token S   Bearer token (default: env RELAY_CONTROL_TOKEN or CONTROL_TOKEN).
  --dial HOST Only use multiaddrs containing this host (IP or DNS), e.g. 95.217.163.72.
              Default: hostname from --base if it looks like an IP; else env RELAY_DIAL_HOST.

Examples:
  RELAY_CONTROL_BASE=http://95.217.163.72:8008 RELAY_CONTROL_TOKEN=xxx npm run test:transports -- "without-vpn"
  RELAY_CONTROL_BASE=http://95.217.163.72:8008 RELAY_CONTROL_TOKEN=xxx npm run test:transports -- "with-nym-vpn" --out ./vpn-compare.txt
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

function filterByDialHost(multiaddrs: string[], dialHost: string): string[] {
  const needle = `/ip4/${dialHost}/`
  const needle6 = `/ip6/${dialHost}/`
  const filtered = multiaddrs.filter((ma) => ma.includes(needle) || ma.includes(needle6))
  return filtered.length > 0 ? filtered : multiaddrs
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

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0) usage()
  const { positional, flags } = parseArgs(argv)
  const label = positional[0]
  if (!label) usage()

  const outFile = flags.out || process.env.TRANSPORT_TEST_OUT || 'transport-test-results.txt'
  const message = flags.message || process.env.TRANSPORT_TEST_MESSAGE || label
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

  if (!base || !token) {
    console.error('Set RELAY_CONTROL_BASE and RELAY_CONTROL_TOKEN, or pass --base and --token.')
    usage()
  }
  if (!dialHost) {
    console.error('Could not infer dial host; set RELAY_DIAL_HOST or pass --dial <ip-or-host>.')
    usage()
  }

  const status = await fetchStatus(base, token)
  if (!status.ok || !status.multiaddrs?.length) {
    const err = status.error || 'No multiaddrs in /status'
    const block = [
      '--------------------------------------------------------------------------------',
      `Transport matrix run (FAILED to fetch status)`,
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

  const addrs = filterByDialHost(status.multiaddrs, dialHost)
  const picks = {
    tcp: pickTransport(addrs, 'tcp'),
    ws: pickTransport(addrs, 'ws'),
    quic: pickTransport(addrs, 'quic'),
    webrtc: pickTransport(addrs, 'webrtc'),
  } as const

  const order = ['tcp', 'ws', 'quic', 'webrtc'] as const
  const lines: string[] = []
  lines.push('Results:')

  for (const kind of order) {
    const ma = picks[kind]
    if (!ma) {
      lines.push(`  ${kind.padEnd(8)} SKIP   (no matching multiaddr for dial host)`)
      continue
    }
    try {
      const reply = await dialEchoOnce(ma, message)
      const ok = reply === `echo:${message}` || reply.startsWith('echo:')
      lines.push(`  ${kind.padEnd(8)} ${ok ? 'OK    ' : 'MISMATCH'} ${reply}`)
    } catch (e: any) {
      const msg = (e?.message || String(e)).replace(/\s+/g, ' ').slice(0, 200)
      lines.push(`  ${kind.padEnd(8)} FAIL   ${msg}`)
    }
  }

  const header = [
    '--------------------------------------------------------------------------------',
    'Transport matrix run',
    `Timestamp: ${new Date().toISOString()}`,
    `Label: ${label}`,
    `Echo message: ${message}`,
    `Control base: ${base}`,
    `Dial host filter: ${dialHost}`,
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
