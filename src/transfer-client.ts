import { BULK_LADDER_SEC } from './bulk-constants.js'
import { dialBulkTransfer } from './transfer-dial.js'

function usage(): never {
  console.error(`Usage:
  node dist/transfer-client.js <multiaddr> [options]
  RELAY_MULTIADDR=<multiaddr> node dist/transfer-client.js [options]

Random framed payloads (connectivity-bulk protocol); server echoes each chunk.

  --duration SEC   Run for exactly SEC seconds (one shot). Example: --duration 120
  --escalate       Run ${BULK_LADDER_SEC.join('s, ')}s in order; stop at first failure.
  --min-chunk N    Min random payload bytes (default 512)
  --max-chunk N    Max random payload bytes (default 32KiB, cap 256KiB)

Default if neither --duration nor --escalate: --escalate (full ladder).

Examples:
  node dist/transfer-client.js /ip4/95.217.163.72/tcp/82/p2p/12D3KooW... --duration 60
  node dist/transfer-client.js /ip4/95.217.163.72/tcp/82/p2p/12D3KooW... --escalate
`)
  process.exit(1)
}

function parseArgs(argv: string[]) {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') usage()
    if (a === '--escalate') {
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
  return { positional, flags }
}

function printResult(sec: number | string, r: Awaited<ReturnType<typeof dialBulkTransfer>>): void {
  const tag = typeof sec === 'number' ? `${sec}s` : String(sec)
  if (r.ok) {
    console.log(
      `OK ${tag}  rounds=${r.rounds}  bytesUp=${r.bytesSent}  bytesDown=${r.bytesRecv}  wallMs=${r.durationMs}`
    )
  } else {
    console.log(
      `FAIL ${tag}  rounds=${r.rounds}  bytesUp=${r.bytesSent}  bytesDown=${r.bytesRecv}  err=${r.error || 'unknown'}`
    )
  }
}

async function main() {
  const fromEnv = process.env.RELAY_MULTIADDR?.trim()
  const argv = process.argv.slice(2)
  const { positional, flags } = parseArgs(argv)

  let relayAddrStr: string | undefined
  if (positional[0]?.startsWith('/')) {
    relayAddrStr = positional[0]
  } else if (fromEnv) {
    relayAddrStr = fromEnv
  } else {
    usage()
  }

  const durationRaw = flags.duration

  const minChunk = flags['min-chunk'] ? Number(flags['min-chunk']) : undefined
  const maxChunk = flags['max-chunk'] ? Number(flags['max-chunk']) : undefined
  const dialOpts = {
    ...(minChunk !== undefined && Number.isFinite(minChunk) ? { minChunk } : {}),
    ...(maxChunk !== undefined && Number.isFinite(maxChunk) ? { maxChunk } : {}),
  }

  if (durationRaw) {
    const sec = Number(durationRaw)
    if (!Number.isFinite(sec) || sec < 1) {
      console.error('Invalid --duration')
      usage()
    }
    const r = await dialBulkTransfer(relayAddrStr, sec * 1000, dialOpts)
    printResult(sec, r)
    process.exit(r.ok ? 0 : 1)
  }

  let lastOk = true
  for (const sec of BULK_LADDER_SEC) {
    const r = await dialBulkTransfer(relayAddrStr, sec * 1000, dialOpts)
    printResult(sec, r)
    if (!r.ok) {
      lastOk = false
      break
    }
  }
  process.exit(lastOk ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
