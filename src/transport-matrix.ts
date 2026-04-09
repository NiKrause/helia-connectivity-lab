/**
 * Repeatable transport test: GET /status (or --status-file), then dials
 * TCP / WebSocket / QUIC / WebRTC-Direct and appends results to a text file.
 *
 * When /status only lists 127.0.0.1, use --dial RELAY_PUBLIC_IP to rewrite multiaddrs.
 * --dial is the relay’s reachable address (destination), not this machine’s public IP.
 */
import { readFile, appendFile } from 'node:fs/promises'
import { BULK_LADDER_SEC } from './bulk-constants.js'
import { dialEchoOnce } from './echo-dial.js'
import { dialBulkTransfer } from './transfer-dial.js'

type StatusResponse = {
  ok?: boolean
  peerId?: string
  multiaddrs?: string[]
  pubsubDiscoveryTopic?: string
  listenOverrides?: Record<string, unknown>
  error?: string
}

function usage(): never {
  console.error(`Usage:
  npm run test:transports -- <label> [options]

  <label>     Short name for this run (stored in the report; default echo payload for mode echo).
  --out FILE  Append results here (default: transport-test-results.txt).
  --mode echo|bulk   echo = one-line echo (default). bulk = random framed payloads for a duration.
  --duration SEC     With --mode bulk: run exactly SEC seconds per transport (overrides default 30s).
  --escalate         With --mode bulk: run 30,60,120,180,300,600s per transport until first failure.
  --message S Echo string (default: same as <label>; mode echo only).
  --base URL  Control API base for GET /status (env RELAY_CONTROL_BASE). /status is public (no auth).
  --token S   Optional Bearer token (ignored for GET /status; use for POST /run if you script it).
  --status-file PATH   Use JSON from file instead of HTTP (e.g. from SSH curl). Implies no --base/--token needed.
  --dial HOST   Relay’s public IP or DNS name (libp2p destination). Rewrites /ip4/127.0.0.1/ in multiaddrs — NOT your laptop’s IP.
  --show-egress-ip     Look up this machine’s public IP (via api.ipify.org) and print it in the report (VPN before/after checks).

Examples:
  # Public control port reachable:
  RELAY_CONTROL_BASE=http://HOST:8008 RELAY_CONTROL_TOKEN=xxx npm run test:transports -- "vpn-off" --dial HOST

  # Control only on server (cloud blocks 8008): fetch status over SSH, then test locally:
  ssh root@HOST 'curl -sS http://127.0.0.1:8008/status' > /tmp/relay-status.json
  npm run test:transports -- "vpn-off" --status-file /tmp/relay-status.json --dial 95.217.163.72

  # Bulk random payload echo (same transports), fixed 30s each (default):
  npm run test:transports -- "vpn-bulk" --mode bulk --dial 95.217.163.72 --status-file /tmp/relay-status.json

  # Bulk for exactly 120s per transport:
  npm run test:transports -- "vpn-bulk" --mode bulk --duration 120 --dial HOST --status-file /tmp/status.json

  # Bulk escalation ladder (30s → … → 10m) per transport, stops at first failure:
  npm run test:transports -- "vpn-bulk" --mode bulk --escalate --dial HOST --status-file /tmp/status.json
`)
  process.exit(1)
}

function parseArgs(argv: string[]) {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  const boolFlags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') usage()
    if (a === '--escalate') {
      boolFlags.add('escalate')
      continue
    }
    if (a === '--show-egress-ip') {
      boolFlags.add('show-egress-ip')
      continue
    }
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
  return { positional, flags, boolFlags }
}

