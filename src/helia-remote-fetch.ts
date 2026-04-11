/**
 * Phase 2B (client side): one Helia node dials a remote peer, then `cat`s a CID over the network.
 *
 * Prerequisite: the remote peer must already hold the block (e.g. added there with the same Helia/libp2p stack).
 *
 * Usage:
 *   node dist/helia-remote-fetch.js '/ip4/HOST/tcp/PORT/p2p/PEER' bafy...
 */
import { unixfs } from '@helia/unixfs'
import { createHelia } from 'helia'
import { MemoryBlockstore } from 'blockstore-core'
import { MemoryDatastore } from 'datastore-core'
import { CID } from 'multiformats/cid'
import { multiaddr } from '@multiformats/multiaddr'

function usage(): never {
  console.error(`Usage:
  node dist/helia-remote-fetch.js <multiaddr-with-/p2p/> <cid>

Example:
  node dist/helia-remote-fetch.js '/ip4/95.217.163.72/tcp/8443/p2p/12D3KooW...' bafkrei...
`)
  process.exit(1)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length < 2) usage()
  const maStr = argv[0]
  const cidStr = argv[1]
  if (!maStr?.startsWith('/') || !cidStr) usage()

  let cid: CID
  try {
    cid = CID.parse(cidStr)
  } catch {
    console.error('Invalid CID')
    usage()
  }

  const helia = await createHelia({
    blockstore: new MemoryBlockstore(),
    datastore: new MemoryDatastore(),
  })
  try {
    await helia.libp2p.dial(multiaddr(maStr))
    const fs = unixfs(helia)
    const chunks: Uint8Array[] = []
    for await (const chunk of fs.cat(cid)) {
      chunks.push(chunk)
    }
    const out = Buffer.concat(chunks.map((c) => Buffer.from(c)))
    process.stdout.write(out)
    if (!out.toString().endsWith('\n')) process.stdout.write('\n')
  } finally {
    await helia.stop()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
