import { createLibp2p } from 'libp2p'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { multiaddr } from '@multiformats/multiaddr'
import { createClientLibp2pOptions } from './libp2p-client-config.js'
import { CONNECTIVITY_ECHO_PROTOCOL } from './protocol.js'
import { readLine, writeLine } from './stream-line.js'

function usage(): never {
  console.error(`Usage:
  node dist/client.js <multiaddr> [message]
  RELAY_MULTIADDR=<multiaddr> node dist/client.js [message]

Example:
  node dist/client.js /ip4/127.0.0.1/tcp/9092/ws/p2p/12D3KooW... home-vpn
`)
  process.exit(1)
}

async function main() {
  const fromEnv = process.env.RELAY_MULTIADDR?.trim()
  const argv = process.argv.slice(2)
  let relayAddrStr: string | undefined
  let message: string

  if (argv.length === 0) {
    usage()
  }

  if (fromEnv && !argv[0]?.startsWith('/')) {
    relayAddrStr = fromEnv
    message = argv.join(' ') || 'hello-from-client'
  } else if (argv[0]?.startsWith('/')) {
    relayAddrStr = argv[0]
    message = argv.slice(1).join(' ') || 'hello-from-client'
  } else if (fromEnv) {
    relayAddrStr = fromEnv
    message = argv.join(' ') || 'hello-from-client'
  } else {
    usage()
  }

  if (!relayAddrStr) usage()

  const privateKey = await generateKeyPair('Ed25519')
  const libp2p = await createLibp2p(createClientLibp2pOptions(privateKey) as Parameters<typeof createLibp2p>[0])

  await libp2p.start()

  const relayMa = multiaddr(relayAddrStr)

  try {
    await libp2p.dial(relayMa)
    const stream = await libp2p.dialProtocol(relayMa, CONNECTIVITY_ECHO_PROTOCOL)
    try {
      await writeLine(stream, message)
      const reply = await readLine(stream)
      console.log(reply)
    } finally {
      try {
        await stream.close()
      } catch {
        // ignore
      }
    }
  } finally {
    await libp2p.stop()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
