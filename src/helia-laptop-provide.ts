/**
 * Laptop side for the HTTP /ipfs gateway: dial the relay, add a local file as UnixFS, print CID, stay up for bitswap.
 *
 * Usage:
 *   node dist/helia-laptop-provide.js '/ip4/HOST/tcp/PORT/p2p/PEER' /path/to/file
 */
import fs from 'node:fs/promises'
import { createHelia } from 'helia'
import { unixfs } from '@helia/unixfs'
import { MemoryBlockstore } from 'blockstore-core'
import { MemoryDatastore } from 'datastore-core'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { createLibp2p } from 'libp2p'
import { multiaddr } from '@multiformats/multiaddr'
import { createClientLibp2pOptions } from './libp2p-client-config.js'
import {
  attachLibp2pConnectionLogging,
  libp2pConnLogEnabledForLaptopProvide,
} from './libp2p-connection-log.js'

function usage(): never {
  console.error(`Usage:
  node dist/helia-laptop-provide.js <relay-multiaddr-with-/p2p/> <file-path>

Example:
  node dist/helia-laptop-provide.js '/ip4/95.217.163.72/tcp/81/p2p/12D3KooW...' ./notes.txt
`)
  process.exit(1)
}

async function main() {
  const argv = process.argv.slice(2)
  const maStr = argv[0]
  const filePath = argv[1]
  if (!maStr?.startsWith('/') || !filePath) usage()

  const bytes = await fs.readFile(filePath)
  const privateKey = await generateKeyPair('Ed25519')
  const libp2pOptions = {
    ...(createClientLibp2pOptions(privateKey) as Record<string, unknown>),
    start: false,
  } as Parameters<typeof createLibp2p>[0]

  const libp2p = await createLibp2p(libp2pOptions)
  if (libp2pConnLogEnabledForLaptopProvide()) {
    attachLibp2pConnectionLogging(libp2p, '[laptop-provide]')
    console.error('[laptop-provide] libp2p connection logging on (HELIA_LAPTOP_CONN_LOG=0 to disable)')
  }
  const helia = await createHelia<typeof libp2p>({
    libp2p,
    blockstore: new MemoryBlockstore(),
    datastore: new MemoryDatastore(),
    start: false,
  })
  await helia.start()

  try {
    const relayMa = multiaddr(maStr)
    await helia.libp2p.dial(relayMa)

    const fsapi = unixfs(helia)
    const cid = await fsapi.addBytes(bytes)
    console.error(`Dial OK. File ${filePath} (${bytes.length} bytes)`)
    console.error(`UnixFS CID (use in curl): ${cid.toString()}`)
    console.error('Leave this running so the relay can bitswap blocks; Ctrl+C to exit.')

    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve())
      process.once('SIGTERM', () => resolve())
    })
  } finally {
    await helia.stop()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