/** Best-effort public IP of *this* machine (for VPN / egress labeling). */
async function fetchThisMachinePublicIp(): Promise<string | undefined> {
  try {
    const res = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return undefined
    const j = (await res.json()) as { ip?: string }
    const ip = j.ip?.trim()
    return ip || undefined
  } catch {
    return undefined
  }
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

type BulkPlan = { escalate: boolean; durationSec: number }

function resolveBulkPlan(flags: Record<string, string>, boolFlags: Set<string>): BulkPlan {
  const raw = flags.duration ? Number(flags.duration) : NaN
  if (Number.isFinite(raw) && raw >= 1) {
    return { escalate: false, durationSec: Math.floor(raw) }
  }
  if (boolFlags.has('escalate')) {
    return { escalate: true, durationSec: 0 }
  }
  return { escalate: false, durationSec: 30 }
}

function pushProgress(lines: string[], line: string): void {
  lines.push(line)
  console.log(line)
}

async function bulkLinesForTransport(
  ma: string,
  kind: string,
  summary: string,
  plan: BulkPlan,
  lines: string[]
): Promise<void> {
  if (plan.escalate) {
    for (const sec of BULK_LADDER_SEC) {
      const r = await dialBulkTransfer(ma, sec * 1000)
      const tag = `bulk ${sec}s`
      if (r.ok) {
        pushProgress(
          lines,
          `  ${kind.padEnd(8)} OK     ${tag} rounds=${r.rounds} up=${r.bytesSent} down=${r.bytesRecv}  |  ${summary}`
        )
      } else {
        const err = (r.error || 'fail').replace(/\s+/g, ' ').slice(0, 120)
        pushProgress(lines, `  ${kind.padEnd(8)} FAIL   ${tag} ${err}  |  ${summary}`)
        break
      }
    }
    return
  }
  const sec = plan.durationSec
  const r = await dialBulkTransfer(ma, sec * 1000)
  const tag = `bulk ${sec}s`
  if (r.ok) {
    pushProgress(
      lines,
      `  ${kind.padEnd(8)} OK     ${tag} rounds=${r.rounds} up=${r.bytesSent} down=${r.bytesRecv}  |  ${summary}`
    )
  } else {
    const err = (r.error || 'fail').replace(/\s+/g, ' ').slice(0, 120)
    pushProgress(lines, `  ${kind.padEnd(8)} FAIL   ${tag} ${err}  |  ${summary}`)
  }
}

async function fetchStatus(base: string, token: string): Promise<StatusResponse> {
  const url = `${base.replace(/\/$/, '')}/status`
  const headers: Record<string, string> = {}
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  const res = await fetch(url, { headers })
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
  const { positional, flags, boolFlags } = parseArgs(argv)
  const label = positional[0]
  if (!label) usage()

  const mode = (flags.mode || process.env.TRANSPORT_TEST_MODE || 'echo').toLowerCase()
  if (mode !== 'echo' && mode !== 'bulk') {
    console.error('--mode must be echo or bulk')
    usage()
  }
  const bulkPlan = mode === 'bulk' ? resolveBulkPlan(flags, boolFlags) : null

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
    console.error('Pass --dial RELAY_PUBLIC_IP (or RELAY_DIAL_HOST) — the relay’s address, not your own IP.')
    usage()
  }

  const showEgressIp =
    boolFlags.has('show-egress-ip') ||
    process.env.TRANSPORT_TEST_SHOW_EGRESS_IP === '1' ||
    process.env.TRANSPORT_TEST_SHOW_EGRESS_IP === 'true'
  const thisMachineIp = showEgressIp ? await fetchThisMachinePublicIp() : undefined

  let status: StatusResponse
  let statusSource: string

  if (statusFile) {
    status = await readStatusFile(statusFile)
    statusSource = `file:${statusFile}`
    if (!status.ok && status.multiaddrs) {
      status.ok = true
    }
  } else {
    if (!base) {
      console.error('Use --status-file, or set RELAY_CONTROL_BASE for HTTP /status.')
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

  const bulkDesc =
    mode === 'bulk' && bulkPlan
      ? bulkPlan.escalate
        ? `Bulk escalation: ${[...BULK_LADDER_SEC].join('s, ')}s per transport`
        : `Bulk duration: ${bulkPlan.durationSec}s per transport`
      : null

  const header = [
    '--------------------------------------------------------------------------------',
    'Transport matrix run',
    `Timestamp: ${new Date().toISOString()}`,
    `Label: ${label}`,
    `Mode: ${mode}`,
    ...(bulkDesc ? [bulkDesc] : []),
    ...(mode === 'echo' ? [`Echo message: ${message}`] : []),
    `Status source: ${statusSource}`,
    `Relay dial target: ${dialHost}  (libp2p /ip4/... destination; the VPS, not this computer)`,
    ...(showEgressIp
      ? [
          thisMachineIp
            ? `This machine public IP (egress): ${thisMachineIp}`
            : 'This machine public IP (egress): (lookup failed — try: curl -sS https://api.ipify.org)',
        ]
      : []),
    `PeerId: ${status.peerId || '(unknown)'}`,
    '',
  ].join('\n')

  console.log(header)

  const order = ['tcp', 'ws', 'quic', 'webrtc'] as const
  const lines: string[] = []
  pushProgress(lines, 'Dialed multiaddrs (exact strings used):')
  for (const kind of order) {
    const ma = picks[kind]
    if (ma) {
      pushProgress(lines, `  ${kind.padEnd(8)} ${ma}`)
    } else {
      pushProgress(lines, `  ${kind.padEnd(8)} (none — SKIP)`)
    }
  }
  pushProgress(lines, '')
  pushProgress(lines, 'Results:')

  for (const kind of order) {
    const ma = picks[kind]
    if (!ma) {
      pushProgress(lines, `  ${kind.padEnd(8)} SKIP   (no matching multiaddr for relay dial target)`)
      continue
    }
    const summary = transportDialSummary(kind, ma)
    if (mode === 'bulk' && bulkPlan) {
      try {
        await bulkLinesForTransport(ma, kind, summary, bulkPlan, lines)
      } catch (e: any) {
        const msg = (e?.message || String(e)).replace(/\s+/g, ' ').slice(0, 200)
        pushProgress(lines, `  ${kind.padEnd(8)} FAIL   ${msg}  |  ${summary}`)
      }
      continue
    }
    try {
      const reply = await dialEchoOnce(ma, message)
      const ok = reply === `echo:${message}` || reply.startsWith('echo:')
      pushProgress(
        lines,
        `  ${kind.padEnd(8)} ${ok ? 'OK    ' : 'MISMATCH'} ${reply}  |  ${summary}`
      )
    } catch (e: any) {
      const msg = (e?.message || String(e)).replace(/\s+/g, ' ').slice(0, 200)
      pushProgress(lines, `  ${kind.padEnd(8)} FAIL   ${msg}  |  ${summary}`)
    }
  }

  const block = `${header}${lines.join('\n')}
--------------------------------------------------------------------------------

`
  await appendFile(outFile, block, 'utf8')
  console.log('--------------------------------------------------------------------------------')
  console.log(`Appended to ${outFile}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
