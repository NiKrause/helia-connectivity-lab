import { dialEchoOnce } from './echo-dial.js'

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

  const reply = await dialEchoOnce(relayAddrStr, message)
  console.log(reply)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
