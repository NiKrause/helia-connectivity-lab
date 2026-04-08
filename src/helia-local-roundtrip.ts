/**
 * Phase 2A: two Helia nodes on localhost, dial TCP, add bytes on A, cat on B (bitswap).
 *
 * Dependency versions match libp2p 2.x / Helia 5.x (same band as orbitdb-relay-pinner).
 */
import { unixfs } from '@helia/unixfs'
import { createHelia } from 'helia'
import { MemoryBlockstore } from 'blockstore-core'
import { MemoryDatastore } from 'datastore-core'
import { multiaddr } from '@multiformats/multiaddr'

const PAYLOAD = new TextEncoder().encode('hello helia local phase-2a')

/** Helia already appends /p2p/<peerId> to announced addrs — dial that string as-is. */
function pickLocalTcpDialMultiaddr(list: { toString(): string }[]) {
  for (const ma of list) {
    const s = ma.toString()
    if (s.startsWith('/ip4/127.0.0.1/tcp/') && s.includes('/p2p/') && !s.includes('/ws')) {
      return s
    }
  }
  for (const ma of list) {
    const s = ma.toString().replaceAll('/ip4/0.0.0.0/', '/ip4/127.0.0.1/')
    if (s.includes('/tcp/') && s.includes('/p2p/') && !s.includes('/ws') && !s.includes('/webrtc')) {
      return s
    }
  }
  return undefined
}

async function main() {
  const helia1 = await createHelia({
    blockstore: new MemoryBlockstore(),
    datastore: new MemoryDatastore(),
  })
  const helia2 = await createHelia({
    blockstore: new MemoryBlockstore(),
    datastore: new MemoryDatastore(),
  })

  try {
    const dialStr = pickLocalTcpDialMultiaddr(helia1.libp2p.getMultiaddrs())
    if (!dialStr) {
      throw new Error('helia1: no suitable TCP dial multiaddr (expected /ip4/127.0.0.1/tcp/.../p2p/...)')
    }
    await helia2.libp2p.dial(multiaddr(dialStr))

    const fs1 = unixfs(helia1)
    const cid = await fs1.addBytes(PAYLOAD)
    console.log('Added CID:', cid.toString())

    const fs2 = unixfs(helia2)
    const chunks: Uint8Array[] = []
    for await (const chunk of fs2.cat(cid)) {
      chunks.push(chunk)
    }
    let total = 0
    for (const c of chunks) total += c.length
    const merged = new Uint8Array(total)
    let o = 0
    for (const c of chunks) {
      merged.set(c, o)
      o += c.length
    }

    const ok =
      merged.length === PAYLOAD.length && merged.every((b, i) => b === PAYLOAD[i])
    console.log(ok ? 'Phase 2A OK: cat on peer2 matches add on peer1' : 'Phase 2A FAIL: payload mismatch')
    if (!ok) process.exit(1)
  } finally {
    await helia1.stop()
    await helia2.stop()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
